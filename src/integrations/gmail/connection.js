import { GmailProvider } from '../../email-integration/providers/gmail/GmailProvider.js'
import { hasSendScope, validReturnTo, canReadMailbox, canSyncAccount } from '../../email-integration/config/googleOAuth.js'
import { assertEmailEnabled, getSettings, auditEmail } from '../../email-integration/service.js'
import { scheduleRevocation, processRevocations } from '../../email-integration/revocation.js'
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
import { newEnvelope, seal } from './vault.js'
import { managedAccount, permitEmail, ownAccount } from './access.js'
import { settings, configurationStatus, requireConfiguration, ACTIVE, CONSENT_VERSION, gmailError } from './config.js'
import { cleanHtml } from './content.js'

export const validReturn = validReturnTo
const connectionProvider = new GmailProvider()
const statusSelect = { id: true, userId: true, email: true, status: true, lastError: true, createdAt: true, connectedAt: true, consentAt: true, lastUsedAt: true, lastErrorAt: true, disconnectedAt: true, consentVersion: true, state: { select: { lastSyncedAt: true, coverageGap: true } } }
export function accountStatus(row) {
  if (!row) return null
  return { id: row.id, userId: row.userId, email: row.email, status: row.status, lastError: row.lastError,
    connectedAt: row.connectedAt || row.consentAt, lastUsedAt: row.lastUsedAt, lastErrorAt: row.lastErrorAt, disconnectedAt: row.disconnectedAt,
    lastSyncedAt: row.state?.lastSyncedAt || null, coverageGap: row.state?.coverageGap || false,
    signatureHtml: row.signatureHtml, excludedAddresses: row.excludedAddresses, excludedDomains: row.excludedDomains,
    consentVersion: row.consentVersion, retentionDays: settings().retentionDays, createdAt: row.createdAt }
}
export async function gmailMe(ctx) {
  const row = await prisma.gmailAccount.findFirst({ where: { organizationId: ctx.orgId, userId: ctx.userId }, orderBy: [{ consentAt: 'desc' }, { createdAt: 'desc' }], select: { ...statusSelect, scopes: true, signatureHtml: true, excludedAddresses: true, excludedDomains: true } })
  const c = settings()
  const tenant = await getSettings(ctx.orgId)
  const setup = configurationStatus(c)
  return { enabled: setup.ready && tenant.emailEnabled, tenantEnabled: tenant.emailEnabled, setup, syncEnabled: c.syncEnabled && canSyncAccount(row), entitled: planHasFeature(ctx.plan, 'emailSync'), consentVersion: CONSENT_VERSION, account: accountStatus(row) }
}
export async function startLogin(ctx, input) {
  requireConfiguration(); permitEmail(ctx, 'email.connect'); await assertEmailEnabled(ctx.orgId)
  if (!ctx.sessionId) throw gmailError('GMAIL_OAUTH_INVALID', 'Sign into TechSync again before connecting Gmail.', 401)
  const state = crypto.randomBytes(32).toString('base64url'), browser = crypto.randomBytes(32).toString('base64url'), nonce = crypto.randomBytes(24).toString('base64url')
  const { codeVerifier, codeChallenge } = await oauthClient().generateCodeVerifierAsync()
  await prisma.gmailOAuthState.create({ data: { organizationId: ctx.orgId, userId: ctx.userId, sessionId: ctx.sessionId, stateHash: sha256(state), browserHash: sha256(browser), verifierEnc: encrypt(codeVerifier), nonce, returnTo: validReturn(input.returnTo), backfillDays: input.backfillDays, excludedAddresses: input.excludedAddresses, excludedDomains: input.excludedDomains, expiresAt: new Date(Date.now() + 600000) } })
  const url = connectionProvider.getAuthUrl({ state, nonce, codeChallenge, loginHint: ctx.email || ctx.user?.email || '' })
  return { url, browser, expiresAt: new Date(Date.now() + 600000) }
}
export async function finishLogin(query, browser) {
  requireConfiguration()
  if (typeof query.state !== 'string' || query.state.length > 200 || typeof browser !== 'string') throw gmailError('GMAIL_OAUTH_INVALID', 'Gmail connection could not be verified.', 400)
  const state = await prisma.$transaction(async (tx) => {
    const row = await tx.gmailOAuthState.findUnique({ where: { stateHash: sha256(query.state) } })
    if (!row || row.usedAt || row.expiresAt <= new Date()) throw gmailError('GMAIL_OAUTH_EXPIRED', 'The connection request expired. Start again.', 400)
    if (!safeEqual(row.browserHash, sha256(browser))) throw gmailError('GMAIL_OAUTH_INVALID', 'Use the browser that started this connection.', 400)
    if (!(await tx.gmailOAuthState.updateMany({ where: { id: row.id, organizationId: row.organizationId, userId: row.userId, usedAt: null, expiresAt: { gt: new Date() }, browserHash: sha256(browser) }, data: { usedAt: new Date() } })).count) throw gmailError('GMAIL_OAUTH_EXPIRED', 'This connection request has already been used.', 400)
    return row
  })
  try {
  if (query.error) throw Object.assign(gmailError('GMAIL_OAUTH_CANCELLED', 'Gmail connection was cancelled.', 400), { returnTo: state.returnTo, orgId: state.organizationId })
  if (typeof query.code !== 'string' || query.code.length > 4096) throw gmailError('GMAIL_OAUTH_INVALID', 'Google did not return an authorization code.', 400)
  const ctx = await notificationContext(state.organizationId, state.userId)
  if (!ctx || !await prisma.refreshToken.count({ where: { userId: state.userId, sessionId: state.sessionId, revokedAt: null, expiresAt: { gt: new Date() } } })) throw gmailError('GMAIL_OAUTH_EXPIRED', 'Sign into TechSync and connect again.', 400)
  permitEmail(ctx, 'email.connect'); await assertEmailEnabled(ctx.orgId)
  const tokens = await connectionProvider.handleCallback(query.code, decrypt(state.verifierEnc))
  const scopes = String(tokens.scope || '').split(' ')
  if (!hasSendScope(scopes)) throw gmailError('GMAIL_SCOPES_MISSING', 'Please allow sending email to continue.')
  if (!tokens.refresh_token) throw gmailError('GMAIL_RECONNECT_REQUIRED', 'Google did not return offline access. Retry Connect Gmail. If needed, remove TechSync in your Google Account connections and try again.')
  const identity = await provider.identity(tokens.id_token, state.nonce)
  const previous = await prisma.gmailAccount.findFirst({ where: { organizationId: ctx.orgId, userId: ctx.userId, googleSubject: identity.subject }, orderBy: { createdAt: 'desc' } })
  const active = await prisma.gmailAccount.findFirst({ where: { organizationId: ctx.orgId, userId: ctx.userId, status: { in: ACTIVE } } })
  if (active && active.googleSubject !== identity.subject) throw gmailError('GMAIL_ACCOUNT_UNAVAILABLE', 'Disconnect your current mailbox before choosing a different Google account.')
  if (await prisma.gmailAccount.count({ where: { organizationId: ctx.orgId, OR: [{ googleSubject: identity.subject }, { email: identity.email }], status: { in: ACTIVE }, userId: { not: ctx.userId } } })) throw gmailError('GMAIL_ACCOUNT_UNAVAILABLE', 'This Google account is already connected by another teammate in this workspace.')
  if (previous?.deletionRequestedAt) throw gmailError('GMAIL_DELETION_PENDING', 'Wait for email history deletion before reconnecting.')
  const history = await prisma.gmailAccount.findMany({ where: { organizationId: ctx.orgId, OR: [{ googleSubject: identity.subject }, { email: identity.email }] }, select: { id: true } })
  if (await prisma.emailTokenRevocation.count({ where: { organizationId: ctx.orgId, accountId: { in: history.map((row) => row.id) } } })) throw gmailError('GMAIL_REVOCATION_PENDING', 'A previous disconnect is still completing. Try connecting again shortly.')
  const id = previous?.id || crypto.randomUUID(), keyData = previous && previous.wrappedKey !== 'erased' ? { key: await provider.unwrapKey(previous), wrappedKey: previous.wrappedKey, keyVersion: previous.keyVersion } : await newEnvelope()
  const account = { id, organizationId: ctx.orgId }
  const refreshToken = tokens.refresh_token
  if (!refreshToken) throw gmailError('GMAIL_RECONNECT_REQUIRED', 'Reconnect and grant offline access to Gmail.')
  const consentVersion = canSyncAccount(previous) && canReadMailbox(scopes) ? previous.consentVersion : CONSENT_VERSION
  const resume = previous && previous.wrappedKey !== 'erased'
  const requestedFrom = new Date(Date.now() - state.backfillDays * 86400000)
  const syncFrom = resume ? (state.backfillDays === 30 && requestedFrom < previous.syncFrom ? requestedFrom : previous.syncFrom) : requestedFrom
  const resetWindow = !resume || state.backfillDays === 30
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${ctx.orgId}::uuid FOR UPDATE`
      if (previous) {
        const current = await tx.gmailAccount.findFirst({ where: { organizationId: ctx.orgId, id: previous.id } })
        if (!current || current.generation !== previous.generation || current.status === 'deleting') throw gmailError('GMAIL_ACCOUNT_CHANGED', 'Your mailbox connection changed. Start connecting again.')
      }
      const pendingAccounts = await tx.gmailAccount.findMany({ where: { organizationId: ctx.orgId, googleSubject: identity.subject }, select: { id: true } })
      if (await tx.emailTokenRevocation.count({ where: { organizationId: ctx.orgId, accountId: { in: pendingAccounts.map((row) => row.id) } } })) throw gmailError('GMAIL_REVOCATION_PENDING', 'A previous disconnect is still completing. Try connecting again shortly.')
      const fresh = await notificationContext(ctx.orgId, ctx.userId, tx); if (!fresh) throw gmailError('GMAIL_MEMBER_INACTIVE', 'Workspace access changed.')
      permitEmail(fresh, 'email.connect'); await assertEmailEnabled(ctx.orgId, tx)
      // Serializes with membership deactivation; unique indexes handle simultaneous connects.
      await tx.$queryRaw`SELECT id FROM memberships WHERE organization_id = ${ctx.orgId}::uuid AND user_id = ${ctx.userId}::uuid AND status = 'active' FOR UPDATE`
      if (!await notificationContext(ctx.orgId, ctx.userId, tx)) throw gmailError('GMAIL_MEMBER_INACTIVE', 'Workspace access changed.')
      const data = { userId: ctx.userId, googleSubject: identity.subject, email: identity.email, displayName: identity.displayName || null, connectedAt: new Date(), disconnectedAt: null, lastErrorAt: null, scopes, status: 'connected', credentialEnc: seal(keyData.key, account, 'credentials', { refreshToken }), wrappedKey: keyData.wrappedKey, keyVersion: keyData.keyVersion, generation: (previous?.generation || 0) + 1, consentVersion, consentAt: new Date(), excludedAddresses: state.excludedAddresses, excludedDomains: state.excludedDomains, syncFrom, lastError: null }
      if (previous) await tx.gmailAccount.update({ where: { id, organizationId: ctx.orgId }, data })
      else await tx.gmailAccount.create({ data: { ...account, ...data } })
      await tx.gmailSyncState.upsert({ where: { organizationId_accountId: { organizationId: ctx.orgId, accountId: id } }, create: { organizationId: ctx.orgId, accountId: id, searchFrom: syncFrom }, update: { ...(resetWindow && { historyId: null, searchFrom: state.backfillDays === 30 ? requestedFrom : syncFrom, lastSyncedAt: null, coverageGap: false }), scanState: DB_NULL, nextAttemptAt: new Date(), watchRenewAt: new Date(), failures: 0, leaseUntil: null, leaseToken: null } })
      await auditEmail(tx, ctx.orgId, ctx.userId, ctx.userId, 'CONNECTED', { accountId: id })
      await recordAudit(tx, ctx, { action: 'gmail.connected', entityType: 'gmail_account', entityId: id })
    })
  } catch (err) { if (err.code === 'P2002') throw gmailError('GMAIL_ACCOUNT_UNAVAILABLE', 'This Google account is already connected by another teammate in this workspace.'); throw err }
  if (canSyncAccount({ consentVersion, scopes })) await enqueue('gmail.sync', { organizationId: ctx.orgId, accountId: id }).catch(() => {}) // durable due-state scan recovers
  return { returnTo: state.returnTo, orgId: ctx.orgId }
  } catch (error) { throw Object.assign(error, { returnTo: state.returnTo, orgId: state.organizationId }) }
}
export async function disconnect(ctx, id) {
  await managedAccount(ctx, id)
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${ctx.orgId}::uuid FOR UPDATE`
    await tx.$queryRaw`SELECT id FROM gmail_accounts WHERE id = ${id}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`
    const row = await tx.gmailAccount.findFirst({ where: { id, organizationId: ctx.orgId } })
    if (!row || row.status === 'disconnected') return
    await scheduleRevocation(tx, row)
    await tx.gmailAccount.update({ where: { id, organizationId: ctx.orgId }, data: { status: 'disconnected', credentialEnc: null, disconnectedAt: new Date(), generation: { increment: 1 }, lastError: null } })
    await tx.emailMessage.updateMany({ where: { organizationId: ctx.orgId, accountId: id, status: 'queued' }, data: { status: 'cancelled', lastError: 'GMAIL_NOT_CONNECTED' } })
    await auditEmail(tx, ctx.orgId, ctx.userId, row.userId, row.userId === ctx.userId ? 'DISCONNECTED' : 'DISCONNECTED_BY_ADMIN', { accountId: id })
    await recordAudit(tx, ctx, { action: 'gmail.disconnected', entityType: 'gmail_account', entityId: id })
  })
  await processRevocations(new Date(), { organizationId: ctx.orgId, accountId: id }).catch(() => {})
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
  if (!canSyncAccount(row)) throw gmailError('GMAIL_SYNC_NOT_AUTHORIZED', 'Reply sync is not enabled for this connection.', 403)
  await prisma.gmailSyncState.updateMany({ where: { organizationId: ctx.orgId, accountId: row.id }, data: { nextAttemptAt: new Date() } })
  await enqueue('gmail.sync', { organizationId: ctx.orgId, accountId: row.id }).catch(() => {})
  return { queued: true, syncEnabled: settings().syncEnabled }
}
