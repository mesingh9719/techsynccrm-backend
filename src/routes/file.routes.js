import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { requireOrg, permit } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import { fileLinkParams, fileListQuery, fileRef, optionalFileRef, uploadIntentSchema } from '../validators/file.validators.js'
import * as f from '../controllers/file.controller.js'
const router = Router()
const id = validate(z.object({ id: z.uuid('Invalid file id') }), 'params')
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 ** 2, files: 1 } }).single('file')
router.use(requireOrg)
router.post('/upload-intent', permit('tasks.create'), validate(uploadIntentSchema), f.intent)
router.post('/', permit('tasks.create'), upload, validate(optionalFileRef), f.upload)
router.get('/', validate(fileListQuery, 'query'), f.list)
router.post('/:id/complete', id, f.complete)
router.post('/:id/restore', id, f.restore)
router.post('/:id/links', id, validate(fileRef), f.link)
router.delete('/:id/links/:entityType/:entityId', validate(fileLinkParams, 'params'), f.unlink)
router.get('/:id', id, f.getOne)
router.delete('/:id', id, f.remove)
export default router
