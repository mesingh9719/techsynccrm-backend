import { env } from '../config/env.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * Use after requireAuth. Allows only TechSync staff listed in INTERNAL_STAFF_EMAILS.
 * Temporary until the staff admin console (M21) introduces proper staff roles.
 */
export function requireStaff(req, _res, next) {
  const email = req.user?.email?.toLowerCase()
  if (!email || !env.INTERNAL_STAFF_EMAILS.includes(email)) return next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`))
  next()
}
