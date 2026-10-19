import { describe, expect, it } from 'vitest'
import { formatSlotLabel, listSlots, parseSlot, slotStart, validateDemoTime } from '../../src/services/demoSlots.js'

const rules = { maxDaysAhead: 30 }
// Monday 19 Oct 2026, 10:00 IST
const now = new Date('2026-10-19T04:30:00Z')

describe('demo slots', () => {
  it('parses slot labels', () => {
    expect(parseSlot('10:00 AM')).toEqual({ hour: 10, minute: 0 })
    expect(parseSlot('12:30 PM')).toEqual({ hour: 12, minute: 30 })
    expect(parseSlot('5:00 PM')).toEqual({ hour: 17, minute: 0 })
    expect(slotStart('2026-10-21', '2:00 PM').toISOString()).toBe('2026-10-21T08:30:00.000Z')
  })

  it('accepts a valid weekday booking', () => {
    expect(validateDemoTime('2026-10-21', '2:00 PM', now, rules)).toEqual({})
  })

  it('rejects past dates, Sundays and dates too far ahead', () => {
    expect(validateDemoTime('2026-10-18', '2:00 PM', now, rules)).toHaveProperty('date')
    expect(validateDemoTime('2026-10-25', '2:00 PM', now, rules).date).toMatch(/Monday to Saturday/)
    expect(validateDemoTime('2026-11-18', '2:00 PM', now, rules)).toEqual({}) // exactly 30 days
    expect(validateDemoTime('2026-11-19', '2:00 PM', now, rules).date).toMatch(/30 days/)
  })

  it('requires same-day slots to be at least 2 hours away', () => {
    expect(validateDemoTime('2026-10-19', '11:30 AM', now, rules)).toHaveProperty('slot')
    expect(validateDemoTime('2026-10-19', '2:00 PM', now, rules)).toEqual({})
  })

  it('uses the IST date, not UTC, for "today"', () => {
    const lateNight = new Date('2026-10-19T19:00:00Z') // 00:30 IST Tuesday 20 Oct
    expect(validateDemoTime('2026-10-19', '5:00 PM', lateNight, rules).date).toMatch(/today onwards/)
  })

  it('lists availability with full and too-soon slots', () => {
    const booked = new Map([[slotStart('2026-10-19', '3:30 PM').getTime(), 3]])
    const slots = listSlots('2026-10-19', now, booked, { capacity: 3, ...rules })
    expect(slots.map((s) => [s.label, s.reason])).toEqual([
      ['10:00 AM', 'too_soon'],
      ['11:30 AM', 'too_soon'],
      ['2:00 PM', null],
      ['3:30 PM', 'full'],
      ['5:00 PM', null],
    ])
    expect(listSlots('2026-10-25', now, new Map(), { capacity: 3, ...rules }).every((s) => s.reason === 'unavailable')).toBe(true)
  })

  it('formats a readable label', () => {
    expect(formatSlotLabel('2026-10-21', '2:00 PM')).toBe('Wed, 21 Oct 2026, 2:00 PM')
  })
})
