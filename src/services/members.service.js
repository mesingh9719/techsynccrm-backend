import { disableMemberMailboxes } from '../integrations/gmail/hooks.js'
import { hasPermission } from '../config/permissions.js'
import { planHasFeature } from '../config/plans.js'
import { prisma } from '../db/prisma.js'
import { queueEmail } from '../email/mailer.js'
import { removedFromWorkspaceEmail } from '../email/templates.js'
import { diff, emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { logger } from '../lib/logger.js'
import { ApiError } from '../utils/ApiError.js'
import { assertWithinLimit } from './entitlements.service.js'
import { assertPassword } from './password.js'
import { scheduleReassignment } from './reassign.service.js'

/** Members of the current workspace (M04). Functions take `ctx` (req.ctx) first. */

const forbidden = (message = 'You don’t have permission to do this in this workspace.') => new ApiError(403, message, { code: 'FORBIDDEN' })
const fieldError = (fields) => new ApiError(400, 'Validation failed', { code: 'VALIDATION_ERROR', details: { fields } })

const memberSelect = {
  userId: true,
  role: true,
  status: true,
  title: true,
  joinedAt: true,
  deactivatedAt: true,
  user: { select: { fullName: true, email: true, twoFactorEnabledAt: true } },
}

async function teamsByUser(orgId, userIds) {
  const rows = await prisma.teamMember.findMany({
    where: { userId: { in: userIds }, team: { organizationId: orgId } },
    select: { userId: true, isManager: true, team: { select: { id: true, name: true } } },
  })
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.userId)) map.set(r.userId, [])
    map.get(r.userId).push({ id: r.team.id, name: r.team.name, isManager: r.isManager })
  }
  return map
}

/** Last time each user refreshed a session (≈ last active anywhere). */
async function lastActiveByUser(userIds) {
  const rows = await prisma.refreshToken.groupBy({ by: ['userId'], where: { userId: { in: userIds } }, _max: { createdAt: true } })
  return new Map(rows.map((r) => [r.userId, r._max.createdAt]))
}

function present(m, teams, lastActive) {
  return {
    userId: m.userId,
    fullName: m.user.fullName,
    email: m.user.email,
    role: m.role,
    status: m.status,
    title: m.title,
    joinedAt: m.joinedAt,
    deactivatedAt: m.deactivatedAt,
    twoFactorEnabled: Boolean(m.user.twoFactorEnabledAt),
    teams: teams.get(m.userId) ?? [],
    lastActiveAt: lastActive.get(m.userId) ?? null,
  }
}

export async function listMembers(ctx, { status = 'active', q } = {}) {
  const where = {
    organizationId: ctx.orgId,
    ...(status !== 'all' && { status }),
    ...(q && { user: { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { email: { contains: q.toLowerCase() } }] } }),
  }
  const rows = await prisma.membership.findMany({ where, select: memberSelect, orderBy: [{ status: 'asc' }, { user: { fullName: 'asc' } }], take: 500 })
  const ids = rows.map((r) => r.userId)
  const [teams, lastActive] = await Promise.all([teamsByUser(ctx.orgId, ids), lastActiveByUser(ids)])
  return rows.map((r) => present(r, teams, lastActive))
}

async function getMembership(ctx, userId) {
  const m = await prisma.membership.findUnique({
    where: { organizationId_userId: { organizationId: ctx.orgId, userId } },
    select: { ...memberSelect, id: true },
  })
  if (!m) throw ApiError.notFound('Member not found')
  return m
}

/** Admins can't act on the owner or other admins; only the owner can. */
function assertCanManage(ctx, target) {
  if (target.userId === ctx.userId) throw forbidden('You can’t change your own membership here.')
  if (target.role === 'owner') throw forbidden('The workspace owner can only change through an ownership transfer.')
  if (target.role === 'admin' && !hasPermission(ctx.permissions, 'members.manage.admins')) throw forbidden('Only the workspace owner can change admins.')
}

/** Replaces a member's team memberships (keeping manager flags for teams they stay in). */
async function setTeams(tx, ctx, userId, teamIds) {
  const valid = await tx.team.findMany({ where: { id: { in: teamIds }, organizationId: ctx.orgId }, select: { id: true } })
  if (valid.length !== new Set(teamIds).size) throw fieldError({ teamIds: 'One of these teams no longer exists' })
  await tx.teamMember.deleteMany({ where: { userId, team: { organizationId: ctx.orgId }, teamId: { notIn: teamIds } } })
  await tx.teamMember.createMany({ data: teamIds.map((teamId) => ({ teamId, userId })), skipDuplicates: true })
}

export async function updateMember(ctx, userId, { role, title, teamIds }) {
  const target = await getMembership(ctx, userId)
  assertCanManage(ctx, target)
  if (role === 'admin' && !hasPermission(ctx.permissions, 'members.manage.admins')) throw forbidden('Only the workspace owner can make someone an admin.')

  await prisma.$transaction(async (tx) => {
    const updated = await tx.membership.update({
      where: { id: target.id },
      data: { ...(role && { role }), ...(title !== undefined && { title }) },
      select: { role: true, title: true },
    })
    if (teamIds) await setTeams(tx, ctx, userId, teamIds)
    const changes = diff(target, updated, ['role', 'title'])
    if (changes || teamIds) {
      await emit(tx, ctx, role && role !== target.role ? 'member.role_changed' : 'member.updated', { entityType: 'user', entityId: userId }, { changes, teamIds })
      await recordAudit(tx, ctx, { action: 'member.update', entityType: 'user', entityId: userId, changes: { ...changes, ...(teamIds && { teamIds: [null, teamIds] }) } })
    }
  })
  return (await listMembers(ctx, { status: 'all' })).find((m) => m.userId === userId)
}

/**
 * Removes a member's access. Their open records must go to someone (reassignment job). Nothing is
 * deleted; their name stays on history.
 */
export async function deactivateMember(ctx, userId, { reassignToUserId }) {
  const target = await getMembership(ctx, userId)
  assertCanManage(ctx, target)
  if (target.status !== 'active') throw new ApiError(400, 'This member is already deactivated.', { code: 'ALREADY_DEACTIVATED' })
  if (reassignToUserId === userId) throw fieldError({ reassignToUserId: 'Choose someone else to take over their records' })
  const heir = await prisma.membership.findUnique({
    where: { organizationId_userId: { organizationId: ctx.orgId, userId: reassignToUserId } },
    select: { status: true },
  })
  if (heir?.status !== 'active') throw fieldError({ reassignToUserId: 'Choose an active member' })

  await prisma.$transaction(async (tx) => {
    await tx.membership.update({ where: { id: target.id }, data: { status: 'deactivated', deactivatedAt: new Date() } })
    await disableMemberMailboxes(tx, userId, ctx.orgId)
    await tx.teamMember.deleteMany({ where: { userId, team: { organizationId: ctx.orgId } } })
    await tx.user.updateMany({ where: { id: userId, lastActiveOrganizationId: ctx.orgId }, data: { lastActiveOrganizationId: null } })
    await emit(tx, ctx, 'member.deactivated', { entityType: 'user', entityId: userId }, { reassignToUserId })
    await recordAudit(tx, ctx, { action: 'member.deactivate', entityType: 'user', entityId: userId, changes: { status: ['active', 'deactivated'], reassignToUserId } })
  })
  await scheduleReassignment({ organizationId: ctx.orgId, fromUserId: userId, toUserId: reassignToUserId, actorId: ctx.userId })

  const org = await prisma.organization.findUnique({ where: { id: ctx.orgId }, select: { name: true } })
  queueEmail({ to: target.user.email, ...removedFromWorkspaceEmail({ name: target.user.fullName, organizationName: org.name }) }).catch((err) =>
    logger.error({ err }, '[email] removed-from-workspace email failed'),
  )
}

export async function reactivateMember(ctx, userId) {
  const target = await getMembership(ctx, userId)
  assertCanManage(ctx, target)
  if (target.status === 'active') return
  await prisma.$transaction(async (tx) => {
    await assertWithinLimit(ctx, 'users', 1, tx)
    await tx.membership.update({ where: { id: target.id }, data: { status: 'active', deactivatedAt: null } })
    await emit(tx, ctx, 'member.reactivated', { entityType: 'user', entityId: userId })
    await recordAudit(tx, ctx, { action: 'member.reactivate', entityType: 'user', entityId: userId, changes: { status: [target.status, 'active'] } })
  })
}

/** Owner hands the workspace to another active member (owner → admin). Password re-confirmed. */
export async function transferOwnership(ctx, { userId, password }) {
  await assertPassword(ctx.userId, password)
  if (userId === ctx.userId) throw fieldError({ userId: 'You already own this workspace' })
  const target = await getMembership(ctx, userId)
  if (target.status !== 'active') throw fieldError({ userId: 'Choose an active member' })
  if (!target.user.twoFactorEnabledAt) {
    const org = await prisma.organization.findUnique({ where: { id: ctx.orgId }, select: { require2fa: true, plan: true } })
    if (org.require2fa && planHasFeature(org.plan, 'require2fa')) throw fieldError({ userId: 'This member must turn on two-factor authentication first' })
  }

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${ctx.orgId}::uuid FOR UPDATE`
    const current = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: ctx.userId } } })
    const next = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId } } })
    if (current?.role !== 'owner' || current.status !== 'active') throw forbidden('Only the current workspace owner can transfer ownership.')
    if (next?.status !== 'active') throw fieldError({ userId: 'Choose an active member' })
    await tx.membership.update({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: ctx.userId } }, data: { role: 'admin' } })
    await tx.membership.update({ where: { organizationId_userId: { organizationId: ctx.orgId, userId } }, data: { role: 'owner' } })
    await emit(tx, ctx, 'organization.ownership_transferred', { entityType: 'organization', entityId: ctx.orgId }, { from: ctx.userId, to: userId })
    await recordAudit(tx, ctx, { action: 'organization.transfer_ownership', entityType: 'organization', entityId: ctx.orgId, changes: { ownerId: [ctx.userId, userId] } })
  })
}

/** Active members for pickers (owner fields, reassignment). Light payload. */
export async function memberOptions(ctx, q) {
  const rows = await prisma.membership.findMany({
    where: {
      organizationId: ctx.orgId,
      status: 'active',
      ...(q && { user: { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { email: { contains: q.toLowerCase() } }] } }),
    },
    select: { userId: true, role: true, user: { select: { fullName: true, email: true } } },
    orderBy: { user: { fullName: 'asc' } },
    take: 50,
  })
  return rows.map((r) => ({ userId: r.userId, fullName: r.user.fullName, email: r.user.email, role: r.role }))
}

