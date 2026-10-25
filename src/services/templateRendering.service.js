import { prisma } from '../db/prisma.js'
import crypto from 'node:crypto'
import { hasPermission } from '../config/permissions.js'
import { loadRecord } from './recordRef.service.js'
import { getDefinitions } from './customField.service.js'
import { visibilityWhere } from '../lib/visibility.js'
import { ApiError } from '../utils/ApiError.js'
import { systemVariables, renderVariables, references } from '../lib/templateVariables.js'
import { cleanHtml, plainText } from '../integrations/gmail/content.js'

const allowedRecord = (ctx, type) => hasPermission(ctx.permissions, `${type === 'company' ? 'companies' : `${type}s`}.read`)
const fieldType = (type) => ['text', 'textarea', 'number', 'date', 'url', 'email', 'checkbox'].includes(type) ? type : 'text'

/** Definition metadata follows existing record permissions; no record values leave this endpoint. */
export async function variableCatalogue(ctx, recordType = 'any', db = prisma) {
  const fields = systemVariables(recordType).filter((f) => !/^(lead|contact|company)\./.test(f.key) || allowedRecord(ctx, f.key.split('.')[0]))
  for (const type of ['lead', 'contact', 'company']) {
    if (!allowedRecord(ctx, type) || recordType !== 'any' && (type === 'company' ? recordType !== 'contact' : type !== recordType)) continue
    const defs = await getDefinitions(ctx.orgId, type, {}, db)
    for (const def of defs) fields.push({ key: `${type}.custom.${def.key}`, label: `${type === 'company' ? 'Primary company' : type === 'lead' ? 'Lead' : 'Contact'} · ${def.label}`, type: fieldType(def.type), source: 'crm', required: true, position: def.position, crmType: def.type, options: def.options })
  }
  return fields
}

export async function previewTemplate(ctx, input) {
  const catalogue = [...await variableCatalogue(ctx, input.recordType), ...input.variables.map((d) => ({ ...d, source: 'template' }))]
  const result = renderVariables(input.subject, input.bodyHtml, catalogue, {}, input.values)
  return { ...result, bodyHtml: cleanHtml(result.bodyHtml), channel: input.channel }
}

async function permittedRecord(ctx, type, id, db) {
  await loadRecord(ctx, type, id, 'read', db)
  const resource = type === 'company' ? 'companies' : `${type}s`
  const row = await db[type].findFirst({ where: { AND: [{ organizationId: ctx.orgId, id, deletedAt: null }, visibilityWhere(ctx, resource, 'read')] } })
  if (!row) throw ApiError.notFound('This record is unavailable.')
  return row
}

async function crmValue(ctx, def, row, db) {
  const raw = row?.customFields?.[def.key.split('.').at(-1)]
  if (raw === undefined || raw === null || raw === '') return undefined
  if (def.crmType === 'currency') return Number.isSafeInteger(raw) ? new Intl.NumberFormat(ctx.locale || 'en-IN', { style: 'currency', currency: ctx.currency || 'INR' }).format(raw / 100) : undefined
  if (def.crmType === 'select') return def.options?.find((o) => o.value === raw)?.label
  if (def.crmType === 'multiselect') return Array.isArray(raw) ? raw.map((value) => def.options?.find((o) => o.value === value)?.label).filter(Boolean).join(', ') : undefined
  if (def.crmType === 'user') {
    if (typeof raw !== 'string' || !/^[\da-f-]{36}$/i.test(raw)) return undefined
    const membership = await db.membership.findFirst({ where: { organizationId: ctx.orgId, userId: raw, status: 'active' }, select: { user: { select: { fullName: true } } } })
    return membership?.user.fullName
  }
  return ['string', 'number', 'boolean'].includes(typeof raw) ? raw : undefined
}

/** Only real relationships are followed: a contact's unambiguous primary company. */
async function recordContext(ctx, entityType, entityId, to, catalogue, db) {
  const record = await permittedRecord(ctx, entityType, entityId, db)
  const emails = record.emails || []
  if (to && !emails.some((e) => e.value?.toLowerCase() === to.toLowerCase())) throw new ApiError(422, 'Choose an email address on this recipient record.', { code: 'EMAIL_RECIPIENT_INVALID' })
  const [user, org] = await Promise.all([
    db.user.findUnique({ where: { id: ctx.userId }, select: { fullName: true, email: true } }),
    db.organization.findFirst({ where: { id: ctx.orgId }, select: { name: true } }),
  ])
  const rows = { [entityType]: record }
  if (entityType === 'contact' && allowedRecord(ctx, 'company')) {
    const links = await db.contactCompany.findMany({ where: { organizationId: ctx.orgId, contactId: record.id }, select: { companyId: true, isPrimary: true }, orderBy: { isPrimary: 'desc' }, take: 2 })
    const link = links.find((l) => l.isPrimary) || (links.length === 1 ? links[0] : null)
    if (link) try { rows.company = await permittedRecord(ctx, 'company', link.companyId, db) } catch (err) { if (![403, 404].includes(err.statusCode)) throw err }
  }
  const context = { firstName: record.firstName, lastName: record.lastName, name: record.displayName, company: entityType === 'lead' ? record.companyName : rows.company?.name,
    owner: user?.fullName, workspace: org?.name, 'user.name': user?.fullName, 'user.email': user?.email, 'workspace.name': org?.name,
  }
  const properties = { first_name: 'firstName', last_name: 'lastName', name: 'displayName', email: 'primaryEmail', phone: 'primaryPhoneE164', company: 'companyName', city: 'city', requirement: 'requirement', title: 'title' }
  for (const [key, property] of Object.entries(properties)) context[`${entityType}.${key}`] = key === 'email' ? to || record.primaryEmail || emails.find((e) => e.primary)?.value || emails[0]?.value : record[property]
  for (const key of ['name', 'domain', 'website', 'industry']) context[`company.${key}`] = rows.company?.[key]
  for (const def of catalogue.filter((f) => f.source === 'crm')) {
    const row = rows[def.key.split('.')[0]]
    if (row) context[def.key] = await crmValue(ctx, def, row, db)
  }
  return context
}

/** Preview and send call this same function. Supplied values are never persisted here. */
export async function renderTemplate(ctx, id, input, db = prisma) {
  const template = await db.emailTemplate.findFirst({ where: { organizationId: ctx.orgId, id, OR: [{ ownerId: ctx.userId }, { shared: true }] } })
  if (!template) throw ApiError.notFound('This template is unavailable.')
  if (template.archivedAt) throw new ApiError(409, 'This template has been archived. Choose another template.', { code: 'TEMPLATE_UNAVAILABLE' })
  if (input.expectedVersion && template.version !== input.expectedVersion) throw new ApiError(409, 'This template changed. Select it again to load its latest variables.', { code: 'STALE_UPDATE' })
  if (template.recordType !== 'any' && template.recordType !== input.entityType) throw new ApiError(422, `This template is for ${template.recordType} records. Choose a compatible template.`, { code: 'TEMPLATE_CONTEXT_MISMATCH' })
  const catalogue = [...await variableCatalogue(ctx, input.entityType, db), ...(template.variables || []).map((d) => ({ ...d, source: 'template' }))]
  const subject = input.subject ?? template.subject, body = input.bodyHtml ?? template.bodyHtml
  const keys = new Set([...references(subject).keys, ...references(body).keys])
  const context = await recordContext(ctx, input.entityType, input.entityId, input.to, catalogue.filter((f) => keys.has(f.key)), db)
  const rendered = renderVariables(subject, body, catalogue, context, input.values || {})
  rendered.bodyHtml = cleanHtml(rendered.bodyHtml)
  if (!rendered.subject.trim() && template.channel === 'email') rendered.errors.subject = 'Add a subject before sending.'
  if (!plainText(rendered.bodyHtml)) rendered.errors.bodyHtml = 'Write a message before sending.'
  if (/[\r\n\0]/.test(rendered.subject)) rendered.errors.subject = 'Use a single line for the subject.'
  if (rendered.subject.length > 998) rendered.errors.subject = 'Keep the rendered subject under 999 characters.'
  if (Buffer.byteLength(rendered.bodyHtml) > 200000) rendered.errors.bodyHtml = 'Keep the rendered message under 200 KB.'
  const limit = template.channel === 'sms' ? 1600 : template.channel === 'whatsapp' ? 4096 : null
  if (limit && plainText(rendered.bodyHtml).length > limit) rendered.errors.bodyHtml = `Keep the rendered message under ${limit.toLocaleString('en-US')} characters.`
  rendered.valid = Object.keys(rendered.errors).length === 0
  const renderHash = crypto.createHash('sha256').update(JSON.stringify([ctx.orgId, ctx.userId, input.entityType, input.entityId, template.id, template.version, rendered.subject, rendered.bodyHtml])).digest('hex')
  return { ...rendered, templateId: template.id, templateVersion: template.version, channel: template.channel, renderHash }
}
