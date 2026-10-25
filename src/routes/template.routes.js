import { Router } from 'express'
import { requireOrg } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import * as schemas from '../validators/template.validators.js'
import * as controller from '../controllers/template.controller.js'

export const templateRoutes = Router()
templateRoutes.use(requireOrg, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
templateRoutes.get('/', validate(schemas.templateList, 'query'), controller.list)
templateRoutes.get('/variables', validate(schemas.variableCatalogueQuery, 'query'), controller.variables)
templateRoutes.post('/preview', validate(schemas.templatePreview), controller.preview)
templateRoutes.post('/:id/render', validate(schemas.templateId, 'params'), validate(schemas.templateRender), controller.render)
templateRoutes.post('/', validate(schemas.templateCreate), controller.create)
templateRoutes.patch('/:id', validate(schemas.templateId, 'params'), validate(schemas.templateUpdate), controller.update)
