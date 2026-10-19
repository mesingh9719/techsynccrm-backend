/**
 * Time-zone helpers. Everything is stored in UTC; "today", schedules and report periods are
 * computed in a workspace time zone (default Asia/Kolkata). Built on Intl, no dependencies.
 */

export const DEFAULT_TZ = 'Asia/Kolkata'

const formatters = new Map()
function partsFormatter(tz) {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    formatters.set(tz, f)
  }
  return f
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Wall-clock parts of `date` in `tz`: { year, month (1–12), day, hour, minute, second, weekday (0 = Sunday) }. */
export function zonedParts(date, tz = DEFAULT_TZ) {
  const out = {}
  for (const { type, value } of partsFormatter(tz).formatToParts(date)) {
    if (type === 'weekday') out.weekday = WEEKDAYS[value]
    else if (type !== 'literal') out[type] = Number(value)
  }
  return out
}

/** Offset of `tz` from UTC at instant `date`, in minutes (IST → 330). */
export function tzOffsetMinutes(date, tz = DEFAULT_TZ) {
  const p = zonedParts(date, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000)
}

/** The UTC instant for a wall-clock time in `tz`. Month is 1–12. */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, tz = DEFAULT_TZ) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  // Two passes handle zones whose offset differs on either side of the guess (DST edges).
  let result = new Date(guess.getTime() - tzOffsetMinutes(guess, tz) * 60000)
  result = new Date(guess.getTime() - tzOffsetMinutes(result, tz) * 60000)
  return result
}

/** "YYYY-MM-DD" of `date` as seen in `tz`. */
export function isoDateInTz(date, tz = DEFAULT_TZ) {
  const p = zonedParts(date, tz)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** Parses "YYYY-MM-DD" into { year, month, day }, or null if it isn't a real calendar date. */
export function parseIsoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '')
  if (!m) return null
  const [year, month, day] = m.slice(1).map(Number)
  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  return { year, month, day }
}

/** UTC instant of local midnight (start of the day containing `date`) in `tz`. */
export function startOfDayInTz(date, tz = DEFAULT_TZ) {
  const { year, month, day } = zonedParts(date, tz)
  return zonedTimeToUtc({ year, month, day }, tz)
}

/** Whole calendar days from date string `a` to date string `b` ("YYYY-MM-DD"). */
export function daysBetweenIsoDates(a, b) {
  const pa = parseIsoDate(a)
  const pb = parseIsoDate(b)
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86_400_000)
}

/** Day of week (0 = Sunday) of a "YYYY-MM-DD" date — independent of time zone. */
export function weekdayOfIsoDate(value) {
  const p = parseIsoDate(value)
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
}

/**
 * Indian financial-year label for `date`: "2026-27" for 1 Apr 2026 – 31 Mar 2027.
 * `startMonth` is 1–12 (April = 4).
 */
export function fiscalYearLabel(date, tz = DEFAULT_TZ, startMonth = 4) {
  const { year, month } = zonedParts(date, tz)
  const start = month >= startMonth ? year : year - 1
  if (startMonth === 1) return String(start)
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}
