import { prisma } from '../db/prisma.js'
import { verifyAccessToken } from '../services/token.service.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * Protects a route: requires `Authorization: Bearer <access token>`.
 * On success sets `req.user = { id, email, orgId }` (orgId is the token's active workspace, or
 * null). Expired tokens return 401 with code TOKEN_EXPIRED so the client knows to call
 * /api/auth/refresh. Workspace routes add `requireOrg` (middlewares/org.js), which verifies the
 * membership against the database.
 */
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') ?? ''
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return next(ApiError.unauthorized('Authentication required', 'AUTH_REQUIRED'))
  }
  const payload = verifyAccessToken(token)
  // sid = the session (refresh-token chain) this access token belongs to — used by "sign out other sessions".
  req.user = { id: payload.sub, email: payload.email, orgId: payload.org ?? null, sid: payload.sid ?? null }
  next()
}

/**
 * Use after requireAuth. Blocks accounts that haven't confirmed their email (403 EMAIL_NOT_VERIFIED).
 * Checked against the database so it takes effect the moment the email is verified.
 */
export async function requireVerified(req, _res, next) {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { emailVerifiedAt: true, deletedAt: true } })
  if (!user || user.deletedAt) return next(ApiError.unauthorized('User no longer exists', 'INVALID_TOKEN'))
  if (!user.emailVerifiedAt) return next(new ApiError(403, 'Please verify your email address first.', { code: 'EMAIL_NOT_VERIFIED' }))
  next()
}
