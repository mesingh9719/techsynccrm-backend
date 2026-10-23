import { disableMemberMailboxes } from '../integrations/gmail/hooks.js'
import { env } from '../config/env.js'
import { MAX_TRIAL_EXTENSION_DAYS, PLANS, planDefinition, planName, TRIAL_DAYS, TRIAL_PLANS } from '../config/plans.js'
import { prisma } from '../db/prisma.js'
import { queueEmail } from '../email/mailer.js'
import { removedFromWorkspaceEmail, trialEndedEmail, upgradeRequestInternalEmail } from '../email/templates.js'
import { emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { logger } from '../lib/logger.js'
import { isoDateInTz, startOfDayInTz, zonedParts } from '../lib/time.js'
import { ApiError } from '../utils/ApiError.js'
import { countUsage, getUsage, refreshUsage, trialDaysLeft } from './entitlements.service.js'
import { scheduleReassignment } from './reassign.service.js'

/**
 * Plan lifecycle (M06): trials at signup, reminder emails, expiry → Starter with over-limit
 * handling, seat selection after a downgrade, upgrade requests and staff plan changes.
 * Payment (M16) will call `changePlanTx` with reason "upgrade" / "downgrade".
 */

const log = logger.child({ component: 'plans' })
const DAY_MS = 86_400_000
const TRIAL_DOMAIN_WINDOW_DAYS = 90
/** Reminders go out at 09:00 workspace time, at T-3, T-1 and T0 (the last day). */
const REMINDER_HOUR = 9
const REMINDER_STAGES = { 3: 't3', 1: 't1', 0: 't0' }
const UPGRADE_REQUESTS_PER_DAY = 5

/** Personal email providers: anyone can sign up many times, so the per-domain trial rule skips them. */
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'yahoo.in',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'rediffmail.com',
  'proton.me',
  'protonmail.com',
  'zoho.com',
  'zohomail.in',
  'gmx.com',
  'mail.com',
  'yandex.com',
])

const systemCtx = (orgId) => ({ orgId, userId: null, actorType: 'system' })
const fieldError = (fields) => new ApiError(400, 'Validation failed', { code: 'VALIDATION_ERROR', details: { fields } })
const appUrl = (path) => `${env.FRONTEND_URL}${path}`

/** End of the day `days` days after `from`, in `tz` (the trial runs through that whole day). */
export function trialEndFor(from, tz, days = TRIAL_DAYS) {
  return new Date(startOfDayInTz(new Date(from.getTime() + (days + 1) * DAY_MS), tz).getTime() - 1)
}

// ---------- Signup ----------

/** True when a workspace created by someone at the same business domain had a trial in the last 90 days. */
async function domainHadRecentTrial(tx, email) {
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain || FREE_EMAIL_DOMAINS.has(domain)) return false
  const since = new Date(Date.now() - TRIAL_DOMAIN_WINDOW_DAYS * DAY_MS)
  const [row] = await tx.$queryRaw`
    SELECT 1 AS hit
    FROM organizations o
    JOIN users u ON u.id = o.created_by_id
    JOIN plan_changes pc ON pc.organization_id = o.id AND pc.reason = 'signup' AND pc.to_plan::text IN ('growth', 'business')
    WHERE o.created_at >= ${since} AND u.email LIKE ${`%@${domain}`}
    LIMIT 1`
  return Boolean(row)
}

/**
 * The plan a new workspace starts on. Growth/Business get a 14-day trial — unless another
 * workspace from the same business email domain had one in the last 90 days, then Starter.
 * @returns {Promise<{ plan: string, trialEndsAt: Date | null, trialDenied: boolean }>}
 */
export async function initialPlanFor(tx, userId, requestedPlan, timezone) {
  if (!TRIAL_PLANS.includes(requestedPlan)) return { plan: 'starter', trialEndsAt: null, trialDenied: false }
  const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true } })
  if (user && (await domainHadRecentTrial(tx, user.email))) return { plan: 'starter', trialEndsAt: null, trialDenied: true }
  return { plan: requestedPlan, trialEndsAt: trialEndFor(new Date(), timezone), trialDenied: false }
}

// ---------- Plan changes ----------

/**
 * Records a plan change: plan_changes row, `organization.plan_changed` event and audit entry.
 * The caller has already updated organizations.plan in the same transaction.
 */
export async function recordPlanChangeTx(tx, ctx, { organizationId, fromPlan, toPlan, reason, meta }) {
  await tx.planChange.create({ data: { organizationId, fromPlan: fromPlan ?? null, toPlan, reason, actorId: ctx.userId ?? null, meta: meta ?? undefined } })
  const c = { ...ctx, orgId: organizationId }
  await emit(tx, c, 'organization.plan_changed', { entityType: 'organization', entityId: organizationId }, { changes: { plan: [fromPlan ?? null, toPlan] }, reason })
  await recordAudit(tx, c, { action: 'organization.plan_change', entityType: 'organization', entityId: organizationId, changes: { plan: [fromPlan ?? null, toPlan], reason, ...meta } })
}

/** Locks the workspace row for the rest of the transaction and returns its plan fields. */
async function lockOrg(tx, orgId) {
  const [org] = await tx.$queryRaw`
    SELECT id, name, plan::text AS plan, trial_ends_at AS "trialEndsAt", timezone,
           seat_selection_required_at AS "seatSelectionRequiredAt", deleted_at AS "deletedAt"
      FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`
  return org
}

/**
 * Applies the limits of the workspace's (new, lower) plan to things that hold capacity:
 * - more members than seats → the owner must choose who stays (until then only the owner and the
 *   longest-serving admin can use the workspace — middlewares/org.js);
 * - pending invitations hold seats → revoked when they no longer fit.
 * Records, pipelines and feature-gated data are never deleted: creates are blocked by
 * assertWithinLimit, and paused features are checked where they run.
 * @returns {Promise<string[]>} human-readable over-limit notes (for the email)
 */
async function applyLimitsTx(tx, org, plan) {
  const limits = planDefinition(plan).limits
  const notes = []
  const now = new Date()

  const active = await tx.membership.count({ where: { organizationId: org.id, status: 'active' } })
  const pending = await tx.invitation.count({ where: { organizationId: org.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } })
  if (active + pending > limits.users && pending > 0) {
    await tx.invitation.updateMany({ where: { organizationId: org.id, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } })
    notes.push(`${pending} pending invitation${pending === 1 ? ' was' : 's were'} cancelled`)
  }
  if (active > limits.users) {
    await tx.organization.update({ where: { id: org.id }, data: { seatSelectionRequiredAt: org.seatSelectionRequiredAt ?? now } })
    notes.push(`${active} members, but ${planName(plan)} includes ${limits.users} — the owner needs to choose who keeps access`)
  } else if (org.seatSelectionRequiredAt) {
    await tx.organization.update({ where: { id: org.id }, data: { seatSelectionRequiredAt: null, seatSuspendedResolvedAt: now } })
  }

  const records = await countUsage(org.id, 'records', tx)
  if (records > limits.records) notes.push(`${records.toLocaleString('en-IN')} leads and contacts (limit ${limits.records.toLocaleString('en-IN')}) — you can still view and edit them, but not add more`)
  const pipelines = await countUsage(org.id, 'pipelines', tx)
  if (pipelines > limits.pipelines) notes.push(`${pipelines} pipelines (limit ${limits.pipelines}) — the extra ones are read-only`)
  return notes
}

/**
 * Changes a workspace's plan inside `tx` and applies the new plan's limits. Used by staff tools now
 * and by billing (M16) later.
 */
export async function changePlanTx(tx, ctx, orgId, toPlan, options = {}) {
  return applyPlanTx(tx, ctx, await lockOrg(tx, orgId), toPlan, options)
}

/** Applies a change using the workspace snapshot already locked by the caller. */
async function applyPlanTx(tx, ctx, org, toPlan, { reason, trialEndsAt, meta } = {}) {
  if (!org || org.deletedAt) throw ApiError.notFound('Workspace not found')
  const orgId = org.id
  const data = { plan: toPlan, ...(trialEndsAt !== undefined && { trialEndsAt }) }
  await tx.organization.update({ where: { id: orgId }, data })
  // A staff change to the same plan still matters: it converts a trial into a paid plan.
  if (org.plan !== toPlan || reason === 'staff') await recordPlanChangeTx(tx, ctx, { organizationId: orgId, fromPlan: org.plan, toPlan, reason, meta })
  return { org, notes: await applyLimitsTx(tx, { ...org, plan: toPlan }, toPlan) }
}

// ---------- Current plan (GET /organizations/current) ----------

/** Plan, trial and entitlement fields added to the current workspace. */
export async function planOverview(org) {
  return {
    trialDaysLeft: trialDaysLeft(org.trialEndsAt, org.timezone),
    trialActive: Boolean(org.trialEndsAt && org.trialEndsAt > new Date() && TRIAL_PLANS.includes(org.plan)),
    seatSelectionRequired: Boolean(org.seatSelectionRequiredAt),
    usage: await getUsage(org.id),
  }
}

// ---------- Jobs ----------

async function adminsOf(orgId) {
  const rows = await prisma.membership.findMany({
    where: { organizationId: orgId, status: 'active', role: { in: ['owner', 'admin'] }, user: { deletedAt: null } },
    select: { user: { select: { email: true, fullName: true } } },
  })
  return rows.map((r) => r.user)
}

async function emailAdmins(orgId, build) {
  for (const user of await adminsOf(orgId)) {
    await queueEmail({ to: user.email, ...build(user) }).catch((err) => log.error({ err, orgId }, '[email] plan email failed'))
  }
}

/**
 * `trial.reminders` (hourly): at 09:00 workspace time on T-3, T-1 and T0, notifies the owner and
 * admins. Each reminder is claimed atomically (trial_reminders_sent), so re-runs and parallel
 * workers emit one reminder event; a missed 09:00 run is caught up later the same day.
 */
export async function sendTrialReminders(now = new Date()) {
  const orgs = await prisma.organization.findMany({
    where: { deletedAt: null, plan: { in: TRIAL_PLANS }, trialEndsAt: { gt: now, lte: new Date(now.getTime() + 4 * DAY_MS) } },
    select: { id: true, name: true, plan: true, trialEndsAt: true, timezone: true },
  })
  let sent = 0
  for (const org of orgs) {
    const daysLeft = trialDaysLeft(org.trialEndsAt, org.timezone, now)
    const stage = REMINDER_STAGES[daysLeft]
    if (!stage || zonedParts(now, org.timezone).hour < REMINDER_HOUR) continue
    const key = `${stage}:${isoDateInTz(org.trialEndsAt, org.timezone)}`
    const claimed = await prisma.$transaction(async (tx) => {
      const changed = await tx.organization.updateMany({
        where: { id: org.id, trialEndsAt: org.trialEndsAt, NOT: { trialRemindersSent: { has: key } } },
        data: { trialRemindersSent: { push: key } },
      })
      if (changed.count !== 1) return false
      await emit(tx, systemCtx(org.id), 'trial.ending', { entityType: 'organization', entityId: org.id }, { daysLeft, trialEndsAt: org.trialEndsAt.toISOString() })
      return true
    })
    if (!claimed) continue
    sent++
  }
  return { checked: orgs.length, sent }
}

/**
 * Moves one workspace whose trial has ended to Starter. Idempotent: the condition is re-checked
 * under a row lock, so a second run (or a second worker) does nothing and sends no email.
 */
export async function expireTrial(orgId, now = new Date()) {
  const result = await prisma.$transaction(async (tx) => {
    const org = await lockOrg(tx, orgId)
    // No subscriptions exist until M16; then an active subscription also skips the downgrade.
    if (!org || org.deletedAt || !TRIAL_PLANS.includes(org.plan) || !org.trialEndsAt || org.trialEndsAt > now) return null
    const { notes } = await changePlanTx(tx, systemCtx(orgId), orgId, 'starter', { reason: 'trial_expired', meta: { trialEndsAt: org.trialEndsAt.toISOString() } })
    return { org, notes }
  })
  if (!result) return false
  await refreshUsage(orgId).catch(() => {})
  await emailAdmins(orgId, (user) =>
    trialEndedEmail({ name: user.fullName, organizationName: result.org.name, planName: planName(result.org.plan), overLimits: result.notes, url: appUrl('/app/settings/plan') }),
  )
  log.info({ orgId, from: result.org.plan }, 'trial expired, moved to starter')
  return true
}

/** `trial.expire` (hourly): every trial that has ended. */
export async function expireTrials(now = new Date()) {
  const due = await prisma.organization.findMany({
    where: { deletedAt: null, plan: { in: TRIAL_PLANS }, trialEndsAt: { lte: now } },
    select: { id: true },
  })
  let expired = 0
  for (const { id } of due) {
    try {
      if (await expireTrial(id, now)) expired++
    } catch (err) {
      log.error({ err, orgId: id }, 'trial expiry failed')
    }
  }
  return { due: due.length, expired }
}

/** `usage.recount` (nightly): refreshes the usage display cache for every workspace. */
export async function recountAllUsage() {
  const orgs = await prisma.organization.findMany({ where: { deletedAt: null }, select: { id: true } })
  for (const { id } of orgs) await refreshUsage(id).catch((err) => log.error({ err, orgId: id }, 'usage recount failed'))
  return { workspaces: orgs.length }
}

// ---------- Seat selection (after a downgrade) ----------

/**
 * Owner chooses who keeps access after a downgrade left more members than seats. Everyone else is
 * deactivated (their open records go to the owner) and the workspace is unlocked for the rest.
 */
export async function selectSeats(ctx, keepUserIds) {
  const keep = new Set([...keepUserIds, ctx.userId])
  const deactivated = await prisma.$transaction(async (tx) => {
    const org = await lockOrg(tx, ctx.orgId)
    if (!org.seatSelectionRequiredAt) throw new ApiError(400, 'There’s nothing to choose — every member fits your plan.', { code: 'SEAT_SELECTION_NOT_REQUIRED' })
    const seats = planDefinition(org.plan).limits.users
    if (keep.size > seats) throw fieldError({ keepUserIds: `Your ${planName(org.plan)} plan includes ${seats} users — choose up to ${seats}, including you` })

    const members = await tx.membership.findMany({
      where: { organizationId: ctx.orgId, status: 'active' },
      select: { id: true, userId: true, role: true, user: { select: { email: true, fullName: true } } },
    })
    const memberIds = new Set(members.map((m) => m.userId))
    if ([...keep].some((id) => !memberIds.has(id))) throw fieldError({ keepUserIds: 'Choose active members of this workspace' })

    const leaving = members.filter((m) => !keep.has(m.userId))
    const now = new Date()
    for (const m of leaving) {
      await tx.membership.update({ where: { id: m.id }, data: { status: 'deactivated', deactivatedAt: now } })
      await disableMemberMailboxes(tx, m.userId, ctx.orgId)
      await tx.teamMember.deleteMany({ where: { userId: m.userId, team: { organizationId: ctx.orgId } } })
      await tx.user.updateMany({ where: { id: m.userId, lastActiveOrganizationId: ctx.orgId }, data: { lastActiveOrganizationId: null } })
      await emit(tx, ctx, 'member.deactivated', { entityType: 'user', entityId: m.userId }, { reassignToUserId: ctx.userId, reason: 'seat_selection' })
    }
    await tx.organization.update({ where: { id: ctx.orgId }, data: { seatSelectionRequiredAt: null, seatSuspendedResolvedAt: now } })
    await recordAudit(tx, ctx, {
      action: 'organization.seat_selection',
      entityType: 'organization',
      entityId: ctx.orgId,
      changes: { kept: [...keep], deactivated: leaving.map((m) => m.userId) },
    })
    return { org, leaving }
  })

  for (const m of deactivated.leaving) {
    await scheduleReassignment({ organizationId: ctx.orgId, fromUserId: m.userId, toUserId: ctx.userId, actorId: ctx.userId })
    queueEmail({ to: m.user.email, ...removedFromWorkspaceEmail({ name: m.user.fullName, organizationName: deactivated.org.name }) }).catch((err) =>
      log.error({ err }, '[email] removed-from-workspace email failed'),
    )
  }
  await refreshUsage(ctx.orgId).catch(() => {})
  return { kept: [...keep], deactivated: deactivated.leaving.map((m) => m.userId) }
}

// ---------- Upgrade request (until M16) ----------

export async function requestUpgrade(ctx, { plan, message }) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true, plan: true } })
  if (plan === org.plan) throw fieldError({ plan: 'You’re already on this plan' })
  const since = new Date(Date.now() - DAY_MS)
  const recent = await prisma.auditLog.count({ where: { organizationId: ctx.orgId, action: 'organization.upgrade_request', createdAt: { gte: since } } })
  if (recent >= UPGRADE_REQUESTS_PER_DAY) throw new ApiError(429, 'We’ve received your request — our team will be in touch shortly.', { code: 'RATE_LIMITED' })

  const [user, usage] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { fullName: true, email: true } }),
    getUsage(ctx.orgId),
  ])
  await recordAudit(prisma, ctx, { action: 'organization.upgrade_request', entityType: 'organization', entityId: ctx.orgId, changes: { plan: [org.plan, plan] } })
  const to = env.SALES_INBOX
  if (to) {
    await queueEmail({
      to,
      replyTo: user.email,
      ...upgradeRequestInternalEmail({
        organizationName: org.name,
        organizationId: ctx.orgId,
        currentPlan: planName(org.plan),
        requestedPlan: planName(plan),
        name: user.fullName,
        email: user.email,
        role: ctx.role,
        message: message || null,
        usage,
      }),
    })
  } else {
    log.warn({ orgId: ctx.orgId, plan }, 'upgrade request received but no SALES_INBOX / HELLO_INBOX / SMTP_USER is set')
  }
  return { requested: plan }
}

// ---------- Staff tools (/api/internal) ----------

const staffCtx = (actor, orgId) => ({ ...actor, orgId, actorType: 'user' })

/**
 * Extends (or restarts) a workspace's trial by up to 14 days. If the trial already expired, the
 * workspace goes back to the plan it was trialling and everything is re-enabled immediately.
 */
export async function extendTrial(actor, orgId, days) {
  if (days < 1 || days > MAX_TRIAL_EXTENSION_DAYS) throw fieldError({ days: `Extend by 1–${MAX_TRIAL_EXTENSION_DAYS} days` })
  const updated = await prisma.$transaction(async (tx) => {
    const org = await lockOrg(tx, orgId)
    if (!org || org.deletedAt) throw ApiError.notFound('Workspace not found')
    if (!org.trialEndsAt) throw new ApiError(400, 'This workspace never had a trial.', { code: 'NO_TRIAL' })

    const now = new Date()
    const base = org.trialEndsAt > now ? org.trialEndsAt : now
    const trialEndsAt = trialEndFor(base, org.timezone, days)
    let plan = org.plan
    if (!TRIAL_PLANS.includes(plan)) {
      const last = await tx.planChange.findFirst({ where: { organizationId: orgId, reason: 'trial_expired' }, orderBy: { createdAt: 'desc' }, select: { fromPlan: true } })
      plan = TRIAL_PLANS.includes(last?.fromPlan) ? last.fromPlan : 'growth'
    }
    const ctx = staffCtx(actor, orgId)
    await applyPlanTx(tx, ctx, org, plan, { reason: 'trial_extended', trialEndsAt, meta: { days, trialEndsAt: trialEndsAt.toISOString() } })
    if (plan === org.plan) {
      await recordAudit(tx, ctx, { action: 'organization.trial_extend', entityType: 'organization', entityId: orgId, changes: { trialEndsAt: [org.trialEndsAt, trialEndsAt], days } })
    }
    return { plan, trialEndsAt }
  })
  await refreshUsage(orgId).catch(() => {})
  return updated
}

/**
 * Sets a workspace's plan by hand (e.g. after an offline payment). A paid plan ends the trial
 * (trial_ends_at cleared, so expiry leaves it alone); the old trial end is kept in plan_changes.
 */
export async function setPlanByStaff(actor, orgId, plan) {
  if (!PLANS[plan]) throw fieldError({ plan: 'Choose a plan' })
  const result = await prisma.$transaction(async (tx) => {
    const org = await lockOrg(tx, orgId)
    return applyPlanTx(tx, staffCtx(actor, orgId), org, plan, {
      reason: 'staff',
      trialEndsAt: plan === 'starter' ? undefined : null,
      meta: org?.trialEndsAt ? { previousTrialEndsAt: org.trialEndsAt.toISOString() } : undefined,
    })
  })
  await refreshUsage(orgId).catch(() => {})
  return { plan, notes: result.notes }
}
