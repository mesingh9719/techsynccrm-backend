import { env } from '../../config/env.js'
import { ApiError } from '../../utils/ApiError.js'

export const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly']
export const CONSENT_VERSION = '2026-10-23-team-history-v1'
export const ACTIVE = ['connected', 'syncing', 'delayed', 'reconnect_required', 'paused']
export const gmailError = (code, message, status = 409) => new ApiError(status, message, { code })
export const settings = () => ({
  enabled: env.GMAIL_ENABLED === true,
  syncEnabled: env.GMAIL_SYNC_ENABLED === true,
  clientId: env.GOOGLE_GMAIL_CLIENT_ID || '', clientSecret: env.GOOGLE_GMAIL_CLIENT_SECRET || '',
  redirectUri: env.GOOGLE_GMAIL_REDIRECT_URI || '', kmsKey: env.GMAIL_KMS_KEY_NAME || '',
  topic: env.GMAIL_PUBSUB_TOPIC || '', audience: env.GMAIL_PUBSUB_AUDIENCE || '',
  pushIdentity: env.GMAIL_PUBSUB_SERVICE_ACCOUNT || '',
  pollSeconds: env.GMAIL_POLL_SECONDS || 300, retentionDays: env.GMAIL_MESSAGE_RETENTION_DAYS || 365,
})
/** Safe setup diagnostics: never return credentials or the KMS resource. */
export function configurationStatus(c = settings()) {
  let redirectValid = false
  try {
    const url = new URL(c.redirectUri)
    redirectValid = !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/api/integrations/gmail/callback' &&
      (url.protocol === 'https:' || !env.isProduction && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  } catch { /* Missing or malformed callback is a setup issue. */ }
  const missing = [
    ...(!c.enabled ? ['enabled'] : []), ...(!c.clientId ? ['clientId'] : []),
    ...(!c.clientSecret ? ['clientSecret'] : []), ...(!redirectValid ? ['redirectUri'] : []),
    ...(!c.kmsKey ? ['encryption'] : []),
  ]
  return { ready: missing.length === 0, missing, redirectUri: redirectValid ? c.redirectUri : null }
}
export function requireConfiguration() {
  const c = settings()
  if (!configurationStatus(c).ready)
    throw gmailError('GMAIL_NOT_CONFIGURED', 'Gmail is not enabled in this environment yet.', 503)
  return c
}
export const cookieName = 'techsync_gmail_oauth'
export const cookieOptions = () => ({ httpOnly: true, secure: env.isProduction || settings().redirectUri.startsWith('https:'), sameSite: 'lax', path: '/api/integrations/gmail', maxAge: 600000 })
