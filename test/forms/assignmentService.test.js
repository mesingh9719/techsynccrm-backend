import { beforeEach, describe, expect, it, vi } from 'vitest'

const { db, emit } = vi.hoisted(() => ({
  db: {
    $queryRaw: vi.fn(),
    assignmentRule: { findMany: vi.fn(), update: vi.fn() },
    workingHours: { findUnique: vi.fn() },
    membership: { findMany: vi.fn(), count: vi.fn() },
    outOfOffice: { findMany: vi.fn() },
    lead: { groupBy: vi.fn(), update: vi.fn() },
  },
  emit: vi.fn(),
}))
vi.mock('../../src/db/prisma.js', () => ({ prisma: db }))
vi.mock('../../src/events/outbox.js', () => ({ emit }))
vi.mock('../../src/lib/audit.js', () => ({ recordAudit: vi.fn() }))
vi.mock('../../src/services/lead.service.js', () => ({ OPEN_STATUSES: ['new', 'contacted', 'qualified'] }))
vi.mock('../../src/services/entitlements.service.js', () => ({ assertFeature: vi.fn() }))

import { assignCapturedLead, testAssignment } from '../../src/services/assignment.service.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  F = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const ctx = { orgId: ORG, userId: null, actorType: 'system' }
const lead = { id: 'lead-1', sourceId: null, city: 'Bengaluru', stateCode: null, pincode: null, budgetMinor: null, customFields: {} }
const OPEN = new Date('2026-10-23T06:30:00Z'),
  CLOSED = new Date('2026-10-23T15:30:00Z')
const rule = (patch = {}) => ({ id: 'r1', name: 'Web', position: 0, isActive: true, conditions: [], strategy: 'round_robin', memberIds: [A, B], outsideHours: 'assign_anyway', onlyWorkingHours: true, dailyCap: null, lastAssignedIndex: 0, ...patch })

beforeEach(() => {
  vi.clearAllMocks()
  db.assignmentRule.findMany.mockResolvedValue([rule()])
  db.workingHours.findUnique.mockResolvedValue({ organizationId: ORG, timezone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5, 6], startTime: '10:00', endTime: '19:00', fallbackOwnerId: F })
  db.membership.findMany.mockResolvedValue([{ userId: A }, { userId: B }, { userId: F }])
  db.outOfOffice.findMany.mockResolvedValue([])
  db.lead.groupBy.mockResolvedValue([])
})

describe('assigning a captured lead', () => {
  it('locks the rules, advances the rotation, sets the owner and notifies them', async () => {
    const result = await assignCapturedLead(db, ctx, lead, { formId: 'form-1', now: OPEN })
    expect(result).toEqual({ ownerId: B, ruleId: 'r1', ruleName: 'Web', held: false, reason: 'rule' })
    expect(db.$queryRaw).toHaveBeenCalledTimes(1)
    expect(db.assignmentRule.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { lastAssignedIndex: 1 } })
    expect(db.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { ownerId: B, assignedAt: OPEN, assignmentRuleId: 'r1', assignmentHeldAt: null } })
    expect(emit).toHaveBeenCalledWith(db, ctx, 'lead.assigned', { entityType: 'lead', entityId: 'lead-1' }, { changes: { ownerId: [null, B] }, meta: { assignment: 'rule', ruleId: 'r1' } })
  })

  it('skips teammates who are out of office', async () => {
    db.outOfOffice.findMany.mockResolvedValue([{ userId: B }])
    expect((await assignCapturedLead(db, ctx, lead, { now: OPEN })).ownerId).toBe(A)
  })

  it('skips teammates at their daily cap', async () => {
    db.assignmentRule.findMany.mockResolvedValue([rule({ dailyCap: 2 })])
    db.lead.groupBy.mockImplementation(async ({ where }) => (where.assignmentRuleId ? [{ ownerId: B, _count: { _all: 2 } }] : []))
    expect((await assignCapturedLead(db, ctx, lead, { now: OPEN })).ownerId).toBe(A)
  })

  it('holds the lead outside working hours when the rule says so', async () => {
    db.assignmentRule.findMany.mockResolvedValue([rule({ outsideHours: 'hold_until_open' })])
    const result = await assignCapturedLead(db, ctx, lead, { now: CLOSED })
    expect(result).toMatchObject({ ownerId: null, held: true })
    expect(db.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { assignmentRuleId: 'r1', assignmentHeldAt: CLOSED } })
    expect(db.assignmentRule.update).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('uses the fallback owner only while they are active and in office', async () => {
    db.assignmentRule.findMany.mockResolvedValue([])
    expect((await assignCapturedLead(db, ctx, lead, { now: OPEN })).ownerId).toBe(F)
    db.outOfOffice.findMany.mockResolvedValue([{ userId: F }])
    const none = await assignCapturedLead(db, ctx, lead, { now: OPEN })
    expect(none).toMatchObject({ ownerId: null, reason: 'unassigned' })
  })
})

describe('testing rules', () => {
  it('never advances the rotation or changes leads', async () => {
    const result = await testAssignment({ orgId: ORG }, { city: 'Bengaluru', tag: 't1, t2' })
    expect(result).toMatchObject({ ruleId: 'r1', ownerId: expect.any(String) })
    expect(db.assignmentRule.update).not.toHaveBeenCalled()
    expect(db.lead.update).not.toHaveBeenCalled()
  })
})
