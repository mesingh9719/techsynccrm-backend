import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import express from 'express'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
const { objects, mail, queued } = vi.hoisted(() => ({ objects: new Map(), mail: vi.fn().mockResolvedValue({ messageId: 'test' }), queued: vi.fn().mockResolvedValue('job') }))
vi.mock('../../src/config/env.js', () => ({ env: { NODE_ENV: 'test', isProduction: false, DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused', DATABASE_URL_UNPOOLED: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused', DB_POOL_MAX: 10, FRONTEND_URL: 'https://crm.example.test', STORAGE_URL_EXPIRES_IN: 900, MAX_UPLOAD_MB: 25, JWT_ACCESS_SECRET: 'test-only-not-a-real-secret-01234567890123456789', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test', JWT_ACCESS_EXPIRES_IN: '15m', INVITATION_TTL_DAYS: 7, DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } }))
vi.mock('../../src/email/mailer.js', () => ({ sendEmail: mail, queueEmail: mail }))
vi.mock('../../src/storage/files.js', () => ({ storage: { url: vi.fn().mockResolvedValue('https://storage.example.test/file') } }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue: queued }))
vi.mock('../../src/storage/objectStore.js', () => ({ objectStore: {
  upload: async (key, bytes) => { objects.set(key, Buffer.from(bytes)) },
  head: async (key) => { if (!objects.has(key)) throw new Error('Missing test object'); return { ContentLength: objects.get(key).length, ETag: crypto.createHash('sha256').update(objects.get(key)).digest('hex') } },
  bytes: async (key) => Buffer.from(objects.get(key)),
  promote: async (source, target, etag) => { if (crypto.createHash('sha256').update(objects.get(source)).digest('hex') !== etag) throw new Error('ETag mismatch'); objects.set(target, Buffer.from(objects.get(source))) },
  delete: async (key) => { objects.delete(key) },
  url: async (_key, type, disposition) => `https://storage.example.test/file?type=${encodeURIComponent(type)}&disposition=${encodeURIComponent(disposition)}`,
  intent: async (key) => ({ url: 'https://storage.example.test/upload', fields: { key } }),
} }))
import { prisma } from '../../src/db/prisma.js'
import { permissionsFor } from '../../src/config/permissions.js'
import { versionedUpdate } from '../../src/lib/versionedUpdate.js'
import { createTask, updateTask, completeTask, cancelTask, reopenTask, deleteTask, getTask, sendDueReminders, listTasks } from '../../src/services/task.service.js'
import { createContact, updateContact } from '../../src/services/contact.service.js'
import { createCompany, updateCompany } from '../../src/services/company.service.js'
import { createLead, updateLead, convertLead } from '../../src/services/lead.service.js'
import { createDeal, updateDeal } from '../../src/services/deal.service.js'
import { createInvitations, resendInvitation, acceptInvitation } from '../../src/services/invitation.service.js'
import { ensureLeadDefaults } from '../../src/services/leadSetup.service.js'
import { ensureDefaultPipeline } from '../../src/services/pipeline.service.js'
import { uploadFile, createUploadIntent, completeUpload, getFileWithUrl, listFiles, linkFile, unlinkFile, deleteFile, restoreFile } from '../../src/services/file.service.js'
import { createImport, updateImport, previewImport, startImport, runImport, importStatus, undoImport, importErrors, createExport, exportStatus } from '../../src/services/transfer.service.js'
import { signAccessToken } from '../../src/services/token.service.js'
import { taskRoutes } from '../../src/routes/activity.routes.js'
import { importRoutes, exportRoutes } from '../../src/routes/transfer.routes.js'
import fileRoutes from '../../src/routes/file.routes.js'
import { errorHandler } from '../../src/middlewares/errorHandler.js'

const enabled = Boolean(process.env.TEST_DATABASE_URL), uuid = () => crypto.randomUUID()
let users, org, other, ctx, rep, viewer, server, base, pipeline, stages
const uploadCsv = (text, context = ctx) => uploadFile(context, { originalname: 'records.csv', mimetype: 'text/csv', size: Buffer.byteLength(text), buffer: Buffer.from(text) })
const draftImport = async (text, entityType = 'lead', options = {}) => {
  const file = await uploadCsv(text), job = await createImport(ctx, { entityType, fileId: file.id })
  await updateImport(ctx, job.id, { options: { ...job.options, ...options } })
  return job
}
const runDraft = async (job) => { await startImport(ctx, job.id); await runImport(job.id); return importStatus(ctx, job.id) }

describe.skipIf(!enabled)('product regressions on disposable PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && process.env.TEST_DATABASE_DISPOSABLE !== 'true') throw new Error('Disposable test database required')
    users = await Promise.all(['owner', 'rep', 'viewer'].map((name) => prisma.user.create({ data: { fullName: name, email: `${name}-${uuid()}@example.test`, passwordHash: 'cannot-login', emailVerifiedAt: new Date() } })))
    org = await prisma.organization.create({ data: { name: 'Product audit tests', slug: `audit-${uuid()}`, createdById: users[0].id, plan: 'business' } })
    other = await prisma.organization.create({ data: { name: 'Other audit workspace', slug: `audit-${uuid()}`, createdById: users[0].id, plan: 'business' } })
    await prisma.membership.createMany({ data: users.map((u, i) => ({ organizationId: org.id, userId: u.id, role: ['owner', 'sales_rep', 'viewer'][i], joinedAt: new Date() })) })
    await prisma.membership.create({ data: { organizationId: other.id, userId: users[0].id, role: 'owner' } })
    ctx = { orgId: org.id, userId: users[0].id, role: 'owner', permissions: permissionsFor('owner'), plan: 'business', currency: 'INR', country: 'IN', timezone: 'Asia/Kolkata', managedUserIds: [] }
    rep = { ...ctx, userId: users[1].id, role: 'sales_rep', permissions: permissionsFor('sales_rep') }
    viewer = { ...ctx, userId: users[2].id, role: 'viewer', permissions: permissionsFor('viewer') }
    await prisma.$transaction(async (tx) => { await ensureLeadDefaults(tx, org.id); await ensureDefaultPipeline(tx, org.id) })
    pipeline = await prisma.pipeline.findFirst({ where: { organizationId: org.id }, include: { stages: { orderBy: { position: 'asc' } } } }); stages = pipeline.stages
    const app = express(); app.use(express.json()); app.use('/api/tasks', taskRoutes); app.use('/api/files', fileRoutes); app.use('/api/imports', importRoutes); app.use('/api/exports', exportRoutes); app.use(errorHandler)
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) }); base = `http://127.0.0.1:${server.address().port}/api`
  }, 20000)
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (org) await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } })
    if (users) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } })
    await prisma.$disconnect()
  }, 20000)

  it('migrates original M10 tasks additively, backfills future reminders, preserves rows and replays safely', async () => {
    const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await client.connect()
    try {
      await client.query('BEGIN')
      const schema = `audit_${uuid().replaceAll('-', '')}`
      await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET LOCAL search_path TO ${schema}, public`)
      await client.query('CREATE TABLE organizations (id UUID PRIMARY KEY)')
      const original = await fs.readFile(new URL('../../prisma/migrations/20261019190000_activities_tasks/migration.sql', import.meta.url), 'utf8')
      expect(crypto.createHash('sha256').update(original).digest('hex')).toBe('ad35e14c4852cad43cd479e3bb82bc3858a1dba8b44f5fbfea8b5ecde521a29e')
      await client.query(original)
      const oid = uuid(); await client.query('INSERT INTO organizations VALUES ($1)', [oid])
      await client.query("INSERT INTO tasks (organization_id, title, assignee_id, due_at, updated_at, reminder_job_id) VALUES ($1,'Legacy task',$2,now()+interval '1 day',now(),'old-job')", [oid, users[0].id])
      let repair = await fs.readFile(new URL('../../prisma/migrations/20261020001000_task_reminder_scan/migration.sql', import.meta.url), 'utf8')
      repair = repair.replace(/^BEGIN;|^COMMIT;/gm, '')
      await client.query(repair)
      const before = (await client.query('SELECT * FROM tasks')).rows[0]
      expect(before.reminder_job_id).toBe('old-job'); expect(before.remind_at.getTime()).toBe(before.due_at.getTime() - 15 * 60000); expect(before.reminder_sent_at).toBeNull()
      await client.query(repair)
      expect((await client.query('SELECT remind_at FROM tasks')).rows[0].remind_at).toEqual(before.remind_at)
      await client.query('ROLLBACK')
    } finally { await client.end() }
  })

  it('creates, retrieves, reschedules, reminds once, cancels, reopens and completes tasks through real columns', async () => {
    const due = new Date(Date.now() + 3600000)
    const task = await createTask(ctx, { title: 'Follow up', dueAt: due.toISOString() })
    expect(task.remindAt.getTime()).toBe(due.getTime() - 15 * 60000)
    await sendDueReminders(new Date(task.remindAt.getTime() + 1)); await sendDueReminders(new Date(task.remindAt.getTime() + 2))
    expect(await prisma.domainEvent.count({ where: { organizationId: org.id, entityId: task.id, type: 'task.reminder_due' } })).toBe(1)
    const moved = await updateTask(ctx, task.id, { dueAt: new Date(due.getTime() + 3600000).toISOString() })
    expect((await prisma.task.findUnique({ where: { id: task.id } })).reminderSentAt).toBeNull()
    expect(moved.remindAt > task.remindAt).toBe(true)
    await cancelTask(ctx, task.id); expect((await getTask(ctx, task.id)).remindAt).toBeNull()
    await reopenTask(ctx, task.id); await completeTask(ctx, task.id)
    expect((await getTask(ctx, task.id)).status).toBe('completed')
    const allDay = await createTask(ctx, { title: 'All day', dueDate: '2027-04-01', reminderOffsetMinutes: null })
    expect(allDay.dueAt.toISOString()).toBe('2027-04-01T18:29:59.999Z'); expect(allDay.remindAt).toBeNull()
    expect((await listTasks(ctx, { view: 'all', limit: 100 })).items.some((t) => t.id === task.id)).toBe(true)
  })

  it('enforces task delete permission on both HTTP and bulk/service paths and isolates workspaces', async () => {
    const task = await createTask(rep, { title: 'Rep task' })
    await expect(deleteTask(rep, task.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const token = signAccessToken(users[1], org.id).accessToken
    expect((await fetch(`${base}/tasks/${task.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status).toBe(403)
    await expect(getTask({ ...ctx, orgId: other.id }, task.id)).rejects.toMatchObject({ statusCode: 404 })
    await deleteTask(ctx, task.id); await expect(getTask(ctx, task.id)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('retains atomic activity logging and one recurring successor under concurrent completion', async () => {
    const lead = await createLead(ctx, { firstName: 'Recurring customer' })
    const task = await createTask(ctx, { title: 'Call customer', type: 'call', entityType: 'lead', entityId: lead.id, dueAt: new Date(Date.now() + 3600000).toISOString(), recurrence: { freq: 'daily', count: 3 } })
    await Promise.allSettled([completeTask(ctx, task.id, { logActivity: { outcome: 'connected' } }), completeTask(ctx, task.id, { logActivity: { outcome: 'connected' } })])
    expect(await prisma.task.count({ where: { organizationId: org.id, seriesId: task.id } })).toBe(2)
    expect(await prisma.activity.count({ where: { organizationId: org.id, entityId: lead.id, type: 'call' } })).toBe(1)
    expect((await prisma.lead.findUnique({ where: { id: lead.id } })).status).toBe('contacted')
  })

  it.each(['contact', 'company', 'lead', 'deal'])('prevents concurrent %s overwrites in the write predicate', async (type) => {
    const creators = { contact: () => createContact(ctx, { firstName: 'Version' }), company: () => createCompany(ctx, { name: `Version ${uuid()}` }), lead: () => createLead(ctx, { firstName: 'Version' }), deal: () => createDeal(ctx, { title: 'Version', stageId: stages[0].id }) }
    const row = await creators[type](), before = await prisma[type].findUnique({ where: { id: row.id } })
    const field = { contact: 'firstName', company: 'name', lead: 'firstName', deal: 'title' }[type]
    const results = await Promise.allSettled(['A', 'B'].map((value) => prisma.$transaction((tx) => versionedUpdate(tx, type, ctx, before, { [field]: value }))))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected').reason.code).toBe('STALE_UPDATE')
    const updates = { contact: updateContact, company: updateCompany, lead: updateLead, deal: updateDeal }
    await expect(updates[type](ctx, before.id, { [field]: 'C' }, { expectedUpdatedAt: before.updatedAt.toISOString() })).rejects.toMatchObject({ code: 'STALE_UPDATE' })
  })

  it('replaces an invitation at full seat capacity and blocks expired resend over the limit', async () => {
    const seatOrg = await prisma.organization.create({ data: { name: 'Seats', slug: `seats-${uuid()}`, createdById: users[0].id, plan: 'starter' } })
    try {
      await prisma.membership.create({ data: { organizationId: seatOrg.id, userId: users[0].id, role: 'owner' } })
      const context = { ...ctx, orgId: seatOrg.id, plan: 'starter' }, email = `invite-${uuid()}@example.test`
      await createInvitations(context, { emails: [email], role: 'sales_rep' })
      await createInvitations(context, { emails: [email], role: 'sales_rep' })
      expect(await prisma.invitation.count({ where: { organizationId: seatOrg.id, revokedAt: null } })).toBe(1)
      const inv = await prisma.invitation.findFirst({ where: { organizationId: seatOrg.id, revokedAt: null } })
      await prisma.invitation.update({ where: { id: inv.id }, data: { expiresAt: new Date(0), lastSentAt: new Date(0) } })
      await prisma.membership.create({ data: { organizationId: seatOrg.id, userId: users[1].id, role: 'sales_rep' } })
      await expect(resendInvitation(context, inv.id)).rejects.toMatchObject({ code: 'PLAN_LIMIT_REACHED' })
    } finally { await prisma.organization.delete({ where: { id: seatOrg.id } }) }
  })

  it('sniffs attachments, checks record/workspace access, uses immutable completed keys and restores soft-deleted files', async () => {
    const contact = await createContact(ctx, { firstName: 'Private owner' })
    const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n')
    const file = await uploadFile(ctx, { originalname: 'contract.pdf', buffer: bytes, size: bytes.length }, { entityType: 'contact', entityId: contact.id })
    await expect(getFileWithUrl(rep, file.id)).rejects.toMatchObject({ statusCode: 404 })
    await expect(getFileWithUrl({ ...ctx, orgId: other.id }, file.id)).rejects.toMatchObject({ statusCode: 404 })
    expect((await listFiles(ctx, { entityType: 'contact', entityId: contact.id })).map((f) => f.id)).toContain(file.id)
    await linkFile(ctx, file.id, { entityType: 'deal', entityId: (await createDeal(ctx, { title: 'Attachment deal', stageId: stages[0].id })).id })
    const row = await prisma.file.findUnique({ where: { id: file.id } }); expect(row.storageKey).toMatch(/^orgs\//); expect(objects.has(row.storageKey)).toBe(true)
    expect((await getFileWithUrl(ctx, file.id)).url).toContain('application%2Fpdf')
    await deleteFile(ctx, file.id); await expect(getFileWithUrl(ctx, file.id)).rejects.toMatchObject({ statusCode: 404 })
    await restoreFile(ctx, file.id); expect((await getFileWithUrl(ctx, file.id)).id).toBe(file.id)
    await expect(uploadFile(ctx, { originalname: 'bad.pdf', buffer: Buffer.from('MZ-not-pdf'), size: 10 })).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' })
    await expect(uploadFile(viewer, { originalname: 'text.txt', buffer: Buffer.from('safe'), size: 4 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('reserves storage quota under the same workspace lock for parallel direct uploads', async () => {
    const quotaOrg = await prisma.organization.create({ data: { name: 'Storage quota', slug: `quota-${uuid()}`, createdById: users[0].id, plan: 'starter' } })
    const context = { ...ctx, orgId: quotaOrg.id, plan: 'starter' }
    try {
      await prisma.file.create({ data: { organizationId: quotaOrg.id, userId: ctx.userId, storageKey: uuid(), originalName: 'old.txt', contentType: 'text/plain', sizeBytes: BigInt(1024 ** 3 - 16 * 1024 ** 2), sha256: 'legacy' } })
      const result = await Promise.allSettled(Array.from({ length: 4 }, () => createUploadIntent(context, { name: 'large.txt', size: 8 * 1024 ** 2 })))
      expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
      expect(result.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'PLAN_LIMIT_REACHED')).toBe(true)
    } finally { await prisma.organization.delete({ where: { id: quotaOrg.id } }) }
  })

  it('imports CSV through mapping/preview with in-file dedupe and resumes without creating records twice', async () => {
    const email = `import-${uuid()}@example.test`
    const job = await draftImport(`Customer Name,Mobile,Email ID,Company Name\nAsha Sharma,9876543210,${email},Saffron\nAsha Sharma,9876543210,${email},Saffron\n`)
    expect((await previewImport(ctx, job.id)).rows[0].errors).toEqual([])
    const result = await runDraft(job); expect(result).toMatchObject({ status: 'completed', processed: 2, created: 1, skipped: 1 })
    await runImport(job.id)
    expect(await prisma.lead.count({ where: { organizationId: org.id, importId: job.id } })).toBe(1)
    expect(await prisma.domainEvent.count({ where: { organizationId: org.id, entityId: job.id, type: 'import.completed', actorId: null } })).toBe(1)
    const events = await prisma.domainEvent.findMany({ where: { organizationId: org.id, type: 'lead.created', payload: { path: ['meta', 'importId'], equals: job.id } } }); expect(events).toHaveLength(1)
  })

  it('updates duplicates, reports invalid rows, and undo preserves modified created records', async () => {
    const email = `update-${uuid()}@example.test`
    const old = await createContact(ctx, { firstName: 'Before', emails: [{ value: email }] })
    const update = await draftImport(`Customer Name,Email ID\nAfter Name,${email}\nBad,not-email`, 'contact', { duplicateStrategy: 'update', updateMode: 'overwrite' })
    const done = await runDraft(update); expect(done).toMatchObject({ updated: 1, failed: 1, processed: 2 })
    expect((await prisma.contact.findUnique({ where: { id: old.id } })).firstName).toBe('After')
    const errors = await importErrors(ctx, update.id); expect(errors.url).toContain('attachment')
    const job = await draftImport(`Company Name,Domain\nUndo One,one-${uuid()}.example\nUndo Two,two-${uuid()}.example`, 'company')
    await runDraft(job)
    const created = await prisma.company.findMany({ where: { organizationId: org.id, importId: job.id }, orderBy: { createdAt: 'asc' } })
    await updateCompany(ctx, created[0].id, { industry: 'Edited after import' })
    expect(await undoImport(ctx, job.id)).toEqual({ removed: 1, kept: 1 })
    expect((await prisma.company.findUnique({ where: { id: created[0].id } })).deletedAt).toBeNull()
  })

  it('exports requested filters/columns with formula safety and audit; managers cannot export outside their team', async () => {
    const lead = await createLead(ctx, { firstName: '=UNSAFE()', emails: [{ value: `export-${uuid()}@example.test` }], ownerId: rep.userId })
    const manager = { ...ctx, userId: rep.userId, role: 'manager', permissions: permissionsFor('manager'), managedUserIds: [] }
    await prisma.membership.update({ where: { organizationId_userId: { organizationId: org.id, userId: rep.userId } }, data: { role: 'manager' } })
    const result = await createExport(manager, { entityType: 'lead', filters: { q: '=UNSAFE()' }, columns: ['displayName', 'primaryEmail'], format: 'csv' })
    expect(result.status).toBe('completed')
    const job = await prisma.exportJob.findUnique({ where: { id: result.exportId } }); expect(job.rowCount).toBe(1)
    const file = await prisma.file.findUnique({ where: { id: job.fileId } }); expect(objects.get(file.storageKey).toString()).toContain("'=UNSAFE()")
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityId: job.id, action: 'data.export' } })).toBe(1)
    await expect(exportStatus({ ...manager, orgId: other.id }, result.exportId)).rejects.toMatchObject({ statusCode: 404 })
    await expect(createExport(rep, { entityType: 'lead', filters: {}, columns: ['id'], format: 'csv' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await exportStatus(manager, result.exportId)).file.id).toBe(job.fileId)
    expect(lead.id).toBeTruthy()
    await prisma.membership.update({ where: { organizationId_userId: { organizationId: org.id, userId: rep.userId } }, data: { role: 'sales_rep' } })
  })
})
