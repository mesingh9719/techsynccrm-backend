import crypto from 'node:crypto'
import { prisma } from '../../db/prisma.js'
import { googleProvider } from './provider.js'
import { CONSENT_VERSION, SERVICE_SCOPES, settings, requireConfiguration, fingerprint, googleError, scopesAllowed } from './config.js'
import { currentContext, assertService, auditGoogle } from './access.js'
import { openValue, sealValue, workspaceContext } from './envelope.js'
import { processGoogleRevocations, detachConnection } from './revocation.js'

const cache = new Map()
async function active(orgId, id, generation, service) {
  const row = await prisma.googleConnection.findFirst({ where: { id, organizationId: orgId }, include: { services: true } })
  if (!row || row.status !== 'connected' || !row.credentialEnc || generation !== undefined && row.generation !== generation) throw googleError('GOOGLE_RECONNECT_REQUIRED', 'Google connection changed or needs reconnecting.')
  const c = requireConfiguration(), ctx = await currentContext(row.organizationId, row.userId)
  await assertService(ctx, service)
  if (row.projectNumber !== c.projectNumber || row.clientFingerprint !== fingerprint(c.clientId)) throw googleError('GOOGLE_RECONNECT_REQUIRED', 'Google setup changed. Reconnect this account.')
  if (!row.grantedScopes.includes(SERVICE_SCOPES[service]) || !row.services.some((s) => s.service === service && s.enabled && s.consentVersion === CONSENT_VERSION)) throw googleError('GOOGLE_CONSENT_REQUIRED', 'Enable this Google service before using it.', 403)
  return row
}
/** Server-only capability token. Every read/cache hit rechecks current membership and consent. */
export async function workspaceAccessToken(orgId, id, service) {
  const row = await active(orgId, id, undefined, service), key = `${id}:${row.generation}`
  const cached = cache.get(key)
  if (cached?.expiresAt > Date.now() + 60000) return cached.value
  const leaseToken = crypto.randomUUID(), now = new Date()
  const claimed = await prisma.googleConnection.updateMany({ where: { id, organizationId: orgId, generation: row.generation, status: 'connected', credentialEnc: { not: null },
    OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: now } }] }, data: { refreshLeaseUntil: new Date(Date.now() + 45000), refreshLeaseToken: leaseToken } })
  if (!claimed.count) throw googleError('GOOGLE_REFRESH_BUSY', 'Google access is refreshing. Try again shortly.', 503)
  try {
    const envelopeKey = await googleProvider.unwrapKey(row)
    const credentials = openValue(envelopeKey, workspaceContext(row), 'credentials', row.credentialEnc)
    await active(orgId, id, row.generation, service)
    const tokens = await googleProvider.refresh(credentials.refreshToken)
    if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw googleError('GOOGLE_REFRESH_DELAYED', 'Google access is temporarily unavailable.', 503)
    if (tokens.scope && (!scopesAllowed(tokens.scope.split(/\s+/).filter(Boolean)) || !tokens.scope.split(/\s+/).includes(SERVICE_SCOPES[service]))) throw googleError('GOOGLE_RECONNECT_REQUIRED', 'Google permissions changed. Reconnect this account.')
    await active(orgId, id, row.generation, service)
    const updated = await prisma.googleConnection.updateMany({ where: { id, organizationId: orgId, generation: row.generation, status: 'connected', refreshLeaseToken: leaseToken }, data: {
      ...(tokens.refresh_token && { credentialEnc: sealValue(envelopeKey, workspaceContext(row), 'credentials', { refreshToken: tokens.refresh_token }) }),
      lastSuccessAt: new Date(), lastError: null, nextCheckAt: new Date(Date.now() + 15 * 60000),
    } })
    if (!updated.count) throw googleError('GOOGLE_ACCOUNT_CHANGED', 'Google connection changed while refreshing.')
    if (cache.size > 500) cache.clear()
    cache.set(key, { value: tokens.access_token, expiresAt: tokens.expiry_date || Date.now() + 300000 })
    return tokens.access_token
  } catch (error) {
    if (error.code === 'GOOGLE_RECONNECT_REQUIRED') await prisma.$transaction(async (tx) => {
      const changed = await tx.googleConnection.updateMany({ where: { id, organizationId: orgId, generation: row.generation, status: 'connected' }, data: { status: 'reconnect_required', lastError: 'GOOGLE_RECONNECT_REQUIRED' } })
      if (changed.count) await auditGoogle(tx, { orgId, userId: null }, 'reconnect_required', { connectionId: id, status: 'failed', reason: 'GOOGLE_RECONNECT_REQUIRED' })
    })
    throw error
  } finally { await prisma.googleConnection.updateMany({ where: { id, organizationId: orgId, refreshLeaseToken: leaseToken }, data: { refreshLeaseToken: null, refreshLeaseUntil: null } }) }
}

export async function maintainGoogleWorkspace(now = new Date()) {
  // Privacy cleanup is deliberately independent of rollout flags/provider availability.
  await processGoogleRevocations(now)
  await prisma.googleWorkspaceOAuthState.deleteMany({ where: { expiresAt: { lte: now } } })
  await prisma.googleSyncLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 30 * 86400000) } } })
  const rows = await prisma.googleConnection.findMany({ where: { status: { not: 'disconnected' }, nextCheckAt: { lte: now } }, orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }], take: 50, include: { services: true } })
  for (const row of rows) {
    let permitted = true
    try { await currentContext(row.organizationId, row.userId) } catch (error) {
      if (error.statusCode !== 403) throw error
      permitted = false
    }
    if (!permitted) {
      await prisma.$transaction((tx) => detachConnection(tx, row, { orgId: row.organizationId, userId: null }, { reason: 'MEMBERSHIP_INACTIVE' }))
      continue
    }
    const service = row.services.find((s) => s.enabled && settings().services[s.service])?.service
    if (settings().enabled && service && row.status === 'connected') {
      try { await workspaceAccessToken(row.organizationId, row.id, service) }
      catch { /* No provider exception or payload is emitted. */ }
    }
    await prisma.googleConnection.updateMany({ where: { id: row.id, organizationId: row.organizationId, generation: row.generation }, data: { nextCheckAt: new Date(now.getTime() + 15 * 60000) } })
  }
}
