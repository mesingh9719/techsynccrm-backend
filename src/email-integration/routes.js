import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { requireOrg, requireRole } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import * as c from './controller.js'
import * as v from './validators.js'

export const emailFoundationRoutes = Router()
emailFoundationRoutes.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
// Google cannot attach a bearer header. This callback authenticates using the one-use,
// browser-bound state and verifies that the originating CRM session is still live.
emailFoundationRoutes.get('/connect/google/callback', c.callback)
emailFoundationRoutes.use(requireOrg)
emailFoundationRoutes.get('/connect/google/start', rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { success: false, error: { code: 'RATE_LIMITED', message: 'Please wait a minute before trying again.' } } }), validate(v.startQuery, 'query'), c.start)
emailFoundationRoutes.get('/accounts/me', c.me)
emailFoundationRoutes.post('/accounts/:id/disconnect', validate(v.accountParams, 'params'), c.disconnectAccount)
emailFoundationRoutes.use('/admin', requireRole('owner', 'admin'))
emailFoundationRoutes.get('/admin/team', validate(v.teamQuery, 'query'), c.team)
emailFoundationRoutes.post('/admin/accounts/:id/disconnect', validate(v.accountParams, 'params'), c.disconnectAccount)
emailFoundationRoutes.post('/admin/remind', rateLimit({ windowMs: 60000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: { success: false, error: { code: 'RATE_LIMITED', message: 'Please wait a minute before trying again.' } } }), validate(v.reminderBody), c.remind)
emailFoundationRoutes.get('/admin/settings', c.settings)
emailFoundationRoutes.put('/admin/settings', validate(v.settingsBody), c.updateSettings)
