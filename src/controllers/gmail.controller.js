import { logger } from '../lib/logger.js'
import { ApiError } from '../utils/ApiError.js'
import * as connection from '../integrations/gmail/connection.js'
import * as mail from '../integrations/gmail/mail.js'
import { acceptPush, deleteHistory } from '../integrations/gmail/maintenance.js'
import { cookieName, cookieOptions } from '../integrations/gmail/config.js'
import { safeFailure } from '../integrations/gmail/jobs.js'

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data })
// Do not forward Google/Gaxios/KMS exceptions (which may include request credentials) to the global logger.
export const guarded = (fn) => async (req, res, next) => {
  try { await fn(req, res) } catch (error) {
    if (error instanceof ApiError) return next(error)
    next(new ApiError(503, 'Gmail is temporarily unavailable. Your existing CRM data is safe.', { code: safeFailure(error) }))
  }
}
export const me = guarded(async (req, res) => ok(res, await connection.gmailMe(req.ctx)))
export const start = guarded(async (req, res) => {
  const { url, browser, expiresAt } = await connection.startLogin(req.ctx, req.body)
  res.cookie(cookieName, browser, cookieOptions()); ok(res, { url, expiresAt })
})
export async function callback(req, res) {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  let result, code
  try { result = await connection.finishLogin(req.query, req.cookies?.[cookieName]) }
  catch (error) {
    code = ['GMAIL_OAUTH_CANCELLED', 'GMAIL_OAUTH_EXPIRED', 'GMAIL_OAUTH_INVALID', 'GMAIL_SCOPES_MISSING', 'GMAIL_RECONNECT_REQUIRED', 'GMAIL_ACCOUNT_UNAVAILABLE', 'GMAIL_NOT_CONFIGURED', 'GMAIL_DELETION_PENDING'].includes(error.code) ? error.code : 'GMAIL_OAUTH_FAILED'
    logger.warn({ code }, 'Gmail connection was not completed')
  }
  const { maxAge: _maxAge, ...options } = cookieOptions(); res.clearCookie(cookieName, options)
  res.redirect(303, connection.callbackDestination(result, code))
}
export const accounts = guarded(async (req, res) => ok(res, await connection.listAccounts(req.ctx, req.validated.query)))
export const disconnect = guarded(async (req, res) => ok(res, await connection.disconnect(req.ctx, req.params.id)))
export const settingsUpdate = guarded(async (req, res) => ok(res, await connection.updateSettings(req.ctx, req.body)))
export const sync = guarded(async (req, res) => ok(res, await connection.requestSync(req.ctx), 202))
export const historyDelete = guarded(async (req, res) => ok(res, await deleteHistory(req.ctx, req.params.id), 202))
export const send = guarded(async (req, res) => ok(res, { message: await mail.queueSend(req.ctx, req.body, req.get('idempotency-key')) }, 202))
export const message = guarded(async (req, res) => ok(res, { message: await mail.getMessage(req.ctx, req.params.id) }))
export const threads = guarded(async (req, res) => { const q = req.validated.query; ok(res, await mail.listThreads(req.ctx, q.entityType, q.entityId, q)) })
export const messages = guarded(async (req, res) => ok(res, await mail.threadMessages(req.ctx, req.params.id, req.validated.query)))
export const templates = guarded(async (req, res) => ok(res, { items: await mail.templates(req.ctx) }))
export const templateSave = guarded(async (req, res) => ok(res, { template: await mail.saveTemplate(req.ctx, req.body, req.params.id) }, req.params.id ? 200 : 201))
export const templateDelete = guarded(async (req, res) => ok(res, await mail.deleteTemplate(req.ctx, req.params.id)))
export const push = guarded(async (req, res) => { await acceptPush(req.get('authorization'), req.body); res.status(204).end() })
