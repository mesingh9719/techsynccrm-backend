import bcrypt from 'bcryptjs'
import { env } from '../config/env.js'
import { LEGAL_VERSIONS } from '../config/legal.js'
import { prisma, UNIQUE_VIOLATION } from '../db/prisma.js'
import { queueEmail } from '../email/mailer.js'
import { accountLockedEmail, newSignInEmail, passwordResetEmail, verificationEmail, welcomeEmail } from '../email/templates.js'
import { tryRecordAudit } from '../lib/audit.js'
import { sha256 } from '../lib/hash.js'
import { logger } from '../lib/logger.js'
import { describeUserAgent } from '../lib/userAgent.js'
import { profileImageUrl } from './profileImage.service.js'
import { ApiError } from '../utils/ApiError.js'
import { createOrganizationTx, presentOrganizationSummary, resolveActiveMembership, withSlugRetry } from './organization.service.js'
import { issueRefreshToken, recentSignInFrom, revokeAllForUser, revokeRefreshToken, rotateRefreshToken, signAccessToken } from './token.service.js'
import { verifySecondFactor } from './twoFactor.service.js'
import { consumeUserTokenRecord, cooldownRemaining, createUserToken } from './userToken.service.js'

export const BCRYPT_ROUNDS = 12
// Compared against when the email doesn't exist, so response time doesn't reveal registered emails.
const DUMMY_HASH = bcrypt.hashSync('timing-safe-dummy-password', BCRYPT_ROUNDS)

const LOGIN_CHALLENGE_TTL_MS = 5 * 60_000
const LOGIN_CHALLENGE_MAX_ATTEMPTS = 5

export const userSelect = {
  id: true,
  fullName: true,
  email: true,
  passwordHash: true,
  emailVerifiedAt: true,
  jobRole: true,
  phone: true,
  goals: true,
  onboardingCompletedAt: true,
  lastActiveOrganizationId: true,
  avatarFileId: true,
  timezone: true,
  locale: true,
  termsVersion: true,
  privacyVersion: true,
  twoFactorEnabledAt: true,
  pendingEmail: true,
  createdAt: true,
}

const avatarUrl = profileImageUrl

/**
 * Public user shape — never includes the password hash or 2FA secrets. `organization` is the
 * workspace the session is signed in to ({ id, name, slug, plan, role, permissions, require2fa }),
 * or null when the user has none yet.
 */
export async function presentUser(row, active = null) {
  const {
    emailVerifiedAt,
    onboardingCompletedAt,
    lastActiveOrganizationId: _org,
    avatarFileId,
    termsVersion,
    privacyVersion,
    twoFactorEnabledAt,
    passwordHash,
    ...rest
  } = row
  return {
    ...rest,
    emailVerified: Boolean(emailVerifiedAt),
    onboardingCompleted: Boolean(onboardingCompletedAt),
    avatarFileId,
    avatarUrl: await avatarUrl(avatarFileId),
    twoFactorEnabled: Boolean(twoFactorEnabledAt),
    hasPassword: Boolean(passwordHash),
    /** False when the Terms or Privacy Policy changed since the user last accepted them. */
    termsUpToDate: termsVersion === LEGAL_VERSIONS.terms && privacyVersion === LEGAL_VERSIONS.privacy,
    organization: active ? presentOrganizationSummary(active.organization, active.role) : null,
  }
}

/** User + an access token for their active workspace (no new refresh token). */
async function accessFor(row, { preferredOrgId = row.lastActiveOrganizationId, sessionId = null } = {}) {
  const active = await resolveActiveMembership(row.id, preferredOrgId)
  return { user: await presentUser(row, active), ...signAccessToken(row, active?.organization.id, sessionId) }
}

async function createSession(row, meta) {
  const refresh = await issueRefreshToken(row.id, meta)
  const access = await accessFor(row, { sessionId: refresh.sessionId })
  return { ...access, ...refresh }
}

/**
 * Fresh access token + user after the active workspace or profile changed (onboarding, switch,
 * create, delete). The refresh cookie stays valid: refreshes always issue tokens for the last
 * active workspace.
 */
export async function sessionForUser(userId, sessionId = null) {
  return accessFor(await getUserRow(userId), { sessionId })
}

/** Full session (refresh cookie + access token) for a user who just proved who they are some other way. */
export async function startSession(userId, meta) {
  return createSession(await getUserRow(userId), meta)
}

export async function getUserRow(id) {
  const user = await prisma.user.findFirst({ where: { id, deletedAt: null }, select: userSelect })
  if (!user) throw ApiError.unauthorized('User no longer exists', 'INVALID_TOKEN')
  return user
}

/** @param {string | null} [tokenOrgId] the workspace in the caller's access token, preferred if still valid */
export async function getUserById(id, tokenOrgId = null) {
  const row = await getUserRow(id)
  const active = await resolveActiveMembership(row.id, tokenOrgId ?? row.lastActiveOrganizationId)
  return presentUser(row, active)
}

// ---------- Emails ----------

async function sendVerification(user) {
  const token = await createUserToken(user.id, 'email_verification', env.EMAIL_VERIFICATION_TTL_HOURS * 3600_000)
  const url = `${env.FRONTEND_URL}/verify-email?token=${token}`
  await queueEmail({ to: user.email, ...verificationEmail({ name: user.fullName, url, hours: env.EMAIL_VERIFICATION_TTL_HOURS }) })
}

/** Email failures shouldn't fail the request; the user can usually ask again. */
export async function trySend(label, fn) {
  try {
    await fn()
    return true
  } catch (err) {
    logger.error({ err }, `[email] ${label} failed`)
    return false
  }
}

export function formatWhen(date, timezone = 'Asia/Kolkata') {
  return `${new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(date)} (${timezone})`
}

// ---------- Sign up / log in / sessions ----------

/** Consent record for the current Terms and Privacy Policy versions. */
export const consentFields = () => ({ termsAcceptedAt: new Date(), termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy })

export async function signup({ fullName, email, password, plan }, meta) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  let user
  try {
    // The plan is applied when onboarding creates the workspace (Growth/Business → 14-day trial).
    user = await prisma.user.create({ data: { fullName, email, passwordHash, signupPlan: plan, ...consentFields() }, select: userSelect })
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw ApiError.conflict('An account with this email already exists. Try logging in instead.', 'email')
    throw err
  }
  const verificationEmailSent = await trySend('verification email', () => sendVerification(user))
  return { ...(await createSession(user, meta)), verificationEmailSent }
}

/** Counts a failed password; locks the account for a while after too many in a short window. */
async function recordFailedLogin(user, meta) {
  const now = new Date()
  const windowMs = env.LOGIN_LOCKOUT_MINUTES * 60_000
  const freshWindow = !user.failedLoginSince || now - user.failedLoginSince > windowMs
  const count = freshWindow ? 1 : user.failedLoginCount + 1

  if (count >= env.LOGIN_LOCKOUT_THRESHOLD) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, failedLoginSince: null, lockedUntil: new Date(now.getTime() + windowMs) },
    })
    await tryRecordAudit({ userId: user.id, ip: meta.ip, userAgent: meta.userAgent }, { action: 'auth.account_locked', entityType: 'user', entityId: user.id })
    await trySend('account locked email', () =>
      queueEmail({ to: user.email, ...accountLockedEmail({ name: user.fullName, minutes: env.LOGIN_LOCKOUT_MINUTES, resetUrl: `${env.FRONTEND_URL}/login?mode=reset` }) }),
    )
    return
  }
  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: count, failedLoginSince: freshWindow ? now : user.failedLoginSince } })
}

function lockedError(lockedUntil) {
  const retryAfter = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000))
  const minutes = Math.ceil(retryAfter / 60)
  return new ApiError(423, `Too many failed attempts. Your account is locked — try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password.`, {
    code: 'ACCOUNT_LOCKED',
    details: { retryAfter },
  })
}

/** Emails the user when a sign-in comes from a browser/network not seen in the last 90 days. */
async function alertIfNewDevice(user, meta, device) {
  if (device.isFirstSignIn || device.known) return
  await trySend('new sign-in email', () =>
    queueEmail({
      to: user.email,
      ...newSignInEmail({
        name: user.fullName,
        device: describeUserAgent(meta.userAgent).label,
        ip: meta.ip ?? 'unknown',
        when: formatWhen(new Date(), user.timezone ?? 'Asia/Kolkata'),
        resetUrl: `${env.FRONTEND_URL}/login?mode=reset`,
      }),
    }),
  )
}

/** Issues a full session after the password (and 2FA, if on) checked out. */
async function completeLogin(row, meta) {
  const device = await recentSignInFrom(row.id, meta)
  const session = await createSession(row, meta)
  await tryRecordAudit({ userId: row.id, orgId: session.user.organization?.id, ip: meta.ip, userAgent: meta.userAgent }, { action: 'auth.login', entityType: 'user', entityId: row.id })
  await alertIfNewDevice(row, meta, device)
  return session
}

/**
 * Step 1 of sign-in. Returns a session, or `{ twoFactorRequired, challengeToken }` when the account
 * has 2FA — the client then calls loginWithSecondFactor. Unknown emails and wrong passwords get the
 * same error and take the same time.
 */
export async function login({ email, password, remember }, meta) {
  const found = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: { ...userSelect, passwordHash: true, failedLoginCount: true, failedLoginSince: true, lockedUntil: true },
  })
  const valid = await bcrypt.compare(password, found?.passwordHash ?? DUMMY_HASH)

  if (found?.lockedUntil && found.lockedUntil > new Date()) throw lockedError(found.lockedUntil)
  if (!found || !valid) {
    if (found) await recordFailedLogin(found, meta)
    throw ApiError.unauthorized('That email and password combination is incorrect.', 'INVALID_CREDENTIALS')
  }

  const { passwordHash: _p, failedLoginCount, failedLoginSince: _s, lockedUntil, ...user } = found
  if (failedLoginCount || lockedUntil) {
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, failedLoginSince: null, lockedUntil: null } })
  }

  if (user.twoFactorEnabledAt) {
    const challengeToken = await createUserToken(user.id, 'login_challenge', LOGIN_CHALLENGE_TTL_MS, { remember: Boolean(remember) })
    return { twoFactorRequired: true, challengeToken }
  }
  return completeLogin({ ...user, passwordHash: found.passwordHash }, { ...meta, remember })
}

/** Federated proof does not bypass account locks, local 2FA or membership/onboarding gates. */
export async function completeExternalLogin(userId, remember, meta) {
  const row = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { ...userSelect, lockedUntil: true } })
  if (!row) throw ApiError.unauthorized('This account is unavailable.', 'INVALID_TOKEN')
  if (row.lockedUntil && row.lockedUntil > new Date()) throw lockedError(row.lockedUntil)
  const { lockedUntil: _lock, ...user } = row
  if (user.twoFactorEnabledAt) return { twoFactorRequired: true, challengeToken: await createUserToken(user.id, 'login_challenge', LOGIN_CHALLENGE_TTL_MS, { remember: Boolean(remember) }) }
  return completeLogin(user, { ...meta, remember })
}

const challengeExpired = () =>
  new ApiError(400, 'Your sign-in timed out. Please enter your email and password again.', { code: 'CHALLENGE_EXPIRED' })

/** Step 2 of sign-in for 2FA accounts: an authenticator code or a recovery code. */
export async function loginWithSecondFactor({ challengeToken, code, recoveryCode }, meta) {
  const record = await prisma.userToken.findUnique({ where: { tokenHash: sha256(challengeToken) } })
  if (!record || record.type !== 'login_challenge' || record.usedAt || record.expiresAt <= new Date() || record.attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS) {
    throw challengeExpired()
  }

  const ok = await verifySecondFactor(record.userId, { code, recoveryCode })
  if (!ok) {
    const attempts = record.attempts + 1
    await prisma.userToken.update({
      where: { id: record.id },
      data: { attempts, ...(attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS && { usedAt: new Date() }) },
    })
    if (attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS) throw challengeExpired()
    const field = recoveryCode ? 'recoveryCode' : 'code'
    throw new ApiError(400, 'That code didn’t work. Check your authenticator app and try again.', {
      code: 'INVALID_2FA_CODE',
      details: { fields: { [field]: recoveryCode ? 'That recovery code isn’t valid or was already used' : 'That code didn’t work — try the latest one' } },
    })
  }

  // Single use, even if two requests race.
  const claimed = await prisma.userToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } })
  if (claimed.count !== 1) throw challengeExpired()

  const user = await getUserRow(record.userId)
  return completeLogin(user, { ...meta, remember: Boolean(record.payload?.remember) })
}

export async function refresh(refreshToken, meta) {
  const rotated = await rotateRefreshToken(refreshToken, meta)
  const row = await getUserRow(rotated.userId)
  return { ...(await accessFor(row, { sessionId: rotated.sessionId })), refreshToken: rotated.refreshToken, refreshExpiresAt: rotated.refreshExpiresAt }
}

export async function logout(refreshToken) {
  await revokeRefreshToken(refreshToken)
}

export async function logoutEverywhere(userId) {
  await revokeAllForUser(userId)
}

// ---------- Terms ----------

/** Records acceptance of the current Terms and Privacy Policy (versions must match what was shown). */
export async function acceptTerms(userId, { termsVersion, privacyVersion }, meta) {
  if (termsVersion !== LEGAL_VERSIONS.terms || privacyVersion !== LEGAL_VERSIONS.privacy) {
    throw new ApiError(409, 'The Terms were updated again — please review the latest version.', { code: 'TERMS_OUTDATED', details: { current: LEGAL_VERSIONS } })
  }
  await prisma.user.update({ where: { id: userId }, data: consentFields() })
  await tryRecordAudit({ userId, ip: meta.ip, userAgent: meta.userAgent }, { action: 'auth.terms_accepted', entityType: 'user', entityId: userId, changes: { termsVersion: [null, termsVersion] } })
}

// ---------- Email verification ----------

/** Verifies the email and signs the user in (the link proves they control the inbox). */
export async function verifyEmail(token, meta) {
  const { userId } = await consumeUserTokenRecord(token, 'email_verification')
  const user = await prisma.user.update({
    where: { id: userId },
    data: { emailVerifiedAt: new Date() },
    select: userSelect,
  })
  return createSession(user, meta)
}

export async function resendVerification(userId) {
  const user = await getUserRow(userId)
  if (user.emailVerifiedAt) throw new ApiError(400, 'Your email is already verified.', { code: 'ALREADY_VERIFIED' })

  const wait = await cooldownRemaining(userId, 'email_verification', env.EMAIL_RESEND_COOLDOWN_SECONDS)
  if (wait > 0) throw new ApiError(429, `Please wait ${wait}s before requesting another email.`, { code: 'COOLDOWN', details: { retryAfter: wait } })

  await sendVerification(user)
  return { sentTo: user.email, retryAfter: env.EMAIL_RESEND_COOLDOWN_SECONDS }
}

// ---------- Password reset ----------

/** Always succeeds from the caller's point of view, so it can't be used to discover accounts. */
export async function forgotPassword(email) {
  const user = await prisma.user.findFirst({ where: { email, deletedAt: null }, select: { id: true, fullName: true, email: true } })
  if (!user) return
  if ((await cooldownRemaining(user.id, 'password_reset', env.EMAIL_RESEND_COOLDOWN_SECONDS)) > 0) return

  await trySend('password reset email', async () => {
    const token = await createUserToken(user.id, 'password_reset', env.PASSWORD_RESET_TTL_MINUTES * 60_000)
    const url = `${env.FRONTEND_URL}/reset-password?token=${token}`
    await queueEmail({ to: user.email, ...passwordResetEmail({ name: user.fullName, url, minutes: env.PASSWORD_RESET_TTL_MINUTES }) })
  })
}

/**
 * Sets a new password, signs out every session, lifts any lockout and confirms the email (the link
 * proved inbox access). 2FA stays on — a reset link alone must not be enough to take over an account.
 */
export async function resetPassword(token, password) {
  const { userId } = await consumeUserTokenRecord(token, 'password_reset')
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } })
  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash,
      failedLoginCount: 0,
      failedLoginSince: null,
      lockedUntil: null,
      ...(!user?.emailVerifiedAt && { emailVerifiedAt: new Date() }),
    },
  })
  await revokeAllForUser(userId)
  await tryRecordAudit({ userId }, { action: 'auth.password_reset', entityType: 'user', entityId: userId })
}

// ---------- Onboarding ----------

/**
 * Saves the personal profile and, the first time, creates the user's workspace from the company
 * step (they become its owner). Idempotent: a second submit — or two tabs at once — never creates
 * a second workspace. Users who already belong to a workspace (e.g. joined by invitation) only
 * update their profile.
 */
export async function completeOnboarding(userId, data, meta = {}) {
  const { company, industry, teamSize, ...profile } = data
  const existing = await getUserRow(userId)

  await withSlugRetry(async (tx) => {
    // Serialises concurrent submissions for the same user.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`onboarding:${userId}`}))`
    const { signupPlan } = await tx.user.update({
      where: { id: userId },
      data: { ...profile, onboardingCompletedAt: existing.onboardingCompletedAt ?? new Date() },
      select: { signupPlan: true },
    })
    const member = await tx.membership.findFirst({
      where: { userId, status: 'active', organization: { deletedAt: null } },
      select: { id: true },
    })
    if (!member) {
      await createOrganizationTx(tx, { userId, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null }, { company, industry, teamSize }, { plan: signupPlan ?? 'starter' })
      // One trial per signup: a later workspace (e.g. after deleting this one) starts on Starter.
      await tx.user.update({ where: { id: userId }, data: { signupPlan: null } })
    }
  })

  if (!existing.onboardingCompletedAt) {
    await trySend('welcome email', () =>
      queueEmail({ to: existing.email, ...welcomeEmail({ name: existing.fullName, url: `${env.FRONTEND_URL}/app` }) }),
    )
  }
  return sessionForUser(userId, meta.sessionId ?? null)
}
