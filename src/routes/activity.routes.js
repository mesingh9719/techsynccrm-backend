import { Router } from 'express'
import * as a from '../controllers/activity.controller.js'
import { permit, requireOrg } from '../middlewares/org.js'
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
activityRoutes.use(requireOrg, permit('tasks.create'))
activityRoutes.post('/', validate(logActivitySchema), a.logActivity)
activityRoutes.patch('/:id', id, validate(updateActivitySchema), a.updateActivity)
activityRoutes.delete('/:id', id, a.deleteActivity)
activityRoutes.post('/:id/pin', id, validate(pinSchema), a.pinActivity)

export const taskRoutes = Router()
taskRoutes.use(requireOrg)
taskRoutes.get('/', permit('tasks.read'), validate(taskListQuery, 'query'), a.listTasks)
taskRoutes.get('/summary', permit('tasks.read'), a.summary)
taskRoutes.post('/', permit('tasks.create'), validate(createTaskSchema), a.createTask)
taskRoutes.post('/bulk', permit('tasks.update'), validate(taskBulkSchema), a.bulkTasks)
taskRoutes.get('/:id', permit('tasks.read'), id, a.getTask)
taskRoutes.patch('/:id', permit('tasks.update'), id, validate(updateTaskSchema), a.updateTask)
taskRoutes.delete('/:id', permit('tasks.update'), id, a.deleteTask)
taskRoutes.post('/:id/complete', permit('tasks.update'), id, validate(completeTaskSchema), a.completeTask)
taskRoutes.post('/:id/reopen', permit('tasks.update'), id, a.reopenTask)
taskRoutes.post('/:id/cancel', permit('tasks.update'), id, a.cancelTask)
