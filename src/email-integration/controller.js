import { guarded, callback } from '../controllers/gmail.controller.js'
import { cookieName, cookieOptions, CONSENT_VERSION } from '../integrations/gmail/config.js'
import { startLogin, disconnect } from '../integrations/gmail/connection.js'
import * as service from './service.js'

const ok = (res, data) => res.json({ success: true, data })
export const start = guarded(async (req, res) => {
  const result = await startLogin(req.ctx, { returnTo: req.validated.query.returnTo, consentVersion: CONSENT_VERSION, backfillDays: 0, excludedAddresses: [], excludedDomains: [] })
  res.cookie(cookieName, result.browser, cookieOptions())
  ok(res, { url: result.url, expiresAt: result.expiresAt })
})
export { callback }
export const me = guarded(async (req, res) => ok(res, await service.emailMe(req.ctx)))
export const disconnectAccount = guarded(async (req, res) => ok(res, await disconnect(req.ctx, req.params.id)))
export const team = guarded(async (req, res) => ok(res, await service.teamEmail(req.ctx, req.validated.query)))
export const remind = guarded(async (req, res) => ok(res, await service.remindTeam(req.ctx, req.body)))
export const settings = guarded(async (req, res) => { service.requireEmailAdmin(req.ctx); ok(res, await service.getSettings(req.ctx.orgId)) })
export const updateSettings = guarded(async (req, res) => ok(res, await service.updateTenantSettings(req.ctx, req.body)))
