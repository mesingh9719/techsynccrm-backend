import { prisma } from '../db/prisma.js'
import { emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { logger } from '../lib/logger.js'
import { validationError } from '../lib/records.js'
import { startOfDayInTz } from '../lib/time.js'
import { ApiError } from '../utils/ApiError.js'
import { TERRITORY_FIELDS, decideAssignment, isWithinHours, leadFacts } from './assignmentEngine.js'
import { assertFeature } from './entitlements.service.js'
import { OPEN_STATUSES } from './lead.service.js'

/** Assignment rules, working hours and out-of-office (M14), and assigning captured leads with them. */

const log = logger.child({ component: 'assignment' })
const RULE = 'assignment_rule'
const ruleSelect = { id: true, name: true, position: true, isActive: true, conditions: true, strategy: true, memberIds: true, outsideHours: true, onlyWorkingHours: true, dailyCap: true, lastAssignedIndex: true }
const LOAD_WINDOW_MS = 7 * 86_400_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_HOURS = { timezone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5, 6], startTime: '10:00', endTime: '19:00', fallbackOwnerId: null, firstResponseSlaMinutes: 30, slaAutoReassign: false }

const presentHours = (h) => ({
  timezone: h.timezone,
  days: h.days,
  start: h.startTime,
  end: h.endTime,
  fallbackOwnerId: h.fallbackOwnerId,
  firstResponseSlaMinutes: h.firstResponseSlaMinutes,
  slaAutoReassign: h.slaAutoReassign,
})

async function loadHours(orgId, db = prisma) {
  return (await db.workingHours.findUnique({ where: { organizationId: orgId } })) ?? { ...DEFAULT_HOURS, organizationId: orgId }
}

async function assertActiveMembers(ctx, ids, field, db = prisma) {
  if (!ids.length) return
  const active = await db.membership.count({ where: { organizationId: ctx.orgId, userId: { in: ids }, status: 'active' } })
  if (active !== new Set(ids).size) throw validationError({ [field]: 'Choose active teammates of this workspace' })
}

function assertConditionsAllowed(ctx, conditions) {
  if (conditions.some((c) => TERRITORY_FIELDS.includes(c.field))) assertFeature(ctx, 'territories')
}

/** A rule keeps a source that was disabled after it was chosen (`previous`); a newly chosen source must be enabled. */
export async function assertActiveSources(ctx, conditions, previous = [], db = prisma) {
  const sourceValues = (list) => (Array.isArray(list) ? list : []).filter((c) => c.field === 'sourceId').map((c) => c.value)
  const kept = new Set(sourceValues(previous))
  const ids = [...new Set(sourceValues(conditions).filter((v) => !kept.has(v)))]
  if (!ids.length) return
  // A non-uuid value would make Postgres reject the query, so it simply counts as not found.
  const active = ids.every((v) => UUID.test(v)) ? await db.leadSource.count({ where: { organizationId: ctx.orgId, id: { in: ids }, archivedAt: null } }) : 0
  if (active !== ids.length) throw validationError({ conditions: 'Choose an enabled lead source' })
}

// ---------- Rules ----------

export async function listRules(ctx) {
  return prisma.assignmentRule.findMany({ where: { organizationId: ctx.orgId }, select: ruleSelect, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] })
}

export async function createRule(ctx, input) {
  assertConditionsAllowed(ctx, input.conditions)
  await assertActiveSources(ctx, input.conditions)
  await assertActiveMembers(ctx, input.memberIds, 'memberIds')
  return prisma.$transaction(async (tx) => {
    const last = await tx.assignmentRule.aggregate({ where: { organizationId: ctx.orgId }, _max: { position: true } })
    const rule = await tx.assignmentRule.create({ data: { ...input, organizationId: ctx.orgId, position: (last._max.position ?? -1) + 1 }, select: ruleSelect })
    await recordAudit(tx, ctx, { action: 'assignment_rule.created', entityType: RULE, entityId: rule.id, changes: { name: [null, rule.name] } })
    return rule
  })
}

export async function updateRule(ctx, id, input) {
  const before = await prisma.assignmentRule.findFirst({ where: { id, organizationId: ctx.orgId }, select: ruleSelect })
  if (!before) throw ApiError.notFound('Rule not found')
  assertConditionsAllowed(ctx, input.conditions)
  await assertActiveSources(ctx, input.conditions, before.conditions)
  await assertActiveMembers(ctx, input.memberIds, 'memberIds')
  // A changed team restarts the rotation so the index never points at the wrong person.
  const restart = before.memberIds.join() !== input.memberIds.join() ? { lastAssignedIndex: -1 } : {}
  return prisma.$transaction(async (tx) => {
    const rule = await tx.assignmentRule.update({ where: { id }, data: { ...input, ...restart }, select: ruleSelect })
    await recordAudit(tx, ctx, { action: 'assignment_rule.updated', entityType: RULE, entityId: id, changes: { name: [before.name, rule.name], isActive: [before.isActive, rule.isActive] } })
    return rule
  })
}

export async function deleteRule(ctx, id) {
  const before = await prisma.assignmentRule.findFirst({ where: { id, organizationId: ctx.orgId }, select: { id: true, name: true } })
  if (!before) throw ApiError.notFound('Rule not found')
  await prisma.$transaction(async (tx) => {
    await tx.assignmentRule.delete({ where: { id } })
    await recordAudit(tx, ctx, { action: 'assignment_rule.deleted', entityType: RULE, entityId: id, changes: { name: [before.name, null] } })
  })
}

/** `ids` must list every rule of the workspace, in the new order. */
export async function orderRules(ctx, ids) {
  const existing = await prisma.assignmentRule.findMany({ where: { organizationId: ctx.orgId }, select: { id: true } })
  if (existing.length !== ids.length || existing.some((r) => !ids.includes(r.id))) throw ApiError.conflict('Rules changed since you loaded them. Reload and try again.')
  await prisma.$transaction(ids.map((id, position) => prisma.assignmentRule.update({ where: { id }, data: { position } })))
  return listRules(ctx)
}

// ---------- Working hours ----------

export async function getHours(ctx) {
  return presentHours(await loadHours(ctx.orgId))
}

export async function saveHours(ctx, input) {
  if (input.fallbackOwnerId) await assertActiveMembers(ctx, [input.fallbackOwnerId], 'fallbackOwnerId')
  const data = {
    timezone: input.timezone,
    days: input.days,
    startTime: input.start,
    endTime: input.end,
    fallbackOwnerId: input.fallbackOwnerId,
    firstResponseSlaMinutes: input.firstResponseSlaMinutes,
    slaAutoReassign: input.slaAutoReassign,
  }
  const row = await prisma.$transaction(async (tx) => {
    const saved = await tx.workingHours.upsert({ where: { organizationId: ctx.orgId }, create: { ...data, organizationId: ctx.orgId }, update: data })
    await recordAudit(tx, ctx, { action: 'working_hours.updated', entityType: 'working_hours', entityId: ctx.orgId, changes: { hours: `${data.startTime}–${data.endTime}`, days: data.days.join(',') } })
    return saved
  })
  return presentHours(row)
}

// ---------- Out of office (each member manages their own) ----------

const absenceSelect = { id: true, startsAt: true, endsAt: true, note: true }

export async function listAbsences(ctx) {
  return prisma.outOfOffice.findMany({ where: { organizationId: ctx.orgId, userId: ctx.userId, endsAt: { gt: new Date() } }, select: absenceSelect, orderBy: { startsAt: 'asc' } })
}

export async function addAbsence(ctx, { startsAt, endsAt, note }) {
  return prisma.outOfOffice.create({ data: { organizationId: ctx.orgId, userId: ctx.userId, startsAt: new Date(startsAt), endsAt: new Date(endsAt), note }, select: absenceSelect })
}

export async function deleteAbsence(ctx, id) {
  const { count } = await prisma.outOfOffice.deleteMany({ where: { id, organizationId: ctx.orgId, userId: ctx.userId } })
  if (!count) throw ApiError.notFound('Out-of-office period not found')
}

// ---------- Deciding ----------

/** Everything the engine needs for one decision, read in one go. */
async function loadDecisionInputs(db, orgId, now) {
  const [rules, hours] = await Promise.all([
    db.assignmentRule.findMany({ where: { organizationId: orgId, isActive: true }, select: ruleSelect, orderBy: { position: 'asc' } }),
    loadHours(orgId, db),
  ])
  const candidates = [...new Set([...rules.flatMap((r) => r.memberIds), ...(hours.fallbackOwnerId ? [hours.fallbackOwnerId] : [])])]
  const [active, away, loads] = candidates.length
    ? await Promise.all([
        db.membership.findMany({ where: { organizationId: orgId, userId: { in: candidates }, status: 'active' }, select: { userId: true } }),
        db.outOfOffice.findMany({ where: { organizationId: orgId, userId: { in: candidates }, startsAt: { lte: now }, endsAt: { gt: now } }, select: { userId: true } }),
        db.lead.groupBy({ by: ['ownerId'], where: { organizationId: orgId, ownerId: { in: candidates }, deletedAt: null, status: { in: OPEN_STATUSES }, assignedAt: { gte: new Date(now.getTime() - LOAD_WINDOW_MS) } }, _count: { _all: true } }),
      ])
    : [[], [], []]
  const awayIds = new Set(away.map((a) => a.userId))
  const available = new Set(active.map((m) => m.userId).filter((id) => !awayIds.has(id)))
  return { rules, hours, available, loads: Object.fromEntries(loads.map((l) => [l.ownerId, l._count._all])) }
}

/** Members of `rule` who are available and, when the rule has a daily cap, under it today (workspace time zone). */
async function eligibilityFor(db, orgId, inputs, now) {
  const capped = new Map()
  for (const rule of inputs.rules.filter((r) => r.dailyCap)) {
    const counts = await db.lead.groupBy({ by: ['ownerId'], where: { organizationId: orgId, assignmentRuleId: rule.id, ownerId: { in: rule.memberIds }, assignedAt: { gte: startOfDayInTz(now, inputs.hours.timezone) } }, _count: { _all: true } })
    capped.set(rule.id, new Set(counts.filter((c) => c._count._all >= rule.dailyCap).map((c) => c.ownerId)))
  }
  return (rule) => new Set(rule.memberIds.filter((id) => inputs.available.has(id) && !capped.get(rule.id)?.has(id)))
}

async function decide(db, orgId, facts, now) {
  const inputs = await loadDecisionInputs(db, orgId, now)
  const eligibleFor = await eligibilityFor(db, orgId, inputs, now)
  return decideAssignment({ rules: inputs.rules, hours: inputs.hours, facts, now, eligibleFor, loads: inputs.loads, fallbackEligible: Boolean(inputs.hours.fallbackOwnerId && inputs.available.has(inputs.hours.fallbackOwnerId)) })
}

/** Dry run from the "Test" tab: nothing is saved and the rotation doesn't move. */
export async function testAssignment(ctx, sample) {
  const facts = { ...sample, tag: sample.tag ? sample.tag.split(',').map((t) => t.trim()) : [] }
  const result = await decide(prisma, ctx.orgId, facts, new Date())
  return { ruleId: result.ruleId, ruleName: result.ruleName, ownerId: result.ownerId, explanation: result.explanation }
}

/**
 * Assigns a newly captured, unowned lead inside the capture transaction. Locks the workspace's
 * rules so concurrent submissions advance a round-robin rotation one step each.
 * @returns {Promise<{ ownerId: string|null, ruleId: string|null, ruleName: string|null, held: boolean, reason: string }>}
 */
export async function assignCapturedLead(tx, ctx, lead, { formId = null, createdVia = 'web_form', now = new Date() } = {}) {
  await tx.$queryRaw`SELECT id FROM assignment_rules WHERE organization_id = ${ctx.orgId}::uuid ORDER BY id FOR UPDATE`
  const result = await decide(tx, ctx.orgId, leadFacts(lead, { formId, createdVia }), now)
  if (result.index !== null) await tx.assignmentRule.update({ where: { id: result.ruleId }, data: { lastAssignedIndex: result.index } })
  if (result.held) {
    await tx.lead.update({ where: { id: lead.id }, data: { assignmentRuleId: result.ruleId, assignmentHeldAt: now } })
  } else if (result.ownerId) {
    await tx.lead.update({ where: { id: lead.id }, data: { ownerId: result.ownerId, assignedAt: now, assignmentRuleId: result.ruleId, assignmentHeldAt: null } })
    await emit(tx, ctx, 'lead.assigned', { entityType: 'lead', entityId: lead.id }, { changes: { ownerId: [null, result.ownerId] }, meta: { assignment: result.reason, ruleId: result.ruleId } })
  }
  return { ownerId: result.ownerId, ruleId: result.ruleId, ruleName: result.ruleName, held: result.held, reason: result.reason }
}

/**
 * Worker: assigns leads held outside working hours once their workspace is open again. A lead that
 * found an owner some other way (manual assignment) is simply released.
 */
export async function releaseHeldLeads(now = new Date()) {
  const held = await prisma.lead.findMany({ where: { assignmentHeldAt: { not: null }, deletedAt: null }, select: { organizationId: true }, distinct: ['organizationId'], take: 200 })
  let assigned = 0
  for (const { organizationId } of held) {
    const hours = await loadHours(organizationId)
    if (!isWithinHours(hours, now)) continue
    const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { country: true, currency: true, plan: true } })
    const ctx = { orgId: organizationId, userId: null, actorType: 'system', ...org, permissions: [] }
    const leads = await prisma.lead.findMany({ where: { organizationId, assignmentHeldAt: { not: null }, deletedAt: null }, select: { id: true, ownerId: true, sourceId: true, city: true, stateCode: true, pincode: true, budgetMinor: true, customFields: true, webFormId: true }, orderBy: { assignmentHeldAt: 'asc' }, take: 100 })
    for (const lead of leads) {
      try {
        await prisma.$transaction(async (tx) => {
          const [live] = await tx.$queryRaw`SELECT owner_id, assignment_held_at FROM leads WHERE id = ${lead.id}::uuid FOR UPDATE`
          if (!live?.assignment_held_at) return
          await tx.lead.update({ where: { id: lead.id }, data: { assignmentHeldAt: null } })
          if (live.owner_id) return
          // Re-run the rules now that the team is open (the hold rule may have changed meanwhile).
          const result = await assignCapturedLead(tx, ctx, lead, { formId: lead.webFormId, now })
          if (result.ownerId) assigned++
        })
      } catch (err) {
        log.error({ err, leadId: lead.id }, 'releasing a held lead failed')
      }
    }
  }
  return { assigned }
}
