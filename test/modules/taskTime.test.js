import { describe, expect, it } from 'vitest'
import { dueLabel, duePresets, fromLocalInput, toDateInput, toLocalInput } from '../../../frontend/src/features/tasks/taskTime.ts'

describe('M10 workspace task dates', () => {
  it('interprets datetime input in the workspace rather than the host time zone', () => {
    expect(fromLocalInput('2026-10-20T10:00', 'Asia/Kolkata').toISOString()).toBe('2026-10-20T04:30:00.000Z')
    expect(toLocalInput(new Date('2026-10-20T04:30:00Z'), 'Asia/Kolkata')).toBe('2026-10-20T10:00')
  })
  it('preserves an all-day date when the browser is on another calendar day', () => {
    expect(toDateInput(new Date('2026-10-20T18:29:59.999Z'), 'Asia/Kolkata')).toBe('2026-10-20')
  })
  it('computes presets and due labels across the workspace midnight boundary', () => {
    const now = new Date('2026-10-19T20:00:00Z') // 20 Oct, 01:30 IST
    expect(duePresets(now, 'Asia/Kolkata').find((p) => p.key === 'today').date.toISOString()).toBe('2026-10-20T12:30:00.000Z')
    expect(duePresets(now, 'Asia/Kolkata').find((p) => p.key === 'tomorrow').date.toISOString()).toBe('2026-10-21T04:30:00.000Z')
    expect(dueLabel('2026-10-20T18:29:59Z', true, now, 'Asia/Kolkata')).toBe('Today')
  })
  it('uses the correct DST offset and rejects a nonexistent local time', () => {
    expect(fromLocalInput('2026-07-01T10:00', 'America/New_York').toISOString()).toBe('2026-07-01T14:00:00.000Z')
    expect(() => fromLocalInput('2026-03-08T02:30', 'America/New_York')).toThrow('does not exist')
  })
})
