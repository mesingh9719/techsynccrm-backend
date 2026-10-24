import { Router } from 'express'
import { requireOrg, permit } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import * as schema from '../validators/assignment.validators.js'
import * as assignment from '../controllers/assignment.controller.js'

/** Lead assignment (M14). Rules and working hours are workspace settings; out-of-office is per member. */
export const assignmentRuleRoutes = Router()
assignmentRuleRoutes.use(requireOrg, permit('settings.workspace.manage'))
assignmentRuleRoutes.get('/', assignment.listRules)
assignmentRuleRoutes.post('/', validate(schema.assignmentRuleSchema), assignment.createRule)
// Static paths before /:id.
assignmentRuleRoutes.patch('/order', validate(schema.ruleOrderSchema), assignment.orderRules)
assignmentRuleRoutes.post('/test', validate(schema.assignmentTestSchema), assignment.test)
assignmentRuleRoutes.patch('/:id', validate(schema.ruleIdParams, 'params'), validate(schema.assignmentRuleSchema), assignment.updateRule)
assignmentRuleRoutes.delete('/:id', validate(schema.ruleIdParams, 'params'), assignment.deleteRule)

export const workingHoursRoutes = Router()
workingHoursRoutes.use(requireOrg)
workingHoursRoutes.get('/', permit('settings.workspace.manage'), assignment.getHours)
workingHoursRoutes.put('/', permit('settings.workspace.manage'), validate(schema.workingHoursSchema), assignment.saveHours)

export const outOfOfficeRoutes = Router()
outOfOfficeRoutes.use(requireOrg)
outOfOfficeRoutes.get('/', assignment.listAbsences)
outOfOfficeRoutes.post('/', validate(schema.outOfOfficeSchema), assignment.addAbsence)
outOfOfficeRoutes.delete('/:id', validate(schema.absenceIdParams, 'params'), assignment.deleteAbsence)
