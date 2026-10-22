import * as campaigns from '../services/campaign.service.js'
import { listLeads } from '../services/lead.service.js'
import { concurrency } from './crm.controller.js'

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data })
const id = (req) => req.validated.params.id
export const list = async (req, res) => ok(res, await campaigns.listCampaigns(req.ctx, req.validated.query))
export const get = async (req, res) => ok(res, { campaign: await campaigns.getCampaign(req.ctx, id(req)) })
export const create = async (req, res) => ok(res, { campaign: await campaigns.createCampaign(req.ctx, req.body) }, 201)
export async function update(req, res) {
  const { body, expectedUpdatedAt } = concurrency(req)
  ok(res, { campaign: await campaigns.updateCampaign(req.ctx, id(req), body, { expectedUpdatedAt }) })
}
export async function setStatus(req, res) {
  const { body, expectedUpdatedAt } = concurrency(req)
  ok(res, { campaign: await campaigns.setCampaignStatus(req.ctx, id(req), body.status, { expectedUpdatedAt }) })
}
export const metaState = async (req, res) => ok(res, await campaigns.getMetaCampaignState(req.ctx, id(req)))
export async function remove(req, res) {
  await campaigns.deleteCampaign(req.ctx, id(req), { expectedUpdatedAt: req.get('if-match') })
  res.status(204).end()
}
export async function leads(req, res) {
  await campaigns.campaignFor(req.ctx, id(req))
  ok(res, await listLeads(req.ctx, { ...req.validated.query, campaignId: id(req) }))
}
export const syncMeta = async (req, res) => ok(res, await campaigns.syncMetaCampaigns(req.ctx, req.body))
