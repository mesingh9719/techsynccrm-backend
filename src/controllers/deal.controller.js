import * as deals from '../services/deal.service.js'
import * as pipelines from '../services/pipeline.service.js'
import { concurrency } from './crm.controller.js'

/** Pipelines, stages and deals (M09). */

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data })
const params = (req) => req.validated.params

// ---------- Pipelines ----------

export async function listPipelines(req, res) {
  ok(res, { pipelines: await pipelines.listPipelines(req.ctx) })
}

export async function listTemplates(_req, res) {
  ok(res, { templates: pipelines.listTemplates() })
}

export async function createPipeline(req, res) {
  ok(res, { pipeline: await pipelines.createPipeline(req.ctx, req.body) }, 201)
}

export async function updatePipeline(req, res) {
  ok(res, { pipeline: await pipelines.updatePipeline(req.ctx, params(req).id, req.body) })
}

export async function deletePipeline(req, res) {
  await pipelines.deletePipeline(req.ctx, params(req).id, req.body ?? {})
  res.status(204).end()
}

export async function createStage(req, res) {
  ok(res, { pipeline: await pipelines.createStage(req.ctx, params(req).id, req.body) }, 201)
}

export async function updateStage(req, res) {
  ok(res, { pipeline: await pipelines.updateStage(req.ctx, params(req).id, params(req).stageId, req.body) })
}

export async function deleteStage(req, res) {
  ok(res, { pipeline: await pipelines.deleteStage(req.ctx, params(req).id, params(req).stageId, req.body ?? {}) })
}

export async function reorderStages(req, res) {
  ok(res, { pipeline: await pipelines.reorderStages(req.ctx, params(req).id, req.body.stageIds) })
}

// ---------- Deals ----------

export async function board(req, res) {
  ok(res, await deals.board(req.ctx, req.validated.query))
}

export async function list(req, res) {
  ok(res, await deals.listDeals(req.ctx, req.validated.query))
}

export async function forecast(req, res) {
  ok(res, await deals.forecast(req.ctx, req.validated.query))
}

export async function get(req, res) {
  ok(res, { deal: await deals.getDeal(req.ctx, params(req).id) })
}

export async function history(req, res) {
  ok(res, { history: await deals.getHistory(req.ctx, params(req).id) })
}

export async function create(req, res) {
  ok(res, { deal: await deals.createDeal(req.ctx, req.body) }, 201)
}

export async function update(req, res) {
  const { body, expectedUpdatedAt } = concurrency(req)
  ok(res, { deal: await deals.updateDeal(req.ctx, params(req).id, body, { expectedUpdatedAt }) })
}

export async function move(req, res) {
  const { body, expectedUpdatedAt } = concurrency(req)
  ok(res, { deal: await deals.moveDeal(req.ctx, params(req).id, body, { expectedUpdatedAt }) })
}

export async function addContact(req, res) {
  ok(res, { deal: await deals.addDealContact(req.ctx, params(req).id, req.body) })
}

export async function removeContact(req, res) {
  ok(res, { deal: await deals.removeDealContact(req.ctx, params(req).id, params(req).contactId) })
}

export async function remove(req, res) {
  await deals.deleteDeal(req.ctx, params(req).id)
  res.status(204).end()
}

export async function restore(req, res) {
  ok(res, { deal: await deals.restoreDeal(req.ctx, params(req).id) })
}

export async function bulk(req, res) {
  ok(res, await deals.bulkDeals(req.ctx, req.body))
}
