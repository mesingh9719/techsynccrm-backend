import { daysBetweenIsoDates, isoDateInTz, parseIsoDate, weekdayOfIsoDate, zonedTimeToUtc } from '../lib/time.js'
import { demoSlots } from '../validators/public.validators.js'

/**
 * Demo booking calendar rules (pure functions — `now` is passed in so they're easy to test).
 * Demos run Monday–Saturday in fixed IST slots, from today up to `maxDaysAhead` days ahead, and a
 * same-day slot must start at least `minLeadMinutes` from now.
 */

export const DEMO_TZ = 'Asia/Kolkata'
export const DEMO_DURATION_MINUTES = 30
const MIN_LEAD_MINUTES = 120

/** "2:00 PM" → { hour: 14, minute: 0 } */
export function parseSlot(slot) {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(slot)
  if (!m) throw new Error(`Invalid slot "${slot}"`)
  let hour = Number(m[1]) % 12
  if (m[3] === 'PM') hour += 12
  return { hour, minute: Number(m[2]) }
}

/** UTC instant a slot starts on a "YYYY-MM-DD" date (IST). */
export function slotStart(date, slot) {
  const d = parseIsoDate(date)
  return zonedTimeToUtc({ ...d, ...parseSlot(slot) }, DEMO_TZ)
}

/**
 * Checks the date (and the slot, if given) against the booking rules.
 * @returns {Record<string, string>} field errors; empty when the booking is allowed
 */
export function validateDemoTime(date, slot, now, { maxDaysAhead }) {
  if (!parseIsoDate(date)) return { date: 'Choose a valid date' }
  const today = isoDateInTz(now, DEMO_TZ)
  const ahead = daysBetweenIsoDates(today, date)
  if (ahead < 0) return { date: 'Choose a date from today onwards' }
  if (ahead > maxDaysAhead) return { date: `Demos can be booked up to ${maxDaysAhead} days ahead` }
  if (weekdayOfIsoDate(date) === 0) return { date: 'Demos run Monday to Saturday' }
  if (slot && slotStart(date, slot).getTime() - now.getTime() < MIN_LEAD_MINUTES * 60_000) {
    return { slot: 'That time is too soon — please pick a slot at least 2 hours from now' }
  }
  return {}
}

/**
 * Every slot on `date` with whether it can still be booked.
 * @param {Map<number, number>} bookedBySlotStart booking count keyed by slot start time (ms)
 */
export function listSlots(date, now, bookedBySlotStart, { capacity, maxDaysAhead }) {
  const dateError = validateDemoTime(date, null, now, { maxDaysAhead }).date
  return demoSlots.map((label) => {
    const start = slotStart(date, label)
    let reason = null
    if (dateError) reason = 'unavailable'
    else if (start.getTime() - now.getTime() < MIN_LEAD_MINUTES * 60_000) reason = 'too_soon'
    else if ((bookedBySlotStart.get(start.getTime()) ?? 0) >= capacity) reason = 'full'
    return { label, start: start.toISOString(), available: !reason, reason }
  })
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Wed, 21 Oct 2026, 2:00 PM" for emails. Built by hand: ICU's en-IN punctuation differs between Node builds. */
export function formatSlotLabel(date, slot) {
  const { year, month, day } = parseIsoDate(date)
  return `${WEEKDAY_NAMES[weekdayOfIsoDate(date)]}, ${day} ${MONTH_NAMES[month - 1]} ${year}, ${slot}`
}
