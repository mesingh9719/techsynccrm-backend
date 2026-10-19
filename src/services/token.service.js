import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { prisma } from '../db/prisma.js'
import { networkPrefix } from '../lib/userAgent.js'
import { ApiError } from '../utils/ApiError.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** A just-rotated token presented again within this window is a concurrent request (two tabs, StrictMode), not theft. */
const ROTATION_GRACE_MS = 30_000
const JWT_OPTIONS = { algorithm: 'HS256', issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE }

// ---------- Access tokens (stateless JWT) ----------

/**
 * @param {{ id: string, email: string }} user
 * @param {string | null} [organizationId] the active workspace, carried as the `org` claim;
 *   requireOrg re-checks the membership against the database on every request.
 * @param {string | null} [sessionId] the refresh-token chain (signed-in device) this token belongs to — `sid`
 */
export function signAccessToken(user, organizationId = null, sessionId = null) {
  const claims = { email: user.email, ...(organizationId && { org: organizationId }), ...(sessionId && { sid: sessionId }) }
  const token = jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    ...JWT_OPTIONS,
    subject: user.id,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  })
  const { exp } = jwt.decode(token)
  return { accessToken: token, expiresAt: new Date(exp * 1000).toISOString() }
}

/** Verifies signature, algorithm, issuer, audience and expiry. Returns `{ sub, email, org? }`. */
export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, { ...JWT_OPTIONS, algorithms: ['HS256'] })
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw ApiError.unauthorized('Access token has expired', 'TOKEN_EXPIRED')
    throw ApiError.unauthorized('Invalid access token', 'INVALID_TOKEN')
  }
}

// ---------- Refresh tokens (opaque, hashed in Postgres, rotated on use) ----------

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex')
const newOpaqueToken = () => crypto.randomBytes(48).toString('base64url')
const clientMeta = ({ userAgent, ip } = {}) => ({ userAgent: userAgent?.slice(0, 300) ?? null, ip: ip ?? null })

/** Starts a new session (sign-in) with a fresh refresh token. Only its hash is stored. */
export async function issueRefreshToken(userId, { remember = false, ...meta } = {}) {
  const token = newOpaqueToken()
  const days = remember ? env.REFRESH_TOKEN_REMEMBER_TTL_DAYS : env.REFRESH_TOKEN_TTL_DAYS
  const expiresAt = new Date(Date.now() + days * DAY_MS)
  const sessionId = crypto.randomUUID()
  await prisma.refreshToken.create({
    data: { userId, sessionId, tokenHash: hash(token), expiresAt, ...clientMeta(meta) },
  })
  return { refreshToken: token, refreshExpiresAt: expiresAt, sessionId }
}

/**
 * Exchanges a refresh token for a new one (rotation). The new token keeps the original
 * expiry, so a session can't be extended forever. Presenting a token that was already
 * rotated means it leaked: every session for that user is revoked.
 */
export async function rotateRefreshToken(token, meta = {}) {
  if (!token) throw ApiError.unauthorized('Refresh token missing', 'REFRESH_TOKEN_MISSING')

  const outcome = await prisma.$transaction(async (tx) => {
    const current = await tx.refreshToken.findUnique({ where: { tokenHash: hash(token) } })
    if (!current) return { error: 'invalid' }
    if (current.revokedAt) {
      const recentlyRotated = current.replacedById && Date.now() - current.revokedAt.getTime() < ROTATION_GRACE_MS
      return recentlyRotated ? { error: 'superseded' } : { error: 'reused', userId: current.userId }
    }
    if (current.expiresAt <= new Date()) return { error: 'expired' }

    // Compare-and-set: only one concurrent request can revoke this token.
    const claimed = await tx.refreshToken.updateMany({
      where: { id: current.id, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    if (claimed.count !== 1) return { error: 'reused', userId: current.userId }

    const next = newOpaqueToken()
    const created = await tx.refreshToken.create({
      data: { userId: current.userId, sessionId: current.sessionId, tokenHash: hash(next), expiresAt: current.expiresAt, ...clientMeta(meta) },
    })
    await tx.refreshToken.update({ where: { id: current.id }, data: { replacedById: created.id } })
    return { userId: current.userId, sessionId: current.sessionId, refreshToken: next, refreshExpiresAt: current.expiresAt }
  })

  // Handled outside the transaction so the revocation is committed before we respond.
  if (outcome.error === 'reused') await revokeAllForUser(outcome.userId)
  if (outcome.error === 'superseded') {
    // The browser already holds the newer cookie from the parallel request; the client should simply retry.
    throw ApiError.unauthorized('Refresh token was just rotated, retry with the latest cookie', 'REFRESH_TOKEN_SUPERSEDED')
  }
  if (outcome.error === 'expired') throw ApiError.unauthorized('Session has expired, please log in again', 'REFRESH_TOKEN_EXPIRED')
  if (outcome.error) throw ApiError.unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN')
  return outcome
}

export async function revokeRefreshToken(token) {
  if (!token) return
  await prisma.refreshToken.updateMany({ where: { tokenHash: hash(token), revokedAt: null }, data: { revokedAt: new Date() } })
}

/** Signs the user out everywhere, optionally keeping one session (the device making the request). */
export async function revokeAllForUser(userId, { exceptSessionId = null } = {}) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId && { sessionId: { not: exceptSessionId } }) },
    data: { revokedAt: new Date() },
  })
}

// ---------- Sessions (signed-in devices) ----------

/**
 * Active sessions: one per rotation chain that still has an unrevoked, unexpired token. The latest
 * token's time is when the device last refreshed (≈ last active).
 */
export async function listSessions(userId) {
  const heads = await prisma.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { sessionId: true, userAgent: true, ip: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: 'desc' },
  })
  if (!heads.length) return []
  const starts = await prisma.refreshToken.groupBy({
    by: ['sessionId'],
    where: { sessionId: { in: heads.map((h) => h.sessionId) } },
    _min: { createdAt: true },
  })
  const startedAt = new Map(starts.map((s) => [s.sessionId, s._min.createdAt]))
  // A chain has at most one live token, but be defensive about duplicates.
  const seen = new Set()
  return heads
    .filter((h) => !seen.has(h.sessionId) && seen.add(h.sessionId))
    .map((h) => ({ id: h.sessionId, userAgent: h.userAgent, ip: h.ip, lastActiveAt: h.createdAt, startedAt: startedAt.get(h.sessionId) ?? h.createdAt, expiresAt: h.expiresAt }))
}

/** Revokes one session. Returns false if it wasn't found (or wasn't the user's). */
export async function revokeSession(userId, sessionId) {
  const { count } = await prisma.refreshToken.updateMany({ where: { userId, sessionId, revokedAt: null }, data: { revokedAt: new Date() } })
  return count > 0
}

/**
 * New-device check for sign-in alerts: has the user signed in from this browser (same user agent)
 * on this network (same /24 or /64) in the last `days` days? `isFirstSignIn` is true when there's no
 * recent history at all (e.g. right after signup), in which case no alert should be sent.
 */
export async function recentSignInFrom(userId, { userAgent, ip }, days = 90) {
  const since = new Date(Date.now() - days * DAY_MS)
  const recent = await prisma.refreshToken.findMany({
    where: { userId, createdAt: { gte: since } },
    select: { userAgent: true, ip: true },
    distinct: ['userAgent', 'ip'],
    take: 200,
  })
  const prefix = networkPrefix(ip)
  return {
    isFirstSignIn: recent.length === 0,
    known: recent.some((r) => (r.userAgent ?? null) === (userAgent?.slice(0, 300) ?? null) && networkPrefix(r.ip) === prefix),
  }
}
