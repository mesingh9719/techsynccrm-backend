import { GoogleAuth, OAuth2Client } from 'google-auth-library'
import { settings, requireConfiguration, gmailError } from './config.js'

export class GmailProviderError extends Error {
  constructor(code, { status = 503, retryAfter = 30, uncertain = false } = {}) {
    super(code); this.name = 'GmailProviderError'; this.code = code; this.providerStatus = status; this.retryAfter = retryAfter; this.uncertain = uncertain
  }
}
export const oauthClient = ({ allowDisabled = false } = {}) => {
  const c = allowDisabled ? settings() : requireConfiguration()
  return new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri, transporterOptions: { timeout: 20000, retry: false } })
}
const adc = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
async function kms(action, data, keyName = settings().kmsKey) {
  if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+(?:\/cryptoKeyVersions\/\d+)?$/.test(keyName)) throw gmailError('GMAIL_NOT_CONFIGURED', 'Gmail encryption is not configured.', 503)
  const resource = action === 'decrypt' ? keyName.replace(/\/cryptoKeyVersions\/\d+$/, '') : keyName
  try {
    const client = await adc.getClient()
    const response = await client.request({ url: `https://cloudkms.googleapis.com/v1/${resource}:${action}`, method: 'POST', data, timeout: 15000, retry: false })
    return response.data
  } catch { throw new GmailProviderError('GMAIL_ENCRYPTION_UNAVAILABLE') }
}
/** Replaced by module mocks in tests, never by a production test-mode switch. */
export const provider = {
  async wrapKey(key) { const r = await kms('encrypt', { plaintext: key.toString('base64') }); return { wrappedKey: r.ciphertext, keyVersion: r.name || settings().kmsKey } },
  async unwrapKey(account) {
    const r = await kms('decrypt', { ciphertext: account.wrappedKey }, account.keyVersion || settings().kmsKey), key = Buffer.from(r.plaintext, 'base64')
    if (key.length !== 32) throw new GmailProviderError('GMAIL_ENCRYPTION_UNAVAILABLE')
    return key
  },
  async exchange(code, verifier) {
    try { return (await oauthClient().getToken({ code, codeVerifier: verifier })).tokens }
    catch { throw new GmailProviderError('GMAIL_OAUTH_INVALID', { status: 400 }) }
  },
  async identity(idToken, nonce) {
    try {
      const c = settings(), ticket = await oauthClient().verifyIdToken({ idToken, audience: c.clientId }), p = ticket.getPayload()
      if (!p?.sub || !p.email_verified || p.nonce !== nonce) throw new Error('invalid')
      return { subject: p.sub, email: p.email.toLowerCase() }
    } catch { throw new GmailProviderError('GMAIL_OAUTH_INVALID', { status: 400 }) }
  },
  async refresh(refreshToken) {
    try {
      const client = oauthClient(); client.setCredentials({ refresh_token: refreshToken })
      const result = await client.refreshAccessToken()
      return result.credentials
    } catch (err) {
      throw new GmailProviderError(err.response?.data?.error === 'invalid_grant' ? 'GMAIL_RECONNECT_REQUIRED' : 'GMAIL_REFRESH_DELAYED')
    }
  },
  async revoke(token) { try { await oauthClient({ allowDisabled: true }).revokeToken(token) } catch { /* Local access is already disabled. */ } },
  async verifyPush(jwt) {
    try {
      const c = settings(), ticket = await new OAuth2Client().verifyIdToken({ idToken: jwt, audience: c.audience }), p = ticket.getPayload()
      if (!p?.email_verified || p.email !== c.pushIdentity || !c.pushIdentity || !c.audience) throw new Error('invalid')
    } catch { throw gmailError('GMAIL_PUSH_INVALID', 'Invalid notification authentication.', 401) }
  },
  async api(token, path, { method = 'GET', query, body, send = false, fields } = {}) {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`)
    for (const [key, value] of Object.entries({ ...query, ...(fields && { fields }) })) if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item))
    let response
    try { response = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) }) }
    catch { throw new GmailProviderError(send ? 'EMAIL_SEND_UNKNOWN' : 'GMAIL_SYNC_DELAYED', { uncertain: send }) }
    if (!response.ok) {
      let reason
      if (response.status === 403) { try { reason = (await response.json()).error?.errors?.[0]?.reason } catch { /* Ignore upstream detail. */ } }
      const code = response.status === 401 ? 'GMAIL_RECONNECT_REQUIRED' : response.status === 404 ? (path === 'history' ? 'GMAIL_HISTORY_EXPIRED' : 'GMAIL_MESSAGE_GONE') : response.status === 429 || response.status === 403 && ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'].includes(reason) ? 'GMAIL_RATE_LIMITED' : response.status === 403 ? 'GMAIL_RECONNECT_REQUIRED' : send ? (response.status >= 500 ? 'EMAIL_SEND_UNKNOWN' : 'EMAIL_SEND_REJECTED') : 'GMAIL_SYNC_DELAYED'
      throw new GmailProviderError(code, { status: response.status, retryAfter: Math.min(86400, Number(response.headers.get('retry-after')) || 30), uncertain: send && response.status >= 500 })
    }
    const reader = response.body?.getReader(), chunks = []; let bytes = 0
    if (reader) for (;;) {
      const { value, done } = await reader.read(); if (done) break
      bytes += value.byteLength
      if (bytes > 4_000_000) { await reader.cancel(); throw new GmailProviderError(send ? 'EMAIL_SEND_UNKNOWN' : 'GMAIL_MESSAGE_TOO_LARGE', { uncertain: send }) }
      chunks.push(Buffer.from(value))
    }
    const text = Buffer.concat(chunks).toString('utf8')
    try { return text ? JSON.parse(text) : {} } catch { throw new GmailProviderError(send ? 'EMAIL_SEND_UNKNOWN' : 'GMAIL_SYNC_DELAYED', { uncertain: send }) }
  },
}
