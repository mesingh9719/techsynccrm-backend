import crypto from 'node:crypto'
import { prisma } from '../../db/prisma.js'
import { env } from '../../config/env.js'
import { encrypt, decrypt, sha256, safeEqual } from '../../lib/crypto.js'
import { hasPermission } from '../../config/permissions.js'
import { enqueue } from '../../jobs/queue.js'
import { googleProvider } from './provider.js'
import { gmailAdapter } from './gmailAdapter.js'
import { GOOGLE_SERVICES, CONSENT_VERSION, SERVICE_SCOPES, settings, configurationStatus, requireConfiguration, scopesAllowed, fingerprint, safeReturn, googleError, sharedGoogleProject } from './config.js'
import { currentContext, tenantSettings, assertService, requireAdmin, ownedConnection, publicConnection, auditGoogle } from './access.js'
import { workspaceContext, openValue, sealValue } from './envelope.js'
import { lockGrant, detachConnection } from './revocation.js'

export const metadataSelect = { id: true, userId: true, email: true, status: true, generation: true, createdAt: true,
  disconnectedAt: true, lastSuccessAt: true, lastError: true, grantedScopes: true, clientFingerprint: true, projectNumber: true,
  services: { select: { service: true, enabled: true, consentVersion: true, consentAt: true } } }
const connected = (row) => row?.status === 'connected' && Boolean(row.credentialEnc)
const liveSession = (db, userId, sessionId) => sessionId && db.refreshToken.count({ where: { userId, sessionId, revokedAt: null, expiresAt: { gt: new Date() } } })
async function lockMember(tx, orgId, userId) {
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR NO KEY UPDATE`
  await tx.$queryRaw`SELECT id FROM memberships WHERE organization_id = ${orgId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`
}
export async function me(ctx) {
  const [row, tenant, gmail] = await Promise.all([
    prisma.googleConnection.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: ctx.userId } }, select: metadataSelect }),
    tenantSettings(ctx.orgId), gmailAdapter.metadata(ctx),
  ])
  const c = settings(), setup = configurationStatus(c), canConnect = hasPermission(ctx.permissions, 'google.connect.own')
  return { connection: publicConnection(row), gmail, setup, consentVersion: CONSENT_VERSION, canConnect,
    services: GOOGLE_SERVICES.map((service) => ({ service, connectionOnly: true, available: setup.ready && c.services[service],
      tenantEnabled: tenant[`${service}Enabled`], permissionGranted: row?.clientFingerprint === fingerprint(c.clientId) && row?.projectNumber === c.projectNumber && row.grantedScopes.includes(SERVICE_SCOPES[service]) || false,
      enabled: canConnect && setup.ready && c.services[service] && tenant[`${service}Enabled`] && row?.status === 'connected' && row.clientFingerprint === fingerprint(c.clientId) && row.projectNumber === c.projectNumber && row.grantedScopes.includes(SERVICE_SCOPES[service]) && row.services.some((s) => s.service === service && s.enabled && s.consentVersion === CONSENT_VERSION) || false })) }
}

export async function start(ctx, input) {
  const c = requireConfiguration()
  await currentContext(ctx.orgId, ctx.userId); await assertService(ctx, input.service)
  if (!await liveSession(prisma, ctx.userId, ctx.sessionId)) throw googleError('GOOGLE_SESSION_REQUIRED', 'Sign in again before connecting Google.', 401)
  const state = crypto.randomBytes(32).toString('base64url'), browser = crypto.randomBytes(32).toString('base64url'), nonce = crypto.randomBytes(24).toString('base64url')
  const previous = await prisma.googleConnection.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: ctx.userId } }, select: { generation: true } })
  const authorization = await googleProvider.authorization({ state, nonce, scope: SERVICE_SCOPES[input.service], loginHint: ctx.email || '' })
  const expiresAt = new Date(Date.now() + 600000)
  await prisma.googleWorkspaceOAuthState.create({ data: { organizationId: ctx.orgId, userId: ctx.userId, sessionId: ctx.sessionId,
    stateHash: sha256(state), browserHash: sha256(browser), verifierEnc: encrypt(authorization.verifier), nonce, service: input.service,
    consentVersion: CONSENT_VERSION, expectedGeneration: previous?.generation || 0, clientFingerprint: fingerprint(c.clientId), returnTo: safeReturn(input.returnTo), expiresAt } })
  return { url: authorization.url, expiresAt, browser }
}

export async function finish(query, browser) {
  if (typeof query.state !== 'string' || query.state.length > 200 || typeof browser !== 'string' || browser.length > 200) throw googleError('GOOGLE_OAUTH_INVALID', 'Google connection could not be verified.', 400)
  const state = await prisma.$transaction(async (tx) => {
    const row = await tx.googleWorkspaceOAuthState.findUnique({ where: { stateHash: sha256(query.state) } })
    if (!row || row.usedAt || row.expiresAt <= new Date()) throw googleError('GOOGLE_OAUTH_EXPIRED', 'The Google connection request expired. Try again.', 400)
    if (!safeEqual(row.browserHash, sha256(browser))) throw googleError('GOOGLE_OAUTH_INVALID', 'Use the browser that started the Google connection.', 400)
    if (!(await tx.googleWorkspaceOAuthState.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() }, browserHash: sha256(browser) }, data: { usedAt: new Date() } })).count) throw googleError('GOOGLE_OAUTH_EXPIRED', 'This connection request was already used.', 400)
    return row
  })
  try {
    if (query.error) throw googleError('GOOGLE_OAUTH_CANCELLED', 'Google connection was cancelled.', 400)
    const c = requireConfiguration()
    if (fingerprint(c.clientId) !== state.clientFingerprint || state.consentVersion !== CONSENT_VERSION) throw googleError('GOOGLE_OAUTH_EXPIRED', 'Google setup changed. Start connecting again.', 400)
    if (typeof query.code !== 'string' || query.code.length > 4096) throw googleError('GOOGLE_OAUTH_INVALID', 'Google did not return an authorization code.', 400)
    const ctx = await currentContext(state.organizationId, state.userId)
    await assertService(ctx, state.service)
    if (!await liveSession(prisma, state.userId, state.sessionId)) throw googleError('GOOGLE_SESSION_REQUIRED', 'Sign in again before connecting Google.', 401)
    const tokens = await googleProvider.exchange(query.code, decrypt(state.verifierEnc))
    const identity = await googleProvider.identity(tokens.id_token, state.nonce)
    const scopes = [...new Set(String(tokens.scope || '').split(/\s+/).filter(Boolean))]
    if (!scopesAllowed(scopes)) throw googleError('GOOGLE_UNEXPECTED_SCOPES', 'Google returned unsupported permissions. Check the OAuth project scope configuration.', 400)
    if (!scopes.includes(SERVICE_SCOPES[state.service])) throw googleError('GOOGLE_SCOPES_MISSING', 'The requested Google permission was not granted. Existing connections are unchanged.', 400)
    const previous = await prisma.googleConnection.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: ctx.userId } } })
    if ((previous?.generation || 0) !== state.expectedGeneration) throw googleError('GOOGLE_ACCOUNT_CHANGED', 'Your Google connection changed. Start again.')
    if (connected(previous) && previous.googleSubject !== identity.subject) throw googleError('GOOGLE_ACCOUNT_CHANGED', 'Disconnect this workspace connection before choosing another Google account.')
    const sameGrant = connected(previous) && previous.googleSubject === identity.subject && previous.clientFingerprint === state.clientFingerprint && previous.projectNumber === c.projectNumber
    const account = { id: previous?.id || crypto.randomUUID(), organizationId: ctx.orgId }
    const keyData = sameGrant ? { key: await googleProvider.unwrapKey(previous), wrappedKey: previous.wrappedKey, keyVersion: previous.keyVersion } : await googleProvider.newKey(account)
    let refreshToken = tokens.refresh_token
    if (!refreshToken && sameGrant) refreshToken = openValue(keyData.key, workspaceContext(account), 'credentials', previous.credentialEnc).refreshToken
    if (!refreshToken) throw googleError('GOOGLE_RECONNECT_REQUIRED', 'Google did not grant offline access. Connect again and allow the requested permission.')
    const grantHash = fingerprint(`${c.projectNumber}:${identity.subject}`)
    await prisma.$transaction(async (tx) => {
      await lockMember(tx, ctx.orgId, ctx.userId); await lockGrant(tx, grantHash)
      await currentContext(ctx.orgId, ctx.userId, tx); await assertService(ctx, state.service, tx)
      if (!await liveSession(tx, state.userId, state.sessionId)) throw googleError('GOOGLE_SESSION_REQUIRED', 'Sign in again before connecting Google.', 401)
      const current = await tx.googleConnection.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: ctx.userId } } })
      if ((current?.generation || 0) !== state.expectedGeneration) throw googleError('GOOGLE_ACCOUNT_CHANGED', 'Your Google connection changed. Start again.')
      if (await tx.googleRevocation.count({ where: { grantHash } })) throw googleError('GOOGLE_REVOCATION_PENDING', 'Google access removal is still completing. Try connecting again later.')
      const data = { googleSubject: identity.subject, email: identity.email, projectNumber: c.projectNumber, clientFingerprint: state.clientFingerprint, grantHash,
        status: 'connected', generation: state.expectedGeneration + 1, grantedScopes: scopes,
        credentialEnc: sealValue(keyData.key, workspaceContext(account), 'credentials', { refreshToken }), wrappedKey: keyData.wrappedKey, keyVersion: keyData.keyVersion,
        disconnectedAt: null, lastError: null, nextCheckAt: new Date(), refreshLeaseUntil: null, refreshLeaseToken: null }
      await tx.googleConnection.upsert({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: ctx.userId } },
        create: { ...account, userId: ctx.userId, ...data }, update: data })
      // Missing returned scopes turn old capabilities off; historical scopes alone never turn one on.
      await tx.googleServiceConsent.updateMany({ where: { organizationId: ctx.orgId, connectionId: account.id, service: { in: GOOGLE_SERVICES.filter((s) => !scopes.includes(SERVICE_SCOPES[s])) } }, data: { enabled: false } })
      await tx.googleServiceConsent.upsert({ where: { organizationId_connectionId_service: { organizationId: ctx.orgId, connectionId: account.id, service: state.service } },
        create: { organizationId: ctx.orgId, connectionId: account.id, service: state.service, enabled: true, consentVersion: CONSENT_VERSION },
        update: { enabled: true, consentVersion: CONSENT_VERSION, consentAt: new Date() } })
      await auditGoogle(tx, ctx, 'connection_consented', { connectionId: account.id, service: state.service })
    })
    return { returnTo: state.returnTo, status: 'connected' }
  } catch (error) { throw Object.assign(error, { returnTo: state.returnTo }) }
}

export async function setService(ctx, id, service, input) {
  return prisma.$transaction(async (tx) => {
    await lockMember(tx, ctx.orgId, ctx.userId)
    const row = await ownedConnection(ctx, id, tx)
    if (input.enabled) {
      const c = requireConfiguration(); await currentContext(ctx.orgId, ctx.userId, tx); await assertService(ctx, service, tx)
      if (row.clientFingerprint !== fingerprint(c.clientId) || row.projectNumber !== c.projectNumber) throw googleError('GOOGLE_RECONNECT_REQUIRED', 'Google setup changed. Reconnect this account.')
      if (input.consentVersion !== CONSENT_VERSION) throw googleError('GOOGLE_CONSENT_REQUIRED', 'Review the current Google permission notice before enabling this service.', 400)
      if (!connected(row) || !row.grantedScopes.includes(SERVICE_SCOPES[service])) throw googleError('GOOGLE_SCOPES_MISSING', 'Connect Google to grant the permission for this service.', 400)
    }
    const changed = await tx.googleConnection.updateMany({ where: { id: row.id, organizationId: ctx.orgId, generation: row.generation }, data: { generation: { increment: 1 } } })
    if (!changed.count) throw googleError('GOOGLE_ACCOUNT_CHANGED', 'Your Google connection changed. Refresh and try again.')
    await tx.googleServiceConsent.upsert({ where: { organizationId_connectionId_service: { organizationId: ctx.orgId, connectionId: id, service } },
      create: { organizationId: ctx.orgId, connectionId: id, service, enabled: input.enabled, consentVersion: CONSENT_VERSION },
      update: { enabled: input.enabled, ...(input.enabled && { consentVersion: CONSENT_VERSION, consentAt: new Date() }) } })
    await auditGoogle(tx, ctx, input.enabled ? 'service_enabled' : 'service_disabled', { connectionId: id, service })
    return publicConnection(await ownedConnection(ctx, id, tx))
  })
}

export async function disconnect(ctx, id, { admin = false, projectWide = false } = {}) {
  if (admin) requireAdmin(ctx)
  if (projectWide) {
    if (admin) throw googleError('GOOGLE_ACCESS_DENIED', 'Only the connected account owner can remove the Google project grant.', 403)
    const binding = await ownedConnection(ctx, id)
    if (sharedGoogleProject(binding.projectNumber)) throw googleError('GOOGLE_SHARED_PROJECT_REVOCATION', 'This project also serves Gmail or Google sign-in. Remove full access from your Google Account connections page; this may require reconnecting those services.')
    const first = ctx.sessionId && await prisma.refreshToken.findFirst({ where: { userId: ctx.userId, sessionId: ctx.sessionId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
    if (!first || Date.now() - first.createdAt.getTime() > 15 * 60000 || !await liveSession(prisma, ctx.userId, ctx.sessionId)) throw googleError('GOOGLE_RECENT_LOGIN_REQUIRED', 'Sign out and sign in again before removing Google access.', 401)
  }
  await prisma.$transaction(async (tx) => {
    const row = await ownedConnection(ctx, id, tx, { admin })
    await detachConnection(tx, row, ctx, { projectWide })
  })
  await enqueue('google.maintain', {}).catch(() => {})
  return { disconnected: true, ...(projectWide && { revocationPending: true }) }
}

export async function updateTenantSettings(ctx, input) {
  requireAdmin(ctx)
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${ctx.orgId}::uuid FOR NO KEY UPDATE`
    const result = await tx.googleWorkspaceSettings.upsert({ where: { organizationId: ctx.orgId }, create: { organizationId: ctx.orgId, ...input }, update: input })
    // Disable preferences immediately; re-enabling the tenant never restores personal consent silently.
    const disabled = GOOGLE_SERVICES.filter((service) => input[`${service}Enabled`] === false)
    if (disabled.length) {
      await tx.googleServiceConsent.updateMany({ where: { organizationId: ctx.orgId, service: { in: disabled } }, data: { enabled: false } })
      await tx.googleConnection.updateMany({ where: { organizationId: ctx.orgId, status: { not: 'disconnected' } }, data: { generation: { increment: 1 } } })
    }
    await auditGoogle(tx, ctx, 'settings_updated')
    return result
  })
}

export async function adminConnections(ctx, { q = '', page = 1, pageSize = 25 } = {}) {
  requireAdmin(ctx)
  const where = { organizationId: ctx.orgId, status: 'active', user: { deletedAt: null, ...(q && { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] }) } }
  const [total, members] = await Promise.all([prisma.membership.count({ where }), prisma.membership.findMany({ where, orderBy: [{ user: { fullName: 'asc' } }, { userId: 'asc' }], skip: (page - 1) * pageSize, take: pageSize,
    select: { role: true, userId: true, user: { select: { fullName: true, email: true, googleConnections: { where: { organizationId: ctx.orgId }, select: metadataSelect, take: 1 },
      gmailAccounts: { where: { organizationId: ctx.orgId }, orderBy: [{ consentAt: 'desc' }, { createdAt: 'desc' }], take: 1, select: { id: true, email: true, status: true } } } } } })])
  return { total, page, pageSize, items: members.map(({ userId, role, user }) => ({ userId, role, fullName: user.fullName, email: user.email,
    workspace: publicConnection(user.googleConnections[0]), gmail: user.gmailAccounts[0] || null })) }
}
export async function syncLogs(ctx, { page = 1, pageSize = 25, service } = {}) {
  requireAdmin(ctx)
  const where = { organizationId: ctx.orgId, ...(service && { service }) }
  const [total, items] = await Promise.all([prisma.googleSyncLog.count({ where }), prisma.googleSyncLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize })])
  return { total, items, page, pageSize }
}
export const callbackDestination = (returnTo, status) => `${env.FRONTEND_URL}${safeReturn(returnTo)}?google=${encodeURIComponent(status)}`
