import { describe, expect, it } from 'vitest'
import {
  daysBetweenIsoDates,
  fiscalYearLabel,
  isoDateInTz,
  parseIsoDate,
  startOfDayInTz,
  tzOffsetMinutes,
  weekdayOfIsoDate,
  zonedTimeToUtc,
} from '../../src/lib/time.js'

describe('time', () => {
  it('converts IST wall-clock time to UTC', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 10, day: 21, hour: 14 }).toISOString()).toBe('2026-10-21T08:30:00.000Z')
    expect(tzOffsetMinutes(new Date('2026-10-21T00:00:00Z'))).toBe(330)
  })

  it('handles zones with DST', () => {
    // 09:00 in New York on 1 Jul (EDT, UTC-4) and 1 Dec (EST, UTC-5)
    expect(zonedTimeToUtc({ year: 2026, month: 7, day: 1, hour: 9 }, 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z')
    expect(zonedTimeToUtc({ year: 2026, month: 12, day: 1, hour: 9 }, 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z')
  })

  it('computes "today" in IST, not UTC', () => {
    const lateEveningUtc = new Date('2026-10-20T20:00:00Z') // 01:30 IST on the 21st
    expect(isoDateInTz(lateEveningUtc)).toBe('2026-10-21')
    expect(startOfDayInTz(lateEveningUtc).toISOString()).toBe('2026-10-20T18:30:00.000Z')
  })

  it('labels Indian financial years', () => {
    expect(fiscalYearLabel(new Date('2027-03-31T18:00:00Z'))).toBe('2026-27') // 23:30 IST 31 Mar
    expect(fiscalYearLabel(new Date('2027-03-31T18:30:00Z'))).toBe('2027-28') // 00:00 IST 1 Apr
    expect(fiscalYearLabel(new Date('2099-06-01T00:00:00Z'))).toBe('2099-00')
  })

  it('parses and compares ISO dates', () => {
    expect(parseIsoDate('2026-02-29')).toBeNull()
    expect(parseIsoDate('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 })
    expect(parseIsoDate('21-10-2026')).toBeNull()
    expect(daysBetweenIsoDates('2026-10-19', '2026-11-18')).toBe(30)
    expect(weekdayOfIsoDate('2026-10-25')).toBe(0) // Sunday
  })
})
