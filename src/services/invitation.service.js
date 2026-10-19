import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { env } from '../config/env.js'
import { LEGAL_VERSIONS } from '../config/legal.js'
import { ASSIGNABLE_ROLES, hasPermission } from '../config/permissions.js'
import { prisma, UNIQUE_VIOLATION } from '../db/prisma.js'
import { queueEmail } from '../email/mailer.js'
import { invitationEmail } from '../email/templates.js'
import { emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { sha256 } from '../lib/hash.js'
import { logger } from '../lib/logger.js'
import { ApiError } from '../utils/ApiError.js'
import { BCRYPT_ROUNDS } from './auth.service.js'
import { assertWithinLimit } from './entitlements.service.js'

/** Invitations to join a workspace (M04). Tokens are single-use and only their hash is stored. */

const DAILY_INVITE_LIMIT = 20
const RESEND_COOLDOWN_MS = 60_000

const ROLE_LABELS = { admin: 'Admin', manager: 'Manager', sales_rep: 'Sales rep', viewer: 'Viewer', owner: 'Owner' }
const forbidden = (message) => new ApiError(403, message, { code: 'FORBIDDEN' })
const fieldError = (fields) => new ApiError(400, 'Validation failed', { code: 'VALIDATION_ERROR', details: { fields } })

const newToken = () => crypto.randomBytes(32).toString('base64url')
const expiry = () => new Date(Date.now() + env.INVITATION_TTL_DAYS * 86_400_000)

function stateOf(inv) {
  if (inv.acceptedAt) return 'accepted'
  if (inv.revokedAt) return 'revoked'
  if (inv.expiresAt <= new Date()) return 'expired'
  return 'pending'
}

async function sendInvitationEmail(ctx, invitation, token) {
  const [org, inviter] = await Promise.all([
    prisma.organization.findUnique({ where: { id: ctx.orgId }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: ctx.userId }, select: { fullName: true } }),
  ])
  await queueEmail({
    to: invitation.email,
    ...invitationEmail({
      inviterName: inviter.fullName,
      organizationName: org.name,
      roleLabel: ROLE_LABELS[invitation.role],
      url: `${env.FRONTEND_URL}/invite?token=${token}`,
      days: env.INVITATION_TTL_DAYS,
    }),
  })
}

// ---------- Admin side ----------

export async function listInvitations(ctx) {
  const rows = await prisma.invitation.findMany({
    where: { organizationId: ctx.orgId, acceptedAt: null, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true, role: true, teamIds: true, expiresAt: true, lastSentAt: true, createdAt: true, acceptedAt: true, revokedAt: true, invitedById: true },
  })
  const inviters = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.invitedById))] } }, select: { id: true, fullName: true } })
  const names = new Map(inviters.map((u) => [u.id, u.fullName]))
  return rows.map(({ acceptedAt: _a, revokedAt: _r, ...r }) => ({ ...r, status: stateOf({ ...r, acceptedAt: null, revokedAt: null }), invitedByName: names.get(r.invitedById) ?? null }))
}

/**
 * Invites up to 20 emails at once. Returns a result per email so the UI can show which were sent.
 * Re-inviting an email replaces its earlier pending invitation (new link, old one stops working).
 */
export async function createInvitations(ctx, { emails, role, teamIds = [] }) {
  if (!ASSIGNABLE_ROLES.includes(role)) throw fieldError({ role: 'Choose a role' })
  if (role === 'admin' && !hasPermission(ctx.permissions, 'members.manage.admins')) throw forbidden('Only the workspace owner can invite admins.')

  const unique = [...new Set(emails)]
  const since = new Date(Date.now() - 86_400_000)
  const sentToday = await prisma.invitation.count({ where: { organizationId: ctx.orgId, createdAt: { gte: since } } })
  if (sentToday + unique.length > DAILY_INVITE_LIMIT) {
    throw new ApiError(429, `You can send up to ${DAILY_INVITE_LIMIT} invitations a day. ${Math.max(0, DAILY_INVITE_LIMIT - sentToday)} left today.`, {
      code: 'INVITE_LIMIT',
    })
  }
  if (teamIds.length) {
    const valid = await prisma.team.count({ where: { id: { in: teamIds }, organizationId: ctx.orgId } })
    if (valid !== new Set(teamIds).size) throw fieldError({ teamIds: 'One of these teams no longer exists' })
  }

  const members = await prisma.membership.findMany({
    where: { organizationId: ctx.orgId, status: 'active', user: { email: { in: unique } } },
    select: { user: { select: { email: true } } },
  })
  const memberEmails = new Set(members.map((m) => m.user.email))

  const results = []
  for (const email of unique) {
    if (memberEmails.has(email)) {
      results.push({ email, status: 'already_member' })
      continue
    }
    const token = newToken()
    const invitation = await prisma.$transaction(async (tx) => {
      // Seats: active members + pending invitations must fit the plan (enforced from M06).
      await assertWithinLimit(ctx, 'users', 1, tx)
      await tx.invitation.updateMany({
        where: { organizationId: ctx.orgId, email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      const created = await tx.invitation.create({
        data: { organizationId: ctx.orgId, email, role, teamIds, tokenHash: sha256(token), invitedById: ctx.userId, expiresAt: expiry() },
      })
      await emit(tx, ctx, 'member.invited', { entityType: 'invitation', entityId: created.id }, { email, role })
      await recordAudit(tx, ctx, { action: 'member.invite', entityType: 'invitation', entityId: created.id, changes: { email: [null, email], role: [null, role] } })
      return created
    })
    try {
      await sendInvitationEmail(ctx, invitation, token)
      results.push({ email, status: 'invited', id: invitation.id })
    } catch (err) {
      logger.error({ err }, '[email] invitation failed')
      results.push({ email, status: 'email_failed', id: invitation.id })
    }
  }
  return results
}

async function getPending(ctx, id) {
  const inv = await prisma.invitation.findFirst({ where: { id, organizationId: ctx.orgId } })
  if (!inv || inv.acceptedAt || inv.revokedAt) throw ApiError.notFound('Invitation not found')
  return inv
}

/** New link (the old one stops working) and a fresh expiry. */
export async function resendInvitation(ctx, id) {
  const inv = await getPending(ctx, id)
  const wait = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - inv.lastSentAt.getTime())) / 1000)
  if (wait > 0) throw new ApiError(429, `Please wait ${wait}s before resending.`, { code: 'COOLDOWN', details: { retryAfter: wait } })
  const token = newToken()
  const updated = await prisma.invitation.update({ where: { id }, data: { tokenHash: sha256(token), expiresAt: expiry(), lastSentAt: new Date() } })
  await sendInvitationEmail(ctx, updated, token)
}

export async function revokeInvitation(ctx, id) {
  const inv = await getPending(ctx, id)
  await prisma.$transaction(async (tx) => {
    await tx.invitation.update({ where: { id }, data: { revokedAt: new Date() } })
    await recordAudit(tx, ctx, { action: 'member.invite_revoke', entityType: 'invitation', entityId: id, changes: { email: [inv.email, null] } })
  })
}

// ---------- Invitee side ----------

async function findByToken(token) {
  return prisma.invitation.findUnique({
    where: { tokenHash: sha256(token) },
    include: { organization: { select: { id: true, name: true, deletedAt: true } } },
  })
}

/** Public: what the /invite page shows before the person signs in or signs up. */
export async function lookupInvitation(token) {
  const inv = await findByToken(token)
  if (!inv || inv.organization.deletedAt) throw new ApiError(404, 'This invitation link isn’t valid.', { code: 'INVITE_INVALID' })
  const [inviter, account] = await Promise.all([
    prisma.user.findUnique({ where: { id: inv.invitedById }, select: { fullName: true } }),
    prisma.user.findFirst({ where: { email: inv.email, deletedAt: null }, select: { id: true } }),
  ])
  return {
    organizationName: inv.organization.name,
    inviterName: inviter?.fullName ?? null,
    email: inv.email,
    role: inv.role,
    status: stateOf(inv),
    accountExists: Boolean(account),
  }
}

function assertUsable(inv) {
  const state = inv ? stateOf(inv) : 'invalid'
  if (!inv || inv.organization.deletedAt) throw new ApiError(400, 'This invitation link isn’t valid.', { code: 'INVITE_INVALID' })
  if (state === 'accepted') throw new ApiError(400, 'This invitation has already been used.', { code: 'INVITE_USED' })
  if (state === 'revoked') throw new ApiError(400, 'This invitation was cancelled. Ask your admin to invite you again.', { code: 'INVITE_REVOKED' })
  if (state === 'expired') throw new ApiError(400, 'This invitation has expired. Ask your admin to resend it.', { code: 'INVITE_EXPIRED' })
}

/** Adds the user to the workspace (or reactivates them) and marks the invitation used — in `tx`. */
async function join(tx, inv, user, meta) {
  const claimed = await tx.invitation.updateMany({
    where: { id: inv.id, acceptedAt: null, revokedAt: null },
    data: { acceptedAt: new Date(), acceptedById: user.id },
  })
  if (claimed.count !== 1) throw new ApiError(400, 'This invitation has already been used.', { code: 'INVITE_USED' })

  const existing = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: inv.organizationId, userId: user.id } } })
  // The invitation (claimed above, so no longer counted as pending) turns into a member: +1 seat.
  // Normally it fits — the invitation held the seat — unless the plan was downgraded since.
  if (existing?.status !== 'active') await assertWithinLimit({ orgId: inv.organizationId }, 'users', 1, tx)
  if (existing?.status === 'active') {
    // Already in — nothing to change, just switch to it.
  } else if (existing) {
    await tx.membership.update({ where: { id: existing.id }, data: { status: 'active', role: inv.role, deactivatedAt: null, joinedAt: new Date() } })
  } else {
    await tx.membership.create({ data: { organizationId: inv.organizationId, userId: user.id, role: inv.role, status: 'active', joinedAt: new Date() } })
  }
  if (inv.teamIds.length) {
    const teams = await tx.team.findMany({ where: { id: { in: inv.teamIds }, organizationId: inv.organizationId }, select: { id: true } })
    await tx.teamMember.createMany({ data: teams.map((t) => ({ teamId: t.id, userId: user.id })), skipDuplicates: true })
  }
  await tx.user.update({
    where: { id: user.id },
    // The link reached their inbox, so the address is proven.
    data: { lastActiveOrganizationId: inv.organizationId, ...(!user.emailVerifiedAt && { emailVerifiedAt: new Date() }) },
  })

  const ctx = { orgId: inv.organizationId, userId: user.id, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null }
  await emit(tx, ctx, 'member.joined', { entityType: 'user', entityId: user.id }, { invitationId: inv.id, invitedById: inv.invitedById, role: inv.role })
  await recordAudit(tx, ctx, { action: 'member.join', entityType: 'user', entityId: user.id, changes: { role: [null, inv.role] } })
}

/** Signed-in user accepts. Their account email must be the invited one. */
export async function acceptInvitation(userId, token, meta = {}) {
  const inv = await findByToken(token)
  assertUsable(inv)
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, emailVerifiedAt: true } })
  if (user.email !== inv.email) {
    throw new ApiError(403, `This invitation is for ${inv.email}. Sign out and sign in with that email to accept it.`, { code: 'INVITE_EMAIL_MISMATCH', details: { email: inv.email } })
  }
  await prisma.$transaction((tx) => join(tx, inv, user, meta))
  return { organizationId: inv.organizationId }
}

/**
 * New person accepts: creates their account (email pre-verified by the link, onboarding skipped —
 * they join an existing workspace) and adds them in one transaction. Returns the new user id.
 */
export async function signupWithInvite({ token, fullName, password, jobRole }, meta = {}) {
  const inv = await findByToken(token)
  assertUsable(inv)
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  try {
    return await prisma.$transaction(async (tx) => {
      const now = new Date()
      const user = await tx.user.create({
        data: {
          fullName,
          email: inv.email,
          passwordHash,
          jobRole: jobRole ?? null,
          emailVerifiedAt: now,
          onboardingCompletedAt: now,
          termsAcceptedAt: now,
          termsVersion: LEGAL_VERSIONS.terms,
          privacyVersion: LEGAL_VERSIONS.privacy,
        },
        select: { id: true, emailVerifiedAt: true },
      })
      await join(tx, inv, user, meta)
      return user.id
    })
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw new ApiError(409, 'You already have a TechSync account with this email. Sign in to accept the invitation.', { code: 'ACCOUNT_EXISTS' })
    }
    throw err
  }
}
