import crypto from 'node:crypto'
import { prisma } from '../../db/prisma.js'
import { googleProvider } from './provider.js'
import { workspaceContext, openValue } from './envelope.js'
import { auditGoogle } from './access.js'
import { sharedGoogleProject, googleError } from './config.js'

export const lockGrant = (tx, hash) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`google-workspace:${hash}`}, 0))`
const erased = () => ({ status: 'disconnected', credentialEnc: null, wrappedKey: null, keyVersion: null, disconnectedAt: new Date(),
  generation: { increment: 1 }, refreshLeaseUntil: null, refreshLeaseToken: null, lastError: null })
async function schedule(tx, row) {
  if (!row.credentialEnc) return
  await tx.googleRevocation.upsert({ where: { grantHash: row.grantHash }, update: {}, create: {
    organizationId: row.organizationId, connectionId: row.id, grantHash: row.grantHash, credentialEnc: row.credentialEnc,
    wrappedKey: row.wrappedKey, keyVersion: row.keyVersion, expiresAt: new Date(Date.now() + 30 * 86400000),
  } })
}
/** Caller already authorized the local binding. Internal cross-tenant checks expose no DTOs. */
export async function detachConnection(tx, row, ctx, { projectWide = false, reason = null } = {}) {
  if (projectWide && sharedGoogleProject(row.projectNumber)) throw googleError('GOOGLE_SHARED_PROJECT_REVOCATION', 'Remove full project access from your Google Account connections page; Gmail and sign-in may need reconnecting.')
  await lockGrant(tx, row.grantHash)
  const current = await tx.googleConnection.findFirst({ where: { id: row.id, organizationId: row.organizationId }, include: { services: true } })
  if (!current) return
  if (projectWide) {
    const credential = current.credentialEnc ? current : await tx.googleConnection.findFirst({ where: { grantHash: current.grantHash, credentialEnc: { not: null } } })
    if (credential) await schedule(tx, credential)
    // Provider revocation is project-wide, including other legitimate workspace bindings.
    // Local invalidation commits before the worker contacts Google.
    for (;;) {
      const rows = await tx.googleConnection.findMany({ where: { grantHash: current.grantHash, status: { not: 'disconnected' } }, take: 100, orderBy: { id: 'asc' } })
      if (!rows.length) break
      for (const other of rows) {
        await tx.googleConnection.update({ where: { id: other.id, organizationId: other.organizationId }, data: erased() })
        await tx.googleServiceConsent.updateMany({ where: { organizationId: other.organizationId, connectionId: other.id }, data: { enabled: false } })
        await auditGoogle(tx, { orgId: other.organizationId, userId: other.organizationId === ctx.orgId ? ctx.userId : null }, 'grant_revocation_requested', { connectionId: other.id, status: 'pending' })
      }
    }
  } else if (current.status !== 'disconnected') {
    await tx.googleConnection.update({ where: { id: current.id, organizationId: current.organizationId }, data: erased() })
    await tx.googleServiceConsent.updateMany({ where: { organizationId: current.organizationId, connectionId: current.id }, data: { enabled: false } })
    const peers = await tx.googleConnection.count({ where: { grantHash: current.grantHash, credentialEnc: { not: null } } })
    if (!peers && !sharedGoogleProject(current.projectNumber)) await schedule(tx, current)
    await auditGoogle(tx, ctx, 'connection_detached', { connectionId: current.id, reason })
  }
}

/** Also used inside existing membership/user/workspace deletion transactions. */
export async function detachForDeparture(tx, { userId, organizationId }) {
  for (;;) {
    const rows = await tx.googleConnection.findMany({ where: { ...(userId && { userId }), ...(organizationId && { organizationId }), status: { not: 'disconnected' } }, take: 100, orderBy: [{ grantHash: 'asc' }, { id: 'asc' }] })
    if (!rows.length) break
    for (const row of rows) await detachConnection(tx, row, { orgId: row.organizationId, userId: null }, { reason: 'MEMBERSHIP_INACTIVE' })
  }
}

export async function processGoogleRevocations(now = new Date()) {
  await prisma.googleRevocation.deleteMany({ where: { expiresAt: { lte: now } } })
  const rows = await prisma.googleRevocation.findMany({ where: { nextAttemptAt: { lte: now }, expiresAt: { gt: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, take: 25, orderBy: { nextAttemptAt: 'asc' } })
  for (const row of rows) {
    // Old queued local cleanup must not become a project-wide revoke after an operator
    // configures this same project for Gmail/sign-in. Erase the snapshot locally.
    if (sharedGoogleProject()) {
      await prisma.googleRevocation.deleteMany({ where: { id: row.id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] } })
      continue
    }
    const leaseToken = crypto.randomUUID()
    if (!(await prisma.googleRevocation.updateMany({ where: { id: row.id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseToken, leaseUntil: new Date(Date.now() + 60000) } })).count) continue
    try {
      const account = { ...row, id: row.connectionId }
      const value = openValue(await googleProvider.unwrapKey(account), workspaceContext(account), 'credentials', row.credentialEnc)
      await googleProvider.revoke(value.refreshToken)
      await prisma.googleRevocation.deleteMany({ where: { id: row.id, leaseToken } })
    } catch {
      await prisma.googleRevocation.updateMany({ where: { id: row.id, leaseToken }, data: { attempts: { increment: 1 }, leaseToken: null, leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + Math.min(86400, 60 * 2 ** Math.min(row.attempts, 10)) * 1000) } })
    }
  }
}
