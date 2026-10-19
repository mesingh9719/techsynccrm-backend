import * as leads from '../services/lead.service.js'
import * as setup from '../services/leadSetup.service.js'
import * as views from '../services/savedView.service.js'
import { allowDuplicate, concurrency } from './crm.controller.js'

/** Leads, lead sources, lost reasons and saved views (M08). */

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data })
const id = (req) => req.validated.params.id

export async function list(req, res) {
  ok(res, await leads.listLeads(req.ctx, req.validated.query))
}

export async function get(req, res) {
  ok(res, { lead: await leads.getLead(req.ctx, id(req)) })
}

export async function create(req, res) {
  ok(res, { lead: await leads.createLead(req.ctx, req.body, { allowDuplicate: allowDuplicate(req) }) }, 201)
}

export async function update(req, res) {
  const { body, expectedUpdatedAt } = concurrency(req)
  ok(res, { lead: await leads.updateLead(req.ctx, id(req), body, { expectedUpdatedAt, allowDuplicate: allowDuplicate(req) }) })
}

export async function remove(req, res) {
  await leads.deleteLead(req.ctx, id(req))
  res.status(204).end()
}

export async function restore(req, res) {
  ok(res, { lead: await leads.restoreLead(req.ctx, id(req)) })
}

export async function changeStatus(req, res) {
  ok(res, { lead: await leads.changeStatus(req.ctx, id(req), req.body) })
}

export async function claim(req, res) {
  ok(res, { lead: await leads.claimLead(req.ctx, id(req)) })
}

export async function assign(req, res) {
  ok(res, { lead: await leads.assignLead(req.ctx, id(req), req.body.ownerId) })
}

export async function convert(req, res) {
  ok(res, await leads.convertLead(req.ctx, id(req), req.body))
}

export async function conversionSuggestions(req, res) {
  ok(res, await leads.conversionSuggestions(req.ctx, id(req)))
}

export async function checkDuplicates(req, res) {
  ok(res, { duplicates: await leads.checkDuplicates(req.ctx, req.body) })
}

export async function bulk(req, res) {
  ok(res, await leads.bulkLeads(req.ctx, req.body))
}

// ---------- Sources & lost reasons ----------

export async function listSources(req, res) {
  ok(res, { sources: await setup.listSources(req.ctx) })
}

export async function createSource(req, res) {
  ok(res, { source: await setup.createSource(req.ctx, req.body) }, 201)
}

export async function updateSource(req, res) {
  ok(res, { source: await setup.updateSource(req.ctx, id(req), req.body) })
}

export async function deleteSource(req, res) {
  await setup.deleteSource(req.ctx, id(req))
  res.status(204).end()
}

export async function listLostReasons(req, res) {
  ok(res, { reasons: await setup.listLostReasons(req.ctx, req.validated.query.entityType) })
}

export async function createLostReason(req, res) {
  ok(res, { reason: await setup.createLostReason(req.ctx, req.body) }, 201)
}

export async function updateLostReason(req, res) {
  ok(res, { reason: await setup.updateLostReason(req.ctx, id(req), req.body) })
}

// ---------- Saved views ----------

export async function listViews(req, res) {
  ok(res, { views: await views.listViews(req.ctx, req.validated.query.entityType) })
}

export async function createView(req, res) {
  ok(res, { view: await views.createView(req.ctx, req.body) }, 201)
}

export async function updateView(req, res) {
  ok(res, { view: await views.updateView(req.ctx, id(req), req.body) })
}

export async function deleteView(req, res) {
  await views.deleteView(req.ctx, id(req))
  res.status(204).end()
}
