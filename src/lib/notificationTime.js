import { isoDateInTz, zonedParts, zonedTimeToUtc } from './time.js'

export function dayBounds(now, timezone) {
  const p = zonedParts(now, timezone)
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1))
  return { start: zonedTimeToUtc({ ...p, hour: 0, minute: 0, second: 0 }, timezone), end: zonedTimeToUtc({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }, timezone) }
}

/** End of quiet hours, or now when email is allowed. Supports overnight ranges and DST. */
export function emailAllowedAt(now, quietHours, timezone) {
  if (!quietHours) return now
  const minuteOf = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
  const start = minuteOf(quietHours.start)
  const end = minuteOf(quietHours.end)
  if (start === end) return now
  const p = zonedParts(now, timezone)
  const minute = p.hour * 60 + p.minute
  const overnight = start > end
  const quiet = overnight ? minute >= start || minute < end : minute >= start && minute < end
  if (!quiet) return now
  const tomorrow = overnight && minute >= start ? 1 : 0
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day + tomorrow))
  return zonedTimeToUtc({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: Math.floor(end / 60), minute: end % 60 }, timezone)
}

export function digestDay(now, timezone) {
  const p = zonedParts(now, timezone)
  return p.hour * 60 + p.minute >= 8 * 60 + 30 ? isoDateInTz(now, timezone) : null
}
