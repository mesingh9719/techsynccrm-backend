import { planDefinition, planHasFeature, planName, planWithLimitAbove, requiredPlanFor } from '../config/plans.js'
import { prisma } from '../db/prisma.js'
import { daysBetweenIsoDates, isoDateInTz } from '../lib/time.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * Plan limits and features (M06). Limits come from config/plans.js and are always enforced by
 * counting live rows — `organization_usage` is only a display cache.
 */

const GB = 1024 ** 3

/**
 * How each limited resource is counted for a workspace. Modules that add the counted tables
 * replace their placeholder here: webForms (M14), workflowRules (M18).
 *
 * @type {Record<string, (db: any, orgId: string, opts?: { entityType?: string }) => Promise<number>>}
 */
const COUNTERS = {
  /** Seats: active members plus pending invitations (an invitation holds a seat until it's used). */
  users: async (db, orgId) => {
    const [members, invitations] = await Promise.all([
      db.membership.count({ where: { organizationId: orgId, status: 'active' } }),
      db.invitation.count({ where: { organizationId: orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ])
    return members + invitations
  },
  /** Leads and contacts (decision D1). Converted leads stop counting — their contact does instead. */
  records: async (db, orgId) => {
    const [contacts, leads] = await Promise.all([
      db.contact.count({ where: { organizationId: orgId, deletedAt: null } }),
      db.lead.count({ where: { organizationId: orgId, deletedAt: null, status: { not: 'converted' } } }),
    ])
    return contacts + leads
  },
  /** Live (not archived) pipelines (M09). */
  pipelines: async (db, orgId) => db.pipeline.count({ where: { organizationId: orgId, archivedAt: null } }),
  /** Per entity type; archived definitions still count (M07). */
  customFields: async (db, orgId, { entityType } = {}) => db.customFieldDefinition.count({ where: { organizationId: orgId, ...(entityType && { entityType }) } }),
  webForms: async () => 0,
  workflowRules: async () => 0,
  /** Bytes stored in Object Storage by this workspace. */
  storage: async (db, orgId) => {
    const { _sum } = await db.file.aggregate({ where: { organizationId: orgId }, _sum: { sizeBytes: true } })
    return Number(_sum.sizeBytes ?? 0)
  },
}

const RESOURCE_LABELS = {
  users: 'users',
  records: 'leads and contacts',
  pipelines: 'pipelines',
  customFields: 'custom fields',
  webForms: 'web forms',
  workflowRules: 'workflow rules',
  storage: 'storage',
}

/** Limit for a resource on a plan, in the unit its counter returns (storage → bytes). */
function limitOf(plan, resource) {
  const limits = planDefinition(plan).limits
  return resource === 'storage' ? limits.storageGb * GB : limits[resource]
}

/** Live count of `resource` in a workspace. */
export async function countUsage(orgId, resource, db = prisma, opts = {}) {
  const counter = COUNTERS[resource]
  if (!counter) throw new Error(`Unknown plan resource "${resource}"`)
  return counter(db, orgId, opts)
}

/**
 * Throws 403 PLAN_LIMIT_REACHED when adding `delta` of `resource` would exceed the plan.
 *
 * Call it inside the same transaction as the insert and pass `tx`: it locks the workspace row
 * (`FOR UPDATE`), so concurrent creates in one workspace queue up behind each other and can't
 * overshoot. The plan is read from the locked row, not from `ctx`, so a downgrade that just
 * happened applies immediately.
 *
 * @param {{ orgId: string }} ctx req.ctx
 * @param {'users' | 'records' | 'pipelines' | 'customFields' | 'webForms' | 'workflowRules' | 'storage'} resource
 * @param {number} [delta] how many are being added (bytes for storage)
 * @param {object} [tx] Prisma transaction client
 * @param {{ entityType?: string }} [opts] customFields are limited per entity type
 */
export async function assertWithinLimit(ctx, resource, delta = 1, tx, opts = {}) {
  const db = tx ?? prisma
  const [org] = tx
    ? await tx.$queryRaw`SELECT plan::text AS plan FROM organizations WHERE id = ${ctx.orgId}::uuid FOR UPDATE`
    : await prisma.$queryRaw`SELECT plan::text AS plan FROM organizations WHERE id = ${ctx.orgId}::uuid`
  if (!org) throw ApiError.notFound('Workspace not found')

  const limit = limitOf(org.plan, resource)
  if (!Number.isFinite(limit)) return
  const used = await countUsage(ctx.orgId, resource, db, opts)
  if (used + delta <= limit) return

  const limitKey = resource === 'storage' ? 'storageGb' : resource
  const requiredPlan = planWithLimitAbove(limitKey, resource === 'storage' ? Math.ceil((used + delta) / GB) - 1 : used + delta - 1)
  const label = RESOURCE_LABELS[resource]
  const shown = resource === 'storage' ? `${planDefinition(org.plan).limits.storageGb} GB of ${label}` : `${limit.toLocaleString('en-IN')} ${label}`
  throw new ApiError(403, `Your ${planName(org.plan)} plan includes ${shown}. Upgrade to add more.`, {
    code: 'PLAN_LIMIT_REACHED',
    details: { resource, limit, used, requiredPlan, ...(opts.entityType && { entityType: opts.entityType }) },
  })
}

function featureError(plan, feature) {
  const requiredPlan = requiredPlanFor(feature)
  return new ApiError(403, `This feature isn’t included in your ${planName(plan)} plan${requiredPlan ? ` — it’s available on ${planName(requiredPlan)} and above` : ''}.`, {
    code: 'FEATURE_NOT_IN_PLAN',
    details: { feature, requiredPlan },
  })
}

/** Throws 403 FEATURE_NOT_IN_PLAN when the workspace's plan lacks `feature`. */
export function assertFeature(ctx, feature) {
  if (!planHasFeature(ctx.plan, feature)) throw featureError(ctx.plan, feature)
}

export function hasFeature(ctx, feature) {
  return planHasFeature(ctx.plan, feature)
}

/** Whole days left in the trial as seen in the workspace's time zone (0 on the last day), or null. */
export function trialDaysLeft(trialEndsAt, timezone, now = new Date()) {
  if (!trialEndsAt || trialEndsAt <= now) return null
  return Math.max(0, daysBetweenIsoDates(isoDateInTz(now, timezone), isoDateInTz(trialEndsAt, timezone)))
}

// ---------- Usage cache (display only) ----------

/** Recounts a workspace and stores the result in organization_usage. */
export async function refreshUsage(orgId) {
  const [users, records, pipelines, storage] = await Promise.all([
    countUsage(orgId, 'users'),
    countUsage(orgId, 'records'),
    countUsage(orgId, 'pipelines'),
    countUsage(orgId, 'storage'),
  ])
  const data = { users, records, pipelines, storageBytes: BigInt(storage) }
  return prisma.organizationUsage.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId, ...data }, update: data })
}

/** Usage for Settings → Plan, from the cache (filled on first read). */
export async function getUsage(orgId) {
  const row = (await prisma.organizationUsage.findUnique({ where: { organizationId: orgId } })) ?? (await refreshUsage(orgId))
  return { users: row.users, records: row.records, pipelines: row.pipelines, storageBytes: Number(row.storageBytes), updatedAt: row.updatedAt }
}
