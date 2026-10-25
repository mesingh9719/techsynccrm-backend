import { prisma } from '../db/prisma.js'
import { hasPermission } from '../config/permissions.js'
import { recordAudit } from '../lib/audit.js'
import { emit } from '../events/outbox.js'
import { parseListQuery, buildPage } from '../lib/pagination.js'
import { ApiError } from '../utils/ApiError.js'
import { cleanHtml, plainText } from '../integrations/gmail/content.js'
import { references, systemVariables } from '../lib/templateVariables.js'
import { variableCatalogue } from './templateRendering.service.js'
import { lockTemplateFields } from '../lib/templateFieldDependencies.js'
import { permitEmail } from '../integrations/gmail/access.js'

const visible = (ctx) => ({ organizationId: ctx.orgId, OR: [{ ownerId: ctx.userId }, { shared: true }] })
const select = { recordType: true, variables: true, id: true, ownerId: true, shared: true, channel: true, category: true, archivedAt: true, name: true, subject: true, bodyHtml: true, version: true, createdAt: true, updatedAt: true }
const fail = (field, message) => { throw new ApiError(422, message, { code: 'VALIDATION_ERROR', details: { fields: { [field]: message } } }) }

/** Read visibility is identical for the library and all communication pickers. */
export async function listTemplates(ctx, query = {}) {
  const page = parseListQuery(query, { sortable: { updatedAt: 'date', createdAt: 'date', name: 'string' }, defaultSort: '-updatedAt' })
  const where = { ...visible(ctx), archivedAt: query.status === 'archived' ? { not: null } : null,
    ...(query.channel && { channel: query.channel }), ...(query.category && { category: query.category }),
    ...(query.scope === 'personal' && { ownerId: ctx.userId, shared: false }), ...(query.scope === 'team' && { shared: true }),
  }
  const search = query.q ? { OR: ['name', 'subject', 'bodyText'].map((key) => ({ [key]: { contains: query.q, mode: 'insensitive' } })) } : {}
  const rows = await prisma.emailTemplate.findMany({ where: { AND: [where, search, page.cursorWhere] }, orderBy: page.orderBy, take: page.take, select })
  return buildPage(rows, page)
}

function canWrite(ctx, row) {
  if (!hasPermission(ctx.permissions, 'email.templates.write.own')) throw ApiError.forbidden('You cannot change templates.')
  if (row.channel === 'email') permitEmail(ctx, 'email.templates.write.own')
  if (row.shared && !hasPermission(ctx.permissions, 'email.templates.manage')) throw ApiError.forbidden('Only workspace owners and admins can manage team templates. Duplicate this as a personal template instead.')
}

/** Validate after sanitizing, so formatting-only content cannot become a saved blank message. */
export function validateTemplateContent(input, catalogue = systemVariables(input.recordType || 'any')) {
  const bodyHtml = cleanHtml(input.bodyHtml), text = plainText(bodyHtml)
  if (!text.trim()) fail('bodyHtml', 'Write a message before saving.')
  if (input.channel === 'email' && !input.subject?.trim()) fail('subject', 'Add an email subject.')
  if (input.channel === 'sms' && text.length > 1600) fail('bodyHtml', 'Keep SMS templates under 1,600 characters.')
  if (input.channel === 'whatsapp' && text.length > 4096) fail('bodyHtml', 'Keep WhatsApp templates under 4,096 characters.')
  const allowed = new Set([...catalogue.map((f) => f.key), ...(input.variables || []).map((v) => v.key)])
  for (const [field, value] of [['subject', input.subject || ''], ['bodyHtml', bodyHtml]]) {
    const parsed = references(value)
    if (parsed.errors.length) fail(field, parsed.errors[0])
    for (const key of parsed.keys) if (!allowed.has(key)) fail(field, `Unknown field {{${key}}}. Choose a field from the picker, define this variable, or remove its references first.`)
  }
  return { bodyHtml, bodyText: text, subject: input.subject?.trim() || '' }
}

/** Atomic version predicate prevents lost updates, including archive/edit races. */
export async function saveTemplate(ctx, input, id, { emailOnly = false } = {}) {
  return prisma.$transaction(async (tx) => {
    await lockTemplateFields(tx, ctx.orgId)
    const old = id ? await tx.emailTemplate.findFirst({ where: { id, ...visible(ctx), ...(emailOnly && { channel: 'email' }) } }) : null
    if (id && !old) throw ApiError.notFound('This template is unavailable.')
    const { expectedVersion, archived, ...changes } = input
    const next = { ...(old || { channel: 'email', category: 'general', shared: false }), ...changes }
    // Admins can manage shared templates, but can never read or change another member's private ones.
    if (old) canWrite(ctx, old)
    canWrite(ctx, next)
    const content = !old || ['bodyHtml', 'subject', 'variables', 'recordType'].some((key) => key in changes) ? validateTemplateContent(next, await variableCatalogue(ctx, next.recordType || 'any', tx)) : {}
    const data = { ...changes, ...content, ...(archived !== undefined && { archivedAt: archived ? new Date() : null }),
      ...(old?.shared && !next.shared && { ownerId: ctx.userId }),
    }
    let result
    if (old) {
      const updated = await tx.emailTemplate.updateMany({ where: { id, organizationId: ctx.orgId, version: expectedVersion ?? old.version }, data: { ...data, version: { increment: 1 } } })
      if (!updated.count) throw new ApiError(409, 'This template changed since you opened it. Your work is still here. Save a personal copy, or close the editor and reopen the latest version.', { code: 'STALE_UPDATE' })
      result = await tx.emailTemplate.findFirst({ where: { id, organizationId: ctx.orgId }, select })
    } else {
      result = await tx.emailTemplate.create({ data: { ...data, organizationId: ctx.orgId, ownerId: ctx.userId }, select })
    }
    const action = old ? archived === true ? 'template.archived' : archived === false ? 'template.restored' : 'template.updated' : 'template.created'
    const metadata = { channel: result.channel, shared: result.shared, ownerId: result.ownerId, version: result.version }
    await recordAudit(tx, ctx, { action, entityType: 'email_template', entityId: result.id, changes: metadata })
    await emit(tx, ctx, action, { entityType: 'email_template', entityId: result.id }, metadata)
    return result
  })
}

/** Legacy delete remains supported, with the same privacy and authorization as editing. */
export async function deleteTemplate(ctx, id) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.emailTemplate.findFirst({ where: { id, ...visible(ctx), channel: 'email' } })
    if (!row || row.ownerId !== ctx.userId && !hasPermission(ctx.permissions, 'email.templates.manage')) throw ApiError.notFound('This template is unavailable.')
    canWrite(ctx, row)
    const deleted = await tx.emailTemplate.deleteMany({ where: { id, organizationId: ctx.orgId, version: row.version } })
    if (!deleted.count) throw new ApiError(409, 'This template changed. Reload before deleting.', { code: 'STALE_UPDATE' })
    await recordAudit(tx, ctx, { action: 'template.deleted', entityType: 'email_template', entityId: id })
    await emit(tx, ctx, 'template.deleted', { entityType: 'email_template', entityId: id })
    return { deleted: true }
  })
}
