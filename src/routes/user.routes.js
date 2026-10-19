import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { env } from '../config/env.js'
import * as account from '../controllers/account.controller.js'
import * as auth from '../controllers/auth.controller.js'
import { requireAuth, requireVerified } from '../middlewares/auth.js'
import { notificationPreferenceRoutes } from './notification.routes.js'
import { validate } from '../middlewares/validate.js'
import {
  changeEmailSchema,
  changePasswordSchema,
  onboardingSchema,
  passwordOnlySchema,
  profileSchema,
  reauthSchema,
  sessionIdParams,
  twoFactorCodeSchema,
} from '../validators/auth.validators.js'

/** The signed-in person's own account. Mounted at /api/users. Profile reads use GET /api/auth/me. */
const router = Router()

/** Password- and code-checking endpoints get their own stricter per-IP limit. */
const sensitiveLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many attempts, please try again later', code: 'RATE_LIMITED' } },
})

router.use('/me/notification-preferences', notificationPreferenceRoutes)
router.use(requireAuth)

router.put('/me/onboarding', requireVerified, validate(onboardingSchema), auth.completeOnboarding)
router.patch('/me', validate(profileSchema), account.updateProfile)
router.delete('/me', sensitiveLimiter, validate(passwordOnlySchema), account.deleteAccount)

router.post('/me/password', sensitiveLimiter, validate(changePasswordSchema), account.changePassword)
router.post('/me/email', sensitiveLimiter, validate(changeEmailSchema), account.requestEmailChange)
router.delete('/me/email', account.discardEmailChange)

router.get('/me/sessions', account.listSessions)
router.delete('/me/sessions', account.revokeOtherSessions)
router.delete('/me/sessions/:sessionId', validate(sessionIdParams, 'params'), account.revokeSession)

router.get('/me/2fa', account.twoFactorStatus)
router.post('/me/2fa/setup', account.twoFactorSetup)
router.post('/me/2fa/enable', sensitiveLimiter, validate(twoFactorCodeSchema), account.twoFactorEnable)
router.post('/me/2fa/disable', sensitiveLimiter, validate(reauthSchema), account.twoFactorDisable)
router.post('/me/2fa/recovery-codes', sensitiveLimiter, validate(reauthSchema), account.twoFactorRecoveryCodes)

export default router
