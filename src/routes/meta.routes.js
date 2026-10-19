import { Router } from 'express'
import * as plans from '../controllers/plan.controller.js'

/** Public reference data. Mounted at /api/meta. */
const router = Router()

router.get('/plans', plans.catalogue)

export default router
