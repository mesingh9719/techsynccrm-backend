import crypto from 'node:crypto'
import { env } from '../../config/env.js'
import { ApiError } from '../../utils/ApiError.js'

export function facebookConfiguration() {
  const missing = ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'FACEBOOK_REDIRECT_URI', 'FACEBOOK_WEBHOOK_VERIFY_TOKEN'].filter((key) => !env[key])
  let redirect
  try { redirect = new URL(env.FACEBOOK_REDIRECT_URI) } catch { /* Report configuration without secrets. */ }
  if (redirect && (redirect.pathname !== '/api/integrations/facebook/callback' || redirect.search || redirect.hash || redirect.username || redirect.password || (redirect.protocol !== 'https:' && !(!env.isProduction && redirect.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirect.hostname))))) missing.push('FACEBOOK_REDIRECT_URI (valid HTTPS callback required)')
  if (!redirect && env.FACEBOOK_REDIRECT_URI) missing.push('FACEBOOK_REDIRECT_URI (invalid URL)')
  if (!/^v\d+\.0$/.test(env.FACEBOOK_API_VERSION)) missing.push('FACEBOOK_API_VERSION (use vNN.0)')
  if (env.FACEBOOK_APP_ID && !/^\d+$/.test(env.FACEBOOK_APP_ID)) missing.push('FACEBOOK_APP_ID (numeric ID required)')
  if (env.FACEBOOK_LOGIN_CONFIG_ID && !/^\d{1,40}$/.test(env.FACEBOOK_LOGIN_CONFIG_ID)) missing.push('FACEBOOK_LOGIN_CONFIG_ID (numeric ID required)')
  return { configured: missing.length === 0, missing, apiVersion: env.FACEBOOK_API_VERSION, callbackUrl: redirect?.toString() ?? null, webhookPath: '/api/webhooks/in/facebook' }
}
export function requireFacebookConfiguration() {
  if (!facebookConfiguration().configured) throw new ApiError(503, 'Configure the Meta app in the backend environment before connecting Facebook.', { code: 'FACEBOOK_NOT_CONFIGURED' })
}

// Never follow provider paging.next URLs: they contain tokens. Only reuse the opaque after cursor.
export async function graph(path, token, params = {}, method = 'GET') {
  requireFacebookConfiguration()
  if (!/^[a-zA-Z0-9_/-]+$/.test(path)) throw ApiError.badRequest('Invalid Facebook resource.')
  const url = new URL(`https://graph.facebook.com/${env.FACEBOOK_API_VERSION}/${path}`)
  const values = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
  if (token) values.set('appsecret_proof', crypto.createHmac('sha256', env.FACEBOOK_APP_SECRET).update(token).digest('hex'))
  const options = { method, headers: { Accept: 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, signal: AbortSignal.timeout(15000), redirect: 'error' }
  if (method === 'GET' || method === 'DELETE') url.search = values.toString()
  else { options.body = values; options.headers['Content-Type'] = 'application/x-www-form-urlencoded' }
  let response, data
  try { response = await fetch(url, options); data = await response.json() }
  catch { throw new ApiError(502, 'Facebook could not be reached. Try again later.', { code: 'FACEBOOK_UNAVAILABLE' }) }
  if (!response.ok || data.error) {
    const providerCode = Number(data.error?.code) || response.status
    const message = providerCode === 190 ? 'Facebook access expired or was revoked. Reconnect Facebook.' : [10, 200, 294].includes(providerCode) ? 'Facebook denied access. Check app permissions and Page/lead access in Meta Business settings.' : [4, 17, 32, 613].includes(providerCode) ? 'Facebook rate limit reached. The worker will retry later.' : 'Facebook rejected this request. Check the selected assets and permissions.'
    throw new ApiError(502, message, { code: 'FACEBOOK_API_ERROR', details: { providerCode, traceId: data.error?.fbtrace_id } })
  }
  return data
}
export const graphPage = (data) => ({ items: data.data ?? [], nextCursor: data.paging?.next ? data.paging.cursors?.after ?? null : null })
export async function managedPages(token, after) {
  return graphPage(await graph('me/accounts', token, { fields: 'id,name,access_token,tasks', limit: 100, after }))
}
