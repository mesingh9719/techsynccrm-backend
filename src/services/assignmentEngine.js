import { zonedParts } from '../lib/time.js'

/**
 * Lead assignment rules (M14), as pure functions so they're easy to test (`now` is passed in).
 * The service (assignment.service.js) loads rules, working hours and member eligibility, then:
 * 1. the first active rule (by position) whose conditions all match the lead wins;
 * 2. outside working hours a rule may assign anyway, hold the lead until opening, or use the fallback owner;
 * 3. the rule's strategy picks an eligible teammate (active, not out of office, under the daily cap);
 * 4. no matching rule, or nobody eligible → the workspace fallback owner, else the lead stays unassigned.
 */

/** Territory conditions need the `territories` plan feature. */
export const TERRITORY_FIELDS = ['city', 'stateCode', 'pincode']

/** Rule facts for a lead. `formId`/`createdVia` describe how it arrived; `tag` matches any of its tags. */
export function leadFacts(lead, { formId = null, createdVia = null, tagIds = [] } = {}) {
  const facts = {
    sourceId: lead.sourceId ?? '',
    formId: formId ?? '',
    city: lead.city ?? '',
    stateCode: lead.stateCode ?? '',
    pincode: lead.pincode ?? '',
    budgetMinor: lead.budgetMinor === null || lead.budgetMinor === undefined ? '' : String(lead.budgetMinor),
    createdVia: createdVia ?? '',
    tag: tagIds,
  }
  for (const [key, value] of Object.entries(lead.customFields ?? {})) facts[`cf.${key}`] = Array.isArray(value) ? value.map(String) : value === null || value === undefined ? '' : String(value)
  return facts
}

/** Case-insensitive; list facts (tags, multi-select) match when any item matches. gte/lte compare numbers. */
export function matchesCondition({ field, operator, value }, facts) {
  const actual = facts[field]
  if (Array.isArray(actual)) return actual.some((item) => matchesCondition({ field, operator, value }, { [field]: item }))
  const a = String(actual ?? '').trim().toLowerCase(),
    e = String(value ?? '').trim().toLowerCase()
  if (operator === 'contains') return a.includes(e)
  if (operator === 'starts_with') return a.startsWith(e)
  if (operator === 'gte' || operator === 'lte') {
    if (a === '' || !Number.isFinite(Number(a)) || !Number.isFinite(Number(e))) return false
    return operator === 'gte' ? Number(a) >= Number(e) : Number(a) <= Number(e)
  }
  return a === e
}

export function matchRule(rules, facts) {
  return rules
    .filter((r) => r.isActive && r.memberIds.length)
    .toSorted((a, b) => a.position - b.position)
    .find((r) => r.conditions.every((c) => matchesCondition(c, facts))) ?? null
}

const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Whether `now` falls in the workspace's open days and hours (its own time zone). Overnight ranges wrap. */
export function isWithinHours(hours, now) {
  if (!hours) return true
  const p = zonedParts(now, hours.timezone)
  const minute = p.hour * 60 + p.minute,
    start = minutesOf(hours.startTime),
    end = minutesOf(hours.endTime)
  if (start === end) return hours.days.includes(p.weekday)
  if (start < end) return hours.days.includes(p.weekday) && minute >= start && minute < end
  // e.g. 22:00–06:00: the early-morning part belongs to the previous day's shift.
  return minute >= start ? hours.days.includes(p.weekday) : minute < end && hours.days.includes((p.weekday + 6) % 7)
}

/**
 * Picks a teammate from `rule.memberIds` (in their configured order) among `eligible`.
 * `loads` (open leads per member) is needed for load_balanced.
 * @returns {{ ownerId: string, index: number } | null} index = position in memberIds, for round robin
 */
export function pickMember(rule, eligible, loads = {}) {
  const members = rule.memberIds.map((id, index) => ({ id, index })).filter((m) => eligible.has(m.id))
  if (!members.length) return null
  let chosen
  if (rule.strategy === 'round_robin') {
    const n = rule.memberIds.length
    for (let step = 1; step <= n && !chosen; step++) {
      const index = (((rule.lastAssignedIndex + step) % n) + n) % n
      chosen = members.find((m) => m.index === index)
    }
  } else if (rule.strategy === 'load_balanced') {
    chosen = members.reduce((best, m) => ((loads[m.id] ?? 0) < (loads[best.id] ?? 0) ? m : best))
  } else chosen = members[0]
  return { ownerId: chosen.id, index: chosen.index }
}

/**
 * The whole decision. `eligibleFor(rule)` → Set of eligible member ids for that rule;
 * `fallbackEligible` → whether the fallback owner can take leads right now.
 * @returns {{ ownerId: string|null, ruleId: string|null, ruleName: string|null, index: number|null, held: boolean, reason: string, explanation: string }}
 */
export function decideAssignment({ rules, hours, facts, now, eligibleFor, loads = {}, fallbackEligible = false }) {
  const fallbackOwnerId = fallbackEligible ? (hours?.fallbackOwnerId ?? null) : null
  const fallback = (rule, reason, why) => ({
    ownerId: fallbackOwnerId,
    ruleId: rule?.id ?? null,
    ruleName: rule?.name ?? null,
    index: null,
    held: false,
    reason: fallbackOwnerId ? reason : 'unassigned',
    explanation: `${why} ${fallbackOwnerId ? 'The fallback owner gets the lead.' : 'No fallback owner is available, so the lead stays unassigned.'}`,
  })
  const rule = matchRule(rules, facts)
  if (!rule) return fallback(null, 'fallback', 'No active rule matches.')
  const open = isWithinHours(hours, now)
  if (rule.onlyWorkingHours && !open) {
    if (rule.outsideHours === 'hold_until_open')
      return { ownerId: null, ruleId: rule.id, ruleName: rule.name, index: null, held: true, reason: 'held', explanation: `“${rule.name}” matches, but it’s outside working hours. The lead is held and assigned when the team is next open.` }
    if (rule.outsideHours === 'fallback') return fallback(rule, 'outside_hours_fallback', `“${rule.name}” matches, but it’s outside working hours.`)
  }
  const picked = pickMember(rule, eligibleFor(rule), loads)
  if (!picked) return fallback(rule, 'no_eligible_member', `“${rule.name}” matches, but every teammate in it is inactive, out of office or at their daily cap.`)
  const how = { round_robin: 'next in the rotation', load_balanced: 'the teammate with the fewest open leads', specific_user: 'the first available teammate' }[rule.strategy]
  return { ownerId: picked.ownerId, ruleId: rule.id, ruleName: rule.name, index: picked.index, held: false, reason: 'rule', explanation: `“${rule.name}” matches. The lead goes to ${how}${!open && rule.onlyWorkingHours ? ', even though it’s outside working hours' : ''}.` }
}
