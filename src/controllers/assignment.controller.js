import * as assignment from '../services/assignment.service.js'

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data })

export const listRules = async (req, res) => ok(res, { rules: await assignment.listRules(req.ctx) })
export const createRule = async (req, res) => ok(res, { rule: await assignment.createRule(req.ctx, req.body) }, 201)
export const updateRule = async (req, res) => ok(res, { rule: await assignment.updateRule(req.ctx, req.validated.params.id, req.body) })
export async function deleteRule(req, res) {
  await assignment.deleteRule(req.ctx, req.validated.params.id)
  res.status(204).end()
}
export const orderRules = async (req, res) => ok(res, { rules: await assignment.orderRules(req.ctx, req.body.ids) })
export const test = async (req, res) => ok(res, await assignment.testAssignment(req.ctx, req.body.leadSample))

export const getHours = async (req, res) => ok(res, await assignment.getHours(req.ctx))
export const saveHours = async (req, res) => ok(res, await assignment.saveHours(req.ctx, req.body))

export const listAbsences = async (req, res) => ok(res, { items: await assignment.listAbsences(req.ctx) })
export const addAbsence = async (req, res) => ok(res, { outOfOffice: await assignment.addAbsence(req.ctx, req.body) }, 201)
export async function deleteAbsence(req, res) {
  await assignment.deleteAbsence(req.ctx, req.validated.params.id)
  res.status(204).end()
}
