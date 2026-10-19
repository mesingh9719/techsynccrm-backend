import { prisma } from '../db/prisma.js'
import { diff, emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { gstinErrors } from '../lib/india.js'
import { runMergeSteps } from '../lib/merge.js'
import { buildPage, parseListQuery } from '../lib/pagination.js'
import { normalizePhone } from '../lib/phone.js'
import { assertAssignableOwner, assertNotStale, assertRestorable, dateRange, listParam, ownerFilter, usersById, validationError } from '../lib/records.js'
import { canAccessRecord, registerReassignable, visibilityWhere } from '../lib/visibility.js'
import { ApiError } from '../utils/ApiError.js'
import { customFieldWhere, validateCustomFields } from './customField.service.js'
import { addTagsToRecords, moveTags, removeTagsFromRecords, setRecordTags, tagFilterIds, tagsFor } from './tag.service.js'

/** Companies (M07). Functions take `ctx` (req.ctx) first; every query is scoped to the workspace. */

registerReassignable({ entity: 'company', model: 'company', openWhere: { deletedAt: null } })

const RESOURCE = 'companies'
const ENTITY = 'company'

const companySelect = {
  id: true,
  name: true,
  domain: true,
  industry: true,
  size: true,
  gstin: true,
  phoneE164: true,
  phoneRaw: true,
  email: true,
  website: true,
  billingAddress: true,
  shippingAddress: true,
  ownerId: true,
  customFields: true,
  lastActivityAt: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  mergedIntoId: true,
}

const AUDITED = ['name', 'domain', 'industry', 'size', 'gstin', 'phoneE164', 'email', 'website', 'billingAddress', 'shippingAddress', 'ownerId', 'customFields']

/** "https://www.Saffron.in/about" → "saffron.in" */
export function normalizeDomain(value) {
  if (!value) return null
  const host = String(value)
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null
}

async function present(rows) {
  const list = Array.isArray(rows) ? rows : [rows]
  const ids = list.map((r) => r.id)
  if (!list.length) return Array.isArray(rows) ? [] : null
  const [owners, tags, counts] = await Promise.all([
    usersById(list.map((r) => r.ownerId)),
    tagsFor(list[0].organizationId, ENTITY, ids),
    prisma.contactCompany.groupBy({ by: ['companyId'], where: { companyId: { in: ids }, contact: { deletedAt: null } }, _count: { _all: true } }),
  ])
  const contactCounts = new Map(counts.map((c) => [c.companyId, c._count._all]))
  const out = list.map(({ organizationId: _o, ...r }) => ({
    ...r,
    owner: r.ownerId ? (owners.get(r.ownerId) ?? null) : null,
    tags: tags.get(r.id) ?? [],
    contactCount: contactCounts.get(r.id) ?? 0,
  }))
  return Array.isArray(rows) ? out : out[0]
}

const withOrg = { ...companySelect, organizationId: true }

/** Loads a company the caller may `action`. Not visible → 404; visible but not allowed → 403. */
async function getForAction(ctx, id, action, { includeDeleted = false } = {}, db = prisma) {
  const row = await db.company.findFirst({
    where: { AND: [{ id, organizationId: ctx.orgId }, includeDeleted ? {} : { deletedAt: null }, visibilityWhere(ctx, RESOURCE, 'read')] },
    select: withOrg,
  })
  if (!row) throw ApiError.notFound('Company not found')
  if (action !== 'read' && !canAccessRecord(ctx, RESOURCE, action, row.ownerId)) {
    throw new ApiError(403, 'You don’t have permission to change this company.', { code: 'FORBIDDEN' })
  }
  return row
}

// ---------- Normalise & validate ----------

async function prepare(ctx, input, existing = null) {
  const data = {}
  if ('name' in input) data.name = input.name
  if ('industry' in input) data.industry = input.industry
  if ('size' in input) data.size = input.size
  if ('email' in input) data.email = input.email
  if ('website' in input) data.website = input.website
  if ('billingAddress' in input) data.billingAddress = input.billingAddress
  if ('shippingAddress' in input) data.shippingAddress = input.shippingAddress
  if ('ownerId' in input) {
    await assertAssignableOwner(ctx, input.ownerId)
    data.ownerId = input.ownerId
  }
  if ('domain' in input || ('website' in input && !existing?.domain && !input.domain)) {
    const domain = normalizeDomain(input.domain ?? input.website)
    if (input.domain && !domain) throw validationError({ domain: 'Enter a domain like saffron.in' })
    data.domain = domain
  }
  if ('phone' in input) {
    const { e164, raw } = normalizePhone(input.phone, ctx.country ?? 'IN')
    data.phoneE164 = e164
    data.phoneRaw = raw
  }
  if ('gstin' in input || 'billingAddress' in input) {
    const gstin = 'gstin' in input ? input.gstin : existing?.gstin
    const stateCode = ('billingAddress' in input ? input.billingAddress : existing?.billingAddress)?.stateCode ?? null
    const errors = gstinErrors(gstin, stateCode)
    if (errors) throw validationError(errors.stateCode ? { 'billingAddress.stateCode': errors.stateCode } : errors)
    if ('gstin' in input) data.gstin = gstin
  }
  if ('customFields' in input) {
    data.customFields = await validateCustomFields(ctx, ENTITY, input.customFields, { existing: existing?.customFields, isCreate: !existing })
  } else if (!existing) {
    data.customFields = await validateCustomFields(ctx, ENTITY, {}, { isCreate: true })
  }
  return data
}

// ---------- Duplicates ----------

/**
 * Companies matching on normalised domain, GSTIN or exact name (case-insensitive) — live records
 * only, regardless of owner (a duplicate the caller can't see is still a duplicate).
 */
export async function findCompanyDuplicates(ctx, { name, domain, gstin }, excludeId = null) {
  const or = []
  const d = normalizeDomain(domain)
  if (d) or.push({ domain: d })
  if (gstin) or.push({ gstin: gstin.toUpperCase() })
  if (name) or.push({ name: { equals: name.trim(), mode: 'insensitive' } })
  if (!or.length) return []
  const rows = await prisma.company.findMany({
    where: { organizationId: ctx.orgId, deletedAt: null, OR: or, ...(excludeId && { id: { not: excludeId } }) },
    select: { id: true, name: true, domain: true, gstin: true },
    take: 10,
  })
  return rows.map((r) => ({
    id: r.id,
    displayName: r.name,
    matchedOn: d && r.domain === d ? 'domain' : gstin && r.gstin === gstin.toUpperCase() ? 'gstin' : 'name',
  }))
}

function duplicateError(duplicates, entity = 'company') {
  return new ApiError(409, `A ${entity} like this already exists.`, { code: 'DUPLICATE_FOUND', details: { duplicates } })
}

// ---------- List & read ----------

const SORTABLE = { name: 'string', createdAt: 'date', lastActivityAt: 'date', updatedAt: 'date' }

export async function listCompanies(ctx, query) {
  const page = parseListQuery(query, { sortable: SORTABLE, defaultSort: '-createdAt' })
  const and = [{ organizationId: ctx.orgId }, query.deleted ? { deletedAt: { not: null }, mergedIntoId: null } : { deletedAt: null }, visibilityWhere(ctx, RESOURCE, 'read')]
  if (query.q) {
    const q = query.q.trim()
    const domain = normalizeDomain(q)
    and.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q.toLowerCase() } },
        ...(domain ? [{ domain: { startsWith: domain } }] : [{ domain: { contains: q.toLowerCase() } }]),
        { gstin: { startsWith: q.toUpperCase() } },
      ],
    })
  }
  if (query.ownerId) and.push(ownerFilter(ctx, query.ownerId))
  if (query.industry) and.push({ industry: { in: listParam(query.industry) } })
  if (query.tag) and.push({ id: { in: await tagFilterIds(ctx.orgId, ENTITY, listParam(query.tag)) } })
  const created = dateRange(query.createdFrom, query.createdTo, ctx.timezone)
  if (created) and.push({ createdAt: created })
  and.push(...(await customFieldWhere(ctx.orgId, ENTITY, query)))

  const where = { AND: and }
  const [rows, total] = await Promise.all([
    prisma.company.findMany({ where: { AND: [...and, page.cursorWhere] }, orderBy: page.orderBy, take: page.take, select: withOrg }),
    query.count ? prisma.company.count({ where }) : null,
  ])
  const result = buildPage(rows, page)
  return { items: await present(result.items), nextCursor: result.nextCursor, ...(total !== null && { total }) }
}

export async function getCompany(ctx, id) {
  return present(await getForAction(ctx, id, 'read', { includeDeleted: true }))
}

/** Contacts linked to the company (that the caller can see). */
export async function listCompanyContacts(ctx, id) {
  await getForAction(ctx, id, 'read', { includeDeleted: true })
  const links = await prisma.contactCompany.findMany({
    where: { organizationId: ctx.orgId, companyId: id, contact: { AND: [{ deletedAt: null }, visibilityWhere(ctx, 'contacts', 'read')] } },
    select: { role: true, isPrimary: true, contact: { select: { id: true, displayName: true, title: true, primaryEmail: true, primaryPhoneE164: true, ownerId: true } } },
    orderBy: { contact: { displayName: 'asc' } },
    take: 500,
  })
  return links.map((l) => ({ ...l.contact, role: l.role, isPrimary: l.isPrimary }))
}

// ---------- Write ----------

export async function createCompany(ctx, input, { allowDuplicate = false } = {}) {
  const data = await prepare(ctx, input)
  if (!allowDuplicate) {
    const duplicates = await findCompanyDuplicates(ctx, { name: data.name, domain: data.domain, gstin: data.gstin })
    if (duplicates.length) throw duplicateError(duplicates)
  }
  const row = await prisma.$transaction(async (tx) => {
    const company = await tx.company.create({
      data: { ...data, organizationId: ctx.orgId, ownerId: 'ownerId' in data ? data.ownerId : ctx.userId, createdById: ctx.userId },
      select: withOrg,
    })
    if (input.tagIds) await setRecordTags(tx, ctx, ENTITY, company.id, input.tagIds)
    await emit(tx, ctx, 'company.created', { entityType: ENTITY, entityId: company.id })
    if (allowDuplicate) await recordAudit(tx, ctx, { action: 'company.create_duplicate', entityType: ENTITY, entityId: company.id, changes: { name: [null, company.name] } })
    return company
  })
  return present(row)
}

export async function updateCompany(ctx, id, input, { expectedUpdatedAt, allowDuplicate = false } = {}) {
  const before = await getForAction(ctx, id, 'update')
  assertNotStale(before, expectedUpdatedAt)
  if ('ownerId' in input && input.ownerId === before.ownerId) delete input.ownerId
  const data = await prepare(ctx, input, before)
  if (!allowDuplicate && (data.name || data.domain || data.gstin)) {
    const duplicates = await findCompanyDuplicates(ctx, { name: data.name, domain: data.domain, gstin: data.gstin }, id)
    if (duplicates.length) throw duplicateError(duplicates)
  }
  const after = await prisma.$transaction(async (tx) => {
    const row = await tx.company.update({ where: { id }, data, select: withOrg })
    if (input.tagIds) await setRecordTags(tx, ctx, ENTITY, id, input.tagIds)
    const changes = diff(before, row, AUDITED)
    if (changes || input.tagIds) await emit(tx, ctx, 'company.updated', { entityType: ENTITY, entityId: id }, { changes: changes ?? {} })
    return row
  })
  return present(after)
}

export async function deleteCompany(ctx, id) {
  const company = await getForAction(ctx, id, 'delete')
  await prisma.$transaction(async (tx) => {
    await tx.company.update({ where: { id }, data: { deletedAt: new Date() } })
    await emit(tx, ctx, 'company.deleted', { entityType: ENTITY, entityId: id })
    await recordAudit(tx, ctx, { action: 'company.delete', entityType: ENTITY, entityId: id, changes: { name: [company.name, null] } })
  })
}

export async function restoreCompany(ctx, id) {
  const company = await getForAction(ctx, id, 'delete', { includeDeleted: true })
  assertRestorable(company)
  const row = await prisma.$transaction(async (tx) => {
    const restored = await tx.company.update({ where: { id }, data: { deletedAt: null }, select: withOrg })
    await emit(tx, ctx, 'company.restored', { entityType: ENTITY, entityId: id })
    await recordAudit(tx, ctx, { action: 'company.restore', entityType: ENTITY, entityId: id })
    return restored
  })
  return present(row)
}

// ---------- Merge ----------

const MERGE_FIELDS = ['name', 'domain', 'industry', 'size', 'gstin', 'phoneE164', 'phoneRaw', 'email', 'website', 'billingAddress', 'shippingAddress', 'ownerId']

/**
 * Merges duplicates into `primaryId`. `fieldChoices` picks, per field, which record's value wins
 * ({ industry: <recordId>, 'cf.gst_type': <recordId> }); otherwise the primary's non-empty value
 * wins, then the first duplicate's. Contacts and tags are unioned; registered child tables are
 * re-pointed; duplicates are soft-deleted with merged_into_id. Their full rows are kept in the
 * audit entry, so a merge can be reconstructed by support.
 */
export async function mergeCompanies(ctx, { primaryId, duplicateIds, fieldChoices = {} }) {
  const ids = [...new Set(duplicateIds)].filter((id) => id !== primaryId)
  if (!ids.length) throw validationError({ duplicateIds: 'Choose at least one other company to merge' })
  const records = await Promise.all([primaryId, ...ids].map((id) => getForAction(ctx, id, 'update')))
  const [primary, ...dups] = records
  const byId = new Map(records.map((r) => [r.id, r]))

  const data = {}
  for (const field of MERGE_FIELDS) {
    const chosen = fieldChoices[field] && byId.get(fieldChoices[field])
    const value = chosen ? chosen[field] : (primary[field] ?? dups.find((d) => d[field] != null)?.[field] ?? null)
    if (value !== primary[field]) data[field] = value
  }
  const customFields = { ...Object.assign({}, ...dups.map((d) => d.customFields).reverse()), ...primary.customFields }
  for (const [choice, recordId] of Object.entries(fieldChoices)) {
    if (!choice.startsWith('cf.') || !byId.has(recordId)) continue
    const key = choice.slice(3)
    const v = byId.get(recordId).customFields?.[key]
    if (v === undefined) delete customFields[key]
    else customFields[key] = v
  }
  data.customFields = customFields

  const merged = await prisma.$transaction(async (tx) => {
    // Contacts: move links, keeping the primary's link where both had one.
    const links = await tx.contactCompany.findMany({ where: { organizationId: ctx.orgId, companyId: { in: ids } } })
    for (const link of links) {
      const exists = await tx.contactCompany.findUnique({ where: { contactId_companyId: { contactId: link.contactId, companyId: primaryId } } })
      if (!exists) await tx.contactCompany.create({ data: { organizationId: ctx.orgId, contactId: link.contactId, companyId: primaryId, role: link.role, isPrimary: link.isPrimary } })
      else if (link.isPrimary && !exists.isPrimary) await tx.contactCompany.update({ where: { contactId_companyId: { contactId: link.contactId, companyId: primaryId } }, data: { isPrimary: true } })
    }
    await tx.contactCompany.deleteMany({ where: { organizationId: ctx.orgId, companyId: { in: ids } } })
    await moveTags(tx, ctx, ENTITY, ids, primaryId)
    await runMergeSteps(tx, ctx, 'company', primaryId, ids)
    await tx.company.updateMany({ where: { id: { in: ids }, organizationId: ctx.orgId }, data: { deletedAt: new Date(), mergedIntoId: primaryId } })
    const row = await tx.company.update({ where: { id: primaryId }, data, select: withOrg })
    await emit(tx, ctx, 'company.merged', { entityType: ENTITY, entityId: primaryId }, { mergedIds: ids })
    await recordAudit(tx, ctx, { action: 'company.merge', entityType: ENTITY, entityId: primaryId, changes: { mergedIds: ids, fieldChoices, duplicates: dups } })
    return row
  })
  return present(merged)
}

// ---------- Bulk ----------

/** { ids, action: assign | tag | untag | delete, payload } → { succeeded, failed: [{ id, code }] } */
export async function bulkCompanies(ctx, { ids, action, payload = {} }) {
  const action2perm = { assign: 'update', tag: 'update', untag: 'update', delete: 'delete' }
  const rows = await prisma.company.findMany({
    where: { AND: [{ id: { in: ids }, organizationId: ctx.orgId, deletedAt: null }, visibilityWhere(ctx, RESOURCE, 'read')] },
    select: { id: true, ownerId: true, name: true },
  })
  const found = new Map(rows.map((r) => [r.id, r]))
  const failed = []
  const allowed = []
  for (const id of ids) {
    const row = found.get(id)
    if (!row) failed.push({ id, code: 'NOT_FOUND' })
    else if (!canAccessRecord(ctx, RESOURCE, action2perm[action], row.ownerId)) failed.push({ id, code: 'FORBIDDEN' })
    else allowed.push(id)
  }
  if (action === 'assign') await assertAssignableOwner(ctx, payload.ownerId ?? null)
  if (allowed.length) {
    await prisma.$transaction(async (tx) => {
      if (action === 'assign') await tx.company.updateMany({ where: { id: { in: allowed } }, data: { ownerId: payload.ownerId ?? null } })
      if (action === 'tag') {
        const { skipped } = await addTagsToRecords(tx, ctx, ENTITY, allowed, payload.tagIds ?? [])
        for (const id of skipped) failed.push({ id, code: 'TOO_MANY_TAGS' })
      }
      if (action === 'untag') await removeTagsFromRecords(tx, ctx, ENTITY, allowed, payload.tagIds ?? [])
      if (action === 'delete') await tx.company.updateMany({ where: { id: { in: allowed } }, data: { deletedAt: new Date() } })
      for (const id of allowed) {
        await emit(tx, ctx, action === 'delete' ? 'company.deleted' : 'company.updated', { entityType: ENTITY, entityId: id }, { bulk: action })
      }
      await recordAudit(tx, ctx, { action: `company.bulk_${action}`, entityType: ENTITY, changes: { ids: allowed, ...payload } })
    })
  }
  const failedIds = new Set(failed.map((f) => f.id))
  return { succeeded: allowed.filter((id) => !failedIds.has(id)), failed }
}
