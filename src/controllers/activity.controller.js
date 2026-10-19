import * as activities from '../services/activity.service.js'
import * as tasks from '../services/task.service.js'

/** Timeline, activities and tasks (M10). */

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data })
const id = (req) => req.validated.params.id

export async function timeline(req, res) {
  ok(res, await activities.timeline(req.ctx, req.validated.query))
}

export async function logActivity(req, res) {
  ok(res, { activity: await activities.logActivity(req.ctx, req.body) }, 201)
}

export async function updateActivity(req, res) {
  ok(res, { activity: await activities.updateActivity(req.ctx, id(req), req.body) })
}

export async function deleteActivity(req, res) {
  await activities.deleteActivity(req.ctx, id(req))
  res.status(204).end()
}

export async function pinActivity(req, res) {
  ok(res, { activity: await activities.pinActivity(req.ctx, id(req), req.body.pinned) })
}

export async function listTasks(req, res) {
  ok(res, await tasks.listTasks(req.ctx, req.validated.query))
}

export async function summary(req, res) {
  ok(res, await tasks.mySummary(req.ctx))
}

export async function getTask(req, res) {
  ok(res, { task: await tasks.getTask(req.ctx, id(req)) })
}

export async function createTask(req, res) {
  ok(res, { task: await tasks.createTask(req.ctx, req.body) }, 201)
}

export async function updateTask(req, res) {
  ok(res, { task: await tasks.updateTask(req.ctx, id(req), req.body) })
}

export async function deleteTask(req, res) {
  await tasks.deleteTask(req.ctx, id(req))
  res.status(204).end()
}

export async function completeTask(req, res) {
  ok(res, { task: await tasks.completeTask(req.ctx, id(req), req.body) })
}

export async function reopenTask(req, res) {
  ok(res, { task: await tasks.reopenTask(req.ctx, id(req)) })
}

export async function cancelTask(req, res) {
  ok(res, { task: await tasks.cancelTask(req.ctx, id(req)) })
}

export async function bulkTasks(req, res) {
  ok(res, await tasks.bulkTasks(req.ctx, req.body))
}
