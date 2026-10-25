import { prisma } from '../../db/prisma.js'
import { googleProvider } from './provider.js'
import { workspaceAccessToken } from './jobs.js'
import { currentContext, assertService, tenantSettings } from './access.js'
import { googleError, CONSENT_VERSION, SERVICE_SCOPES, settings, fingerprint } from './config.js'
import { hasPermission } from '../../config/permissions.js'

export async function ownResourceContext(ctx, service, db = prisma) {
  const fresh = await currentContext(ctx.orgId, ctx.userId, db)
  await assertService(fresh, service, db)
  const connection = await db.googleConnection.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: ctx.userId } }, include: { services: true } })
  if (!connection || connection.status !== 'connected') throw googleError('GOOGLE_RECONNECT_REQUIRED', 'Connect this Google service in Google connections first.', 409)
  const config = settings()
  if (connection.projectNumber !== config.projectNumber || connection.clientFingerprint !== fingerprint(config.clientId)) throw googleError('GOOGLE_RECONNECT_REQUIRED', 'Google configuration changed. Reconnect this service.')
  if (!connection.grantedScopes.includes(SERVICE_SCOPES[service]) || !connection.services.some((entry) => entry.service === service && entry.enabled && entry.consentVersion === CONSENT_VERSION)) throw googleError('GOOGLE_CONSENT_REQUIRED', 'Review and enable this service in Google connections first.', 403)
  return { ctx: fresh, connection }
}
export function requirePermission(ctx, permission) {
  if (!hasPermission(ctx.permissions, permission)) throw googleError('GOOGLE_ACCESS_DENIED', 'Your role cannot perform this action.', 403)
}
export async function requireExport(ctx, db = prisma) {
  requirePermission(ctx, 'records.export')
  if (!(await tenantSettings(ctx.orgId, db)).exportsEnabled) throw googleError('GOOGLE_EXPORT_DISABLED', 'Google exports are turned off in Team & Google.', 403)
}
export async function resourceRequest(ctx, connection, service, api, path, options) {
  const current = await prisma.googleConnection.findFirst({ where: { id: connection.id, organizationId: ctx.orgId, userId: ctx.userId } })
  if (!current || current.generation !== connection.generation || current.googleSubject !== connection.googleSubject || current.projectNumber !== connection.projectNumber) throw googleError('GOOGLE_ACCOUNT_CHANGED', 'Google access changed. Review and retry this operation.')
  const token = await workspaceAccessToken(ctx.orgId, connection.id, service)
  if (!await prisma.googleConnection.count({ where: { id: connection.id, organizationId: ctx.orgId, generation: connection.generation, status: 'connected' } })) throw googleError('GOOGLE_ACCOUNT_CHANGED', 'Google access changed. Review and retry this operation.')
  return googleProvider.request(token, api, path, options)
}
export const providerId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)
export const meetUrl = (value) => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'meet.google.com' && !url.username && !url.password ? url.href : null } catch { return null }
}
export const sheetUrl = (id) => providerId(id) ? `https://docs.google.com/spreadsheets/d/${id}/edit` : null
export const eventId = (id) => `ts${id.replaceAll('-', '')}`
export const retryAt = (attempts) => new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7)))
export const safeCode = (error) => /^GOOGLE_[A-Z_]+$/.test(error?.code || '') ? error.code : [403, 404].includes(error?.statusCode) ? 'GOOGLE_ACCESS_DENIED' : 'GOOGLE_UNAVAILABLE'
