import { beforeEach, describe, expect, it, vi } from 'vitest'

const { db, mail } = vi.hoisted(() => {
  const delegate = () => ({ findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), aggregate: vi.fn() })
  return { db: Object.fromEntries(['lead', 'leadSource', 'leadEmail', 'leadPhone', 'contact', 'contactEmail', 'contactPhone', 'company', 'contactCompany', 'customFieldDefinition', 'recordTag', 'user', 'membership', 'teamMember', 'activity', 'activityLink', 'activityParticipant', 'mention', 'task', 'deal', 'pipeline', 'pipelineStage', 'dealStageHistory', 'dealContact', 'domainEvent', 'auditLog'].map((name) => [name, delegate()])), mail: vi.fn() }
})
vi.mock('../../src/db/prisma.js', () => ({ prisma: db, DB_NULL: 'DB_NULL', UNIQUE_VIOLATION: 'P2002' }))
vi.mock('../../src/config/env.js', () => ({ env: { FRONTEND_URL: 'https://example.test', NODE_ENV: 'test' } }))
vi.mock('../../src/email/mailer.js', () => ({ queueEmail: mail }))
vi.mock('../../src/services/entitlements.service.js', () => ({ assertWithinLimit: vi.fn() }))

import { claimLead, changeStatus, createLead, createLeadFromCapture, convertLead, getLead, recordLeadActivity } from '../../src/services/lead.service.js'
import { isRotting, moveDeal, moveDealTx, moveDealsForRemovalTx, periodKey, weightedMinor } from '../../src/services/deal.service.js'
import { completeTask, deliverTaskReminder, getTask, nextOccurrence, scanOverdueTasks, sendDueReminders, updateTask } from '../../src/services/task.service.js'
import { logActivityTx, sanitizeNote, parseMentions } from '../../src/services/activity.service.js'
import { computeLeadScore } from '../../src/lib/leadScore.js'
import { permissionsFor } from '../../src/config/permissions.js'
import { createTaskSchema, taskBulkSchema, taskListQuery, timelineQuery, updateTaskSchema } from '../../src/validators/activity.validators.js'
import { runMergeSteps } from '../../src/lib/merge.js'
import { isoDateInTz } from '../../src/lib/time.js'

const orgId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const id = '33333333-3333-4333-8333-333333333333'
const otherId = '44444444-4444-4444-8444-444444444444'
const now = new Date('2026-10-19T10:00:00Z')
const ctx = { orgId, userId, role: 'owner', plan: 'business', permissions: permissionsFor('owner'), timezone: 'Asia/Kolkata', country: 'IN' }
const lead = (data = {}) => ({ id, organizationId: orgId, firstName: 'Ravi', displayName: 'Ravi', emails: [], phones: [], ownerId: userId, status: 'new', budgetMinor: null, customFields: {}, createdAt: now, updatedAt: now, lastActivityAt: now, score: 0, ...data })
const task = (data = {}) => ({ id, organizationId: orgId, title: 'Call Ravi', type: 'call', status: 'open', assigneeId: userId, createdById: userId, dueAt: new Date('2026-10-20T10:00:00Z'), reminderOffsetMinutes: 15, remindAt: new Date('2026-10-20T09:45:00Z'), seriesId: null, recurrence: null, createdAt: now, updatedAt: now, ...data })

beforeEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
  for (const model of Object.values(db)) {
    if (!model?.findMany) continue
    model.findMany.mockResolvedValue([])
    model.findFirst.mockResolvedValue(null)
    model.findUnique.mockResolvedValue(null)
    model.count.mockResolvedValue(0)
    model.createMany.mockResolvedValue({ count: 1 })
    model.updateMany.mockResolvedValue({ count: 1 })
    model.create.mockImplementation(async ({ data }) => ({ id, ...data }))
  }
  db.$transaction = vi.fn(async (fn) => fn(db))
  db.$queryRaw = vi.fn().mockResolvedValue([])
  db.$executeRaw = vi.fn().mockResolvedValue(1)
  db.membership.findUnique.mockResolvedValue({ status: 'active', role: 'owner' })
  db.lead.create.mockImplementation(async ({ data }) => lead(data))
  db.lead.update.mockImplementation(async ({ data }) => lead(data))
})

describe('M08 leads', () => {
  it.each([{ firstName: 'Ravi' }, { emails: [{ value: 'ravi@example.test' }] }, { phones: [{ raw: '9876543210' }] }])('creates a lead with optional contact arrays: %j', async (input) => {
    const created = await createLead(ctx, input)
    expect(created.id).toBe(id)
    expect(db.lead.create.mock.calls[0][0].data).toMatchObject({ emails: expect.any(Array), phones: expect.any(Array) })
  })

  it.each(['created', 'merged_into_open', 'linked_contact', 'previous'])('handles capture outcome %s with an omitted phone array', async (outcome) => {
    if (outcome === 'merged_into_open') db.leadEmail.findMany.mockResolvedValueOnce([{ email: 'ravi@example.test', lead: lead() }])
    if (outcome === 'linked_contact') db.contactEmail.findMany.mockResolvedValueOnce([{ email: 'ravi@example.test', contact: { id: otherId, displayName: 'Customer', ownerId: userId } }])
    if (outcome === 'previous') db.leadEmail.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ email: 'ravi@example.test', lead: lead({ status: 'lost' }) }])
    const result = await createLeadFromCapture(ctx, { emails: [{ value: 'ravi@example.test' }] })
    expect(result.outcome).toBe(outcome === 'previous' ? 'created' : outcome)
    if (outcome === 'previous') expect(db.lead.create.mock.calls[0][0].data.previousLeadId).toBe(id)
    if (outcome === 'linked_contact') expect(db.lead.create.mock.calls[0][0].data).toMatchObject({ contactId: otherId, isExistingCustomer: true })
    if (outcome === 'merged_into_open') expect(db.lead.create).not.toHaveBeenCalled()
  })

  it('keeps lastActivityAt monotonic and records the real outbound time for qualified leads', async () => {
    db.lead.findFirst.mockResolvedValue(lead({ status: 'qualified', firstRespondedAt: null, createdAt: new Date('2026-10-01Z') }))
    const at = new Date('2026-10-10T10:00:00Z')
    await recordLeadActivity(ctx, id, { outbound: true, at })
    expect(db.lead.update.mock.calls[0][0].data).toMatchObject({ lastActivityAt: now, firstRespondedAt: at })
  })

  it('rejects conversion from lost without creating customer records', async () => {
    db.lead.findFirst.mockResolvedValue(lead({ status: 'lost' }))
    await expect(convertLead(ctx, id, { contact: { mode: 'create' }, company: { mode: 'none' } })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
    expect(db.contact.create).not.toHaveBeenCalled()
  })

  it('rejects the losing claimant and invalid status transitions', async () => {
    db.lead.findFirst.mockResolvedValue(lead({ ownerId: null }))
    db.lead.updateMany.mockResolvedValue({ count: 0 })
    await expect(claimLead(ctx, id)).rejects.toMatchObject({ code: 'ALREADY_ASSIGNED' })
    expect(db.lead.updateMany.mock.calls[0][0].where).toMatchObject({ ownerId: null, organizationId: orgId })
    db.lead.findFirst.mockResolvedValue(lead({ status: 'lost' }))
    await expect(changeStatus(ctx, id, { status: 'qualified' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
  })

  it('returns 404 for a lead outside the workspace', async () => {
    await expect(getLead(ctx, otherId)).rejects.toMatchObject({ statusCode: 404 })
    expect(db.lead.findFirst.mock.calls[0][0].where.AND[0]).toMatchObject({ organizationId: orgId })
  })

  it.each([
    [{}, {}, 5],
    [{ primaryPhoneE164: '+919876543210', primaryEmail: 'a@b.test', companyName: 'Firm', budgetMinor: 100, status: 'qualified' }, { sourceWeight: 20, lastInboundAt: now, completedTouches14d: 10 }, 100],
    [{ lastActivityAt: new Date(now.getTime() - 14 * 86400000) }, {}, 0],
    [{ lastActivityAt: null, createdAt: now }, {}, 5],
    [{}, { lastInboundAt: new Date(now.getTime() + 86400000) }, 5],
  ])('scores fit, engagement and decay: %j', (fields, signals, score) => {
    expect(computeLeadScore(lead(fields), { now, ...signals }).score).toBe(score)
  })
})

describe('M09 deals', () => {
  it('checks If-Match after locking and loading the current deal', async () => {
    db.deal.findFirst.mockResolvedValue({ id, ownerId: userId, updatedAt: new Date(now.getTime() + 1000) })
    await expect(moveDeal(ctx, id, { stageId: otherId }, { expectedUpdatedAt: now.toISOString() })).rejects.toMatchObject({ code: 'STALE_UPDATE' })
    expect(db.$transaction).toHaveBeenCalled()
    expect(db.$queryRaw).toHaveBeenCalled()
    expect(db.deal.update).not.toHaveBeenCalled()
  })
  it('enforces stage requirements during stage deletion as well as normal moves', async () => {
    const deal = { id, organizationId: orgId, status: 'open', pipelineId: otherId, stageId: id, stage: { name: 'New' }, contacts: [], stageEnteredAt: now, valueMinor: 0n, companyId: null }
    db.deal.findFirst.mockResolvedValue(deal)
    db.pipelineStage.findFirst.mockResolvedValue({ id: otherId, pipelineId: otherId, type: 'open', name: 'Proposal', requiredFields: ['companyId'] })
    await expect(moveDealsForRemovalTx(db, ctx, [id], { open: otherId })).rejects.toMatchObject({ code: 'STAGE_REQUIREMENTS', details: { missing: ['companyId'] } })
    expect(db.deal.update).not.toHaveBeenCalled()
  })
  it('requires a positive won value and a valid lost reason', async () => {
    const deal = { id, status: 'open', pipelineId: otherId, stageId: id, contacts: [], valueMinor: 0n }
    db.pipelineStage.findFirst.mockResolvedValue({ id: otherId, pipelineId: otherId, type: 'won', name: 'Won', requiredFields: [] })
    await expect(moveDealTx(db, ctx, deal, { stageId: otherId })).rejects.toMatchObject({ code: 'STAGE_REQUIREMENTS' })
    db.pipelineStage.findFirst.mockResolvedValue({ id: otherId, pipelineId: otherId, type: 'lost', name: 'Lost', requiredFields: [] })
    await expect(moveDealTx(db, ctx, deal, { stageId: otherId })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('returns 404 for a cross-workspace deal move', async () => {
    await expect(moveDeal(ctx, otherId, { stageId: id })).rejects.toMatchObject({ statusCode: 404 })
  })
  it.each([[1n, 50, 0], [3n, 50, 2], [101n, 50, 50], [Number.MAX_SAFE_INTEGER, 100, Number.MAX_SAFE_INTEGER]])('uses exact half-even forecast rounding', (valueMinor, probability, expected) => {
    expect(weightedMinor({ status: 'open', valueMinor, stage: { probability } })).toBe(expected)
  })
  it('clears rotting after a recent activity and freezes closed deals', () => {
    const stale = { status: 'open', stage: { rottingDays: 7 }, stageEnteredAt: new Date('2026-10-01Z'), lastActivityAt: new Date('2026-10-02Z') }
    expect(isRotting(stale, now)).toBe(true)
    expect(isRotting({ ...stale, lastActivityAt: now }, now)).toBe(false)
    expect(isRotting({ ...stale, status: 'won' }, now)).toBe(false)
  })
  it('uses Indian financial-year quarters across the March boundary', () => {
    expect(periodKey(new Date('2027-03-31Z'), 'quarter', 4)).toEqual({ key: '2026-Q4', label: 'Q4 FY2026-27' })
    expect(periodKey(new Date('2027-04-01Z'), 'quarter', 4)).toEqual({ key: '2027-Q1', label: 'Q1 FY2027-28' })
  })
})

describe('M10 activities and tasks', () => {
  it('rejects cross-workspace activity links before writing anything', async () => {
    db.contact.findFirst.mockResolvedValueOnce({ id, ownerId: userId, displayName: 'Ravi' }).mockResolvedValueOnce(null)
    await expect(logActivityTx(db, ctx, { type: 'note', body: 'Hello', entityType: 'contact', entityId: id, relatedRefs: [{ entityType: 'contact', entityId: otherId }] })).rejects.toMatchObject({ statusCode: 404 })
    expect(db.activity.create).not.toHaveBeenCalled()
  })
  it('rejects mentions of inactive or other-workspace members', async () => {
    db.contact.findFirst.mockResolvedValue({ id, ownerId: userId, displayName: 'Ravi' })
    db.membership.findUnique.mockResolvedValue(null)
    await expect(logActivityTx(db, ctx, { type: 'note', body: `Hello @[Other](${otherId})`, entityType: 'contact', entityId: id })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(db.activity.create).not.toHaveBeenCalled()
  })
  it('merges multiple duplicate contacts sharing history even without a survivor link', async () => {
    db.activityLink.findMany.mockResolvedValue([{ activityId: id, entityId: id }, { activityId: id, entityId: userId }])
    db.dealContact.findMany.mockResolvedValue([{ dealId: id, contactId: id, isPrimary: false }, { dealId: id, contactId: userId, isPrimary: true }])
    await runMergeSteps(db, ctx, 'contact', otherId, [id, userId])
    expect(db.activityLink.deleteMany.mock.calls[0][0].where).toMatchObject({ organizationId: orgId, OR: [{ activityId: id, entityId: userId }] })
    expect(db.dealContact.deleteMany.mock.calls[0][0].where.OR).toEqual([{ dealId: id, contactId: userId }])
    expect(db.dealContact.updateMany).toHaveBeenCalledWith({ where: { organizationId: orgId, dealId: id, contactId: id }, data: { isPrimary: true } })
  })
  it('strips note HTML and deduplicates mention ids', () => {
    expect(sanitizeNote('<b>Hello</b> **Ravi**')).toBe('Hello **Ravi**')
    expect(parseMentions(`@[Ravi](${id}) @[Ravi](${id})`)).toEqual([id])
  })
  it('does not log an activity after losing a concurrent task completion', async () => {
    db.task.findFirst.mockResolvedValue(task({ entityType: 'contact', entityId: otherId }))
    db.task.updateMany.mockResolvedValue({ count: 0 })
    await expect(completeTask(ctx, id, { logActivity: { notes: 'Done' } })).rejects.toMatchObject({ code: 'STALE_UPDATE' })
    expect(db.activity.create).not.toHaveBeenCalled()
  })
  it('does not allow clearing the due date while recurrence is enabled', async () => {
    db.task.findFirst.mockResolvedValue(task({ recurrence: { freq: 'daily' } }))
    await expect(updateTask(ctx, id, { dueAt: null })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(db.task.update).not.toHaveBeenCalled()
  })
  it('revalidates the existing assignee when linking a different record', async () => {
    db.task.findFirst.mockResolvedValue(task())
    db.contact.findFirst.mockResolvedValue({ id: otherId, ownerId: otherId, displayName: 'Other' })
    db.membership.findUnique.mockResolvedValue({ role: 'sales_rep', status: 'active' })
    await expect(updateTask(ctx, id, { entityType: 'contact', entityId: otherId })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
  it('returns 404 for a task outside the workspace', async () => {
    await expect(getTask(ctx, otherId)).rejects.toMatchObject({ statusCode: 404 })
  })
  it('durably emits a pending reminder even after more than a day of worker downtime', async () => {
    vi.useFakeTimers(); vi.setSystemTime('2026-10-22T10:00:00Z')
    db.task.findMany.mockResolvedValue([task()])
    expect(await sendDueReminders(new Date())).toEqual({ due: 1, sent: 1 })
    expect(db.task.findMany.mock.calls[0][0].where.remindAt).toEqual({ lte: new Date() })
    expect(db.domainEvent.create.mock.calls[0][0].data.type).toBe('task.reminder_due')
    expect(mail).not.toHaveBeenCalled()
  })
  it('skips reminders cancelled or rescheduled between scan and claim', async () => {
    db.task.findMany.mockResolvedValue([task()]); db.task.updateMany.mockResolvedValue({ count: 0 })
    expect(await sendDueReminders(now)).toEqual({ due: 1, sent: 0 })
    expect(db.domainEvent.create).not.toHaveBeenCalled()
  })
  it('lets email failures reach the outbox dispatcher for retry', async () => {
    db.task.findFirst.mockResolvedValue(task({ organization: { timezone: 'Asia/Kolkata' } }))
    db.user.findUnique.mockResolvedValue({ email: 'ravi@example.test', fullName: 'Ravi' })
    mail.mockRejectedValue(new Error('SMTP unavailable'))
    await expect(deliverTaskReminder({ entityId: id, organizationId: orgId, payload: { assigneeId: userId, dueAt: task().dueAt.toISOString(), remindAt: task().remindAt.toISOString() } })).rejects.toThrow('SMTP unavailable')
  })
  it('skips overdue events if a task was rescheduled since the scan', async () => {
    db.task.findMany.mockResolvedValue([task()]); db.task.updateMany.mockResolvedValue({ count: 0 })
    expect(await scanOverdueTasks(now)).toEqual({ overdue: 1, emitted: 0 })
    expect(db.task.updateMany.mock.calls[0][0].where).toMatchObject({ status: 'open', dueAt: task().dueAt, organizationId: orgId })
  })
  it('keeps the local recurrence time across DST changes', () => {
    expect(nextOccurrence(new Date('2026-03-07T15:00:00Z'), { freq: 'daily' }, 'America/New_York').toISOString()).toBe('2026-03-08T14:00:00.000Z')
  })
  it('handles monthly day 31, weekly days, count and until limits', () => {
    const jan = new Date('2026-01-31T10:00:00Z')
    const rule = { freq: 'monthly', byMonthDay: 31 }
    const feb = nextOccurrence(jan, rule, 'UTC')
    expect(isoDateInTz(feb, 'UTC')).toBe('2026-02-28')
    expect(isoDateInTz(nextOccurrence(feb, rule, 'UTC'), 'UTC')).toBe('2026-03-31')
    expect(nextOccurrence(now, { freq: 'daily', count: 2 }, 'UTC', { occurrences: 2 })).toBeNull()
    expect(nextOccurrence(now, { freq: 'daily', until: '2026-10-19' }, 'UTC')).toBeNull()
    expect(isoDateInTz(nextOccurrence(now, { freq: 'weekly', interval: 2, byWeekday: [1, 3] }, 'UTC'), 'UTC')).toBe('2026-10-21')
  })
})

describe('M10 input validation', () => {
  it.each([
    { title: 'Test', dueDate: '2026-02-30' },
    { title: 'Test', recurrence: { freq: 'daily' } },
    { title: 'Test', dueAt: now.toISOString(), dueDate: '2026-10-19' },
    { title: 'Test', entityType: 'contact' },
  ])('rejects invalid task create input %j', (input) => expect(createTaskSchema.safeParse(input).success).toBe(false))
  it('rejects ambiguous task updates, malformed filters and incomplete bulk actions', () => {
    expect(updateTaskSchema.safeParse({ dueAt: now.toISOString(), dueDate: '2026-10-19' }).success).toBe(false)
    expect(taskListQuery.safeParse({ assigneeId: 'not-a-uuid' }).success).toBe(false)
    expect(taskListQuery.safeParse({ entityType: 'contact' }).success).toBe(false)
    expect(timelineQuery.safeParse({ entityType: 'contact', entityId: id, types: 'unknown' }).success).toBe(false)
    expect(taskBulkSchema.safeParse({ ids: [id], action: 'reassign' }).success).toBe(false)
    expect(taskBulkSchema.safeParse({ ids: [id], action: 'reschedule' }).success).toBe(false)
  })
})
