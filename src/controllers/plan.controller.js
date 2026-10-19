import { planCatalogue } from '../config/plans.js'
import { auditContext } from '../lib/audit.js'
import * as planService from '../services/plan.service.js'

/** GET /api/meta/plans — public plan catalogue. */
export function catalogue(_req, res) {
  res.set('Cache-Control', 'public, max-age=3600')
  res.json({ success: true, data: { plans: planCatalogue() } })
}

export async function upgradeRequest(req, res) {
  res.status(202).json({ success: true, data: await planService.requestUpgrade(req.ctx, req.body) })
}

export async function seatSelection(req, res) {
  res.json({ success: true, data: await planService.selectSeats(req.ctx, req.body.keepUserIds) })
}

// ---------- Staff (/api/internal) ----------

export async function extendTrial(req, res) {
  res.json({ success: true, data: await planService.extendTrial(auditContext(req), req.validated.params.id, req.body.days) })
}

export async function setPlan(req, res) {
  res.json({ success: true, data: await planService.setPlanByStaff(auditContext(req), req.validated.params.id, req.body.plan) })
}
