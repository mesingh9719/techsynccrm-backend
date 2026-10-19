import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { env } from '../config/env.js'
import * as forms from '../controllers/public.controller.js'
import { validate } from '../middlewares/validate.js'
import { lookupInvitation } from '../controllers/team.controller.js'
import { tokenParams } from '../validators/team.validators.js'
import { contactSchema, demoSchema, demoSlotsQuerySchema, newsletterSchema, tokenSchema } from '../validators/public.validators.js'

/** Unauthenticated endpoints used by the marketing site. Mounted at /api/public. */
const router = Router()

/** Per-IP limit for each form, with its own counter so one form can't exhaust another. */
const formLimiter = (max = env.PUBLIC_FORM_RATE_LIMIT_MAX) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, error: { message: 'Too many submissions. Please try again in a few minutes.', code: 'RATE_LIMITED' } },
  })

router.post('/contact', formLimiter(), validate(contactSchema), forms.submitContact)

router.get('/demo-slots', validate(demoSlotsQuerySchema, 'query'), forms.getDemoSlots)
router.post('/demo-requests', formLimiter(), validate(demoSchema), forms.requestDemo)

router.post('/newsletter', formLimiter(), validate(newsletterSchema), forms.subscribeNewsletter)
router.post('/newsletter/confirm', formLimiter(30), validate(tokenSchema), forms.confirmNewsletter)
router.post('/newsletter/unsubscribe', formLimiter(30), validate(tokenSchema), forms.unsubscribeNewsletter)

// Invitation details for the /invite page, before the person signs in (M04).
router.get('/invitations/:token', formLimiter(60), validate(tokenParams, 'params'), lookupInvitation)

export default router
