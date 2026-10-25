import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { requireOrg, permit } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import { ApiError } from '../utils/ApiError.js'
import { tenantSettings } from '../integrations/google/access.js'
import { GOOGLE_SERVICES, CONSENT_VERSION, cookieName, cookieOptions } from '../integrations/google/config.js'
import * as google from '../integrations/google/connection.js'
import { googleResourcesRoutes } from './googleResources.routes.js'

const guarded = (fn) => async (req, res, next) => {
  try { await fn(req, res) } catch (error) {
    next(error instanceof ApiError ? error : new ApiError(503, 'Google Workspace is temporarily unavailable. Please try again.', { code: 'GOOGLE_UNAVAILABLE' }))
  }
}
const ok = (res, data) => res.json({ success: true, data })
const service = z.enum(GOOGLE_SERVICES)
const id = validate(z.object({ id: z.uuid() }), 'params')
const limited = rateLimit({ windowMs: 60000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Wait a moment before connecting Google again.' } } })
export const googleWorkspaceRoutes = Router()
googleWorkspaceRoutes.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next() })
googleWorkspaceRoutes.get('/oauth/callback', limited, async (req, res) => {
  let returnTo, status = 'GOOGLE_OAUTH_FAILED'
  try { const result = await google.finish(req.query, req.cookies?.[cookieName]); returnTo = result.returnTo; status = result.status }
  catch (error) {
    returnTo = error.returnTo
    if (error instanceof ApiError && /^GOOGLE_[A-Z_]+$/.test(error.code || '')) status = error.code
  }
  const { maxAge: _maxAge, ...options } = cookieOptions(); res.clearCookie(cookieName, options)
  res.redirect(303, google.callbackDestination(returnTo, status))
})
googleWorkspaceRoutes.use(requireOrg)
googleWorkspaceRoutes.use(googleResourcesRoutes)
googleWorkspaceRoutes.get('/connections/me', guarded(async (req, res) => ok(res, await google.me(req.ctx))))
googleWorkspaceRoutes.post('/oauth/start', permit('google.connect.own'), limited,
  validate(z.object({ service, consentVersion: z.literal(CONSENT_VERSION), returnTo: z.string().max(160).optional() }).strict()), guarded(async (req, res) => {
    const { browser, ...result } = await google.start(req.ctx, req.body)
    res.cookie(cookieName, browser, cookieOptions()); ok(res, result)
  }))
googleWorkspaceRoutes.patch('/connections/:id/services/:service', validate(z.object({ id: z.uuid(), service }), 'params'),
  validate(z.object({ enabled: z.boolean(), consentVersion: z.string().max(100).optional() }).strict()), guarded(async (req, res) => ok(res, await google.setService(req.ctx, req.params.id, req.params.service, req.body))))
googleWorkspaceRoutes.post('/connections/:id/disconnect', id, guarded(async (req, res) => ok(res, await google.disconnect(req.ctx, req.params.id))))
googleWorkspaceRoutes.post('/connections/:id/revoke-project-grant', id, limited,
  validate(z.object({ confirmProjectRevocation: z.literal(true) }).strict()), guarded(async (req, res) => ok(res, await google.disconnect(req.ctx, req.params.id, { projectWide: true }))))
googleWorkspaceRoutes.use('/admin', permit('google.connections.manage'))
const page = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25), q: z.string().max(100).default('') })
googleWorkspaceRoutes.get('/admin/connections', validate(page, 'query'), guarded(async (req, res) => ok(res, await google.adminConnections(req.ctx, req.validated.query))))
googleWorkspaceRoutes.post('/admin/connections/:id/disconnect', id, guarded(async (req, res) => ok(res, await google.disconnect(req.ctx, req.params.id, { admin: true }))))
googleWorkspaceRoutes.get('/admin/settings', guarded(async (req, res) => ok(res, await tenantSettings(req.ctx.orgId))))
googleWorkspaceRoutes.patch('/admin/settings', validate(z.object({ calendarEnabled: z.boolean().optional(), driveEnabled: z.boolean().optional(), sheetsEnabled: z.boolean().optional(), exportsEnabled: z.boolean().optional() }).strict().refine((value) => Object.keys(value).length > 0, 'Choose a setting to update.')),
  guarded(async (req, res) => ok(res, await google.updateTenantSettings(req.ctx, req.body))))
googleWorkspaceRoutes.get('/admin/sync-logs', validate(page.extend({ service: service.optional() }), 'query'), guarded(async (req, res) => ok(res, await google.syncLogs(req.ctx, req.validated.query))))
