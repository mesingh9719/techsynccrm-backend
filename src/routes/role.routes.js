import { Router } from 'express'
import * as roles from '../controllers/role.controller.js'
import { permit, requireOrg } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import { createRoleSchema, deleteRoleSchema, previewRoleSchema, resetRoleSchema, roleIdParams, updateRoleSchema } from '../validators/role.validators.js'

/** Roles of the current workspace (/api/roles). Reading is open to every member; changes need roles.manage. */
export const roleRoutes = Router()
roleRoutes.use(requireOrg)
roleRoutes.get('/', roles.list)
roleRoutes.get('/catalogue', roles.catalogue)
roleRoutes.get('/me', roles.me)
const manage = permit('roles.manage')
const id = validate(roleIdParams, 'params')
roleRoutes.post('/', manage, validate(createRoleSchema), roles.create)
roleRoutes.post('/preview', manage, validate(previewRoleSchema), roles.preview)
roleRoutes.patch('/:id', manage, id, validate(updateRoleSchema), roles.update)
roleRoutes.post('/:id/reset', manage, id, validate(resetRoleSchema), roles.reset)
// DELETE with a body: where the role's members and invitations move to.
roleRoutes.delete('/:id', manage, id, validate(deleteRoleSchema), roles.remove)
