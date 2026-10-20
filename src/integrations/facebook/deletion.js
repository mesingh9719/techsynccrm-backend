import crypto from 'node:crypto'
import { env } from '../../config/env.js'
import { prisma } from '../../db/prisma.js'
import { encrypt, decrypt, sha256 } from '../../lib/crypto.js'
import { recordAudit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { enqueue } from '../../jobs/queue.js'
import { ApiError } from '../../utils/ApiError.js'
import { lockFacebookSubject, parseFacebookSignedRequest, facebookRequestCutoff } from './identity.js'

const STATUS_BASE = '/api/integrations/facebook/data-deletion/status/'
function publicStatusUrl(code) {
  let origin
  try { origin = new URL(env.FACEBOOK_REDIRECT_URI) } catch { throw new ApiError(503, 'Configure the public Facebook callback URL.', { code: 'FACEBOOK_NOT_CONFIGURED' }) }
  if (origin.protocol !== 'https:' && (env.isProduction || origin.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname))) throw new ApiError(503, 'Facebook data deletion requires a public HTTPS callback URL.', { code: 'FACEBOOK_NOT_CONFIGURED' })
  return new URL(`${STATUS_BASE}${code}`, origin).toString()
}
export async function requestFacebookDeletion(signedRequest) {
  const signed = parseFacebookSignedRequest(signedRequest)
  const requestHash = sha256(Buffer.from(signedRequest.split('.')[1], 'base64url'))
  // Stable per signed payload: Meta retries receive the same capability without storing it raw.
  const code = crypto.createHmac('sha256', Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64')).update(`facebook-deletion-confirmation:${requestHash}`).digest('hex')
  const url = publicStatusUrl(code)
  const request = await prisma.$transaction(async (tx) => {
    const subjectHash = await lockFacebookSubject(tx, signed.user_id)
    const existing = await tx.facebookDeletionRequest.findUnique({ where: { requestHash } })
    if (existing) return existing
    const cutoffAt = facebookRequestCutoff(signed)
    const row = await tx.facebookDeletionRequest.create({ data: { requestHash, confirmationHash: sha256(code), subjectHash, subjectEnc: encrypt(signed.user_id), cutoffAt } })
    // Revoke in the callback transaction; slow cleanup is handled by bounded background batches.
    // AuthorizedAt protects a later, explicitly granted connection from stale callback replays.
    const connections = await tx.$queryRaw`SELECT id, organization_id FROM facebook_connections WHERE facebook_user_id = ${signed.user_id} AND authorized_at <= ${cutoffAt} ORDER BY id FOR UPDATE`
    if (connections.length) {
      const ids = connections.map((c) => c.id)
      await tx.facebookPage.updateMany({ where: { connectionId: { in: ids } }, data: { enabled: false, tokenEnc: '' } })
      await tx.facebookConnection.updateMany({ where: { id: { in: ids } }, data: { tokenEnc: '', connectedById: null } })
      for (const connection of connections) await recordAudit(tx, { orgId: connection.organization_id, actorType: 'system' }, { action: 'facebook.deletion_requested', entityType: 'facebook_connection', entityId: connection.id })
    }
    return row
  }, { timeout: 20000 })
  if (request.status !== 'completed') await enqueue('facebook.delete', { requestId: request.id }, { singletonKey: request.id }).catch(() => {})
  return { url, confirmation_code: code }
}

/** One short database transaction per batch. No provider network call holds a database lock. */
export async function processFacebookDeletion(id) {
  const lease = new Date(Date.now() + 3 * 60000)
  const claimed = await prisma.facebookDeletionRequest.updateMany({ where: { id, attempts: { lt: 8 }, OR: [{ status: { in: ['queued', 'failed'] }, nextAttemptAt: { lte: new Date() } }, { status: 'processing', leaseUntil: { lt: new Date() } }] }, data: { status: 'processing', leaseUntil: lease, lastError: null } })
  if (!claimed.count) return
  const request = await prisma.facebookDeletionRequest.findUnique({ where: { id } })
  try {
    if (!request.subjectEnc) throw new Error('Missing deletion subject')
    const userId = decrypt(request.subjectEnc)
    for (let batch = 0; batch < 10; batch++) {
      const done = await prisma.$transaction(async (tx) => {
        await lockFacebookSubject(tx, userId)
        await tx.$queryRaw`SELECT id FROM facebook_deletion_requests WHERE id = ${id}::uuid FOR UPDATE`
        const current = await tx.facebookDeletionRequest.findFirst({ where: { id, status: 'processing', leaseUntil: lease } })
        if (!current) return true // Another worker owns recovery; this worker must stop.
        const connection = await tx.facebookConnection.findFirst({ where: { facebookUserId: userId, authorizedAt: { lte: current.cutoffAt } }, orderBy: { id: 'asc' }, select: { id: true, organizationId: true } })
        if (!connection) {
          await tx.facebookDeletionRequest.update({ where: { id }, data: { status: 'completed', completedAt: new Date(), subjectEnc: null, subjectHash: null, leaseUntil: null, lastError: null } })
          return true
        }
        await tx.$queryRaw`SELECT id FROM facebook_connections WHERE id = ${connection.id}::uuid FOR UPDATE`
        const eligible = await tx.facebookConnection.findFirst({ where: { id: connection.id, facebookUserId: userId, authorizedAt: { lte: current.cutoffAt } }, select: { id: true } })
        if (!eligible) return false // A different account/new consent replaced it while waiting.
        const page = await tx.facebookPage.findFirst({ where: { connectionId: connection.id }, orderBy: { id: 'asc' }, select: { id: true } })
        if (page) {
          await tx.$queryRaw`SELECT id FROM facebook_pages WHERE id = ${page.id}::uuid FOR UPDATE`
          const deliveries = await tx.facebookLeadDelivery.findMany({ where: { pageId: page.id }, select: { id: true }, take: 1000 })
          if (deliveries.length) { await tx.facebookLeadDelivery.deleteMany({ where: { id: { in: deliveries.map((d) => d.id) } } }); return false }
          const forms = await tx.facebookForm.findMany({ where: { pageId: page.id }, select: { id: true }, take: 100 })
          if (forms.length) { await tx.facebookForm.deleteMany({ where: { id: { in: forms.map((f) => f.id) } } }); return false }
          await tx.facebookPage.delete({ where: { id: page.id } })
        } else {
          await tx.facebookConnection.delete({ where: { id: connection.id } })
          await recordAudit(tx, { orgId: connection.organizationId, actorType: 'system' }, { action: 'facebook.data_deleted', entityType: 'facebook_connection', entityId: connection.id })
        }
        return false
      }, { timeout: 10000 })
      if (done) return
    }
    await prisma.facebookDeletionRequest.updateMany({ where: { id, status: 'processing', leaseUntil: lease }, data: { status: 'queued', attempts: 0, nextAttemptAt: new Date(), leaseUntil: null } })
    await enqueue('facebook.privacy_recover', {}, { singletonKey: 'deletion-progress' }).catch(() => {})
  } catch {
    await prisma.facebookDeletionRequest.updateMany({ where: { id, status: 'processing', leaseUntil: lease }, data: { status: 'failed', attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + Math.min(86400000, 60000 * 2 ** request.attempts)), leaseUntil: null, lastError: 'Deletion processing is delayed. Automatic retries are scheduled; contact support if the delay continues.' } })
    logger.warn({ deletionRequestId: id }, 'Facebook deletion batch needs retry')
  }
}
export async function recoverFacebookDeletions() {
  // Privacy work must continue even when app credentials/login configuration have been disabled.
  const rows = await prisma.facebookDeletionRequest.findMany({ where: { attempts: { lt: 8 }, OR: [{ status: { in: ['queued', 'failed'] }, nextAttemptAt: { lte: new Date() } }, { status: 'processing', leaseUntil: { lt: new Date() } }] }, select: { id: true }, orderBy: { nextAttemptAt: 'asc' }, take: 50 })
  for (const row of rows) await enqueue('facebook.delete', { requestId: row.id }, { singletonKey: row.id })
  const expired = await prisma.facebookDeletionRequest.findMany({ where: { status: 'completed', completedAt: { lt: new Date(Date.now() - 90 * 86400000) } }, select: { id: true }, take: 200 })
  if (expired.length) await prisma.facebookDeletionRequest.deleteMany({ where: { id: { in: expired.map((r) => r.id) }, status: 'completed' } })
}
export async function facebookDeletionStatus(code) {
  if (!/^[a-f0-9]{64}$/.test(code)) throw ApiError.notFound('Deletion request not found.')
  const row = await prisma.facebookDeletionRequest.findUnique({ where: { confirmationHash: sha256(code) }, select: { status: true, createdAt: true, completedAt: true, attempts: true } })
  if (!row) throw ApiError.notFound('Deletion request not found or its 90-day status window has expired.')
  return row
}
