import { prisma } from '../db/prisma.js'
import { ApiError } from '../utils/ApiError.js'
import { hasPermission } from '../config/permissions.js'
import { env } from '../config/env.js'
import { queueEmail } from '../email/mailer.js'
import { logger } from '../lib/logger.js'
import { signalNotifications } from '../services/notification.service.js'
import { cleanHtml } from '../integrations/gmail/content.js'
import { accountDto, accountMetadata } from './dto.js'

export const defaults = Object.freeze({ emailEnabled: true, emailVisibility: 'LEAD_ACCESS', defaultSignatureHtml: '',
  allowEmployeeCustomSignature: true, requireConnectedEmailToSend: true })
const connected = ['connected', 'syncing', 'delayed']
const relevant = [...connected, 'reconnect_required', 'paused']
export function requireEmailAdmin(ctx) {
  if (!hasPermission(ctx.permissions, 'email.connections.manage')) throw new ApiError(403, 'Only workspace administrators can manage team email.', { code: 'FORBIDDEN' })
}
export const getSettings = async (orgId, db = prisma) => await db.tenantEmailSettings.findUnique({ where: { organizationId: orgId } }) || { ...defaults, organizationId: orgId }
export async function assertEmailEnabled(orgId, db = prisma) {
  if (!(await getSettings(orgId, db)).emailEnabled) throw new ApiError(403, 'Email connections are turned off for this workspace.', { code: 'EMAIL_DISABLED' })
}
export const auditEmail = (db, orgId, actorUserId, targetUserId, action, metadata = {}) => db.emailAuditLog.create({
  data: { organizationId: orgId, actorUserId, targetUserId, action, metadata },
})
export async function emailMe(ctx) {
  const [row, settings] = await Promise.all([
    prisma.gmailAccount.findFirst({ where: { organizationId: ctx.orgId, userId: ctx.userId }, orderBy: [{ consentAt: 'desc' }, { createdAt: 'desc' }], select: accountMetadata }),
    getSettings(ctx.orgId),
  ])
  return { account: accountDto(row), settings: { emailEnabled: settings.emailEnabled } }
}
export async function updateTenantSettings(ctx, input) {
  requireEmailAdmin(ctx)
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${ctx.orgId}::uuid FOR UPDATE`
    const data = { ...input, ...(input.defaultSignatureHtml !== undefined && { defaultSignatureHtml: cleanHtml(input.defaultSignatureHtml) }) }
    const result = await tx.tenantEmailSettings.upsert({ where: { organizationId: ctx.orgId }, create: { organizationId: ctx.orgId, ...data }, update: data })
    // Log names only; signature HTML can contain personal information.
    await auditEmail(tx, ctx.orgId, ctx.userId, null, 'SETTINGS_UPDATED', { fields: Object.keys(data) })
    return result
  })
}
function statusWhere(orgId, status) {
  const scope = { organizationId: orgId, status: { in: relevant } }
  if (status === 'all') return {}
  if (status === 'DISCONNECTED') return { user: { gmailAccounts: { none: scope } } }
  const statuses = status === 'CONNECTED' ? connected : status === 'NEEDS_RECONNECT' ? ['reconnect_required'] : ['paused']
  return { user: { gmailAccounts: { some: { organizationId: orgId, status: { in: statuses } } } } }
}
export async function teamEmail(ctx, { q = '', status = 'all', page = 1, pageSize = 25 } = {}) {
  requireEmailAdmin(ctx)
  const base = { organizationId: ctx.orgId, status: 'active', user: { deletedAt: null } }
  const where = { AND: [base, statusWhere(ctx.orgId, status), ...(q ? [{ user: { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] } }] : [])] }
  const [total, members, counts] = await prisma.$transaction([
    prisma.membership.count({ where }),
    prisma.membership.findMany({ where, orderBy: [{ user: { fullName: 'asc' } }, { userId: 'asc' }], skip: (page - 1) * pageSize, take: pageSize,
      select: { userId: true, role: true, user: { select: { fullName: true, email: true, gmailAccounts: {
        where: { organizationId: ctx.orgId }, orderBy: [{ consentAt: 'desc' }, { createdAt: 'desc' }], take: 1, select: accountMetadata,
      } } } } }),
    ...['CONNECTED', 'DISCONNECTED', 'NEEDS_RECONNECT', 'ERROR'].map((s) => prisma.membership.count({ where: { AND: [base, statusWhere(ctx.orgId, s)] } })),
  ]).then(([total, members, ...counts]) => [total, members, counts])
  return { items: members.map((m) => ({ userId: m.userId, fullName: m.user.fullName, email: m.user.email, role: m.role, account: accountDto(m.user.gmailAccounts[0]) })),
    page, pageSize, total, summary: { CONNECTED: counts[0], DISCONNECTED: counts[1], NEEDS_RECONNECT: counts[2], ERROR: counts[3] } }
}
export async function remindTeam(ctx, { userIds } = {}) {
  requireEmailAdmin(ctx); await assertEmailEnabled(ctx.orgId)
  const where = { organizationId: ctx.orgId, status: 'active', role: { not: 'viewer' }, user: { deletedAt: null, gmailAccounts: { none: { organizationId: ctx.orgId, status: { in: connected } } } }, ...(userIds && { userId: { in: userIds } }) }
  // Bounded batches, with a cursor, cover the full team without a large in-memory result.
  let cursor, sent = 0, skipped = 0
  for (;;) {
    const rows = await prisma.membership.findMany({ where, orderBy: { id: 'asc' }, take: 100, ...(cursor && { cursor: { id: cursor }, skip: 1 }), select: { id: true, userId: true, user: { select: { email: true } } } })
    if (!rows.length) break
    for (const member of rows) {
      const notified = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM memberships WHERE organization_id = ${ctx.orgId}::uuid AND user_id = ${member.userId}::uuid FOR UPDATE`
        if (!await tx.membership.count({ where: { ...where, userId: member.userId } })) return false
        const recent = await tx.emailAuditLog.count({ where: { organizationId: ctx.orgId, targetUserId: member.userId, action: 'REMINDER_SENT', createdAt: { gt: new Date(Date.now() - 86400000) } } })
        if (recent) return false
        await tx.notification.create({ data: { organizationId: ctx.orgId, userId: member.userId, actorId: ctx.userId, type: 'system', title: 'Connect your Gmail', body: 'Connect Gmail to email leads from TechSync.', url: '/app/settings/gmail', inApp: true } })
        await signalNotifications(tx, ctx.orgId, member.userId)
        await auditEmail(tx, ctx.orgId, ctx.userId, member.userId, 'REMINDER_SENT', { channel: 'in_app' })
        return true
      })
      if (!notified) { skipped++; continue }
      sent++
      if (env.SMTP_HOST) {
        const url = `${env.FRONTEND_URL}/app/settings/gmail`
        await queueEmail({ to: member.user.email, subject: 'Connect your Gmail to TechSync', text: `Your workspace administrator invited you to connect Gmail to email leads from TechSync. Open ${url}. You can disconnect anytime.`, html: `<p>Your workspace administrator invited you to connect Gmail to TechSync.</p><p><a href="${url}">Open Email settings</a></p><p>You can disconnect anytime.</p>` })
          .catch(() => logger.warn({ code: 'EMAIL_REMINDER_DELIVERY_DELAYED' }, 'Gmail reminder is available in the app; email delivery failed'))
      }
    }
    cursor = rows.at(-1).id
  }
  return { sent, skipped }
}
