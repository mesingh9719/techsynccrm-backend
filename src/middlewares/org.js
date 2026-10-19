import { hasPermission, permissionsFor } from '../config/permissions.js'
import { planDefinition, planHasFeature } from '../config/plans.js'
import { prisma } from '../db/prisma.js'
import { ApiError } from '../utils/ApiError.js'
import { requireAuth } from './auth.js'

const ORG_REQUIRED = (message = 'Choose a workspace to continue.') => new ApiError(403, message, { code: 'ORG_REQUIRED' })
const FORBIDDEN = () => new ApiError(403, 'You don’t have permission to do this in this workspace.', { code: 'FORBIDDEN' })
const SEAT_SUSPENDED = () =>
  new ApiError(403, 'This workspace has more members than its plan allows. The owner needs to choose who keeps access — please contact them.', {
    code: 'SEAT_SUSPENDED',
  })

/**
 * While the owner hasn't chosen who stays after a downgrade (M06), only the owner and the
 * longest-serving admin can use the workspace.
 */
async function keepsAccessDuringSeatSelection(orgId, userId, role) {
  if (role === 'owner') return true
  if (role !== 'admin') return false
  const senior = await prisma.membership.findFirst({
    where: { organizationId: orgId, status: 'active', role: 'admin' },
    orderBy: [{ joinedAt: 'asc' }, { createdAt: 'asc' }],
    select: { userId: true },
  })
  return senior?.userId === userId
}

/**
 * Workspace routes: authenticates, then loads the user, their membership of the token's workspace
 * and the workspace itself in ONE query — on every request, so removing someone, changing their
 * role or deleting a workspace takes effect immediately rather than when the access token expires.
 * Also replaces `requireVerified`, and enforces the workspace's "require 2FA" setting.
 *
 * Sets `req.ctx`, which services take as their first argument:
 *   { userId, email, orgId, role, permissions, teamIds, managedUserIds, plan, trialEndsAt,
 *     entitlements (config/plans.js definition), timezone, currency,
 *     country, locale, fiscalYearStartMonth, actorType, ip, userAgent }
 */
export async function loadOrgContext(req, _res, next) {
  const orgId = req.user.orgId
  if (!orgId) return next(ORG_REQUIRED())

  const membership = await prisma.membership.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId: req.user.id } },
    select: {
      role: true,
      status: true,
      user: { select: { email: true, emailVerifiedAt: true, twoFactorEnabledAt: true, deletedAt: true } },
      organization: {
        select: {
          id: true,
          plan: true,
          timezone: true,
          currency: true,
          country: true,
          locale: true,
          fiscalYearStartMonth: true,
          require2fa: true,
          trialEndsAt: true,
          seatSelectionRequiredAt: true,
          deletedAt: true,
        },
      },
    },
  })

  if (!membership || membership.user.deletedAt) return next(ORG_REQUIRED('You don’t have access to this workspace.'))
  if (!membership.user.emailVerifiedAt) return next(new ApiError(403, 'Please verify your email address first.', { code: 'EMAIL_NOT_VERIFIED' }))
  if (membership.status !== 'active' || membership.organization.deletedAt) {
    return next(ORG_REQUIRED('You no longer have access to this workspace.'))
  }
  // "Require 2FA" is a Business feature: after a downgrade the setting is kept but paused.
  if (membership.organization.require2fa && planHasFeature(membership.organization.plan, 'require2fa') && !membership.user.twoFactorEnabledAt) {
    return next(new ApiError(403, 'This workspace requires two-factor authentication. Set it up to continue.', { code: 'TWO_FACTOR_REQUIRED' }))
  }
  if (membership.organization.seatSelectionRequiredAt && !(await keepsAccessDuringSeatSelection(orgId, req.user.id, membership.role))) {
    return next(SEAT_SUSPENDED())
  }

  // Managers see records owned by members of the teams they manage.
  let teamIds = []
  let managedUserIds = []
  if (membership.role === 'manager') {
    const rows = await prisma.teamMember.findMany({
      where: { team: { organizationId: orgId, members: { some: { userId: req.user.id, isManager: true } } } },
      select: { teamId: true, userId: true },
    })
    teamIds = [...new Set(rows.map((r) => r.teamId))]
    managedUserIds = [...new Set(rows.map((r) => r.userId))].filter((id) => id !== req.user.id)
  }

  const org = membership.organization
  req.ctx = {
    userId: req.user.id,
    sessionId: req.user.sid ?? null,
    email: membership.user.email,
    orgId: org.id,
    role: membership.role,
    permissions: permissionsFor(membership.role),
    teamIds,
    managedUserIds,
    plan: org.plan,
    trialEndsAt: org.trialEndsAt,
    entitlements: planDefinition(org.plan),
    timezone: org.timezone,
    currency: org.currency,
    country: org.country,
    locale: org.locale,
    fiscalYearStartMonth: org.fiscalYearStartMonth,
    actorType: 'user',
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
  }
  next()
}

/** `router.use(requireOrg)` — authentication + active workspace membership. */
export const requireOrg = [requireAuth, loadOrgContext]

/**
 * Use after requireOrg. Allows the request only if the member has every listed permission
 * (`'leads.read'` matches any scope). See config/permissions.js.
 */
export function permit(...permissions) {
  return (req, _res, next) => {
    if (!permissions.every((p) => hasPermission(req.ctx?.permissions ?? [], p))) return next(FORBIDDEN())
    next()
  }
}

/**
 * Use after requireOrg. Coarse role gate for the few actions that are tied to a role rather than a
 * permission. Prefer `permit()`.
 * @param {...('owner'|'admin'|'manager'|'sales_rep'|'viewer')} roles
 */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!roles.includes(req.ctx?.role)) return next(FORBIDDEN())
    next()
  }
}
