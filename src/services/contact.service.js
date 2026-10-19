import { prisma } from '../db/prisma.js'
import { diff, emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { runMergeSteps } from '../lib/merge.js'
import { buildPage, parseListQuery } from '../lib/pagination.js'
import {
  assertAssignableOwner,
  assertNotStale,
  assertRestorable,
  buildDisplayName,
  dateRange,
  listParam,
  MAX_MERGED_CONTACT_POINTS,
  normalizeEmails,
  normalizePhones,
  ownerFilter,
  phoneSearchTerm,
  primaryColumns,
  usersById,
  validationError,
} from '../lib/records.js'
import { canAccessRecord, registerReassignable, visibilityWhere } from '../lib/visibility.js'
import { ApiError } from '../utils/ApiError.js'
import { customFieldWhere, validateCustomFields } from './customField.service.js'
import { assertWithinLimit } from './entitlements.service.js'
import { addTagsToRecords, moveTags, removeTagsFromRecords, setRecordTags, tagFilterIds, tagsFor } from './tag.service.js'

/**
 * Contacts (M07): people, their emails/phones (mirrored into lookup tables for duplicate detection
 * and search), company links, consent, merge. Contacts count toward the plan's `records` limit.
 */

registerReassignable({ entity: 'contact', model: 'contact', openWhere: { deletedAt: null } })

const RESOURCE = 'contacts'
const ENTITY = 'contact'
export const LIFECYCLE_STAGES = ['subscriber', 'lead', 'customer', 'inactive']

const contactSelect = {
  id: true,
  organizationId: true,
  firstName: true,
  lastName: true,
  displayName: true,
  title: true,
  emails: true,
  phones: true,
  primaryEmail: true,
  primaryPhoneE164: true,
  lifecycleStage: true,
  whatsappOptInAt: true,
  emailOptInAt: true,
  optOutAt: true,
  consentSource: true,
  source: true,
  ownerId: true,
  customFields: true,
  lastActivityAt: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  mergedIntoId: true,
}

const AUDITED = ['firstName', 'lastName', 'title', 'emails', 'phones', 'lifecycleStage', 'whatsappOptInAt', 'emailOptInAt', 'optOutAt', 'source', 'ownerId', 'customFields']

// ---------- Presentation ----------

async function companiesFor(contactIds) {
  const map = new Map()
  if (!contactIds.length) return map
  const links = await prisma.contactCompany.findMany({
    where: { contactId: { in: contactIds }, company: { deletedAt: null } },
    select: { contactId: true, role: true, isPrimary: true, company: { select: { id: true, name: true } } },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  })
  for (const l of links) {
    if (!map.has(l.contactId)) map.set(l.contactId, [])
    map.get(l.contactId).push({ id: l.company.id, name: l.company.name, role: l.role, isPrimary: l.isPrimary })
  }
  return map
}

async function present(rows) {
  const list = Array.isArray(rows) ? rows : [rows]
  if (!list.length) return Array.isArray(rows) ? [] : null
  const ids = list.map((r) => r.id)
  const [owners, tags, companies] = await Promise.all([usersById(list.map((r) => r.ownerId)), tagsFor(list[0].organizationId, ENTITY, ids), companiesFor(ids)])
  const out = list.map(({ organizationId: _o, ...r }) => ({
    ...r,
    owner: r.ownerId ? (owners.get(r.ownerId) ?? null) : null,
    tags: tags.get(r.id) ?? [],
    companies: companies.get(r.id) ?? [],
  }))
  return Array.isArray(rows) ? out : out[0]
}

/** Loads a contact the caller may `action`. Not visible → 404; visible but not allowed → 403. */
async function getForAction(ctx, id, action, { includeDeleted = false } = {}, db = prisma) {
  const row = await db.contact.findFirst({
    where: { AND: [{ id, organizationId: ctx.orgId }, includeDeleted ? {} : { deletedAt: null }, visibilityWhere(ctx, RESOURCE, 'read')] },
    select: contactSelect,
  })
  if (!row) throw ApiError.notFound('Contact not found')
  if (action !== 'read' && !canAccessRecord(ctx, RESOURCE, action, row.ownerId)) {
    throw new ApiError(403, 'You don’t have permission to change this contact.', { code: 'FORBIDDEN' })
  }
  return row
}

// ---------- Duplicates ----------

/**
 * Live contacts sharing any email or phone (E.164). Visibility is ignored on purpose: a duplicate
 * owned by a colleague is still a duplicate (only id, name and what matched are returned).
 * @returns {Promise<{ id: string, displayName: string, matchedOn: 'email'|'phone', value: string, ownerId: string|null }[]>}
 */
export async function findContactMatches(orgId, { emails = [], phones = [] }, { excludeIds = [], db = prisma } = {}) {
  const e164s = phones.filter(Boolean)
  const mails = emails.filter(Boolean)
  if (!e164s.length && !mails.length) return []
  const live = { deletedAt: null, ...(excludeIds.length && { id: { notIn: excludeIds } }) }
  const [byPhone, byEmail] = await Promise.all([
    e164s.length
      ? db.contactPhone.findMany({ where: { organizationId: orgId, e164: { in: e164s }, contact: live }, select: { e164: true, contact: { select: { id: true, displayName: true, ownerId: true } } }, take: 20 })
      : [],
    mails.length
      ? db.contactEmail.findMany({ where: { organizationId: orgId, email: { in: mails }, contact: live }, select: { email: true, contact: { select: { id: true, displayName: true, ownerId: true } } }, take: 20 })
      : [],
  ])
  const out = new Map()
  for (const r of byPhone) out.set(r.contact.id, { ...r.contact, matchedOn: 'phone', value: r.e164 })
  for (const r of byEmail) if (!out.has(r.contact.id)) out.set(r.contact.id, { ...r.contact, matchedOn: 'email', value: r.email })
  return [...out.values()]
}

/** POST /contacts/check-duplicates — live warning while typing. */
export async function checkDuplicates(ctx, { emails = [], phones = [], excludeId }) {
  const mails = normalizeEmails(emails.map((value) => ({ value }))).map((e) => e.value)
  const nums = normalizePhones(phones.map((raw) => ({ raw })), ctx.country).map((p) => p.e164)
  const matches = await findContactMatches(ctx.orgId, { emails: mails, phones: nums }, { excludeIds: excludeId ? [excludeId] : [] })
  return matches.map(({ ownerId: _o, ...m }) => m)
}

const duplicateError = (duplicates) =>
  new ApiError(409, 'A contact with this phone or email already exists.', { code: 'DUPLICATE_FOUND', details: { duplicates: duplicates.map(({ ownerId: _o, ...d }) => d) } })

// ---------- Normalise & validate ----------

async function prepare(ctx, input, existing = null) {
  const data = {}
  for (const f of ['firstName', 'lastName', 'title', 'source']) if (f in input) data[f] = input[f]
  if ('lifecycleStage' in input) data.lifecycleStage = input.lifecycleStage
  if ('emails' in input) data.emails = normalizeEmails(input.emails)
  if ('phones' in input) data.phones = normalizePhones(input.phones, ctx.country)
  const emails = data.emails ?? existing?.emails ?? []
  const phones = data.phones ?? existing?.phones ?? []
  const first = 'firstName' in data ? data.firstName : existing?.firstName
  const last = 'lastName' in data ? data.lastName : existing?.lastName
  if (!first && !emails.length && !phones.length) throw validationError({ firstName: 'Enter a name, phone or email' })
  Object.assign(data, primaryColumns(emails, phones), { displayName: buildDisplayName({ firstName: first, lastName: last }, emails, phones) })

  // Consent (DPDP / WhatsApp policy): booleans in, timestamps stored.
  const now = new Date()
  if ('whatsappOptIn' in input) data.whatsappOptInAt = input.whatsappOptIn ? (existing?.whatsappOptInAt ?? now) : null
  if ('emailOptIn' in input) data.emailOptInAt = input.emailOptIn ? (existing?.emailOptInAt ?? now) : null
  if ('optedOut' in input) data.optOutAt = input.optedOut ? (existing?.optOutAt ?? now) : null
  if ('consentSource' in input) data.consentSource = input.consentSource
  if ('ownerId' in input) {
    await assertAssignableOwner(ctx, input.ownerId)
    data.ownerId = input.ownerId
  }
  if ('customFields' in input || !existing) {
    data.customFields = await validateCustomFields(ctx, ENTITY, input.customFields ?? {}, { existing: existing?.customFields, isCreate: !existing })
  }
  return data
}

/** Rewrites the phone/email lookup rows for a contact (in the caller's transaction). */
export async function syncLookups(tx, orgId, contactId, emails, phones) {
  await tx.contactEmail.deleteMany({ where: { contactId } })
  await tx.contactPhone.deleteMany({ where: { contactId } })
  if (emails.length) await tx.contactEmail.createMany({ data: emails.map((e) => ({ organizationId: orgId, contactId, email: e.value })), skipDuplicates: true })
  const e164s = [...new Set(phones.map((p) => p.e164).filter(Boolean))]
  if (e164s.length) await tx.contactPhone.createMany({ data: e164s.map((e164) => ({ organizationId: orgId, contactId, e164 })), skipDuplicates: true })
}

/**
 * Replaces the contact's company links. Exactly one primary when there are any (the first one
 * flagged, else the first). Companies must be live records of the workspace.
 * @param {{ companyId: string, role?: string|null, isPrimary?: boolean }[]} links
 */
export async function setCompanies(tx, ctx, contactId, links) {
  const unique = [...new Map(links.map((l) => [l.companyId, l])).values()]
  if (unique.length) {
    const n = await tx.company.count({ where: { id: { in: unique.map((l) => l.companyId) }, organizationId: ctx.orgId, deletedAt: null } })
    if (n !== unique.length) throw validationError({ companies: 'One of these companies no longer exists' })
  }
  const primary = Math.max(0, unique.findIndex((l) => l.isPrimary))
  await tx.contactCompany.deleteMany({ where: { contactId } })
  if (unique.length) {
    await tx.contactCompany.createMany({
      data: unique.map((l, i) => ({ organizationId: ctx.orgId, contactId, companyId: l.companyId, role: l.role ?? null, isPrimary: i === primary })),
    })
  }
}

// ---------- List & read ----------

const SORTABLE = { displayName: 'string', createdAt: 'date', lastActivityAt: 'date', updatedAt: 'date' }

export async function listContacts(ctx, query) {
  const page = parseListQuery(query, { sortable: SORTABLE, defaultSort: '-createdAt' })
  const and = [{ organizationId: ctx.orgId }, query.deleted ? { deletedAt: { not: null }, mergedIntoId: null } : { deletedAt: null }, visibilityWhere(ctx, RESOURCE, 'read')]
  if (query.q) {
    const q = query.q.trim()
    const phone = phoneSearchTerm(q, ctx.country)
    and.push({
      OR: [
        { displayName: { contains: q, mode: 'insensitive' } },
        { emailLookups: { some: { email: { contains: q.toLowerCase() } } } },
        ...(phone ? [{ phoneLookups: { some: { e164: phone } } }] : []),
      ],
    })
  }
  if (query.ownerId) and.push(ownerFilter(ctx, query.ownerId))
  if (query.companyId) and.push({ companies: { some: { companyId: { in: listParam(query.companyId) } } } })
  if (query.lifecycleStage) and.push({ lifecycleStage: { in: listParam(query.lifecycleStage) } })
  if (query.tag) and.push({ id: { in: await tagFilterIds(ctx.orgId, ENTITY, listParam(query.tag)) } })
  const created = dateRange(query.createdFrom, query.createdTo, ctx.timezone)
  if (created) and.push({ createdAt: created })
  and.push(...(await customFieldWhere(ctx.orgId, ENTITY, query)))

  const [rows, total] = await Promise.all([
    prisma.contact.findMany({ where: { AND: [...and, page.cursorWhere] }, orderBy: page.orderBy, take: page.take, select: contactSelect }),
    query.count ? prisma.contact.count({ where: { AND: and } }) : null,
  ])
  const result = buildPage(rows, page)
  return { items: await present(result.items), nextCursor: result.nextCursor, ...(total !== null && { total }) }
}

export async function getContact(ctx, id) {
  return present(await getForAction(ctx, id, 'read', { includeDeleted: true }))
}

// ---------- Write ----------

/**
 * Creates a contact inside `tx` (also used by lead conversion). `countsTowardLimit: false` when the
 * caller already accounts for the record (conversion is net zero).
 */
export async function createContactTx(tx, ctx, data, { tagIds, companies, countsTowardLimit = true } = {}) {
  if (countsTowardLimit) await assertWithinLimit(ctx, 'records', 1, tx)
  const contact = await tx.contact.create({
    data: { ...data, organizationId: ctx.orgId, ownerId: 'ownerId' in data ? data.ownerId : ctx.userId, createdById: ctx.userId ?? null },
    select: contactSelect,
  })
  await syncLookups(tx, ctx.orgId, contact.id, contact.emails, contact.phones)
  if (tagIds?.length) await setRecordTags(tx, ctx, ENTITY, contact.id, tagIds)
  if (companies?.length) await setCompanies(tx, ctx, contact.id, companies)
  await emit(tx, ctx, 'contact.created', { entityType: ENTITY, entityId: contact.id }, { source: contact.source ?? null })
  return contact
}

export async function createContact(ctx, input, { allowDuplicate = false } = {}) {
  const data = await prepare(ctx, input)
  if (!allowDuplicate) {
    const duplicates = await findContactMatches(ctx.orgId, { emails: data.emails.map((e) => e.value), phones: data.phones.map((p) => p.e164) })
    if (duplicates.length) throw duplicateError(duplicates)
  }
  const row = await prisma.$transaction(async (tx) => {
    const contact = await createContactTx(tx, ctx, data, { tagIds: input.tagIds, companies: input.companies })
    if (allowDuplicate) {
      await recordAudit(tx, ctx, { action: 'contact.create_duplicate', entityType: ENTITY, entityId: contact.id, changes: { displayName: [null, contact.displayName] } })
    }
    return contact
  })
  return present(row)
}

export async function updateContact(ctx, id, input, { expectedUpdatedAt, allowDuplicate = false } = {}) {
  const before = await getForAction(ctx, id, 'update')
  assertNotStale(before, expectedUpdatedAt)
  if ('ownerId' in input && input.ownerId === before.ownerId) delete input.ownerId
  const data = await prepare(ctx, input, before)
  if (!allowDuplicate && (data.emails || data.phones)) {
    const duplicates = await findContactMatches(
      ctx.orgId,
      { emails: (data.emails ?? []).map((e) => e.value), phones: (data.phones ?? []).map((p) => p.e164) },
      { excludeIds: [id] },
    )
    if (duplicates.length) throw duplicateError(duplicates)
  }
  const after = await prisma.$transaction(async (tx) => {
    const row = await tx.contact.update({ where: { id }, data, select: contactSelect })
    if (data.emails || data.phones) await syncLookups(tx, ctx.orgId, id, row.emails, row.phones)
    if (input.tagIds) await setRecordTags(tx, ctx, ENTITY, id, input.tagIds)
    if (input.companies) await setCompanies(tx, ctx, id, input.companies)
    const changes = diff(before, row, AUDITED)
    if (changes || input.tagIds || input.companies) await emit(tx, ctx, 'contact.updated', { entityType: ENTITY, entityId: id }, { changes: changes ?? {} })
    if (changes?.ownerId) await emit(tx, ctx, 'contact.assigned', { entityType: ENTITY, entityId: id }, { changes: { ownerId: changes.ownerId } })
    return row
  })
  return present(after)
}

export async function deleteContact(ctx, id) {
  const contact = await getForAction(ctx, id, 'delete')
  await prisma.$transaction(async (tx) => {
    await tx.contact.update({ where: { id }, data: { deletedAt: new Date() } })
    await emit(tx, ctx, 'contact.deleted', { entityType: ENTITY, entityId: id })
    await recordAudit(tx, ctx, { action: 'contact.delete', entityType: ENTITY, entityId: id, changes: { displayName: [contact.displayName, null] } })
  })
}

export async function restoreContact(ctx, id) {
  const contact = await getForAction(ctx, id, 'delete', { includeDeleted: true })
  assertRestorable(contact)
  const row = await prisma.$transaction(async (tx) => {
    await assertWithinLimit(ctx, 'records', 1, tx)
    const restored = await tx.contact.update({ where: { id }, data: { deletedAt: null }, select: contactSelect })
    await emit(tx, ctx, 'contact.restored', { entityType: ENTITY, entityId: id })
    await recordAudit(tx, ctx, { action: 'contact.restore', entityType: ENTITY, entityId: id })
    return restored
  })
  return present(row)
}

// ---------- Merge ----------

const MERGE_FIELDS = ['firstName', 'lastName', 'title', 'lifecycleStage', 'source', 'ownerId', 'whatsappOptInAt', 'emailOptInAt', 'optOutAt', 'consentSource']

/**
 * Merges duplicates into `primaryId` in one transaction:
 * - fields: `fieldChoices[field] = recordId` picks the winner; otherwise the primary's non-empty
 *   value, then the first duplicate's (custom fields per key: `fieldChoices['cf.<key>']`);
 * - emails, phones, tags and companies are unioned;
 * - every registered child table (registerMergeable) is re-pointed to the primary;
 * - duplicates are soft-deleted with merged_into_id; the audit entry keeps their full rows.
 * The caller must be allowed to edit every record involved.
 */
export async function mergeContacts(ctx, { primaryId, duplicateIds, fieldChoices = {} }) {
  const ids = [...new Set(duplicateIds)].filter((id) => id !== primaryId)
  if (!ids.length) throw validationError({ duplicateIds: 'Choose at least one other contact to merge' })
  const records = await Promise.all([primaryId, ...ids].map((id) => getForAction(ctx, id, 'update')))
  const [primary, ...dups] = records
  const byId = new Map(records.map((r) => [r.id, r]))

  const picked = {}
  for (const field of MERGE_FIELDS) {
    const chosen = fieldChoices[field] && byId.get(fieldChoices[field])
    picked[field] = chosen ? chosen[field] : (primary[field] ?? dups.find((d) => d[field] != null)?.[field] ?? null)
  }
  const customFields = { ...Object.assign({}, ...dups.map((d) => d.customFields).reverse()), ...primary.customFields }
  for (const [choice, recordId] of Object.entries(fieldChoices)) {
    if (!choice.startsWith('cf.') || !byId.has(recordId)) continue
    const v = byId.get(recordId).customFields?.[choice.slice(3)]
    if (v === undefined) delete customFields[choice.slice(3)]
    else customFields[choice.slice(3)] = v
  }

  // Union, primary record's entries first; its primary email/phone stays primary.
  const emails = normalizeEmails(records.flatMap((r) => r.emails.map((e) => ({ ...e, primary: r.id === primaryId && e.primary })))).slice(0, MAX_MERGED_CONTACT_POINTS)
  const phones = normalizePhones(
    records.flatMap((r) => r.phones.map((p) => ({ ...p, primary: r.id === primaryId && p.primary }))),
    ctx.country,
  ).slice(0, MAX_MERGED_CONTACT_POINTS)
  const data = {
    ...picked,
    emails,
    phones,
    customFields,
    ...primaryColumns(emails, phones),
    displayName: buildDisplayName(picked, emails, phones),
    lastActivityAt: new Date(Math.max(...records.map((r) => r.lastActivityAt.getTime()))),
  }

  const merged = await prisma.$transaction(async (tx) => {
    const links = await tx.contactCompany.findMany({ where: { contactId: { in: [primaryId, ...ids] } }, orderBy: { createdAt: 'asc' } })
    const primaryLinks = links.filter((l) => l.contactId === primaryId)
    const union = [...primaryLinks, ...links.filter((l) => l.contactId !== primaryId)]
    await setCompanies(tx, ctx, primaryId, union.map((l) => ({ companyId: l.companyId, role: l.role, isPrimary: l.contactId === primaryId && l.isPrimary })))
    await tx.contactCompany.deleteMany({ where: { contactId: { in: ids } } })
    await moveTags(tx, ctx, ENTITY, ids, primaryId)
    await runMergeSteps(tx, ctx, 'contact', primaryId, ids)
    await tx.contact.updateMany({ where: { id: { in: ids }, organizationId: ctx.orgId }, data: { deletedAt: new Date(), mergedIntoId: primaryId } })
    // Their emails/phones now belong to the primary; free the lookup rows so they don't match.
    await tx.contactEmail.deleteMany({ where: { contactId: { in: ids } } })
    await tx.contactPhone.deleteMany({ where: { contactId: { in: ids } } })
    const row = await tx.contact.update({ where: { id: primaryId }, data, select: contactSelect })
    await syncLookups(tx, ctx.orgId, primaryId, row.emails, row.phones)
    await emit(tx, ctx, 'contact.merged', { entityType: ENTITY, entityId: primaryId }, { mergedIds: ids })
    await recordAudit(tx, ctx, { action: 'contact.merge', entityType: ENTITY, entityId: primaryId, changes: { mergedIds: ids, fieldChoices, before: records } })
    return row
  })
  return present(merged)
}

// ---------- Bulk ----------

/** { ids, action: assign | tag | untag | delete, payload } → { succeeded, failed: [{ id, code }] } */
export async function bulkContacts(ctx, { ids, action, payload = {} }) {
  const needs = { assign: 'update', tag: 'update', untag: 'update', delete: 'delete' }[action]
  const rows = await prisma.contact.findMany({
    where: { AND: [{ id: { in: ids }, organizationId: ctx.orgId, deletedAt: null }, visibilityWhere(ctx, RESOURCE, 'read')] },
    select: { id: true, ownerId: true },
  })
  const found = new Map(rows.map((r) => [r.id, r]))
  const failed = []
  const allowed = []
  for (const id of ids) {
    const row = found.get(id)
    if (!row) failed.push({ id, code: 'NOT_FOUND' })
    else if (!canAccessRecord(ctx, RESOURCE, needs, row.ownerId)) failed.push({ id, code: 'FORBIDDEN' })
    else allowed.push(id)
  }
  if (action === 'assign') await assertAssignableOwner(ctx, payload.ownerId ?? null)
  if (allowed.length) {
    await prisma.$transaction(async (tx) => {
      if (action === 'assign') await tx.contact.updateMany({ where: { id: { in: allowed } }, data: { ownerId: payload.ownerId ?? null } })
      if (action === 'tag') {
        const { skipped } = await addTagsToRecords(tx, ctx, ENTITY, allowed, payload.tagIds ?? [])
        for (const id of skipped) failed.push({ id, code: 'TOO_MANY_TAGS' })
      }
      if (action === 'untag') await removeTagsFromRecords(tx, ctx, ENTITY, allowed, payload.tagIds ?? [])
      if (action === 'delete') await tx.contact.updateMany({ where: { id: { in: allowed } }, data: { deletedAt: new Date() } })
      const type = action === 'delete' ? 'contact.deleted' : action === 'assign' ? 'contact.assigned' : 'contact.updated'
      for (const id of allowed) await emit(tx, ctx, type, { entityType: ENTITY, entityId: id }, { bulk: action, ...(action === 'assign' && { changes: { ownerId: [found.get(id).ownerId, payload.ownerId ?? null] } }) })
      await recordAudit(tx, ctx, { action: `contact.bulk_${action}`, entityType: ENTITY, changes: { ids: allowed, ...payload } })
    })
  }
  const failedIds = new Set(failed.map((f) => f.id))
  return { succeeded: allowed.filter((id) => !failedIds.has(id)), failed }
}
