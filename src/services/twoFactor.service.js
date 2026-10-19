import crypto from 'node:crypto'
import { env } from '../config/env.js'
import { plansWithFeature } from '../config/plans.js'
import { prisma } from '../db/prisma.js'
import { queueEmail } from '../email/mailer.js'
import { twoFactorChangedEmail } from '../email/templates.js'
import { recordAudit } from '../lib/audit.js'
import { decrypt, encrypt } from '../lib/crypto.js'
import { sha256 } from '../lib/hash.js'
import { logger } from '../lib/logger.js'
import { generateSecret, otpauthUrl, verifyCode } from '../lib/totp.js'
import { ApiError } from '../utils/ApiError.js'
import { assertPassword } from './password.js'

/**
 * Two-factor authentication with an authenticator app (TOTP) plus single-use recovery codes.
 * Secrets are encrypted at rest; recovery codes are stored hashed and shown exactly once.
 */

const ISSUER = 'TechSync CRM'
const RECOVERY_CODE_COUNT = 10
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789' // no 0/o/1/l/i

const invalidCode = (field = 'code') =>
  new ApiError(400, 'That code didn’t work.', { code: 'INVALID_2FA_CODE', details: { fields: { [field]: 'That code didn’t work — try the latest one from your app' } } })

const normaliseRecoveryCode = (code) => String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

function newRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]).join('')
    return `${raw.slice(0, 5)}-${raw.slice(5)}`
  })
}

/** Replaces the user's recovery codes inside `tx`; returns the plain codes to show once. */
async function replaceRecoveryCodes(tx, userId) {
  const codes = newRecoveryCodes()
  await tx.recoveryCode.deleteMany({ where: { userId } })
  await tx.recoveryCode.createMany({ data: codes.map((code) => ({ userId, codeHash: sha256(normaliseRecoveryCode(code)) })) })
  return codes
}

async function notify(user, enabled) {
  try {
    await queueEmail({
      to: user.email,
      ...twoFactorChangedEmail({
        name: user.fullName,
        enabled,
        when: new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: user.timezone ?? 'Asia/Kolkata' }).format(new Date()),
        securityUrl: `${env.FRONTEND_URL}/app/settings/security`,
      }),
    })
  } catch (err) {
    logger.error({ err }, '[email] 2FA notification failed')
  }
}

const auditCtx = (userId, meta = {}) => ({ userId, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null })

/**
 * Step 1: a new secret for the authenticator app (QR code). Not active until confirmed with a code.
 * Calling it again replaces the pending secret.
 */
export async function startSetup(userId) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, twoFactorEnabledAt: true } })
  if (user.twoFactorEnabledAt) throw new ApiError(400, 'Two-factor authentication is already on.', { code: 'ALREADY_ENABLED' })
  const secret = generateSecret()
  await prisma.user.update({ where: { id: userId }, data: { twoFactorPendingSecretEnc: encrypt(secret) } })
  return { secret, otpauthUrl: otpauthUrl({ secret, accountName: user.email, issuer: ISSUER }) }
}

/** Step 2: confirm a code from the app → 2FA on, recovery codes returned (only time they're visible). */
export async function enable(userId, code, meta) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, fullName: true, timezone: true, twoFactorEnabledAt: true, twoFactorPendingSecretEnc: true },
  })
  if (user.twoFactorEnabledAt) throw new ApiError(400, 'Two-factor authentication is already on.', { code: 'ALREADY_ENABLED' })
  if (!user.twoFactorPendingSecretEnc) throw new ApiError(400, 'Start the setup again.', { code: 'SETUP_NOT_STARTED' })

  const secret = decrypt(user.twoFactorPendingSecretEnc)
  const step = verifyCode(secret, code)
  if (step === null) throw invalidCode()

  const recoveryCodes = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { twoFactorSecretEnc: encrypt(secret), twoFactorPendingSecretEnc: null, twoFactorEnabledAt: new Date(), twoFactorLastStep: BigInt(step) },
    })
    const codes = await replaceRecoveryCodes(tx, userId)
    await recordAudit(tx, auditCtx(userId, meta), { action: 'auth.2fa_enabled', entityType: 'user', entityId: userId })
    return codes
  })
  await notify(user, true)
  return { recoveryCodes }
}

/**
 * Checks an authenticator code (rejecting reuse of an already-accepted time step) or a recovery
 * code (consumed on use). Returns true/false; never throws for a wrong code.
 */
export async function verifySecondFactor(userId, { code, recoveryCode }) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { twoFactorSecretEnc: true, twoFactorLastStep: true } })
  if (!user?.twoFactorSecretEnc) return false

  if (recoveryCode) {
    const { count } = await prisma.recoveryCode.updateMany({
      where: { userId, codeHash: sha256(normaliseRecoveryCode(recoveryCode)), usedAt: null },
      data: { usedAt: new Date() },
    })
    return count === 1
  }

  const step = verifyCode(decrypt(user.twoFactorSecretEnc), code)
  if (step === null) return false
  if (user.twoFactorLastStep !== null && BigInt(step) <= user.twoFactorLastStep) return false
  // Conditional update so the same code can't be accepted twice by parallel requests.
  const { count } = await prisma.user.updateMany({
    where: { id: userId, OR: [{ twoFactorLastStep: null }, { twoFactorLastStep: { lt: BigInt(step) } }] },
    data: { twoFactorLastStep: BigInt(step) },
  })
  return count === 1
}

/** Password + a current code (or a recovery code) — for disabling 2FA or regenerating codes. */
async function reauthenticate(userId, { password, code, recoveryCode }) {
  await assertPassword(userId, password)
  if (!(await verifySecondFactor(userId, { code, recoveryCode }))) throw invalidCode(recoveryCode ? 'recoveryCode' : 'code')
}

export async function disable(userId, input, meta) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, fullName: true, timezone: true, twoFactorEnabledAt: true } })
  if (!user.twoFactorEnabledAt) throw new ApiError(400, 'Two-factor authentication is already off.', { code: 'ALREADY_DISABLED' })

  const requiring = await prisma.membership.findMany({
    // Only workspaces whose plan includes the setting enforce it (paused after a downgrade).
    where: { userId, status: 'active', organization: { require2fa: true, deletedAt: null, plan: { in: plansWithFeature('require2fa') } } },
    select: { organization: { select: { name: true } } },
  })
  if (requiring.length) {
    const names = requiring.map((m) => m.organization.name).join(', ')
    throw new ApiError(400, `Two-factor authentication is required by ${names}, so it can’t be turned off.`, { code: 'TWO_FACTOR_REQUIRED_BY_WORKSPACE' })
  }

  await reauthenticate(userId, input)
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { twoFactorEnabledAt: null, twoFactorSecretEnc: null, twoFactorPendingSecretEnc: null, twoFactorLastStep: null },
    })
    await tx.recoveryCode.deleteMany({ where: { userId } })
    await recordAudit(tx, auditCtx(userId, meta), { action: 'auth.2fa_disabled', entityType: 'user', entityId: userId })
  })
  await notify(user, false)
}

/** New set of recovery codes; the old ones stop working. */
export async function regenerateRecoveryCodes(userId, input, meta) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorEnabledAt: true } })
  if (!user.twoFactorEnabledAt) throw new ApiError(400, 'Turn on two-factor authentication first.', { code: 'NOT_ENABLED' })
  await reauthenticate(userId, input)
  const recoveryCodes = await prisma.$transaction(async (tx) => {
    const codes = await replaceRecoveryCodes(tx, userId)
    await recordAudit(tx, auditCtx(userId, meta), { action: 'auth.2fa_recovery_codes_regenerated', entityType: 'user', entityId: userId })
    return codes
  })
  return { recoveryCodes }
}

/** For the security page: is 2FA on, and how many unused recovery codes are left. */
export async function status(userId) {
  const [user, remaining] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorEnabledAt: true } }),
    prisma.recoveryCode.count({ where: { userId, usedAt: null } }),
  ])
  return { enabled: Boolean(user.twoFactorEnabledAt), enabledAt: user.twoFactorEnabledAt, recoveryCodesRemaining: user.twoFactorEnabledAt ? remaining : 0 }
}
