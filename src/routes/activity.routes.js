import { Router } from 'express'
import * as a from '../controllers/activity.controller.js'
import { permit, requireOrg } from '../middlewares/org.js'
import { hasPermission } from '../config/permissions.js'
import { ApiError } from '../utils/ApiError.js'

const FORBIDDEN = () => new ApiError(403, 'You don’t have permission to do that.', { code: 'FORBIDDEN' })
import { validate } from '../middlewares/validate.js'
import { idParams } from '../validators/crm.validators.js'
import {
  completeTaskSchema,
  createTaskSchema,
  logActivitySchema,
  pinSchema,
  taskBulkSchema,
  taskListQuery,
  timelineQuery,
  updateActivitySchema,
  updateTaskSchema,
} from '../validators/activity.validators.js'

/**
 * Timeline (/api/timeline), activities (/api/activities) and tasks (/api/tasks) — M10. Access to the
 * linked record (read for logging; update for pinning) is checked in the services.
 */

const id = validate(idParams, 'params')

export const timelineRoutes = Router()
timelineRoutes.use(requireOrg)
timelineRoutes.get('/', validate(timelineQuery, 'query'), a.timeline)

/** Viewers are read-only (no tasks.create); everyone else can log on records they can see. */
export const activityRoutes = Router()
// Logging activity needs tasks.create; roles that can only call (leads.call / contacts.call) may log calls.
activityRoutes.use(requireOrg, (req, _res, next) => {
  const perms = req.ctx.permissions
  if (hasPermission(perms, 'tasks.create')) return next()
  const canCall = perms.includes('leads.call') || perms.includes('contacts.call')
  if (canCall && req.method === 'POST' && req.path === '/' && req.body?.type === 'call') return next()
  next(FORBIDDEN())
})
activityRoutes.post('/', validate(logActivitySchema), a.logActivity)
activityRoutes.patch('/:id', id, validate(updateActivitySchema), a.updateActivity)
activityRoutes.delete('/:id', id, a.deleteActivity)
activityRoutes.post('/:id/pin', id, validate(pinSchema), a.pinActivity)

export const taskRoutes = Router()
taskRoutes.use(requireOrg)
taskRoutes.get('/', permit('tasks.list'), validate(taskListQuery, 'query'), a.listTasks)
taskRoutes.get('/summary', permit('tasks.list'), a.summary)
taskRoutes.post('/', permit('tasks.create'), validate(createTaskSchema), a.createTask)
taskRoutes.post('/bulk', permit('tasks.update'), validate(taskBulkSchema), a.bulkTasks)
taskRoutes.get('/:id', permit('tasks.view'), id, a.getTask)
taskRoutes.patch('/:id', permit('tasks.update'), id, validate(updateTaskSchema), a.updateTask)
taskRoutes.delete('/:id', permit('tasks.delete'), id, a.deleteTask)
taskRoutes.post('/:id/complete', permit('tasks.update'), id, validate(completeTaskSchema), a.completeTask)
taskRoutes.post('/:id/reopen', permit('tasks.update'), id, a.reopenTask)
taskRoutes.post('/:id/cancel', permit('tasks.update'), id, a.cancelTask)
