import { Router } from 'express'
import { requireOrg, permit } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import * as schema from '../validators/webForm.validators.js'
import * as forms from '../controllers/webForm.controller.js'

/** Web form builder (M14). Mounted at /api/forms; the public side lives in public.routes.js. */
export const webFormRoutes = Router()
webFormRoutes.use(requireOrg, permit('settings.forms.manage'))
webFormRoutes.get('/', forms.list)
webFormRoutes.post('/', validate(schema.createWebFormSchema), forms.create)
webFormRoutes.get('/:id', validate(schema.webFormIdParams, 'params'), forms.getOne)
webFormRoutes.patch('/:id', validate(schema.webFormIdParams, 'params'), validate(schema.updateWebFormSchema), forms.update)
webFormRoutes.delete('/:id', validate(schema.webFormIdParams, 'params'), forms.remove)
webFormRoutes.get('/:id/submissions', validate(schema.webFormIdParams, 'params'), validate(schema.submissionsQuery, 'query'), forms.submissions)
webFormRoutes.get('/:id/embed-code', validate(schema.webFormIdParams, 'params'), forms.embedCode)
