import crypto from 'node:crypto'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Explicit disposable DB only. The normal unit-test command never reads the application's .env.
const { mail, enqueueJob } = vi.hoisted(() => ({ mail: vi.fn(), enqueueJob: vi.fn() }))
vi.mock('../../src/config/env.js', () => ({ env: {
  NODE_ENV: 'test', isProduction: false,
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused',
  DATABASE_URL_UNPOOLED: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused',
  DB_POOL_MAX: 10, FRONTEND_URL: 'https://crm.example.test',
  JWT_ACCESS_SECRET: 'test-only-not-a-real-secret-01234567890123456789', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test', JWT_ACCESS_EXPIRES_IN: '15m',
} }))
vi.mock('../../src/email/mailer.js', () => ({ sendEmail: mail, queueEmail: mail }))
vi.mock('../../src/storage/files.js', () => ({ storage: {} }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue: enqueueJob }))

import { prisma, DB_NULL } from '../../src/db/prisma.js'
import { notificationRoutes, notificationPreferenceRoutes } from '../../src/routes/notification.routes.js'
import { errorHandler } from '../../src/middlewares/errorHandler.js'
import { signAccessToken } from '../../src/services/token.service.js'
import { createNotificationFor, createStreamTicket, consumeStreamTicket, handleNotificationEvent, listNotifications, markNotificationRead, notificationFromEvent, unreadCount, updateNotificationPreferences } from '../../src/services/notification.service.js'
import { notificationContext } from '../../src/services/notificationAccess.service.js'
import { cleanupNotifications, deliverNotificationBatch, digestSections, queueNotificationDigests, queueNotificationEmails, reserveNotificationBatch } from '../../src/services/notificationDelivery.service.js'
import { startNotificationListener, stopNotificationStreams } from '../../src/realtime/notifications.js'
import { getCurrentOrganization } from '../../src/services/organization.service.js'
import { sendTrialReminders } from '../../src/services/plan.service.js'
import { subscribersFor } from '../../src/events/registry.js'
import { isoDateInTz } from '../../src/lib/time.js'

const enabled = Boolean(process.env.TEST_DATABASE_URL)
const id = () => crypto.randomUUID()
let users, org, otherOrg, lead, deal, stage, task, contact, activity, ctx, server, base
const event = (type, entityId, payload = {}, actorId = null) => ({ id: id(), organizationId: org.id, entityType: type.split('.')[0], entityId, actorId, type, payload, createdAt: new Date() })
const pref = (userId, type, channels = { inApp: true, email: true }) => prisma.notificationPreference.create({ data: { organizationId: org.id, userId, type, ...channels } })
const batchDue = async () => prisma.notification.updateMany({ where: { organizationId: org.id, emailPendingAt: { not: null } }, data: { emailPendingAt: new Date(Date.now() - 1000) } })

describe.skipIf(!enabled)('M11 real Postgres integration (TEST_DATABASE_URL)', () => {
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.TEST_DATABASE_URL).hostname) && process.env.TEST_DATABASE_DISPOSABLE !== 'true') {
      throw new Error('Use a disposable local test database, or explicitly set TEST_DATABASE_DISPOSABLE=true for a dedicated remote test database. Never use the application database.')
    }
    const prefix = `m11-${id()}`
    users = await Promise.all(['owner', 'rep', 'other', 'admin', 'manager', 'unrelatedManager'].map((name) => prisma.user.create({ data: { fullName: name, email: `${name}-${prefix}@example.test`, passwordHash: 'test-account-cannot-login', emailVerifiedAt: new Date() } })))
    const [owner, rep, other, admin, manager, unrelatedManager] = users
    org = await prisma.organization.create({ data: { name: 'M11 test workspace', slug: prefix, createdById: owner.id, plan: 'business', timezone: 'Asia/Kolkata', trialEndsAt: new Date(Date.now() + 86400000) } })
    otherOrg = await prisma.organization.create({ data: { name: 'Other M11 workspace', slug: `${prefix}-other`, createdById: owner.id } })
    await prisma.membership.createMany({ data: users.map((u, i) => ({ organizationId: org.id, userId: u.id, role: ['owner', 'sales_rep', 'sales_rep', 'admin', 'manager', 'manager'][i], status: 'active' })) })
    await prisma.membership.create({ data: { organizationId: otherOrg.id, userId: rep.id, role: 'sales_rep', status: 'active' } })
    const team = await prisma.team.create({ data: { organizationId: org.id, name: 'Test sales team', members: { create: [{ userId: rep.id }, { userId: manager.id, isManager: true }] } } })
    expect(team.id).toBeTruthy()
    lead = await prisma.lead.create({ data: { organizationId: org.id, displayName: 'Test lead', ownerId: rep.id, createdById: owner.id } })
    contact = await prisma.contact.create({ data: { organizationId: org.id, displayName: 'Test contact', ownerId: rep.id } })
    const pipeline = await prisma.pipeline.create({ data: { organizationId: org.id, name: 'Test pipeline' } })
    stage = await prisma.pipelineStage.create({ data: { organizationId: org.id, pipelineId: pipeline.id, name: 'Open', probability: 50, position: 0, rottingDays: 7 } })
    deal = await prisma.deal.create({ data: { organizationId: org.id, pipelineId: pipeline.id, stageId: stage.id, title: 'Test deal', ownerId: rep.id, currency: 'INR', createdById: owner.id, stageEnteredAt: new Date(Date.now() - 10 * 86400000), lastActivityAt: new Date(Date.now() - 10 * 86400000) } })
    task = await prisma.task.create({ data: { organizationId: org.id, title: 'Test task', assigneeId: rep.id, createdById: owner.id, entityType: 'contact', entityId: contact.id, dueAt: new Date(Date.now() + 3600000), remindAt: new Date(), type: 'call' } })
    activity = await prisma.activity.create({ data: { organizationId: org.id, entityType: 'contact', entityId: contact.id, type: 'note', body: 'A test note', mentions: { create: { organizationId: org.id, userId: rep.id } } } })
    ctx = await notificationContext(org.id, rep.id)
    const app = express()
    app.use(express.json())
    app.use('/api/notifications', notificationRoutes)
    app.use('/api/users/me/notification-preferences', notificationPreferenceRoutes)
    app.use(errorHandler)
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    base = `http://127.0.0.1:${server.address().port}/api`
    await import('../../src/events/subscribers/index.js')
    await startNotificationListener()
  }, 20000)

  beforeEach(async () => {
    mail.mockReset().mockResolvedValue({ messageId: 'test-email' })
    enqueueJob.mockReset().mockResolvedValue(id())
    await prisma.notification.deleteMany({ where: { organizationId: { in: [org.id, otherOrg.id] } } })
    await prisma.notificationReceipt.deleteMany({ where: { organizationId: org.id } })
    await prisma.notificationPreference.deleteMany({ where: { organizationId: org.id } })
    await prisma.notificationEmailBatch.deleteMany({ where: { organizationId: org.id } })
    await prisma.notificationStreamTicket.deleteMany({ where: { organizationId: org.id } })
    await prisma.user.updateMany({ where: { id: { in: users.map((u) => u.id) } }, data: { quietHours: DB_NULL, digestEnabled: true } })
    await prisma.membership.updateMany({ where: { organizationId: org.id }, data: { status: 'active' } })
    await prisma.lead.update({ where: { id: lead.id }, data: { ownerId: users[1].id, deletedAt: null } })
    await prisma.task.update({ where: { id: task.id }, data: { status: 'open', deletedAt: null, dueAt: task.dueAt, assigneeId: users[1].id } })
  })

  afterAll(async () => {
    await stopNotificationStreams()
    if (server) await new Promise((resolve) => server.close(resolve))
    if (org) await prisma.organization.deleteMany({ where: { id: { in: [org.id, otherOrg.id] } } })
    if (users) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } })
    await prisma.$disconnect()
  }, 20000)

  it('deduplicates replayed events and groups different events exactly once under concurrency', async () => {
    const first = event('lead.assigned', lead.id, { changes: { ownerId: [null, users[1].id] } }, users[0].id)
    await Promise.all([handleNotificationEvent(first), handleNotificationEvent(first), handleNotificationEvent(event('lead.assigned', lead.id, first.payload, users[0].id))])
    const rows = await prisma.notification.findMany({ where: { organizationId: org.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].groupCount).toBe(2)
    expect(await prisma.notificationReceipt.count({ where: { organizationId: org.id } })).toBe(2)
  })

  it('rolls back both the receipt and notification after a failed transaction', async () => {
    const e = event('lead.assigned', lead.id)
    const descriptor = await notificationFromEvent(e)
    await expect(createNotificationFor(e, { ...descriptor, title: null }, users[1].id)).rejects.toThrow()
    expect(await prisma.notificationReceipt.count({ where: { organizationId: org.id, sourceEventId: e.id } })).toBe(0)
    await createNotificationFor(e, descriptor, users[1].id)
    expect(await unreadCount(ctx)).toBe(1)
  })

  it('registers one unified notification subscriber for reminders and preserves workspace first paint counts', async () => {
    expect(subscribersFor('task.reminder_due').map((s) => s.name)).toEqual(['notifications'])
    await handleNotificationEvent(event('lead.assigned', lead.id))
    const result = await getCurrentOrganization(ctx)
    expect(result.organization.unreadNotificationCount).toBe(1)
    const token = signAccessToken(users[1], org.id).accessToken
    const response = await fetch(`${base}/notifications/read-all`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    expect(await unreadCount(ctx)).toBe(0)
    await handleNotificationEvent(event('lead.assigned', lead.id))
    expect(await unreadCount(ctx)).toBe(1)
  })

  it('fills visible pages past inaccessible records and preserves a stable cursor', async () => {
    const data = Array.from({ length: 8 }, (_, i) => ({ organizationId: org.id, userId: users[1].id, type: i < 5 ? 'lead_assigned' : 'system', title: `Page ${i}`, entityType: i < 5 ? 'lead' : null, entityId: i < 5 ? lead.id : null, createdAt: new Date(Date.now() - i * 1000) }))
    await prisma.notification.createMany({ data })
    await prisma.lead.update({ where: { id: lead.id }, data: { ownerId: users[2].id } })
    const first = await listNotifications(ctx, { limit: 2 })
    expect(first.items.map((n) => n.title)).toEqual(['Page 5', 'Page 6'])
    expect(first.nextCursor).toBeTruthy()
    expect((await listNotifications(ctx, { limit: 2, cursor: first.nextCursor })).items.map((n) => n.title)).toEqual(['Page 7'])
    expect(await unreadCount(ctx)).toBe(3)
  })

  it('converts the existing trial job to one durable event without sending a second direct email', async () => {
    const now = new Date('2026-10-19T10:00:00Z')
    const end = new Date('2026-10-20T18:29:59Z')
    await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: end, trialRemindersSent: [] } })
    await sendTrialReminders(now); await sendTrialReminders(now)
    expect(await prisma.domainEvent.count({ where: { organizationId: org.id, type: 'trial.ending' } })).toBe(1)
    expect(mail).not.toHaveBeenCalled()
    await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: org.trialEndsAt, trialRemindersSent: [] } })
  })

  it('starts a fresh notification after read or after the grouping window', async () => {
    await handleNotificationEvent(event('lead.assigned', lead.id))
    let row = await prisma.notification.findFirst({ where: { organizationId: org.id } })
    await markNotificationRead(ctx, row.id)
    await handleNotificationEvent(event('lead.assigned', lead.id))
    row = await prisma.notification.findFirst({ where: { organizationId: org.id, readAt: null } })
    await prisma.notification.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - 11 * 60000) } })
    await handleNotificationEvent(event('lead.assigned', lead.id))
    expect(await prisma.notification.count({ where: { organizationId: org.id } })).toBe(3)
  })

  it('never notifies the actor, deactivated members or users who cannot see the record', async () => {
    await handleNotificationEvent(event('lead.assigned', lead.id, {}, users[1].id))
    expect(await unreadCount(ctx)).toBe(0)
    await prisma.membership.update({ where: { organizationId_userId: { organizationId: org.id, userId: users[1].id } }, data: { status: 'deactivated' } })
    await handleNotificationEvent(event('lead.assigned', lead.id))
    expect(await prisma.notification.count({ where: { organizationId: org.id } })).toBe(0)
    const descriptor = await notificationFromEvent(event('lead.assigned', lead.id))
    await createNotificationFor(event('lead.assigned', lead.id), descriptor, users[2].id)
    expect(await prisma.notification.count({ where: { organizationId: org.id } })).toBe(0)
  })

  it.each(['lead.assigned', 'lead.repeat_enquiry', 'deal.assigned', 'deal.rotting', 'task.assigned', 'task.reminder_due', 'mention.created', 'import.completed', 'import.failed'])('routes %s to the intended recipient', async (type) => {
    const entityId = type.startsWith('lead') ? lead.id : type.startsWith('deal') ? deal.id : type.startsWith('task') ? task.id : activity.id
    await handleNotificationEvent(event(type, entityId, { userId: users[1].id, dueAt: task.dueAt.toISOString() }))
    const rows = await prisma.notification.findMany({ where: { organizationId: org.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(users[1].id)
  })

  it('keeps optional admin/team alerts opt-in and routes won deals only to actual managers/admins', async () => {
    await prisma.lead.update({ where: { id: lead.id }, data: { ownerId: null } })
    await handleNotificationEvent(event('lead.created', lead.id))
    await handleNotificationEvent(event('deal.won', deal.id))
    expect(await prisma.notification.count({ where: { organizationId: org.id } })).toBe(0)
    for (const u of [users[0], users[3], users[4], users[5]]) await pref(u.id, 'deal_won')
    await handleNotificationEvent(event('deal.won', deal.id))
    const rows = await prisma.notification.findMany({ where: { organizationId: org.id } })
    expect(rows.map((r) => r.userId).sort()).toEqual([users[0].id, users[3].id, users[4].id].sort())
    await pref(users[4].id, 'new_unassigned_lead', { inApp: true, email: false })
    await handleNotificationEvent(event('lead.created', lead.id))
    expect(await prisma.notification.count({ where: { organizationId: org.id, type: 'new_unassigned_lead', userId: users[4].id } })).toBe(1)
  })

  it('handles member joined, trial, system announcements and digest-only overdue defaults', async () => {
    await handleNotificationEvent(event('member.joined', users[2].id, { invitedById: users[0].id }, users[2].id))
    await handleNotificationEvent(event('trial.ending', org.id, { daysLeft: 1, trialEndsAt: org.trialEndsAt.toISOString() }))
    await handleNotificationEvent(event('notification.announced', org.id, { title: 'Announcement' }, users[0].id))
    await prisma.task.update({ where: { id: task.id }, data: { dueAt: new Date(Date.now() - 60000) } })
    await handleNotificationEvent(event('task.overdue', task.id))
    const rows = await prisma.notification.findMany({ where: { organizationId: org.id } })
    expect(rows.filter((r) => r.type === 'member_joined').map((r) => r.userId)).toEqual([users[0].id])
    expect(rows.filter((r) => r.type === 'trial_ending').map((r) => r.userId).sort()).toEqual([users[0].id, users[3].id].sort())
    expect(rows.filter((r) => r.type === 'system')).toHaveLength(5)
    expect(rows.filter((r) => r.type === 'task_overdue')).toHaveLength(0)
  })

  it('isolates tenant/user reads and rejects another tenant’s read request', async () => {
    await handleNotificationEvent(event('lead.assigned', lead.id))
    const row = await prisma.notification.findFirst({ where: { organizationId: org.id } })
    const otherCtx = { ...ctx, orgId: otherOrg.id }
    expect((await listNotifications(otherCtx)).items).toHaveLength(0)
    await expect(markNotificationRead(otherCtx, row.id)).rejects.toMatchObject({ statusCode: 404 })
    const token = signAccessToken(users[1], otherOrg.id).accessToken
    const response = await fetch(`${base}/notifications/${row.id}/read`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(404)
  })

  it('batches 50 lead assignments into one email and survives duplicate delivery jobs', async () => {
    const leads = await Promise.all(Array.from({ length: 50 }, (_, i) => prisma.lead.create({ data: { organizationId: org.id, displayName: `Bulk ${i}`, ownerId: users[1].id } })))
    for (const l of leads) await handleNotificationEvent(event('lead.assigned', l.id))
    await batchDue()
    await queueNotificationEmails()
    const batches = await prisma.notificationEmailBatch.findMany({ where: { organizationId: org.id, kind: 'batch' } })
    expect(batches).toHaveLength(1)
    expect(batches[0].notificationIds).toHaveLength(50)
    await Promise.all([deliverNotificationBatch(batches[0].id), deliverNotificationBatch(batches[0].id)])
    expect(mail).toHaveBeenCalledTimes(1)
    expect(mail.mock.calls[0][0].text).toContain('Bulk 49')
  }, 20000)

  it('honours email-only preferences and rechecks visibility and preferences at send time', async () => {
    await pref(users[1].id, 'lead_assigned', { inApp: false, email: true })
    await handleNotificationEvent(event('lead.assigned', lead.id))
    expect(await unreadCount(ctx)).toBe(0)
    await batchDue(); const batch = await reserveNotificationBatch(org.id, users[1].id)
    await prisma.lead.update({ where: { id: lead.id }, data: { ownerId: users[2].id } })
    await deliverNotificationBatch(batch.id)
    expect(mail).not.toHaveBeenCalled()
    await prisma.lead.update({ where: { id: lead.id }, data: { ownerId: users[1].id } })
    await handleNotificationEvent(event('lead.assigned', lead.id)); await batchDue()
    const second = await reserveNotificationBatch(org.id, users[1].id)
    await prisma.notificationPreference.update({ where: { organizationId_userId_type: { organizationId: org.id, userId: users[1].id, type: 'lead_assigned' } }, data: { email: false } })
    await deliverNotificationBatch(second.id)
    expect(mail).not.toHaveBeenCalled()
  })

  it('defers quiet-hour email while retaining the inbox notification', async () => {
    const now = new Date('2026-10-19T16:30:00Z') // 22:00 IST
    await prisma.user.update({ where: { id: users[1].id }, data: { quietHours: { start: '21:00', end: '08:00' } } })
    await handleNotificationEvent(event('lead.assigned', lead.id)); await batchDue()
    const batch = await reserveNotificationBatch(org.id, users[1].id)
    await prisma.notificationEmailBatch.update({ where: { id: batch.id }, data: { availableAt: now } })
    expect(await deliverNotificationBatch(batch.id, now)).toEqual({ deferred: true })
    expect(mail).not.toHaveBeenCalled()
    expect(await unreadCount(ctx)).toBe(1)
    expect((await prisma.notificationEmailBatch.findUnique({ where: { id: batch.id } })).availableAt.toISOString()).toBe('2026-10-20T02:30:00.000Z')
  })

  it('keeps failed SMTP batches pending and retries with safe escaped content', async () => {
    await prisma.lead.update({ where: { id: lead.id }, data: { displayName: '<script>alert(1)</script>' } })
    await handleNotificationEvent(event('lead.assigned', lead.id)); await batchDue()
    const batch = await reserveNotificationBatch(org.id, users[1].id)
    mail.mockRejectedValueOnce(new Error('SMTP unavailable'))
    await expect(deliverNotificationBatch(batch.id)).rejects.toThrow('SMTP unavailable')
    const failed = await prisma.notificationEmailBatch.findUnique({ where: { id: batch.id } })
    expect(failed.sentAt).toBeNull(); expect(failed.attempts).toBe(1)
    await deliverNotificationBatch(batch.id, new Date(failed.availableAt.getTime() + 1000))
    expect(mail).toHaveBeenCalledTimes(2)
    expect(mail.mock.calls[1][0].html).not.toContain('<script>')
  })

  it('builds digest sections in user time, suppresses empty digests and schedules once per date', async () => {
    const now = new Date('2026-10-19T03:00:00Z')
    await prisma.task.update({ where: { id: task.id }, data: { dueAt: new Date('2026-10-19T02:00:00Z') } })
    const todayTask = await prisma.task.create({ data: { organizationId: org.id, title: 'Today task', assigneeId: users[1].id, dueAt: new Date('2026-10-19T10:00:00Z') } })
    const sections = await digestSections(await notificationContext(org.id, users[1].id), now)
    expect(sections.find((s) => s.label === 'Overdue tasks').items.some((i) => i.title === task.title)).toBe(true)
    expect(sections.find((s) => s.label === 'Today’s tasks').items.some((i) => i.title === todayTask.title)).toBe(true)
    expect(sections.find((s) => s.label === 'Idle deals').items).toHaveLength(1)
    await queueNotificationDigests(now); await queueNotificationDigests(now)
    expect(await prisma.notificationEmailBatch.count({ where: { organizationId: org.id, userId: users[1].id, kind: 'digest', key: '2026-10-19' } })).toBe(1)
    const empty = await prisma.notificationEmailBatch.findFirstOrThrow({ where: { organizationId: org.id, userId: users[2].id, kind: 'digest', key: isoDateInTz(now, 'Asia/Kolkata') } })
    await deliverNotificationBatch(empty.id, now)
    expect(mail).not.toHaveBeenCalled()
  })

  it('validates mandatory channels and persists per-workspace preferences through the API', async () => {
    const token = signAccessToken(users[1], org.id).accessToken
    const send = (values) => fetch(`${base}/users/me/notification-preferences`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(values) })
    expect((await send({ preferences: [{ type: 'mention', inApp: false, email: false }], quietHours: null, digestEnabled: false })).status).toBe(400)
    const response = await send({ preferences: [{ type: 'mention', inApp: true, email: false }], quietHours: { start: '21:00', end: '08:00' }, digestEnabled: false })
    expect(response.status).toBe(200)
    expect((await response.json()).data.digestEnabled).toBe(false)
    expect(await prisma.notificationPreference.count({ where: { organizationId: otherOrg.id } })).toBe(0)
  })

  it('consumes stream tickets once under a race and rejects expired tickets', async () => {
    const { ticket } = await createStreamTicket(ctx)
    const results = await Promise.allSettled([consumeStreamTicket(ticket), consumeStreamTicket(ticket)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const next = await createStreamTicket(ctx)
    await prisma.notificationStreamTicket.updateMany({ where: { organizationId: org.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    await expect(consumeStreamTicket(next.ticket)).rejects.toMatchObject({ code: 'STREAM_TICKET_INVALID' })
  })

  it('pushes SSE updates across the Postgres listener within two seconds and rejects access-token query auth', async () => {
    const controller = new AbortController()
    try {
      const { ticket } = await createStreamTicket(ctx)
      const response = await fetch(`${base}/notifications/stream?ticket=${ticket}`, { signal: controller.signal })
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const reader = response.body.getReader()
      await reader.read() // Initial count
      const started = Date.now()
      await handleNotificationEvent(event('lead.assigned', lead.id))
      const frame = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('SSE timed out')), 1900))])
      expect(new TextDecoder().decode(frame.value)).toContain('"unreadCount":1')
      expect(Date.now() - started).toBeLessThan(2000)
    } finally { controller.abort() }
    expect((await fetch(`${base}/notifications/stream?access_token=invalid`)).status).toBe(400)
  })

  it('rejects a stream ticket after its login session or workspace access has ended', async () => {
    const endedSession = await createStreamTicket({ ...ctx, sessionId: id() })
    expect((await fetch(`${base}/notifications/stream?ticket=${endedSession.ticket}`)).status).toBe(401)
    const removedMember = await createStreamTicket(ctx)
    await prisma.membership.update({ where: { organizationId_userId: { organizationId: org.id, userId: ctx.userId } }, data: { status: 'deactivated' } })
    expect((await fetch(`${base}/notifications/stream?ticket=${removedMember.ticket}`)).status).toBe(403)
  })

  it('applies read/unread retention without deleting recent notifications', async () => {
    const scope = { organizationId: org.id, userId: users[1].id, type: 'system', title: 'Retention test' }
    await prisma.notification.createMany({ data: [
      { ...scope, readAt: new Date(Date.now() - 91 * 86400000), createdAt: new Date(Date.now() - 100 * 86400000) },
      { ...scope, createdAt: new Date(Date.now() - 181 * 86400000) },
      { ...scope, readAt: new Date(), createdAt: new Date() },
    ] })
    expect((await cleanupNotifications()).count).toBe(2)
    expect(await prisma.notification.count({ where: { organizationId: org.id } })).toBe(1)
  })
})
