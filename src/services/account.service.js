import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { env } from '../config/env.js'
import { prisma, UNIQUE_VIOLATION } from '../db/prisma.js'
import { queueEmail } from '../email/mailer.js'
import { emailChangeNoticeEmail, emailChangeVerifyEmail, passwordChangedEmail } from '../email/templates.js'
import { recordAudit, tryRecordAudit } from '../lib/audit.js'
import { describeUserAgent } from '../lib/userAgent.js'
import { ApiError } from '../utils/ApiError.js'
import { BCRYPT_ROUNDS, formatWhen, getUserById, getUserRow, trySend } from './auth.service.js'
import { assertPassword } from './password.js'
import { scheduleReassignment } from './reassign.service.js'
import { listSessions, revokeAllForUser, revokeSession } from './token.service.js'
import { consumeUserTokenRecord, createUserToken, invalidateUserTokens } from './userToken.service.js'

/** The signed-in person's own account: profile, password, email, sessions, deletion (M05). */

const EMAIL_CHANGE_TTL_HOURS = 24
const EMAIL_CHANGE_CANCEL_TTL_DAYS = 7

const fieldError = (fields, message = 'Validation failed', code = 'VALIDATION_ERROR') => new ApiError(400, message, { code, details: { fields } })
const auditCtx = (userId, meta = {}) => ({ userId, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null })

// ---------- Profile ----------

export async function updateProfile(userId, input, meta) {
  if (input.avatarFileId) {
    const file = await prisma.file.findFirst({ where: { id: input.avatarFileId, userId }, select: { contentType: true } })
    if (!file) throw fieldError({ avatarFileId: 'Upload the photo again' })
    if (!/^image\/(png|jpe?g|webp)$/.test(file.contentType)) throw fieldError({ avatarFileId: 'Use a PNG, JPG or WebP image' })
  }
  await prisma.user.update({ where: { id: userId }, data: input })
  await tryRecordAudit(auditCtx(userId, meta), { action: 'user.profile_updated', entityType: 'user', entityId: userId, changes: { fields: Object.keys(input) } })
  return getUserById(userId, meta.orgId ?? null)
}

// ---------- Password ----------

/** Changes the password and signs out every other device (this one stays signed in). */
export async function changePassword(userId, { currentPassword, newPassword }, meta) {
  await assertPassword(userId, currentPassword, 'currentPassword')
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true, email: true, fullName: true, timezone: true } })
  if (await bcrypt.compare(newPassword, user.passwordHash)) throw fieldError({ newPassword: 'Choose a password you haven’t used for this account' })

  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) } })
  await revokeAllForUser(userId, { exceptSessionId: meta.sessionId })
  await tryRecordAudit(auditCtx(userId, meta), { action: 'auth.password_changed', entityType: 'user', entityId: userId })
  await trySend('password changed email', () =>
    queueEmail({
      to: user.email,
      ...passwordChangedEmail({ name: user.fullName, when: formatWhen(new Date(), user.timezone ?? 'Asia/Kolkata'), resetUrl: `${env.FRONTEND_URL}/login?mode=reset` }),
    }),
  )
}

// ---------- Email change ----------

/**
 * Starts an email change: confirmation link to the NEW address, "this wasn't me" link to the OLD
 * one. The email only changes when the new address is confirmed.
 */
export async function requestEmailChange(userId, { newEmail, password }, meta) {
  await assertPassword(userId, password)
  const user = await getUserRow(userId)
  if (newEmail === user.email) throw fieldError({ newEmail: 'That’s already your email address' })
  const taken = await prisma.user.findUnique({ where: { email: newEmail }, select: { id: true } })
  if (taken) throw fieldError({ newEmail: 'Another account already uses this email' })

  await prisma.user.update({ where: { id: userId }, data: { pendingEmail: newEmail } })
  const verifyToken = await createUserToken(userId, 'email_change', EMAIL_CHANGE_TTL_HOURS * 3600_000, { email: newEmail })
  const cancelToken = await createUserToken(userId, 'email_change_cancel', EMAIL_CHANGE_CANCEL_TTL_DAYS * 86_400_000, { oldEmail: user.email, newEmail })

  await queueEmail({
    to: newEmail,
    ...emailChangeVerifyEmail({ name: user.fullName, newEmail, url: `${env.FRONTEND_URL}/confirm-email-change?token=${verifyToken}`, hours: EMAIL_CHANGE_TTL_HOURS }),
  })
  await trySend('email change notice', () =>
    queueEmail({ to: user.email, ...emailChangeNoticeEmail({ name: user.fullName, newEmail, cancelUrl: `${env.FRONTEND_URL}/cancel-email-change?token=${cancelToken}` }) }),
  )
  await tryRecordAudit(auditCtx(userId, meta), { action: 'auth.email_change_requested', entityType: 'user', entityId: userId, changes: { email: [user.email, newEmail] } })
  return { pendingEmail: newEmail }
}

/** Withdraws a pending change from the profile page (no link needed). */
export async function discardEmailChange(userId) {
  await prisma.user.update({ where: { id: userId }, data: { pendingEmail: null } })
  await invalidateUserTokens(userId, 'email_change')
}

const invalidLink = () => new ApiError(400, 'This link is no longer valid.', { code: 'TOKEN_INVALID' })

/** Link from the new inbox. The token is bound to the pending address it was issued for. */
export async function confirmEmailChange(token, meta) {
  const { userId, payload } = await consumeUserTokenRecord(token, 'email_change')
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, pendingEmail: true, deletedAt: true } })
  if (!user || user.deletedAt || !payload.email || user.pendingEmail !== payload.email) throw invalidLink()

  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { email: payload.email, pendingEmail: null, emailVerifiedAt: new Date() } })
      await recordAudit(tx, auditCtx(userId, meta), { action: 'auth.email_changed', entityType: 'user', entityId: userId, changes: { email: [user.email, payload.email] } })
    })
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw new ApiError(409, 'Another account started using this email in the meantime.', { code: 'EMAIL_TAKEN' })
    throw err
  }
  return { email: payload.email }
}

/**
 * "This wasn't me" from the old inbox: cancels a pending change — or reverts it if it was already
 * confirmed — and signs out every device, since someone else may know the password.
 */
export async function cancelEmailChange(token, meta) {
  const { userId, payload } = await consumeUserTokenRecord(token, 'email_change_cancel')
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, pendingEmail: true } })
  if (!user) throw invalidLink()

  const reverted = user.email === payload.newEmail && payload.oldEmail
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { pendingEmail: null, ...(reverted && { email: payload.oldEmail, emailVerifiedAt: new Date() }) },
    })
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw new ApiError(409, 'We couldn’t restore your old email — please contact support.', { code: 'EMAIL_TAKEN' })
    throw err
  }
  await invalidateUserTokens(userId, 'email_change')
  await revokeAllForUser(userId)
  await tryRecordAudit(auditCtx(userId, meta), {
    action: 'auth.email_change_cancelled',
    entityType: 'user',
    entityId: userId,
    changes: reverted ? { email: [payload.newEmail, payload.oldEmail] } : undefined,
  })
  return { email: reverted ? payload.oldEmail : user.email, reverted: Boolean(reverted) }
}

// ---------- Sessions ----------

export async function getSessions(userId, currentSessionId) {
  const sessions = await listSessions(userId)
  return sessions
    .map((s) => ({ ...s, device: describeUserAgent(s.userAgent), current: s.id === currentSessionId }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt - a.lastActiveAt)
}

export async function signOutSession(userId, sessionId, meta) {
  if (!(await revokeSession(userId, sessionId))) throw ApiError.notFound('Session not found')
  await tryRecordAudit(auditCtx(userId, meta), { action: 'auth.session_revoked', entityType: 'user', entityId: userId })
}

export async function signOutOtherSessions(userId, meta) {
  await revokeAllForUser(userId, { exceptSessionId: meta.sessionId })
  await tryRecordAudit(auditCtx(userId, meta), { action: 'auth.sessions_revoked', entityType: 'user', entityId: userId })
}

// ---------- Delete account ----------

/**
 * Deletes the account. Blocked while the user owns a workspace (transfer it or delete it first).
 * Their memberships are deactivated with records handed to each workspace's owner, personal data is
 * anonymised, and every session ends. Audit history keeps the user id, not the person's details.
 */
export async function deleteAccount(userId, { password }, meta) {
  await assertPassword(userId, password)

  const owned = await prisma.membership.findMany({
    where: { userId, role: 'owner', status: 'active', organization: { deletedAt: null } },
    select: { organization: { select: { name: true } } },
  })
  if (owned.length) {
    const names = owned.map((m) => m.organization.name).join(', ')
    throw new ApiError(400, `You own ${names}. Transfer ownership or delete ${owned.length > 1 ? 'those workspaces' : 'that workspace'} first.`, {
      code: 'OWNS_WORKSPACE',
    })
  }

  const memberships = await prisma.membership.findMany({ where: { userId, status: 'active' }, select: { organizationId: true } })
  const owners = await prisma.membership.findMany({
    where: { organizationId: { in: memberships.map((m) => m.organizationId) }, role: 'owner', status: 'active' },
    select: { organizationId: true, userId: true },
  })

  await prisma.$transaction(async (tx) => {
    await tx.membership.updateMany({ where: { userId, status: 'active' }, data: { status: 'deactivated', deactivatedAt: new Date() } })
    await tx.teamMember.deleteMany({ where: { userId } })
    await tx.recoveryCode.deleteMany({ where: { userId } })
    await tx.userToken.deleteMany({ where: { userId } })
    await tx.user.update({
      where: { id: userId },
      data: {
        email: `deleted-${userId}@deleted.invalid`,
        fullName: 'Deleted user',
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 4),
        phone: null,
        jobRole: null,
        avatarFileId: null,
        pendingEmail: null,
        twoFactorEnabledAt: null,
        twoFactorSecretEnc: null,
        twoFactorPendingSecretEnc: null,
        twoFactorLastStep: null,
        lastActiveOrganizationId: null,
        deletedAt: new Date(),
      },
    })
    await recordAudit(tx, auditCtx(userId, meta), { action: 'user.deleted', entityType: 'user', entityId: userId })
  })
  await revokeAllForUser(userId)

  for (const { organizationId, userId: ownerId } of owners) {
    await scheduleReassignment({ organizationId, fromUserId: userId, toUserId: ownerId, actorId: userId })
  }
}
