import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { env } from '../config/env.js'
import * as auth from '../controllers/auth.controller.js'
import { requireAuth } from '../middlewares/auth.js'
import { validate } from '../middlewares/validate.js'
import {
  acceptTermsSchema,
  forgotPasswordSchema,
  loginSecondFactorSchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
  verifyEmailSchema,
} from '../validators/auth.validators.js'
import { switchOrganizationSchema } from '../validators/organization.validators.js'
import { acceptInvitationSchema, signupWithInviteSchema } from '../validators/team.validators.js'

const router = Router()

/**
 * Stricter per-IP limits on credential and email-sending endpoints, to slow brute force and spam.
 * Each group has its own counter, so e.g. verifying an email doesn't use up login attempts.
 */
const strictLimiter = () =>
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.AUTH_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, error: { message: 'Too many attempts, please try again later', code: 'RATE_LIMITED' } },
  })

const loginLimiter = strictLimiter()
const signupLimiter = strictLimiter()
const verificationLimiter = strictLimiter()
const passwordResetLimiter = strictLimiter()
const twoFactorLimiter = strictLimiter()
const emailChangeLimiter = strictLimiter()
const invitationLimiter = strictLimiter()

router.post('/signup', signupLimiter, validate(signupSchema), auth.signup)
router.post('/login', loginLimiter, validate(loginSchema), auth.login)
router.post('/login/2fa', twoFactorLimiter, validate(loginSecondFactorSchema), auth.loginSecondFactor)
router.post('/refresh', auth.refresh)
router.post('/logout', auth.logout)
router.post('/logout-all', requireAuth, auth.logoutAll)
router.get('/me', requireAuth, auth.me)
router.post('/switch-organization', requireAuth, validate(switchOrganizationSchema), auth.switchOrganization)

router.post('/verify-email', verificationLimiter, validate(verifyEmailSchema), auth.verifyEmail)
router.post('/resend-verification', verificationLimiter, requireAuth, auth.resendVerification)
router.post('/forgot-password', passwordResetLimiter, validate(forgotPasswordSchema), auth.forgotPassword)
router.post('/reset-password', passwordResetLimiter, validate(resetPasswordSchema), auth.resetPassword)

router.post('/accept-terms', requireAuth, validate(acceptTermsSchema), auth.acceptTerms)
router.post('/confirm-email-change', emailChangeLimiter, validate(verifyEmailSchema), auth.confirmEmailChange)
router.post('/cancel-email-change', emailChangeLimiter, validate(verifyEmailSchema), auth.cancelEmailChange)

// Invitations (M04): new people sign up through the link; signed-in people accept it.
router.post('/signup-with-invite', invitationLimiter, validate(signupWithInviteSchema), auth.signupWithInvite)
router.post('/accept-invitation', invitationLimiter, requireAuth, validate(acceptInvitationSchema), auth.acceptInvitation)

export default router
