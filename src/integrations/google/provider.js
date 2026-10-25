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
