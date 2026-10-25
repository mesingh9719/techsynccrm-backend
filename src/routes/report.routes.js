import { Router } from 'express'
import { permit, requireOrg } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import { reportQuery } from '../validators/report.validators.js'
import * as reports from '../services/report.service.js'

/** /api/reports (M15) — scope comes from reports.read.{all,team,own}; the service enforces it. */
export const reportRoutes = Router()
reportRoutes.use(requireOrg, permit('reports.read'))

const handler = (fn) => async (req, res) => {
  const query = req.validated.query
  const period = query.from ? {} : reports.defaultPeriod(req.ctx.timezone)
  res.set('Cache-Control', 'private, no-store')
  res.json({ success: true, data: await fn(req.ctx, { ...query, ...period }) })
}

const q = validate(reportQuery, 'query')
reportRoutes.get('/kpis', q, handler(reports.kpis))
reportRoutes.get('/revenue-series', q, handler(reports.revenueSeries))
reportRoutes.get('/leads-by-source', q, handler(reports.leadsBySource))
reportRoutes.get('/funnel', q, handler(reports.funnel))
reportRoutes.get('/leaderboard', q, handler(reports.leaderboard))
reportRoutes.get('/first-response', q, handler(reports.firstResponse))
reportRoutes.get('/follow-ups', q, handler(reports.followUps))

// The client uses the shared, authenticated HTTP client and CSV encoder. Authorization and
// auditing happen here before releasing the export dataset, including for direct API callers.
reportRoutes.get('/:report/export', permit('records.export'), q, async (req, res) => {
  const query = req.validated.query
  res.set('Cache-Control', 'private, no-store')
  res.json({ success: true, data: await reports.exportReport(req.ctx, req.params.report, { ...query, ...(!query.from && reports.defaultPeriod(req.ctx.timezone)) }) })
})
