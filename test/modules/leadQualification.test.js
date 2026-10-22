import { describe, expect, it } from 'vitest'
import { leadQualificationSchema } from '../../src/validators/leadQualification.validators.js'

describe('lead qualification contract', () => {
  it('allows partial real facts, zero amounts, empty lists and explicit clearing', () => {
    expect(leadQualificationSchema.parse({ priority: 'hot', dealValueMinor: 0, timeline: 'immediate', objections: [] })).toEqual({ priority: 'hot', dealValueMinor: 0, timeline: 'immediate', objections: [] })
    expect(leadQualificationSchema.parse({ priority: null, timeline: null, expectedCloseDate: null, preferences: null, decisionMakers: [] })).toMatchObject({ priority: null, timeline: null })
  })
  it('bounds values and rejects unrecognized or server-owned fields', () => {
    for (const input of [{ priority: 'critical' }, { timeline: 'later' }, { dealValueMinor: -1 }, { dealValueMinor: 1.5 }, { dealValueMinor: Number.MAX_SAFE_INTEGER+1 }, { expectedCloseDate: '2026-02-30' }, { updatedAt: 'client-time' }, { organizationId: 'foreign' }, { preferences: 'a'.repeat(2001) }, { objections: Array(31).fill('Price') }, { decisionMakers: [{ id: 'not-uuid', name: '', role: 'owner' }] }]) expect(leadQualificationSchema.safeParse(input).success).toBe(false)
  })
})
