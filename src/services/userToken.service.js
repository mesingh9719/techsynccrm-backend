import crypto from 'node:crypto'
import { prisma } from '../db/prisma.js'
import { ApiError } from '../utils/ApiError.js'

/** Single-use, emailed tokens (email verification, password reset). Only hashes are stored. */

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex')

/**
 * Creates a token and invalidates any earlier unused token of the same type for the user.
 * `payload` stores type-specific data (e.g. the new address for an email change).
 */
export async function createUserToken(userId, type, ttlMs, payload) {
  const token = crypto.randomBytes(32).toString('base64url')
  await prisma.$transaction([
    prisma.userToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.userToken.create({ data: { userId, type, tokenHash: hash(token), expiresAt: new Date(Date.now() + ttlMs), payload } }),
  ])
  return token
}

/** Invalidates every unused token of `type` for the user (e.g. after the action was cancelled). */
export async function invalidateUserTokens(userId, type) {
  await prisma.userToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } })
}

/** Seconds until another token of this type may be sent, or 0 if allowed now. */
export async function cooldownRemaining(userId, type, cooldownSeconds) {
  const latest = await prisma.userToken.findFirst({ where: { userId, type }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
  if (!latest) return 0
  const elapsed = (Date.now() - latest.createdAt.getTime()) / 1000
  return Math.max(0, Math.ceil(cooldownSeconds - elapsed))
}

/**
 * Marks a token as used and returns its userId (use `consumeUserTokenRecord` to also get the payload). Throws a 400 with a specific code when the
 * token is unknown, already used or expired. The conditional update makes it single-use even
 * under concurrent requests.
 */
export async function consumeUserToken(token, type) {
  return (await consumeUserTokenRecord(token, type)).userId
}

/** Like consumeUserToken, but returns `{ userId, payload }`. */
export async function consumeUserTokenRecord(token, type) {
  const record = token ? await prisma.userToken.findUnique({ where: { tokenHash: hash(token) } }) : null
  if (!record || record.type !== type) throw new ApiError(400, 'This link is invalid.', { code: 'TOKEN_INVALID' })
  if (record.usedAt) throw new ApiError(400, 'This link has already been used.', { code: 'TOKEN_USED' })
  if (record.expiresAt <= new Date()) throw new ApiError(400, 'This link has expired.', { code: 'TOKEN_EXPIRED_LINK' })

  const claimed = await prisma.userToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } })
  if (claimed.count !== 1) throw new ApiError(400, 'This link has already been used.', { code: 'TOKEN_USED' })
  return { userId: record.userId, payload: record.payload ?? {} }
}
