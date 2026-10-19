import { Router } from 'express'
import * as orgs from '../controllers/organization.controller.js'
import { requireAuth } from '../middlewares/auth.js'
import * as plans from '../controllers/plan.controller.js'
import { permit, requireOrg, requireRole } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import {
  createOrganizationSchema,
  deleteOrganizationSchema,
  seatSelectionSchema,
  transferOwnershipSchema,
  updateOrganizationSchema,
  upgradeRequestSchema,
} from '../validators/organization.validators.js'
import { transferOwnership } from '../controllers/team.controller.js'

/** Workspaces. Mounted at /api/organizations. "current" = the workspace in the access token. */
const router = Router()

router.get('/', requireAuth, orgs.list)
router.post('/', requireAuth, validate(createOrganizationSchema), orgs.create)

router.get('/current', requireOrg, orgs.getCurrent)
router.patch('/current', requireOrg, permit('settings.workspace.manage'), validate(updateOrganizationSchema), orgs.updateCurrent)
router.delete('/current', requireOrg, permit('organization.delete'), validate(deleteOrganizationSchema), orgs.deleteCurrent)
router.post('/current/transfer-ownership', requireOrg, permit('ownership.transfer'), validate(transferOwnershipSchema), transferOwnership)

// Plans (M06). Any member can ask for an upgrade; only the owner chooses who keeps a seat.
router.post('/current/upgrade-request', requireOrg, validate(upgradeRequestSchema), plans.upgradeRequest)
router.post('/current/seat-selection', requireOrg, requireRole('owner'), validate(seatSelectionSchema), plans.seatSelection)

router.get('/current/checklist', requireOrg, orgs.getChecklist)
router.post('/current/checklist/dismiss', requireOrg, orgs.dismissChecklist)

export default router
