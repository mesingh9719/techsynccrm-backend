import { prisma } from '../../db/prisma.js'
import { notificationContext } from '../../services/notificationAccess.service.js'
import { hasPermission } from '../../config/permissions.js'
import { recordAudit } from '../../lib/audit.js'
import { googleError, settings } from './config.js'

export const tenantDefaults = Object.freeze({ calendarEnabled: false, driveEnabled: false, sheetsEnabled: false, exportsEnabled: false })
export const tenantSettings = async (orgId, db = prisma) => await db.googleWorkspaceSettings.findUnique({ where: { organizationId: orgId } }) || { organizationId: orgId, ...tenantDefaults }
export async function currentContext(orgId, userId, db = prisma) {
  const ctx = await notificationContext(orgId, userId, db)
  if (!ctx || !hasPermission(ctx.permissions, 'google.connect.own')) throw googleError('GOOGLE_ACCESS_DENIED', 'You cannot use Google connections in this workspace.', 403)
  return ctx
}
export function requireAdmin(ctx) {
  if (!hasPermission(ctx.permissions, 'google.connections.manage')) throw googleError('GOOGLE_ACCESS_DENIED', 'Only workspace administrators can manage Google connections.', 403)
}
export async function assertService(ctx, service, db = prisma) {
  if (!settings().enabled || !settings().services[service]) throw googleError('GOOGLE_SERVICE_DISABLED', 'This Google service is not enabled yet.', 403)
  const tenant = await tenantSettings(ctx.orgId, db)
  if (!tenant[`${service}Enabled`]) throw googleError('GOOGLE_TENANT_DISABLED', 'This Google service is turned off for this workspace.', 403)
}
export async function ownedConnection(ctx, id, db = prisma, { admin = false } = {}) {
  const row = await db.googleConnection.findFirst({ where: { id, organizationId: ctx.orgId, ...(!admin && { userId: ctx.userId }) }, include: { services: true } })
  if (!row) throw googleError('GOOGLE_CONNECTION_NOT_FOUND', 'Google connection not found.', 404)
  return row
}
export async function auditGoogle(db, ctx, action, { connectionId = null, service = null, status = 'completed', reason = null } = {}) {
  await db.googleSyncLog.create({ data: { organizationId: ctx.orgId, actorUserId: ctx.userId ?? null, connectionId, service, action, status, reason } })
  await recordAudit(db, ctx, { action: `google.${action}`, entityType: 'google_connection', entityId: connectionId, changes: { service, status, ...(reason && { reason }) } })
}
export const publicConnection = (row) => row ? { id: row.id, profile: 'workspace', userId: row.userId, email: row.email, status: row.status,
  generation: row.generation, connectedAt: row.createdAt, lastSuccessAt: row.lastSuccessAt, lastError: row.lastError, disconnectedAt: row.disconnectedAt,
  services: (row.services || []).map(({ service, enabled, consentVersion, consentAt }) => ({ service, enabled, consentVersion, consentAt })) } : null
