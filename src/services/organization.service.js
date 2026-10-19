import { env } from '../config/env.js'
import { permissionsFor } from '../config/permissions.js'
import { DB_NULL, prisma, UNIQUE_VIOLATION } from '../db/prisma.js'
import { diff, emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { planHasFeature, presentEntitlements } from '../config/plans.js'
import { gstinErrors } from '../lib/india.js'
import { DEFAULT_TZ } from '../lib/time.js'
import { storage } from '../storage/files.js'
import { ApiError } from '../utils/ApiError.js'
import { assertFeature } from './entitlements.service.js'
import { ensureLeadDefaults } from './leadSetup.service.js'
import { ensureDefaultPipeline } from './pipeline.service.js'
import { initialPlanFor, planOverview, recordPlanChangeTx } from './plan.service.js'
import { unreadCount } from './notification.service.js'

/**
 * Workspaces (organizations) and the user's active workspace.
 * Functions that act inside a workspace take `ctx` (req.ctx from requireOrg) first.
 */

const SLUG_MAX_BASE = 36

const fullSelect = {
  id: true,
  name: true,
  slug: true,
  industry: true,
  teamSize: true,
  logoFileId: true,
  timezone: true,
  country: true,
  stateCode: true,
  currency: true,
  locale: true,
  fiscalYearStartMonth: true,
  gstin: true,
  legalName: true,
  address: true,
  plan: true,
  trialEndsAt: true,
  seatSelectionRequiredAt: true,
  require2fa: true,
  createdAt: true,
  updatedAt: true,
}

/** Fields tracked in audit entries and update events. */
const AUDITED_FIELDS = ['name', 'slug', 'industry', 'teamSize', 'logoFileId', 'timezone', 'country', 'stateCode', 'currency', 'gstin', 'legalName', 'address', 'require2fa']

const validationError = (fields) => new ApiError(400, 'Validation failed', { code: 'VALIDATION_ERROR', details: { fields } })

/**
 * Compact shape embedded in the signed-in user (AuthUser.organization). `permissions` is the
 * member's permission list (config/permissions.js) — the frontend's useCan reads it.
 */
export function presentOrganizationSummary(org, role) {
  // require2fa is only enforced on plans that include it (paused after a downgrade).
  const require2fa = Boolean(org.require2fa) && planHasFeature(org.plan, 'require2fa')
  return { id: org.id, name: org.name, slug: org.slug, plan: org.plan, role, permissions: permissionsFor(role), require2fa }
}

// ---------- Active workspace ----------

/**
 * The workspace a user should be signed in to: their preferred (last active) one if they're still
 * an active member and it isn't deleted, otherwise their most recently joined active workspace,
 * otherwise null. Keeps users.last_active_organization_id in step with the answer.
 *
 * @returns {Promise<{ organization: { id, name, slug, plan }, role: string } | null>}
 */
export async function resolveActiveMembership(userId, preferredOrgId, db = prisma) {
  const select = { role: true, organization: { select: { id: true, name: true, slug: true, plan: true, require2fa: true } } }
  const activeWhere = { userId, status: 'active', organization: { deletedAt: null } }

  let membership = preferredOrgId ? await db.membership.findFirst({ where: { ...activeWhere, organizationId: preferredOrgId }, select }) : null
  membership ??= await db.membership.findFirst({ where: activeWhere, orderBy: [{ joinedAt: 'desc' }, { createdAt: 'desc' }], select })

  const resolvedId = membership?.organization.id ?? null
  if (resolvedId !== (preferredOrgId ?? null)) {
    await db.user.update({ where: { id: userId }, data: { lastActiveOrganizationId: resolvedId } })
  }
  return membership ? { organization: membership.organization, role: membership.role } : null
}

// ---------- Create ----------

function slugify(name) {
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_BASE)
    .replace(/-+$/, '')
  if (!base) return 'workspace'
  return base.length >= 3 ? base : `${base}-ws`
}

/** First free slug of `base`, `base-2`, `base-3`, … (a concurrent insert can still collide; callers retry). */
async function availableSlug(db, name) {
  const base = slugify(name)
  const taken = new Set(
    (await db.organization.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((o) => o.slug),
  )
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

/**
 * Creates a workspace with `actor` as its owner. Must run inside a transaction (`tx`).
 * `plan` is the plan asked for: Growth/Business start a 14-day trial (M06, see plan.service.js).
 * @param {{ userId: string, ip?: string|null, userAgent?: string|null }} actor
 */
export async function createOrganizationTx(tx, actor, { company, industry, teamSize }, { plan: requestedPlan }) {
  const { plan, trialEndsAt, trialDenied } = await initialPlanFor(tx, actor.userId, requestedPlan, DEFAULT_TZ)
  const organization = await tx.organization.create({
    data: {
      name: company,
      slug: await availableSlug(tx, company),
      industry: industry ?? null,
      teamSize: teamSize ?? null,
      plan,
      trialEndsAt,
      timezone: DEFAULT_TZ,
      createdById: actor.userId,
    },
    select: fullSelect,
  })
  await tx.membership.create({
    data: { organizationId: organization.id, userId: actor.userId, role: 'owner', status: 'active', joinedAt: new Date() },
  })
  await tx.user.update({ where: { id: actor.userId }, data: { lastActiveOrganizationId: organization.id } })
  // Lead sources and lost reasons (M08) — created here rather than by an event subscriber so a new
  // workspace can capture leads straight away, even when no worker is running.
  await ensureLeadDefaults(tx, organization.id)
  // First pipeline from the industry template (M09).
  await ensureDefaultPipeline(tx, organization.id, organization.industry)

  const ctx = { ...actor, orgId: organization.id }
  // Subscribers (e.g. pipeline templates in M09) react to this event.
  await emit(tx, ctx, 'organization.created', { entityType: 'organization', entityId: organization.id }, { industry: organization.industry })
  await recordAudit(tx, ctx, { action: 'organization.create', entityType: 'organization', entityId: organization.id, changes: { name: [null, organization.name] } })
  await recordPlanChangeTx(tx, ctx, {
    organizationId: organization.id,
    fromPlan: null,
    toPlan: plan,
    reason: 'signup',
    meta: { requestedPlan, ...(trialEndsAt && { trialEndsAt: trialEndsAt.toISOString() }), ...(trialDenied && { trialDenied: 'domain_recent_trial' }) },
  })
  return organization
}

/** Runs `fn` in a transaction, retrying if a concurrently created workspace took the same slug. */
export async function withSlugRetry(fn, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await prisma.$transaction(fn)
    } catch (err) {
      if (err.code !== UNIQUE_VIOLATION || i >= attempts) throw err
    }
  }
}

/** POST /api/organizations — an additional workspace; becomes the active one. */
export async function createAdditionalOrganization(actor, data) {
  const user = await prisma.user.findUnique({ where: { id: actor.userId }, select: { emailVerifiedAt: true } })
  if (!user?.emailVerifiedAt) throw new ApiError(403, 'Please verify your email address first.', { code: 'EMAIL_NOT_VERIFIED' })
  // Extra workspaces start on the free plan; paid plans are bought per workspace (M16).
  return withSlugRetry((tx) => createOrganizationTx(tx, actor, data, { plan: 'starter' }))
}

// ---------- Read ----------

export async function listMyOrganizations(userId, currentOrgId) {
  const memberships = await prisma.membership.findMany({
    where: { userId, status: 'active', organization: { deletedAt: null } },
    select: { role: true, organization: { select: { id: true, name: true, slug: true, plan: true, require2fa: true, logoFileId: true } } },
    orderBy: { organization: { name: 'asc' } },
  })
  return memberships.map(({ role, organization }) => ({
    ...presentOrganizationSummary(organization, role),
    current: organization.id === currentOrgId,
  }))
}

async function logoUrl(logoFileId) {
  if (!logoFileId) return null
  const file = await prisma.file.findUnique({ where: { id: logoFileId }, select: { storageKey: true } })
  if (!file) return null
  try {
    return await storage.url(file.storageKey, { expiresIn: env.STORAGE_URL_EXPIRES_IN })
  } catch {
    return null
  }
}

/** Full settings record plus plan, trial, entitlements and usage (M06). */
async function presentFull(org) {
  const { seatSelectionRequiredAt: _s, ...rest } = org
  const [url, overview] = await Promise.all([logoUrl(org.logoFileId), planOverview(org)])
  return { ...rest, logoUrl: url, ...overview, entitlements: presentEntitlements(org.plan) }
}

export async function getCurrentOrganization(ctx) {
  const [organization, membership] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: fullSelect }),
    prisma.membership.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: ctx.orgId, userId: ctx.userId } },
      select: { role: true, title: true, joinedAt: true },
    }),
  ])
  return { organization: { ...(await presentFull(organization)), unreadNotificationCount: await unreadCount(ctx) }, membership: { ...membership, permissions: permissionsFor(membership.role) } }
}

// ---------- Update ----------

/** Currency can only change before money has been recorded in it (deals — M09; M17 adds quotes). */
async function assertCurrencyChangeAllowed(ctx) {
  const deals = await prisma.deal.count({ where: { organizationId: ctx.orgId } })
  if (deals) throw validationError({ currency: 'The currency can’t change once deals have been recorded in it' })
}

async function assertLogoFile(ctx, fileId) {
  const file = await prisma.file.findFirst({
    where: { id: fileId, OR: [{ organizationId: ctx.orgId }, { userId: ctx.userId }] },
    select: { id: true, contentType: true, organizationId: true },
  })
  if (!file) throw validationError({ logoFileId: 'Upload the logo again' })
  if (!/^image\/(png|jpe?g|webp)$/.test(file.contentType)) throw validationError({ logoFileId: 'Use a PNG, JPG or WebP image' })
  return file
}

export async function updateCurrentOrganization(ctx, input) {
  const before = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: fullSelect })
  const merged = { ...before, ...input }

  // GSTIN must match the workspace's state.
  if ('gstin' in input || 'stateCode' in input) {
    const errors = gstinErrors(merged.gstin, merged.stateCode)
    if (errors) throw validationError(errors)
  }
  if (input.currency && input.currency !== before.currency) await assertCurrencyChangeAllowed(ctx)
  if (input.require2fa && !before.require2fa) {
    assertFeature(ctx, 'require2fa')
    // Otherwise the admin would lock themselves out on their next request.
    const me = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { twoFactorEnabledAt: true } })
    if (!me?.twoFactorEnabledAt) throw validationError({ require2fa: 'Turn on two-factor authentication for your own account first' })
  }
  if (input.logoFileId) {
    const file = await assertLogoFile(ctx, input.logoFileId)
    if (file.organizationId !== ctx.orgId) await prisma.file.update({ where: { id: file.id }, data: { organizationId: ctx.orgId } })
  }

  let after
  try {
    after = await prisma.$transaction(async (tx) => {
      const data = { ...input, ...(input.address === null && { address: DB_NULL }) }
      const updated = await tx.organization.update({ where: { id: ctx.orgId }, data, select: fullSelect })
      const changes = diff(before, updated, AUDITED_FIELDS)
      if (changes) {
        await emit(tx, ctx, 'organization.updated', { entityType: 'organization', entityId: ctx.orgId }, { changes })
        await recordAudit(tx, ctx, { action: 'organization.update', entityType: 'organization', entityId: ctx.orgId, changes })
      }
      return updated
    })
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw validationError({ slug: 'That address is already taken — try another' })
    throw err
  }
  return { organization: await presentFull(after) }
}

// ---------- Delete ----------

/**
 * Soft-deletes the workspace: from the next request nobody can use it (requireOrg checks
 * deleted_at). Data is kept so it can be restored by support; the permanent purge job arrives
 * with workspace export in M21.
 */
export async function deleteCurrentOrganization(ctx, confirmName) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { id: true, name: true } })
  if (confirmName.trim().toLowerCase() !== org.name.trim().toLowerCase()) {
    throw validationError({ confirmName: 'That doesn’t match the workspace name' })
  }
  await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } })
    await tx.user.updateMany({ where: { lastActiveOrganizationId: org.id }, data: { lastActiveOrganizationId: null } })
    await emit(tx, ctx, 'organization.deleted', { entityType: 'organization', entityId: org.id })
    await recordAudit(tx, ctx, { action: 'organization.delete', entityType: 'organization', entityId: org.id, changes: { name: [org.name, null] } })
  })
}

// ---------- Switch ----------

export async function switchOrganization(userId, organizationId) {
  const membership = await prisma.membership.findFirst({
    where: { userId, organizationId, status: 'active', organization: { deletedAt: null } },
    select: { id: true },
  })
  if (!membership) throw ApiError.notFound('Workspace not found')
  await prisma.user.update({ where: { id: userId }, data: { lastActiveOrganizationId: organizationId } })
}

// ---------- Getting-started checklist (M03) ----------

/**
 * Items are computed from what's in the workspace, so they tick themselves off. Modules add
 * theirs as they ship (import leads — M13, invite team — M04, connect WhatsApp — M19, web form — M14).
 */
const CHECKLIST = [
  {
    key: 'invite_team',
    title: 'Invite your team',
    description: 'Add teammates and choose what each role can see.',
    href: '/app/settings/team',
    done: (_org, counts) => counts.members > 1 || counts.invitations > 0,
  },
  {
    key: 'workspace_details',
    title: 'Add your business details',
    description: 'Address, state and GSTIN — used on quotes and invoices.',
    href: '/app/settings/workspace',
    done: (org) => Boolean(org.stateCode && org.address?.city),
  },
  {
    key: 'workspace_logo',
    title: 'Upload your logo',
    description: 'Shown in the app and on documents you send customers.',
    href: '/app/settings/workspace',
    done: (org) => Boolean(org.logoFileId),
  },
]

export async function getChecklist(ctx) {
  const [org, membership, members, invitations] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { stateCode: true, address: true, logoFileId: true } }),
    prisma.membership.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: ctx.orgId, userId: ctx.userId } },
      select: { dismissedChecklistAt: true },
    }),
    prisma.membership.count({ where: { organizationId: ctx.orgId, status: 'active' } }),
    prisma.invitation.count({ where: { organizationId: ctx.orgId, acceptedAt: null, revokedAt: null } }),
  ])
  const counts = { members, invitations }
  return {
    items: CHECKLIST.map(({ done, ...item }) => ({ ...item, done: done(org, counts) })),
    dismissed: Boolean(membership.dismissedChecklistAt),
  }
}

export async function dismissChecklist(ctx) {
  await prisma.membership.update({
    where: { organizationId_userId: { organizationId: ctx.orgId, userId: ctx.userId } },
    data: { dismissedChecklistAt: new Date() },
  })
}
