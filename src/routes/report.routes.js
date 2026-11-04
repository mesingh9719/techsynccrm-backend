import { Router } from 'express'
import { permit, requireOrg } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import { reportQuery, scheduleBody, scheduleParams, targetsBody, targetsQuery } from '../validators/report.validators.js'
import * as reports from '../services/report.service.js'
import * as targets from '../services/target.service.js'
import * as schedules from '../services/reportSchedule.service.js'

/** /api/reports (M15) — scope comes from reports.read.{all,team,own}; the service enforces it. */
export const reportRoutes = Router()
reportRoutes.use(requireOrg, permit('reports.read'))
reportRoutes.use((_req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  next()
})

const handler = (fn) => async (req, res) => {
  const query = req.validated.query
  const period = query.from ? {} : reports.defaultPeriod(req.ctx.timezone)
  res.json({ success: true, data: await fn(req.ctx, { ...query, ...period }) })
}

const q = validate(reportQuery, 'query')
reportRoutes.get('/kpis', q, handler(reports.kpis))
reportRoutes.get('/trend', q, handler(reports.trend))
reportRoutes.get('/revenue-series', q, handler(reports.revenueSeries))
reportRoutes.get('/leads-by-source', q, handler(reports.leadsBySource))
reportRoutes.get('/funnel', q, handler(reports.funnel))
reportRoutes.get('/leaderboard', q, handler(reports.leaderboard))
reportRoutes.get('/pipeline', q, handler(reports.pipeline))
reportRoutes.get('/forecast', q, handler(reports.forecast))
reportRoutes.get('/lost-reasons', q, handler(reports.lostReasons))
reportRoutes.get('/campaigns', q, handler(reports.campaigns))
reportRoutes.get('/activity', q, handler(reports.activity))
reportRoutes.get('/first-response', q, handler(reports.firstResponse))
reportRoutes.get('/follow-ups', q, handler(reports.followUps))

// Monthly targets: everyone in report scope can read; targets.manage.{all,team} can set them.
reportRoutes.get('/targets', validate(targetsQuery, 'query'), async (req, res) => {
  res.json({ success: true, data: await targets.listTargets(req.ctx, req.validated.query.month) })
})
reportRoutes.put('/targets', permit('targets.manage'), validate(targetsBody), async (req, res) => {
  res.json({ success: true, data: await targets.saveTargets(req.ctx, req.body) })
})

// The caller's own emailed summaries.
reportRoutes.get('/schedules', async (req, res) => {
  res.json({ success: true, data: await schedules.listSchedules(req.ctx) })
})
reportRoutes.put('/schedules/:frequency', validate(scheduleParams, 'params'), validate(scheduleBody), async (req, res) => {
  res.json({ success: true, data: await schedules.saveSchedule(req.ctx, req.validated.params.frequency, req.body) })
})

// The client uses the shared, authenticated HTTP client and CSV encoder. Authorization and
// auditing happen here before releasing the export dataset, including for direct API callers.
reportRoutes.get('/:report/export', permit('reports.export'), q, async (req, res) => {
  const query = req.validated.query
  res.json({ success: true, data: await reports.exportReport(req.ctx, req.params.report, { ...query, ...(!query.from && reports.defaultPeriod(req.ctx.timezone)) }) })
})
