import { env } from '../config/env.js'
import { ApiError } from '../utils/ApiError.js'
import { prisma } from '../db/prisma.js'

/**
 * Use after requireAuth. Allows only TechSync staff listed in INTERNAL_STAFF_EMAILS.
 * Rechecks the current account and session so old JWTs cannot retain staff access
 * after an email change, account deletion, or logout.
 */
export async function requireStaff(req, _res, next) {
  const denied = () => next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`))
  if (!req.user?.id || !req.user.sid) return denied()
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true, deletedAt: true } })
  if (!user || user.deletedAt || !env.INTERNAL_STAFF_EMAILS.includes(user.email.toLowerCase())) return denied()
  const session = await prisma.refreshToken.findFirst({ where: { userId: req.user.id, sessionId: req.user.sid, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } })
  if (!session) return next(ApiError.unauthorized('Your staff session has ended. Please sign in again.', 'AUTH_REQUIRED'))
  next()
}
