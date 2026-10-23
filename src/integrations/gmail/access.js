import { prisma } from '../../db/prisma.js'
import { hasPermission } from '../../config/permissions.js'
import { planHasFeature } from '../../config/plans.js'
import { notificationContext } from '../../services/notificationAccess.service.js'
import { loadRecord } from '../../services/recordRef.service.js'
import { ApiError } from '../../utils/ApiError.js'
import { ACTIVE, gmailError } from './config.js'

export function permitEmail(ctx, action = 'email.send') {
  if (!hasPermission(ctx.permissions, action)) throw new ApiError(403, 'You do not have permission to use this email action.', { code: 'FORBIDDEN' })
  if (!planHasFeature(ctx.plan || ctx.organization?.plan, 'emailSync')) throw new ApiError(403, 'Gmail is included in Growth and above.', { code: 'FEATURE_NOT_IN_PLAN', details: { feature: 'emailSync', requiredPlan: 'growth' } })
}
export async function accountContext(account, db = prisma) {
  const ctx = account.userId && await notificationContext(account.organizationId, account.userId, db)
  if (!ctx) throw gmailError('GMAIL_MEMBER_INACTIVE', 'Mailbox access has stopped because membership changed.')
  permitEmail(ctx)
  return { ...ctx, plan: ctx.organization.plan }
}
export async function ownAccount(ctx, { connected = true } = {}) {
  const row = await prisma.gmailAccount.findFirst({ where: { organizationId: ctx.orgId, userId: ctx.userId, ...(connected && { status: { in: ACTIVE } }) }, orderBy: { createdAt: 'desc' } })
  if (!row) throw gmailError('GMAIL_NOT_CONNECTED', 'Connect your Gmail account first.')
  if (connected && !['connected', 'syncing', 'delayed'].includes(row.status)) throw gmailError('GMAIL_RECONNECT_REQUIRED', 'Reconnect Gmail to continue.')
  if (connected && !row.credentialEnc) throw gmailError('GMAIL_RECONNECT_REQUIRED', 'Reconnect Gmail to continue.')
  return row
}
export async function managedAccount(ctx, id) {
  const row = await prisma.gmailAccount.findFirst({ where: { id, organizationId: ctx.orgId, ...(!hasPermission(ctx.permissions, 'email.connections.manage') && { userId: ctx.userId }) } })
  if (!row) throw ApiError.notFound('This mailbox is unavailable.')
  return row
}
export async function assertThreadAccess(ctx, threadId, db = prisma) {
  const links = await db.emailRecordLink.findMany({ where: { organizationId: ctx.orgId, threadId } })
  for (const link of links) {
    try { return await loadRecord(ctx, link.leadId ? 'lead' : 'contact', link.leadId || link.contactId, 'read', db) }
    catch (err) { if (![403, 404].includes(err.statusCode)) throw err }
  }
  throw ApiError.notFound('This email conversation is unavailable.')
}
export async function sendRecord(ctx, entityType, entityId, db = prisma) {
  await loadRecord(ctx, entityType, entityId, 'read', db)
  const row = await db[entityType].findFirst({ where: { organizationId: ctx.orgId, id: entityId, deletedAt: null } })
  if (entityType === 'lead' && ['converted', 'lost', 'junk'].includes(row.status)) throw gmailError('EMAIL_RECORD_CLOSED', 'Use an open lead or its linked contact to send email.')
  if (row.optOutAt) throw gmailError('EMAIL_SUPPRESSED', 'This contact has opted out of email.')
  return row
}
