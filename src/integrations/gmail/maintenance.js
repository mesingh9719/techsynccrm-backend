import { prisma } from '../../db/prisma.js'
import { enqueue } from '../../jobs/queue.js'
import { logger } from '../../lib/logger.js'
import { recordAudit } from '../../lib/audit.js'
import { managedAccount, accountContext } from './access.js'
import { settings, ACTIVE } from './config.js'
import { disconnect } from './connection.js'
import { checkDeliveryReports } from './bounces.js'
import { provider } from './provider.js'
import { accessToken, reconcileUnknown, safeFailure } from './jobs.js'

const log = logger.child({ component: 'gmail-maintenance' })
export async function deleteHistory(ctx, accountId) {
  await managedAccount(ctx, accountId)
  await disconnect(ctx, accountId)
  await prisma.$transaction(async (tx) => {
    await tx.gmailAccount.update({ where: { id: accountId, organizationId: ctx.orgId }, data: { status: 'deleting', deletionRequestedAt: new Date(), credentialEnc: null } })
    await recordAudit(tx, ctx, { action: 'gmail.history_deletion_requested', entityType: 'gmail_account', entityId: accountId })
  })
  await enqueue('gmail.maintain', {}).catch(() => {})
  return { queued: true, accountId }
}
export async function purgeMessages(where, limit = 100) {
  const rows = await prisma.emailMessage.findMany({ where: { ...where, contentEnc: { not: null } }, select: { id: true, organizationId: true, activityId: true }, take: limit, orderBy: { expiresAt: 'asc' } })
  for (const row of rows) await prisma.$transaction(async (tx) => {
    await tx.emailMessage.update({ where: { id: row.id, organizationId: row.organizationId }, data: { contentEnc: null, status: 'redacted', attachmentFileIds: [], lastError: null, leaseUntil: null } })
    if (row.activityId) await tx.activity.deleteMany({ where: { id: row.activityId, organizationId: row.organizationId } })
  })
  return rows.length
}
export async function maintainGmail(now = new Date()) {
  // Privacy cleanup is independent of the rollout switches.
  await prisma.gmailOAuthState.deleteMany({ where: { expiresAt: { lt: now } } })
  await purgeMessages({ expiresAt: { lte: now } })
  const deleting = await prisma.gmailAccount.findMany({ where: { status: 'deleting' }, take: 20 })
  for (const row of deleting) {
    await purgeMessages({ organizationId: row.organizationId, accountId: row.id }, 500)
    if (!await prisma.emailMessage.count({ where: { organizationId: row.organizationId, accountId: row.id, contentEnc: { not: null } } })) {
      await prisma.gmailAccount.updateMany({ where: { id: row.id, organizationId: row.organizationId, status: 'deleting' }, data: { status: 'disconnected', wrappedKey: 'erased', keyVersion: 'erased', signatureHtml: '', lastError: 'GMAIL_HISTORY_DELETED', deletionRequestedAt: null } })
    }
  }
  // A killed worker must never make an uncertain send eligible for blind re-delivery.
  await prisma.emailMessage.updateMany({ where: { status: 'sending', leaseUntil: { lt: now } }, data: { status: 'unknown', leaseUntil: null, lastError: 'EMAIL_SEND_UNKNOWN' } })
  const accounts = await prisma.gmailAccount.findMany({ where: { status: { in: ACTIVE } }, orderBy: { updatedAt: 'asc' }, take: 100 })
  for (const account of accounts) {
    try { await accountContext(account) }
    catch (error) {
      const inactive = error.code === 'GMAIL_MEMBER_INACTIVE'
      await prisma.gmailAccount.updateMany({ where: { id: account.id, organizationId: account.organizationId, generation: account.generation }, data: { status: inactive ? 'disconnected' : 'paused', ...(inactive && { credentialEnc: null }), generation: { increment: 1 }, lastError: inactive ? 'GMAIL_MEMBER_INACTIVE' : 'FEATURE_NOT_IN_PLAN' } })
      await prisma.emailMessage.updateMany({ where: { organizationId: account.organizationId, accountId: account.id, status: 'queued' }, data: { status: 'cancelled', lastError: inactive ? 'GMAIL_MEMBER_INACTIVE' : 'FEATURE_NOT_IN_PLAN' } })
    }
  }
  if (!settings().enabled) return
  const pending = await prisma.emailMessage.findMany({ where: { status: 'queued', nextAttemptAt: { lte: now }, account: { status: { in: ['connected', 'syncing', 'delayed'] } } }, select: { organizationId: true, id: true }, orderBy: { nextAttemptAt: 'asc' }, take: 50 })
  for (const row of pending) await enqueue('gmail.send', { organizationId: row.organizationId, messageId: row.id })
  const unknown = await prisma.emailMessage.findMany({ where: { status: 'unknown', nextAttemptAt: { lte: now }, account: { status: { in: ['connected', 'syncing', 'delayed'] } } }, orderBy: { nextAttemptAt: 'asc' }, take: 5 })
  for (const message of unknown) {
    await reconcileUnknown(message).catch((error) => log.warn({ messageId: message.id, code: safeFailure(error) }, 'Gmail reconciliation delayed'))
    await prisma.emailMessage.updateMany({ where: { organizationId: message.organizationId, id: message.id, status: 'unknown' }, data: { nextAttemptAt: new Date(now.getTime() + 300000) } })
  }
  if (!settings().syncEnabled) return
  const deliveries = await prisma.emailMessage.findMany({ where: { status: 'provider_accepted', direction: 'outbound', occurredAt: { gt: new Date(now.getTime() - 30 * 86400000) }, nextAttemptAt: { lte: now }, account: { status: { in: ['connected', 'syncing', 'delayed'] } } }, orderBy: { nextAttemptAt: 'asc' }, take: 5 })
  for (const message of deliveries) {
    await checkDeliveryReports(message).catch((error) => log.warn({ messageId: message.id, code: safeFailure(error) }, 'Gmail delivery report check delayed'))
    await prisma.emailMessage.updateMany({ where: { organizationId: message.organizationId, id: message.id, status: 'provider_accepted' }, data: { nextAttemptAt: new Date(now.getTime() + 1800000) } })
  }

  const due = await prisma.gmailSyncState.findMany({ where: { nextAttemptAt: { lte: now }, account: { status: { in: ['connected', 'syncing', 'delayed'] } } }, orderBy: { nextAttemptAt: 'asc' }, take: 50 })
  for (const row of due) await enqueue('gmail.sync', { organizationId: row.organizationId, accountId: row.accountId })
  if (!settings().topic) return // Polling continues if push configuration is unavailable.
  const renewals = await prisma.gmailSyncState.findMany({ where: { watchRenewAt: { lte: now }, account: { status: { in: ['connected', 'syncing', 'delayed'] } } }, include: { account: true }, orderBy: { watchRenewAt: 'asc' }, take: 5 })
  for (const row of renewals) {
    try {
      await accountContext(row.account)
      const result = await provider.api(await accessToken(row.account), 'watch', { method: 'POST', body: { topicName: settings().topic, labelFilterBehavior: 'exclude', labelIds: ['SPAM', 'TRASH'] } })
      await prisma.gmailSyncState.updateMany({ where: { organizationId: row.organizationId, accountId: row.accountId }, data: { watchExpiresAt: new Date(Number(result.expiration)), watchRenewAt: new Date(now.getTime() + 86400000) } })
    } catch (error) {
      await prisma.gmailSyncState.updateMany({ where: { organizationId: row.organizationId, accountId: row.accountId }, data: { watchRenewAt: new Date(now.getTime() + 900000) } })
      log.warn({ accountId: row.accountId, code: safeFailure(error) }, 'Gmail watch renewal delayed; polling remains active')
    }
  }
}
export async function acceptPush(authorization, body) {
  await provider.verifyPush(String(authorization || '').replace(/^Bearer /, ''))
  let payload
  try { payload = JSON.parse(Buffer.from(body.message?.data || '', 'base64').toString('utf8')) } catch { return }
  if (typeof payload.emailAddress !== 'string' || !/^\d{1,30}$/.test(payload.historyId || '')) return
  const account = await prisma.gmailAccount.findFirst({ where: { email: payload.emailAddress.toLowerCase(), status: { in: ['connected', 'syncing', 'delayed'] } } })
  if (!account) return
  await prisma.gmailSyncState.updateMany({ where: { organizationId: account.organizationId, accountId: account.id }, data: { nextAttemptAt: new Date(), pendingHistoryId: payload.historyId } })
  await enqueue('gmail.sync', { organizationId: account.organizationId, accountId: account.id }).catch(() => {}) // due state is durable
}
