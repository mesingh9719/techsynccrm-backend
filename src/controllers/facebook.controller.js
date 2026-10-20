import { requestFacebookDeletion, facebookDeletionStatus } from '../integrations/facebook/deletion.js'
import { env } from '../config/env.js'
import { ApiError } from '../utils/ApiError.js'
import { logger } from '../lib/logger.js'
import { decrypt, safeEqual } from '../lib/crypto.js'
import { graph, graphPage } from '../integrations/facebook/graph.js'
import * as connection from '../integrations/facebook/connection.js'
import * as capture from '../integrations/facebook/capture.js'
const ok = (res, data) => res.json({ success: true, data })
export const status = async (req, res) => ok(res, await connection.facebookStatus(req.ctx))
export const login = async (req, res) => {
  const { url, browser } = await connection.startFacebookLogin(req.ctx)
  res.cookie(connection.FACEBOOK_COOKIE, browser, connection.facebookCookieOptions())
  ok(res, { url })
}
export async function callback(req, res) {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  const destination = new URL(`${env.FRONTEND_URL}/app/settings/facebook`)
  try {
    const orgId = await connection.finishFacebookLogin(req.query, req.cookies?.[connection.FACEBOOK_COOKIE])
    destination.searchParams.set('facebook', 'connected'); destination.searchParams.set('workspace', orgId)
  } catch (err) {
    logger.warn({ code: err.code ?? 'FACEBOOK_OAUTH_FAILED', providerCode: err.details?.providerCode }, 'Facebook authorization did not complete')
    destination.searchParams.set('facebook', err.code === 'FACEBOOK_LOGIN_CANCELLED' ? 'cancelled' : 'failed')
  }
  const { maxAge: _maxAge, ...clearOptions } = connection.facebookCookieOptions()
  res.clearCookie(connection.FACEBOOK_COOKIE, clearOptions)
  res.redirect(303, destination.toString())
}
export const pages = async (req, res) => ok(res, await connection.availablePages(req.ctx, req.validated.query.after))
export const connectPage = async (req, res) => ok(res, await connection.connectPage(req.ctx, req.body.facebookPageId))
export const disconnectPage = async (req, res) => { await connection.disconnectPage(req.ctx, req.validated.params.pageId); res.status(204).end() }
export const forms = async (req, res) => ok(res, await connection.listForms(req.ctx, req.validated.params.pageId, req.validated.query.after))
export const configureForm = async (req, res) => ok(res, await connection.configureForm(req.ctx, req.validated.params.pageId, req.validated.params.formId, req.body))
export const disconnect = async (req, res) => { await connection.disconnectFacebook(req.ctx); res.status(204).end() }
export const sync = async (req, res) => ok(res, await capture.requestFacebookSync(req.ctx, req.validated.params.id))
export const deliveries = async (req, res) => ok(res, { items: await capture.facebookDeliveries(req.ctx, req.validated.query.before) })
export const retry = async (req, res) => { await capture.retryFacebookDelivery(req.ctx, req.validated.params.id); res.status(204).end() }
export async function adAccounts(req, res) {
  const row = await connection.connectionFor(req.ctx)
  ok(res, graphPage(await graph('me/adaccounts', decrypt(row.tokenEnc), { fields: 'id,account_id,name,account_status,currency', limit: 100, after: req.validated.query.after })))
}
export async function campaigns(req, res) {
  const row = await connection.connectionFor(req.ctx)
  const { accountId, after } = req.validated.query
  // The user token itself scopes access to the requested ad account; arbitrary URLs are forbidden.
  ok(res, graphPage(await graph(`${accountId}/campaigns`, decrypt(row.tokenEnc), { fields: 'id,name,status,effective_status,objective', limit: 100, after })))
}
export function verifyWebhook(req, res) {
  if (!env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || req.query['hub.mode'] !== 'subscribe' || typeof req.query['hub.verify_token'] !== 'string' || !safeEqual(req.query['hub.verify_token'], env.FACEBOOK_WEBHOOK_VERIFY_TOKEN)) throw ApiError.forbidden('Invalid Facebook webhook verification token.')
  const challenge = req.query['hub.challenge']
  if (typeof challenge !== 'string' || challenge.length > 500) throw ApiError.badRequest('Invalid webhook challenge.')
  res.type('text/plain').send(challenge)
}
export async function webhook(req, res) {
  if (!capture.verifyFacebookSignature(req.rawBody, req.get('x-hub-signature-256'))) throw ApiError.forbidden('Invalid Facebook webhook signature.')
  await capture.receiveFacebookWebhook(req.body)
  res.status(200).json({ received: true })
}
export async function deauthorize(req, res) { await capture.deauthorizeFacebook(req.body?.signed_request); res.status(200).json({ received: true }) }

export const sdkChallenge = async (req, res) => ok(res, await connection.prepareFacebookSdkLogin(req.ctx))
export const sdkConnect = async (req, res) => ok(res, await connection.finishFacebookSdkLogin(req.ctx, req.body))
export async function dataDeletion(req, res) {
  const result = await requestFacebookDeletion(req.body?.signed_request)
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).json(result)
}
export async function deletionStatus(req, res) {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" })
  let request
  try { request = await facebookDeletionStatus(req.validated.params.code) }
  catch (err) { if (err.statusCode !== 404) throw err; res.status(404) }
  const status = request?.status
  const title = !request ? 'Request not found' : status === 'completed' ? 'Deletion completed' : status === 'failed' ? 'Deletion delayed' : 'Deletion in progress'
  const explanation = !request ? 'This confirmation code is invalid or its 90-day status window has expired.' : status === 'completed' ? 'We removed the Facebook account identity, saved access credentials, connected Page and form settings, and capture receipts associated with this request. Existing CRM records about other people are outside this account-connection request. A later connection authorized after the request is also outside its scope.' : status === 'failed' && request.attempts >= 8 ? 'Processing needs support attention. Your request remains recorded and matching credentials have been revoked. Contact TechSync support using your confirmation code.' : status === 'failed' ? 'Matching credentials have been revoked. Deletion processing is delayed and will retry automatically.' : 'Matching credentials have been revoked. Background cleanup is removing the associated Facebook connection data.'
  if (request && ['queued', 'processing', 'failed'].includes(status) && request.attempts < 8) res.set('Refresh', '15')
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Facebook data deletion · TechSync</title><style>body{margin:0;padding:3rem 1rem;background:#f6f7f9;color:#18181b;font:16px/1.6 system-ui,sans-serif}main{max-width:42rem;margin:auto;padding:2rem;background:white;border:1px solid #e4e4e7;border-radius:16px}h1{font-size:1.6rem;line-height:1.3}code{display:block;padding:1rem;background:#f4f4f5;border-radius:8px;overflow-wrap:anywhere}small{color:#52525b}a{color:#255dc1}</style></head><body><main><small>TechSync · Facebook data deletion</small><h1>${title}</h1><p>${explanation}</p><p>Confirmation code</p><code>${req.validated.params.code}</code>${request ? `<p><small>Received: ${request.createdAt.toISOString()}${request.completedAt ? `<br>Completed: ${request.completedAt.toISOString()}` : ''}<br>Status is available for 90 days after completion.</small></p>` : ''}<p><a href="">Refresh status</a> · <a href="mailto:privacy@techsynccrm.com">Contact privacy support</a></p></main></body></html>`)
}
