import { Router } from 'express'
import * as forms from '../controllers/public.controller.js'
import { requireAuth, requireVerified } from '../middlewares/auth.js'
import { requireStaff } from '../middlewares/staff.js'
import { validate } from '../middlewares/validate.js'
import { inboundListQuerySchema } from '../validators/public.validators.js'
import * as plans from '../controllers/plan.controller.js'
import { extendTrialSchema, organizationIdParamSchema, setPlanSchema } from '../validators/organization.validators.js'

/** TechSync staff tools. Mounted at /api/internal. Non-staff get a 404 so the routes aren't advertised. */
const router = Router()

router.use(requireAuth, requireStaff, requireVerified)
router.get('/inbound', validate(inboundListQuerySchema, 'query'), forms.listInbound)

// Plans (M06): extend a trial (max +14 days) or set a plan by hand until billing (M16).
router.post('/organizations/:id/extend-trial', validate(organizationIdParamSchema, 'params'), validate(extendTrialSchema), plans.extendTrial)
router.post('/organizations/:id/plan', validate(organizationIdParamSchema, 'params'), validate(setPlanSchema), plans.setPlan)

export default router
