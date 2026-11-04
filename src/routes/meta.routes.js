import { Router } from 'express'
import * as industries from '../controllers/industry.controller.js'
import * as plans from '../controllers/plan.controller.js'

/** Public reference data. Mounted at /api/meta. */
const router = Router()

router.get('/plans', plans.catalogue)
router.get('/industries', industries.list)

export default router
