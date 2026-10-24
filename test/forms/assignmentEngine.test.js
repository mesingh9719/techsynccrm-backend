import { describe, expect, it } from 'vitest'
import { decideAssignment, isWithinHours, leadFacts, matchRule, matchesCondition, pickMember } from '../../src/services/assignmentEngine.js'
import { assignmentRuleSchema, outOfOfficeSchema, workingHoursSchema } from '../../src/validators/assignment.validators.js'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  F = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const rule = (patch = {}) => ({ id: 'r1', name: 'Bengaluru', position: 0, isActive: true, conditions: [], strategy: 'round_robin', memberIds: [A, B, C], outsideHours: 'assign_anyway', onlyWorkingHours: true, dailyCap: null, lastAssignedIndex: -1, ...patch })
const hours = { timezone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5, 6], startTime: '10:00', endTime: '19:00', fallbackOwnerId: F }
// Friday 23 Oct 2026: 12:00 IST is 06:30 UTC; 21:00 IST is 15:30 UTC.
const OPEN = new Date('2026-10-23T06:30:00Z'),
  CLOSED = new Date('2026-10-23T15:30:00Z'),
  SUNDAY = new Date('2026-10-25T06:30:00Z')
const all = (rule) => new Set(rule.memberIds)

describe('conditions', () => {
  const facts = leadFacts({ sourceId: 's1', city: 'Bengaluru', stateCode: '29', pincode: '560001', budgetMinor: 5000000n, customFields: { industry: 'Retail', services: ['seo', 'ads'] } }, { formId: 'f1', createdVia: 'web_form', tagIds: ['t1'] })

  it('compares text without case, numbers numerically and lists by any item', () => {
    expect(matchesCondition({ field: 'city', operator: 'equals', value: 'bengaluru' }, facts)).toBe(true)
    expect(matchesCondition({ field: 'pincode', operator: 'starts_with', value: '560' }, facts)).toBe(true)
    expect(matchesCondition({ field: 'cf.industry', operator: 'contains', value: 'tai' }, facts)).toBe(true)
    expect(matchesCondition({ field: 'budgetMinor', operator: 'gte', value: '1000000' }, facts)).toBe(true)
    expect(matchesCondition({ field: 'budgetMinor', operator: 'lte', value: '1000000' }, facts)).toBe(false)
    expect(matchesCondition({ field: 'cf.services', operator: 'equals', value: 'ADS' }, facts)).toBe(true)
    expect(matchesCondition({ field: 'tag', operator: 'equals', value: 't1' }, facts)).toBe(true)
    expect(matchesCondition({ field: 'formId', operator: 'equals', value: 'f1' }, facts)).toBe(true)
    expect(matchesCondition({ field: 'cf.missing', operator: 'gte', value: '1' }, facts)).toBe(false)
  })

  it('uses the first active rule with members whose conditions all match', () => {
    const rules = [
      rule({ id: 'off', position: 0, isActive: false }),
      rule({ id: 'empty', position: 1, memberIds: [] }),
      rule({ id: 'mumbai', position: 2, conditions: [{ field: 'city', operator: 'equals', value: 'Mumbai' }] }),
      rule({ id: 'blr', position: 3, conditions: [{ field: 'city', operator: 'equals', value: 'Bengaluru' }, { field: 'createdVia', operator: 'equals', value: 'web_form' }] }),
      rule({ id: 'all', position: 4 }),
    ]
    expect(matchRule(rules, facts).id).toBe('blr')
    expect(matchRule(rules, { ...facts, city: 'Pune' }).id).toBe('all')
  })
})

describe('working hours', () => {
  it('follows the workspace time zone and working days', () => {
    expect(isWithinHours(hours, OPEN)).toBe(true)
    expect(isWithinHours(hours, CLOSED)).toBe(false)
    expect(isWithinHours(hours, SUNDAY)).toBe(false)
    expect(isWithinHours({ ...hours, timezone: 'UTC' }, CLOSED)).toBe(true)
    expect(isWithinHours(null, CLOSED)).toBe(true)
  })

  it('handles overnight shifts as part of the day they start', () => {
    const night = { ...hours, days: [5], startTime: '22:00', endTime: '06:00' }
    expect(isWithinHours(night, new Date('2026-10-23T17:00:00Z'))).toBe(true) // Fri 22:30 IST
    expect(isWithinHours(night, new Date('2026-10-23T22:00:00Z'))).toBe(true) // Sat 03:30 IST, Friday's shift
    expect(isWithinHours(night, new Date('2026-10-24T17:00:00Z'))).toBe(false) // Sat 22:30 IST
  })
})

describe('picking a teammate', () => {
  it('rotates round robin and skips anyone unavailable', () => {
    expect(pickMember(rule(), all(rule()))).toEqual({ ownerId: A, index: 0 })
    expect(pickMember(rule({ lastAssignedIndex: 0 }), all(rule()))).toEqual({ ownerId: B, index: 1 })
    expect(pickMember(rule({ lastAssignedIndex: 2 }), all(rule()))).toEqual({ ownerId: A, index: 0 })
    expect(pickMember(rule({ lastAssignedIndex: 0 }), new Set([A, C]))).toEqual({ ownerId: C, index: 2 })
    expect(pickMember(rule({ lastAssignedIndex: 7 }), all(rule()))).toEqual({ ownerId: C, index: 2 })
    expect(pickMember(rule(), new Set())).toBeNull()
  })

  it('balances by open leads, breaking ties by the configured order', () => {
    const r = rule({ strategy: 'load_balanced' })
    expect(pickMember(r, all(r), { [A]: 4, [B]: 1, [C]: 1 }).ownerId).toBe(B)
    expect(pickMember(r, all(r), {}).ownerId).toBe(A)
  })

  it('gives specific-teammate rules to the first available person', () => {
    const r = rule({ strategy: 'specific_user' })
    expect(pickMember(r, new Set([B, C])).ownerId).toBe(B)
  })
})

describe('the decision', () => {
  const base = { rules: [rule()], hours, facts: {}, eligibleFor: all, fallbackEligible: true }

  it('assigns by rule during working hours', () => {
    expect(decideAssignment({ ...base, now: OPEN })).toMatchObject({ ownerId: A, ruleId: 'r1', index: 0, held: false, reason: 'rule' })
  })

  it('applies the outside-hours choice of the rule', () => {
    expect(decideAssignment({ ...base, now: CLOSED })).toMatchObject({ ownerId: A, reason: 'rule' })
    expect(decideAssignment({ ...base, rules: [rule({ outsideHours: 'hold_until_open' })], now: CLOSED })).toMatchObject({ ownerId: null, held: true, ruleId: 'r1', reason: 'held' })
    expect(decideAssignment({ ...base, rules: [rule({ outsideHours: 'fallback' })], now: CLOSED })).toMatchObject({ ownerId: F, index: null, reason: 'outside_hours_fallback' })
    expect(decideAssignment({ ...base, rules: [rule({ outsideHours: 'hold_until_open', onlyWorkingHours: false })], now: CLOSED })).toMatchObject({ ownerId: A, held: false })
  })

  it('falls back when nothing matches or nobody is available, and explains why', () => {
    const none = decideAssignment({ ...base, rules: [], now: OPEN })
    expect(none).toMatchObject({ ownerId: F, ruleId: null, reason: 'fallback' })
    expect(none.explanation).toContain('No active rule matches')
    expect(decideAssignment({ ...base, eligibleFor: () => new Set(), now: OPEN })).toMatchObject({ ownerId: F, ruleId: 'r1', reason: 'no_eligible_member' })
    expect(decideAssignment({ ...base, rules: [], fallbackEligible: false, now: OPEN })).toMatchObject({ ownerId: null, reason: 'unassigned' })
  })
})

describe('validation', () => {
  it('accepts the builder payload and drops client-only fields', () => {
    const r = assignmentRuleSchema.parse({ id: 'x', position: 3, lastAssignedIndex: 9, name: ' Web ', conditions: [{ field: 'cf.industry', operator: 'equals', value: 'Retail' }], strategy: 'round_robin', memberIds: [A], outsideHours: 'fallback', onlyWorkingHours: true, dailyCap: 5 })
    expect(r).toEqual({ name: 'Web', isActive: true, conditions: [{ field: 'cf.industry', operator: 'equals', value: 'Retail' }], strategy: 'round_robin', memberIds: [A], outsideHours: 'fallback', onlyWorkingHours: true, dailyCap: 5 })
  })

  it('explains bad rules, hours and absences in plain language', () => {
    const msg = (schema, value) => schema.safeParse(value).error.issues.map((i) => i.message)
    expect(msg(assignmentRuleSchema, { name: '', strategy: 'round_robin', memberIds: [], conditions: [{ field: 'city', operator: 'equals', value: ' ' }] })).toEqual(
      expect.arrayContaining(['Give this rule a name.', 'Choose at least one active teammate.', 'Complete each condition, or remove it.']),
    )
    expect(msg(workingHoursSchema, { timezone: 'Mars/Base', days: [1], start: '10:00', end: '10:00' })).toEqual(expect.arrayContaining(['Choose a valid time zone', 'Closing time must differ from opening time']))
    expect(workingHoursSchema.parse({ timezone: 'Asia/Kolkata', days: [6, 1, 1], start: '10:00', end: '19:00' })).toMatchObject({ days: [1, 6], fallbackOwnerId: null, slaAutoReassign: false })
    expect(msg(outOfOfficeSchema, { startsAt: '2030-01-02T00:00:00Z', endsAt: '2030-01-01T00:00:00Z' })).toContain('The end must be after the start')
  })
})
