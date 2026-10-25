import crypto from 'node:crypto'
import { OAuth2Client, GoogleAuth } from 'google-auth-library'
import { keyring, encryptToken, decryptToken } from '../../email-integration/crypto/tokenCrypto.js'
import { env } from '../../config/env.js'
import { requireConfiguration, settings, IDENTITY_SCOPES, googleError } from './config.js'
import { workspaceContext } from './envelope.js'

export const oauthClient = () => {
  const c = requireConfiguration()
  return new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri, transporterOptions: { timeout: 20000, retry: false } })
}
const localRing = () => keyring({ EMAIL_TOKEN_ENCRYPTION_KEY: env.GOOGLE_WORKSPACE_TOKEN_ENCRYPTION_KEY,
  EMAIL_TOKEN_ENCRYPTION_KEYS: env.GOOGLE_WORKSPACE_TOKEN_ENCRYPTION_KEYS, EMAIL_TOKEN_KEY_VERSION: env.GOOGLE_WORKSPACE_TOKEN_KEY_VERSION || '1' })
const adc = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
async function kms(action, name, data) {
  if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+(?:\/cryptoKeyVersions\/\d+)?$/.test(name)) throw googleError('GOOGLE_ENCRYPTION_UNAVAILABLE', 'Google credential encryption is unavailable.', 503)
  const resource = action === 'decrypt' ? name.replace(/\/cryptoKeyVersions\/\d+$/, '') : name
  const client = await adc.getClient()
  return (await client.request({ url: `https://cloudkms.googleapis.com/v1/${resource}:${action}`, method: 'POST', data, timeout: 15000, retry: false })).data
}
/** Network methods are mocked in tests, never bypassed with a production test switch. */
export const googleProvider = {
  async request(token, api, path, { method = 'GET', query = {}, body, headers = {} } = {}) {
    const roots = { calendar: 'https://www.googleapis.com/calendar/v3/', sheets: 'https://sheets.googleapis.com/v4/', drive: 'https://www.googleapis.com/drive/v3/' }
    if (!roots[api] || path.startsWith('/') || path.includes('://')) throw googleError('GOOGLE_INVALID_RESOURCE', 'Invalid Google resource.', 400)
    const url = new URL(path, roots[api])
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value))
    let response
    try { response = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) }) }
    catch { throw googleError('GOOGLE_REMOTE_UNCERTAIN', 'Google did not confirm this operation. Check its status before retrying.', 503) }
    if (!response.ok) {
      let disabled = false
      try {
        const data = await response.json(), error = data.error
        disabled = [error?.status, ...(error?.errors || []).map((entry) => entry.reason), ...(error?.details || []).map((entry) => entry.reason)].some((reason) => ['accessNotConfigured', 'SERVICE_DISABLED', 'API_DISABLED'].includes(reason))
      } catch { /* No provider payload escapes. */ }
      const code = response.status === 404 || response.status === 410 ? 'GOOGLE_REMOTE_NOT_FOUND' : response.status === 409 ? 'GOOGLE_REMOTE_EXISTS' : response.status === 412 ? 'GOOGLE_REMOTE_CONFLICT' : response.status === 429 ? 'GOOGLE_RATE_LIMITED' : response.status === 401 ? 'GOOGLE_RECONNECT_REQUIRED' : disabled ? `GOOGLE_${api.toUpperCase()}_API_DISABLED` : response.status === 403 ? 'GOOGLE_PERMISSION_DENIED' : response.status === 400 ? 'GOOGLE_REQUEST_REJECTED' : 'GOOGLE_UNAVAILABLE'
      throw Object.assign(googleError(code, 'Google could not complete this request. Check the connection, enabled APIs and resource access.', response.status >= 500 || response.status === 429 ? 503 : 409), { providerStatus: response.status })
    }
    if (response.status === 204) return {}
    const text = await response.text()
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw googleError('GOOGLE_RESULT_TOO_LARGE', 'The Google response is too large. Use a smaller range.', 413)
    try { return text ? JSON.parse(text) : {} } catch { throw googleError('GOOGLE_UNAVAILABLE', 'Google returned an incomplete response.', 503) }
  },
  async authorization({ state, nonce, scope, loginHint }) {
    const client = oauthClient(), { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()
    return { verifier: codeVerifier, url: client.generateAuthUrl({ access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: true,
      scope: [...IDENTITY_SCOPES, scope], state, nonce, code_challenge: codeChallenge, code_challenge_method: 'S256', login_hint: loginHint }) }
  },
  async exchange(code, verifier) { return (await oauthClient().getToken({ code, codeVerifier: verifier })).tokens },
  async identity(idToken, nonce) {
    const ticket = await oauthClient().verifyIdToken({ idToken, audience: settings().clientId }), p = ticket.getPayload()
    if (typeof p?.sub !== 'string' || !p.sub || p.email_verified !== true || typeof p.email !== 'string' || p.nonce !== nonce) throw googleError('GOOGLE_OAUTH_INVALID', 'Google account could not be verified.', 400)
    return { subject: p.sub, email: p.email.toLowerCase() }
  },
  async refresh(refreshToken) {
    try { const client = oauthClient(); client.setCredentials({ refresh_token: refreshToken }); return (await client.refreshAccessToken()).credentials }
    catch (error) { throw googleError(error.response?.data?.error === 'invalid_grant' ? 'GOOGLE_RECONNECT_REQUIRED' : 'GOOGLE_REFRESH_DELAYED', 'Google access needs attention.', 503) }
  },
  async revoke(refreshToken) {
    try { await new OAuth2Client({ transporterOptions: { timeout: 20000, retry: false } }).revokeToken(refreshToken) }
    catch (error) { if (![400, 404].includes(error.response?.status)) throw googleError('GOOGLE_REVOCATION_DELAYED', 'Google access removal is pending.', 503) }
  },
  async newKey(row) {
    const key = crypto.randomBytes(32), name = settings().kmsKey
    if (name) { const result = await kms('encrypt', name, { plaintext: key.toString('base64') }); return { key, wrappedKey: result.ciphertext, keyVersion: result.name || name } }
    const wrapped = encryptToken(key.toString('base64'), workspaceContext(row), localRing())
    return { key, wrappedKey: JSON.stringify(wrapped), keyVersion: `local:${wrapped.keyVersion}` }
  },
  async unwrapKey(row) {
    let key
    if (row.keyVersion.startsWith('local:')) {
      const wrapped = JSON.parse(row.wrappedKey)
      if (row.keyVersion !== `local:${wrapped.keyVersion}`) throw new Error('Invalid key version')
      key = Buffer.from(decryptToken(wrapped, workspaceContext(row), localRing()), 'base64')
    } else key = Buffer.from((await kms('decrypt', row.keyVersion, { ciphertext: row.wrappedKey })).plaintext, 'base64')
    if (key.length !== 32) throw new Error('Invalid envelope key')
    return key
  },
}
