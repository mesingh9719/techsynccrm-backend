import crypto from 'node:crypto'
import { prisma, DB_NULL } from '../../db/prisma.js'
import { env } from '../../config/env.js'
import { parseListQuery, buildPage } from '../../lib/pagination.js'
import { planHasFeature } from '../../config/plans.js'
import { encrypt, decrypt, sha256, safeEqual } from '../../lib/crypto.js'
import { recordAudit } from '../../lib/audit.js'
import { notificationContext } from '../../services/notificationAccess.service.js'
import { enqueue } from '../../jobs/queue.js'
import { provider, oauthClient } from './provider.js'
import { newEnvelope, seal, open } from './vault.js'
import { managedAccount, permitEmail, ownAccount } from './access.js'
import { settings, requireConfiguration, ACTIVE, SCOPES, CONSENT_VERSION, gmailError } from './config.js'
import { cleanHtml } from './content.js'

export const validReturn = (value) => /^\/app\/(?:leads\/[0-9a-f-]{36}|contacts\/[0-9a-f-]{36}|settings\/gmail)$/.test(value || '') ? value : '/app/settings/gmail'
const statusSelect = { id: true, userId: true, email: true, status: true, lastError: true, createdAt: true, consentVersion: true, state: { select: { lastSyncedAt: true, coverageGap: true } } }
export function accountStatus(row) {
  if (!row) return null
  return { id: row.id, userId: row.userId, email: row.email, status: row.status, lastError: row.lastError,
    lastSyncedAt: row.state?.lastSyncedAt || null, coverageGap: row.state?.coverageGap || false,
    signatureHtml: row.signatureHtml, excludedAddresses: row.excludedAddresses, excludedDomains: row.excludedDomains,
    consentVersion: row.consentVersion, retentionDays: settings().retentionDays, createdAt: row.createdAt }
}
export async function gmailMe(ctx) {
  const row = await prisma.gmailAccount.findFirst({ where: { organizationId: ctx.orgId, userId: ctx.userId }, orderBy: [{ consentAt: 'desc' }, { createdAt: 'desc' }], select: { ...statusSelect, signatureHtml: true, excludedAddresses: true, excludedDomains: true } })
  const c = settings()
  return { enabled: c.enabled && Boolean(c.clientId && c.clientSecret && c.redirectUri && c.kmsKey), syncEnabled: c.syncEnabled, entitled: planHasFeature(ctx.plan, 'emailSync'), consentVersion: CONSENT_VERSION, account: accountStatus(row) }
}
export async function startLogin(ctx, input) {
  requireConfiguration(); permitEmail(ctx, 'email.connect')
  if (!ctx.sessionId) throw gmailError('GMAIL_OAUTH_INVALID', 'Sign into TechSync again before connecting Gmail.', 401)
  const state = crypto.randomBytes(32).toString('base64url'), browser = crypto.randomBytes(32).toString('base64url'), nonce = crypto.randomBytes(24).toString('base64url')
  const { codeVerifier, codeChallenge } = await oauthClient().generateCodeVerifierAsync()
  await prisma.gmailOAuthState.create({ data: { organizationId: ctx.orgId, userId: ctx.userId, sessionId: ctx.sessionId, stateHash: sha256(state), browserHash: sha256(browser), verifierEnc: encrypt(codeVerifier), nonce, returnTo: validReturn(input.returnTo), backfillDays: input.backfillDays, excludedAddresses: input.excludedAddresses, excludedDomains: input.excludedDomains, expiresAt: new Date(Date.now() + 600000) } })
  const url = oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent select_account', scope: SCOPES, state, nonce, code_challenge: codeChallenge, code_challenge_method: 'S256' })
  return { url, browser, expiresAt: new Date(Date.now() + 600000) }
}
export async function finishLogin(query, browser) {
  requireConfiguration()
  if (typeof query.state !== 'string' || query.state.length > 200 || typeof browser !== 'string') throw gmailError('GMAIL_OAUTH_INVALID', 'Gmail connection could not be verified.', 400)
  const state = await prisma.$transaction(async (tx) => {
    const row = await tx.gmailOAuthState.findUnique({ where: { stateHash: sha256(query.state) } })
    if (!row || row.expiresAt <= new Date()) throw gmailError('GMAIL_OAUTH_EXPIRED', 'The connection request expired. Start again.', 400)
    if (!safeEqual(row.browserHash, sha256(browser))) throw gmailError('GMAIL_OAUTH_INVALID', 'Use the browser that started this connection.', 400)
    if (!(await tx.gmailOAuthState.deleteMany({ where: { id: row.id, expiresAt: { gt: new Date() }, browserHash: sha256(browser) } })).count) throw gmailError('GMAIL_OAUTH_EXPIRED', 'This connection request has already been used.', 400)
    return row
  })
  if (query.error) throw gmailError('GMAIL_OAUTH_CANCELLED', 'Gmail connection was cancelled.', 400)
  if (typeof query.code !== 'string' || query.code.length > 4096) throw gmailError('GMAIL_OAUTH_INVALID', 'Google did not return an authorization code.', 400)
  const ctx = await notificationContext(state.organizationId, state.userId)
  if (!ctx || !await prisma.refreshToken.count({ where: { userId: state.userId, sessionId: state.sessionId, revokedAt: null, expiresAt: { gt: new Date() } } })) throw gmailError('GMAIL_OAUTH_EXPIRED', 'Sign into TechSync and connect again.', 400)
  permitEmail(ctx, 'email.connect')
  const tokens = await provider.exchange(query.code, decrypt(state.verifierEnc))
  const scopes = String(tokens.scope || '').split(' ')
  if (!SCOPES.filter((s) => s.startsWith('https:')).every((s) => scopes.includes(s))) throw gmailError('GMAIL_SCOPES_MISSING', 'Allow sending and reading lead emails to connect Gmail.')
  const identity = await provider.identity(tokens.id_token, state.nonce)
  const previous = await prisma.gmailAccount.findFirst({ where: { organizationId: ctx.orgId, userId: ctx.userId, googleSubject: identity.subject }, orderBy: { createdAt: 'desc' } })
  const active = await prisma.gmailAccount.findFirst({ where: { organizationId: ctx.orgId, userId: ctx.userId, status: { in: ACTIVE } } })
  if (active && active.googleSubject !== identity.subject) throw gmailError('GMAIL_ACCOUNT_UNAVAILABLE', 'Disconnect your current mailbox before choosing a different Google account.')
  if (await prisma.gmailAccount.count({ where: { googleSubject: identity.subject, status: { in: ACTIVE }, NOT: { organizationId: ctx.orgId, userId: ctx.userId } } })) throw gmailError('GMAIL_ACCOUNT_UNAVAILABLE', 'This Google account cannot be connected here.')
  if (previous?.deletionRequestedAt) throw gmailError('GMAIL_DELETION_PENDING', 'Wait for email history deletion before reconnecting.')
  const id = previous?.id || crypto.randomUUID(), keyData = previous && previous.wrappedKey !== 'erased' ? { key: await provider.unwrapKey(previous), wrappedKey: previous.wrappedKey, keyVersion: previous.keyVersion } : await newEnvelope()
  const account = { id, organizationId: ctx.orgId }
  const oldCredentials = previous?.credentialEnc ? open(keyData.key, previous, 'credentials', previous.credentialEnc) : null
  const refreshToken = tokens.refresh_token || oldCredentials?.refreshToken
  if (!refreshToken) throw gmailError('GMAIL_RECONNECT_REQUIRED', 'Reconnect and grant offline access to Gmail.')
  const resume = previous && previous.wrappedKey !== 'erased'
  const requestedFrom = new Date(Date.now() - state.backfillDays * 86400000)
  const syncFrom = resume ? (state.backfillDays === 30 && requestedFrom < previous.syncFrom ? requestedFrom : previous.syncFrom) : requestedFrom
  const resetWindow = !resume || state.backfillDays === 30
  try {
    await prisma.$transaction(async (tx) => {
      const fresh = await notificationContext(ctx.orgId, ctx.userId, tx); if (!fresh) throw gmailError('GMAIL_MEMBER_INACTIVE', 'Workspace access changed.')
      permitEmail(fresh, 'email.connect')
      const data = { userId: ctx.userId, googleSubject: identity.subject, email: identity.email, scopes, status: 'connected', credentialEnc: seal(keyData.key, account, 'credentials', { refreshToken }), wrappedKey: keyData.wrappedKey, keyVersion: keyData.keyVersion, generation: (previous?.generation || 0) + 1, consentVersion: CONSENT_VERSION, consentAt: new Date(), excludedAddresses: state.excludedAddresses, excludedDomains: state.excludedDomains, syncFrom, lastError: null }
      if (previous) await tx.gmailAccount.update({ where: { id, organizationId: ctx.orgId }, data })
      else await tx.gmailAccount.create({ data: { ...account, ...data } })
      await tx.gmailSyncState.upsert({ where: { organizationId_accountId: { organizationId: ctx.orgId, accountId: id } }, create: { organizationId: ctx.orgId, accountId: id, searchFrom: syncFrom }, update: { ...(resetWindow && { historyId: null, searchFrom: state.backfillDays === 30 ? requestedFrom : syncFrom, lastSyncedAt: null, coverageGap: false }), scanState: DB_NULL, nextAttemptAt: new Date(), watchRenewAt: new Date(), failures: 0, leaseUntil: null, leaseToken: null } })
      await recordAudit(tx, ctx, { action: 'gmail.connected', entityType: 'gmail_account', entityId: id })
    })
  } catch (err) { if (err.code === 'P2002') throw gmailError('GMAIL_ACCOUNT_UNAVAILABLE', 'This Google account cannot be connected here.'); throw err }
  await enqueue('gmail.sync', { organizationId: ctx.orgId, accountId: id }).catch(() => {}) // durable due-state scan recovers
  return { returnTo: state.returnTo, orgId: ctx.orgId }
}
export async function disconnect(ctx, id) {
  const row = await managedAccount(ctx, id)
  await prisma.$transaction(async (tx) => {
    await tx.gmailAccount.update({ where: { id, organizationId: ctx.orgId }, data: { status: 'disconnected', credentialEnc: null, generation: { increment: 1 }, lastError: null } })
    await tx.emailMessage.updateMany({ where: { organizationId: ctx.orgId, accountId: id, status: 'queued' }, data: { status: 'cancelled', lastError: 'GMAIL_NOT_CONNECTED' } })
    await recordAudit(tx, ctx, { action: 'gmail.disconnected', entityType: 'gmail_account', entityId: id })
  })
  if (row.credentialEnc) {
    try {
      const key = await provider.unwrapKey(row), token = open(key, row, 'credentials', row.credentialEnc).refreshToken
      try { const access = await provider.refresh(token); if (access.access_token) await provider.api(access.access_token, 'stop', { method: 'POST' }) } catch { /* Revocation below also stops future access. */ }
      await provider.revoke(token)
    } catch { /* Access is locally disabled even if Google is unavailable. */ }
  }
  return { disconnected: true }
}
export async function updateSettings(ctx, input) {
  permitEmail(ctx, 'email.connect'); const row = await ownAccount(ctx, { connected: false })
  await prisma.gmailAccount.update({ where: { id: row.id, organizationId: ctx.orgId }, data: { ...input, ...(input.signatureHtml !== undefined && { signatureHtml: cleanHtml(input.signatureHtml) }), generation: { increment: 1 } } })
  return gmailMe(ctx)
}
export const callbackDestination = (result, code) => {
  const url = new URL('/gmail/callback', env.FRONTEND_URL)
  url.searchParams.set('gmail', code || 'connected')
  if (result) { url.searchParams.set('returnTo', validReturn(result.returnTo)); url.searchParams.set('workspace', result.orgId) }
  return url.toString()
}
export async function listAccounts(ctx, query) {
  const page = parseListQuery(query, { sortable: { createdAt: 'date' }, defaultSort: '-createdAt' })
  const rows = await prisma.gmailAccount.findMany({ where: { AND: [{ organizationId: ctx.orgId }, page.cursorWhere] }, orderBy: page.orderBy, take: page.take, select: statusSelect })
  const result = buildPage(rows, page)
  const users = await prisma.user.findMany({ where: { id: { in: result.items.map((r) => r.userId).filter(Boolean) } }, select: { id: true, fullName: true } })
  return { ...result, items: result.items.map((r) => {
    const { signatureHtml: _signature, excludedAddresses: _addresses, excludedDomains: _domains, ...status } = accountStatus(r)
    return { ...status, userName: users.find((u) => u.id === r.userId)?.fullName ?? null }
  }) }
}
export async function requestSync(ctx) {
  permitEmail(ctx); const row = await ownAccount(ctx)
  await prisma.gmailSyncState.updateMany({ where: { organizationId: ctx.orgId, accountId: row.id }, data: { nextAttemptAt: new Date() } })
  await enqueue('gmail.sync', { organizationId: ctx.orgId, accountId: row.id }).catch(() => {})
  return { queued: true, syncEnabled: settings().syncEnabled }
}
