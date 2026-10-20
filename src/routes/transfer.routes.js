import { Router } from 'express'
import { requireOrg, permit } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import { idParams } from '../validators/crm.validators.js'
import { createImportSchema, updateImportSchema, exportSchema } from '../validators/transfer.validators.js'
import * as t from '../controllers/transfer.controller.js'
const id = validate(idParams, 'params')
export const importRoutes = Router()
importRoutes.use(requireOrg, permit('records.import'))
importRoutes.get('/', t.importHistory)
importRoutes.post('/', validate(createImportSchema), t.createImport)
importRoutes.get('/:id', id, t.importStatus)
importRoutes.patch('/:id', id, validate(updateImportSchema), t.updateImport)
importRoutes.post('/:id/preview', id, t.previewImport)
importRoutes.post('/:id/start', id, t.startImport)
importRoutes.post('/:id/cancel', id, t.cancelImport)
importRoutes.post('/:id/undo', id, t.undoImport)
importRoutes.get('/:id/errors', id, t.importErrors)
export const exportRoutes = Router()
exportRoutes.use(requireOrg, permit('records.export'))
exportRoutes.get('/', t.exportHistory)
exportRoutes.post('/', validate(exportSchema), t.createExport)
exportRoutes.get('/:id', id, t.exportStatus)
