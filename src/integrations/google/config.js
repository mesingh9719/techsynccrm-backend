import crypto from 'node:crypto'
import { env } from '../../config/env.js'
import { ApiError } from '../../utils/ApiError.js'
import { keyring } from '../../email-integration/crypto/tokenCrypto.js'

export const GOOGLE_SERVICES = ['calendar', 'drive', 'sheets']
export const CONSENT_VERSION = '2026-10-25-workspace-tools-v2'
export const SERVICE_SCOPES = Object.freeze({ calendar: 'https://www.googleapis.com/auth/calendar.app.created', drive: 'https://www.googleapis.com/auth/drive.file', sheets: 'https://www.googleapis.com/auth/drive.file' })
export const IDENTITY_SCOPES = ['openid', 'email', 'profile']
const acceptedScopes = new Set([...IDENTITY_SCOPES, ...Object.values(SERVICE_SCOPES), 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'])
const existingGmailScopes = new Set(['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify'])
// Account ownership is independent of project isolation. A shared project is supported,
// but local disconnects must not revoke other services' project-wide grants.
export const sharedGoogleProject = (projectNumber = env.GOOGLE_WORKSPACE_PROJECT_NUMBER || '') => /^\d+$/.test(projectNumber) &&
  [env.GOOGLE_GMAIL_CLIENT_ID, env.GOOGLE_AUTH_CLIENT_ID, env.GOOGLE_CLIENT_ID].filter(Boolean).some((client) => client.startsWith(`${projectNumber}-`))
export const gmailSharesWorkspaceProject = () => sharedGoogleProject() &&
  Boolean((env.GOOGLE_GMAIL_CLIENT_ID || env.GOOGLE_CLIENT_ID || '').startsWith(`${env.GOOGLE_WORKSPACE_PROJECT_NUMBER}-`))
// Google can return existing grants for another client in this project. They never
// enable Gmail operations through the Workspace profile or get requested by it.
export const scopesAllowed = (scopes) => scopes.every((scope) => acceptedScopes.has(scope) || sharedGoogleProject() && existingGmailScopes.has(scope))
export const fingerprint = (value) => crypto.createHash('sha256').update(value).digest('hex')
export const googleError = (code, message, status = 409) => new ApiError(status, message, { code })
export const settings = () => ({ enabled: env.GOOGLE_WORKSPACE_ENABLED === true,
  clientId: env.GOOGLE_WORKSPACE_CLIENT_ID || '', clientSecret: env.GOOGLE_WORKSPACE_CLIENT_SECRET || '',
  projectNumber: env.GOOGLE_WORKSPACE_PROJECT_NUMBER || '', redirectUri: env.GOOGLE_WORKSPACE_REDIRECT_URI || '',
  kmsKey: env.GOOGLE_WORKSPACE_KMS_KEY_NAME || '',
  services: Object.fromEntries(GOOGLE_SERVICES.map((service) => [service, env[`GOOGLE_WORKSPACE_${service.toUpperCase()}_ENABLED`] === true])),
})
export function configurationStatus(c = settings()) {
  let callback = false
  try {
    const url = new URL(c.redirectUri)
    callback = !url.username && !url.password && !url.search && !url.hash && url.pathname === '/api/google/oauth/callback' &&
      (url.protocol === 'https:' || !env.isProduction && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
  } catch { /* Safe diagnostics only. */ }
  const project = /^\d+$/.test(c.projectNumber) && c.clientId.startsWith(`${c.projectNumber}-`) && c.clientId.endsWith('.apps.googleusercontent.com')
  let encryption = false
  if (c.kmsKey) encryption = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(c.kmsKey)
  else {
    try {
      keyring({ EMAIL_TOKEN_ENCRYPTION_KEY: env.GOOGLE_WORKSPACE_TOKEN_ENCRYPTION_KEY,
        EMAIL_TOKEN_ENCRYPTION_KEYS: env.GOOGLE_WORKSPACE_TOKEN_ENCRYPTION_KEYS, EMAIL_TOKEN_KEY_VERSION: env.GOOGLE_WORKSPACE_TOKEN_KEY_VERSION || '1' })
      encryption = true
    } catch { /* Invalid encryption setup disables connections without exposing values. */ }
  }
  const missing = [...(!c.enabled ? ['enabled'] : []), ...(!c.clientId ? ['clientId'] : []), ...(!c.clientSecret ? ['clientSecret'] : []),
    ...(!project ? ['projectNumber'] : []), ...(!callback ? ['redirectUri'] : []), ...(!encryption ? ['encryption'] : [])]
  return { ready: missing.length === 0, missing, sharedProject: sharedGoogleProject(c.projectNumber) }
}
export function requireConfiguration() {
  const c = settings()
  if (!configurationStatus(c).ready) throw googleError('GOOGLE_NOT_CONFIGURED', 'Google Workspace connections are not configured yet.', 503)
  return c
}
export const cookieName = 'techsync_google_workspace'
export const cookieOptions = () => ({ httpOnly: true, secure: env.isProduction || settings().redirectUri.startsWith('https:'), sameSite: 'lax', path: '/api/google/oauth', maxAge: 600000 })
export const safeReturn = (value) => ['/app/settings/google', '/app/settings/google-team', '/app/integrations'].includes(value) ? value : '/app/settings/google'
