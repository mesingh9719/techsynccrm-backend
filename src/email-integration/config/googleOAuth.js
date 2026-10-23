// Identity only: lets the user see the actual Google mailbox they selected.
export const SEND_ONLY_CONSENT_VERSION = '2026-10-23-send-only-v1'
export const LEGACY_SYNC_CONSENT_VERSION = '2026-10-23-team-history-v1'
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
export const GOOGLE_EMAIL_SCOPES = Object.freeze(['openid', 'email', 'profile', GMAIL_SEND_SCOPE])
// Read permission belongs to a later, incremental consent flow. Never include it above.
export const canReadMailbox = (scopes) => scopes.includes('https://www.googleapis.com/auth/gmail.readonly') || scopes.includes('https://www.googleapis.com/auth/gmail.modify')
// Incremental authorization can return old grants. A read scope alone is not new sync consent.
export const canSyncAccount = (account) => account?.consentVersion === LEGACY_SYNC_CONSENT_VERSION && canReadMailbox(account.scopes || [])
export const hasSendScope = (scopes) => scopes.includes(GMAIL_SEND_SCOPE)

/** Reject external, encoded, backslash and control-character redirect tricks. */
export function validReturnTo(value) {
  if (typeof value !== 'string' || value.length > 200 || /[%\\\s\u0000-\u001f\u007f]/.test(value)) return '/app/settings/gmail'
  return /^\/app\/(?:leads\/[0-9a-f-]{36}|contacts\/[0-9a-f-]{36}|settings\/(?:gmail|email|team-email))$/.test(value) ? value : '/app/settings/gmail'
}
