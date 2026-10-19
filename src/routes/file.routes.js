import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { env } from '../config/env.js'
import * as files from '../controllers/file.controller.js'
import { requireAuth, requireVerified } from '../middlewares/auth.js'
import { validate } from '../middlewares/validate.js'

const router = Router()

// Files are buffered in memory (bounded by MAX_UPLOAD_MB) and streamed to Object Storage.
const uploadSingle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
}).single('file')

const idParams = validate(z.object({ id: z.uuid('Invalid file id') }), 'params')

router.use(requireAuth, requireVerified)
router.post('/', uploadSingle, files.upload)
router.get('/', files.list)
router.get('/:id', idParams, files.getOne)
router.delete('/:id', idParams, files.remove)

export default router
