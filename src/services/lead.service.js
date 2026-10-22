import { versionedUpdate } from '../lib/versionedUpdate.js'
import { prisma, DB_NULL } from '../db/prisma.js'
import { resolveCampaignId } from '../lib/campaignAttribution.js'
import { diff, emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { computeLeadScore, FROZEN_STATUSES } from '../lib/leadScore.js'
import { registerMergeable, runConversionHooks } from '../lib/merge.js'
import { buildPage, parseListQuery } from '../lib/pagination.js'
import {
  assertAssignableOwner,
  assertNotStale,
  assertRestorable,
  bigToNumber,
  buildDisplayName,
  dateRange,
  listParam,
  MAX_CONTACT_POINTS,
  normalizeEmails,
  normalizePhones,
  ownerFilter,
  phoneSearchTerm,
  primaryColumns,
  usersById,
  validationError,
} from '../lib/records.js'
import { canAccessRecord, registerReassignable, visibilityWhere } from '../lib/visibility.js'
import { logger } from '../lib/logger.js'
import { ApiError } from '../utils/ApiError.js'
import { findContactMatches, setCompanies, syncLookups as syncContactLookups } from './contact.service.js'
import { copyMatchingCustomFields, customFieldWhere, validateCustomFields } from './customField.service.js'
import { assertWithinLimit } from './entitlements.service.js'
import { createDealTx } from './deal.service.js'
import { getSourceByKey } from './leadSetup.service.js'
import { defaultStage } from './pipeline.service.js'
import { addTagsToRecords, removeTagsFromRecords, setRecordTags, tagFilterIds, tagsFor } from './tag.service.js'

/**
 * Leads (M08): unqualified enquiries. Status machine, claim/assign, duplicate handling for manual
 * and automated capture, scoring v1, conversion into contact (+ company, + deal from M09).
 * Open leads count toward the plan's `records` limit; converted ones don't.
 */

export const OPEN_STATUSES = ['new', 'contacted', 'qualified']
const log = logger.child({ component: 'leads' })

registerReassignable({ entity: 'lead', model: 'lead', openWhere: { deletedAt: null, status: { in: OPEN_STATUSES } } })
// Leads that point at a contact/company follow it when it's merged (M07).
registerMergeable('contact', { model: 'lead', field: 'contactId' })
registerMergeable('contact', { model: 'lead', field: 'convertedContactId' })
registerMergeable('company', { model: 'lead', field: 'convertedCompanyId' })

const RESOURCE = 'leads'
const ENTITY = 'lead'

/**
 * Allowed manual status changes (decision D4). `converted` is only reached through conversion.
 *   new → contacted | qualified | lost | junk
 *   contacted → qualified | lost | junk
 *   qualified → contacted | lost
 *   lost → contacted (reopen) · junk → new (reopen) · converted: terminal
 */
export const TRANSITIONS = {
  new: ['contacted', 'qualified', 'lost', 'junk'],
  contacted: ['qualified', 'lost', 'junk'],
  qualified: ['contacted', 'lost'],
  lost: ['contacted'],
  junk: ['new'],
  converted: [],
}
export const JUNK_REASONS = ['spam', 'wrong_number', 'test', 'duplicate', 'other']

const leadSelect = {
  id: true,
  organizationId: true,
  firstName: true,
  lastName: true,
  displayName: true,
  emails: true,
  phones: true,
  primaryEmail: true,
  primaryPhoneE164: true,
  companyName: true,
  requirement: true,
  budgetMinor: true,
  city: true,
  stateCode: true,
  pincode: true,
  sourceId: true,
  sourceDetail: true,
  campaignId: true,
  utm: true,
  status: true,
  lostReasonId: true,
  lostNote: true,
  junkReason: true,
  score: true,
  scoreBreakdown: true,
  ownerId: true,
  assignedAt: true,
  firstRespondedAt: true,
  lastActivityAt: true,
  enquiryCount: true,
  contactId: true,
  isExistingCustomer: true,
  previousLeadId: true,
  convertedAt: true,
  convertedById: true,
  convertedContactId: true,
  convertedCompanyId: true,
  convertedDealId: true,
  customFields: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  source: { select: { id: true, name: true, key: true, scoreWeight: true } },
  lostReason: { select: { id: true, name: true } },
}

const AUDITED = ['firstName', 'lastName', 'emails', 'phones', 'companyName', 'requirement', 'budgetMinor', 'city', 'stateCode', 'pincode', 'sourceId', 'sourceDetail', 'campaignId', 'utm', 'customFields']

// ---------- Presentation ----------

async function present(rows) {
  const list = Array.isArray(rows) ? rows : [rows]
  if (!list.length) return Array.isArray(rows) ? [] : null
  const [owners, tags] = await Promise.all([usersById(list.map((r) => r.ownerId)), tagsFor(list[0].organizationId, ENTITY, list.map((r) => r.id))])
  const out = list.map(({ organizationId: _o, source, ...r }) => ({
    ...r,
    budgetMinor: bigToNumber(r.budgetMinor),
    source: source ? { id: source.id, name: source.name, key: source.key } : null,
    owner: r.ownerId ? (owners.get(r.ownerId) ?? null) : null,
    tags: tags.get(r.id) ?? [],
    firstResponseSeconds: r.firstRespondedAt ? Math.round((r.firstRespondedAt - r.createdAt) / 1000) : null,
  }))
  return Array.isArray(rows) ? out : out[0]
}

async function getForAction(ctx, id, action, { includeDeleted = false } = {}, db = prisma) {
  const row = await db.lead.findFirst({
    where: { AND: [{ id, organizationId: ctx.orgId }, includeDeleted ? {} : { deletedAt: null }, visibilityWhere(ctx, RESOURCE, 'read')] },
    select: leadSelect,
  })
  if (!row) throw ApiError.notFound('Lead not found')
  if (action !== 'read' && !canAccessRecord(ctx, RESOURCE, action, row.ownerId)) {
    throw new ApiError(403, 'You don’t have permission to change this lead.', { code: 'FORBIDDEN' })
  }
  return row
}

const assertOpen = (lead) => {
  if (lead.status === 'converted') throw new ApiError(409, 'This lead has been converted and can’t be changed. Edit the contact instead.', { code: 'LEAD_CONVERTED' })
}

// ---------- Scoring ----------

/** Recomputes and stores a lead's score (no-op for frozen statuses). Cheap: one lead per call. */
async function scoreTx(tx, lead) {
  if (FROZEN_STATUSES.includes(lead.status)) return lead
  const weight = lead.source?.scoreWeight ?? (lead.sourceId ? (await tx.leadSource.findUnique({ where: { id: lead.sourceId }, select: { scoreWeight: true } }))?.scoreWeight : 5) ?? 5
  // Engagement from the timeline (M10): inbound messages and completed calls/meetings/visits.
  const signals = await leadEngagement(tx, lead.organizationId, lead.id)
  const { score, breakdown } = computeLeadScore(lead, { sourceWeight: weight, ...signals })
  if (score === lead.score && JSON.stringify(breakdown) === JSON.stringify(lead.scoreBreakdown)) return lead
  return tx.lead.update({ where: { id: lead.id }, data: { score, scoreBreakdown: breakdown }, select: leadSelect })
}

/** Scoring subscriber / nightly job. Idempotent. */
export async function rescoreLead(leadId, db = prisma) {
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: leadSelect })
  if (lead && !lead.deletedAt) await scoreTx(db, lead)
}

/** `leads.rescore` (nightly): applies decay to every open lead. */
export async function rescoreAllLeads() {
  let cursor
  let n = 0
  for (;;) {
    const batch = await prisma.lead.findMany({
      where: { deletedAt: null, status: { in: OPEN_STATUSES } },
      select: leadSelect,
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    })
    if (!batch.length) break
    for (const lead of batch) await scoreTx(prisma, lead).catch((err) => log.error({ err, leadId: lead.id }, 'rescore failed'))
    n += batch.length
    cursor = batch.at(-1).id
  }
  return { rescored: n }
}

// ---------- Scoring signals (activities, M10) ----------

/** Engagement inputs for computeLeadScore: last inbound message (7 d) and completed touches (14 d). */
export async function leadEngagement(db, orgId, leadId, now = new Date()) {
  const since14 = new Date(now.getTime() - 14 * 86_400_000)
  const link = { some: { entityType: 'lead', entityId: leadId } }
  const [inbound, touches] = await Promise.all([
    db.activity.findFirst({
      where: { organizationId: orgId, deletedAt: null, links: link, direction: 'inbound', type: { in: ['call', 'whatsapp', 'email', 'sms'] } },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    }),
    db.activity.count({
      where: {
        organizationId: orgId,
        deletedAt: null,
        links: link,
        occurredAt: { gte: since14, lte: now },
        OR: [{ type: 'call', outcome: 'connected' }, { type: { in: ['meeting', 'site_visit'] } }],
      },
    }),
  ])
  return { lastInboundAt: inbound?.occurredAt ?? null, completedTouches14d: touches }
}

// ---------- Duplicates ----------

async function syncLeadLookups(tx, orgId, leadId, emails, phones) {
  await tx.leadEmail.deleteMany({ where: { leadId } })
  await tx.leadPhone.deleteMany({ where: { leadId } })
  if (emails.length) await tx.leadEmail.createMany({ data: emails.map((e) => ({ organizationId: orgId, leadId, email: e.value })), skipDuplicates: true })
  const e164s = [...new Set(phones.map((p) => p.e164).filter(Boolean))]
  if (e164s.length) await tx.leadPhone.createMany({ data: e164s.map((e164) => ({ organizationId: orgId, leadId, e164 })), skipDuplicates: true })
}

/** Live leads sharing an email or phone. `statuses` limits which (e.g. open only). */
async function findLeadMatches(orgId, { emails = [], phones = [] }, { statuses, excludeIds = [], db = prisma } = {}) {
  const mails = emails.filter(Boolean)
  const nums = phones.filter(Boolean)
  if (!mails.length && !nums.length) return []
  const leadWhere = { deletedAt: null, ...(statuses && { status: { in: statuses } }), ...(excludeIds.length && { id: { notIn: excludeIds } }) }
  const pick = { id: true, displayName: true, status: true, ownerId: true, createdAt: true }
  const [byPhone, byEmail] = await Promise.all([
    nums.length ? db.leadPhone.findMany({ where: { organizationId: orgId, e164: { in: nums }, lead: leadWhere }, select: { e164: true, lead: { select: pick } }, take: 20 }) : [],
    mails.length ? db.leadEmail.findMany({ where: { organizationId: orgId, email: { in: mails }, lead: leadWhere }, select: { email: true, lead: { select: pick } }, take: 20 }) : [],
  ])
  const out = new Map()
  for (const r of byPhone) out.set(r.lead.id, { ...r.lead, matchedOn: 'phone', value: r.e164 })
  for (const r of byEmail) if (!out.has(r.lead.id)) out.set(r.lead.id, { ...r.lead, matchedOn: 'email', value: r.email })
  return [...out.values()].sort((a, b) => b.createdAt - a.createdAt)
}

/** Open leads and contacts matching — what a manual create warns about (decision D6). */
async function findDuplicates(orgId, emails, phones, excludeId = null) {
  const key = { emails: emails.map((e) => e.value), phones: phones.map((p) => p.e164) }
  const [leads, contacts] = await Promise.all([
    findLeadMatches(orgId, key, { statuses: OPEN_STATUSES, excludeIds: excludeId ? [excludeId] : [] }),
    findContactMatches(orgId, key),
  ])
  return [
    ...leads.map((l) => ({ entityType: 'lead', id: l.id, displayName: l.displayName, status: l.status, matchedOn: l.matchedOn, value: l.value })),
    ...contacts.map((c) => ({ entityType: 'contact', id: c.id, displayName: c.displayName, matchedOn: c.matchedOn, value: c.value })),
  ]
}

export async function checkDuplicates(ctx, { emails = [], phones = [], excludeId }) {
  return findDuplicates(ctx.orgId, normalizeEmails(emails.map((value) => ({ value }))), normalizePhones(phones.map((raw) => ({ raw })), ctx.country), excludeId)
}

const duplicateError = (duplicates) => new ApiError(409, 'A lead or contact with this phone or email already exists.', { code: 'DUPLICATE_FOUND', details: { duplicates } })

// ---------- Normalise & validate ----------

async function assertSource(ctx, sourceId, db = prisma) {
  if (!sourceId) return
  const source = await db.leadSource.findFirst({ where: { id: sourceId, organizationId: ctx.orgId }, select: { archivedAt: true } })
  if (!source) throw validationError({ sourceId: 'Choose a source' })
  if (source.archivedAt) throw validationError({ sourceId: 'This source is archived' })
}

/** `capture: true` skips required custom fields — a web form or connector can't fill them in. */
async function prepare(ctx, input, existing = null, { capture = false, db = prisma } = {}) {
  const data = {}
  for (const f of ['firstName', 'lastName', 'companyName', 'requirement', 'city', 'stateCode', 'pincode', 'sourceDetail']) if (f in input) data[f] = input[f]
  if ('budgetMinor' in input) data.budgetMinor = input.budgetMinor === null ? null : BigInt(input.budgetMinor)
  if ('utm' in input) data.utm = input.utm ?? DB_NULL
  if ('emails' in input) data.emails = normalizeEmails(input.emails)
  if ('phones' in input) data.phones = normalizePhones(input.phones, ctx.country)
  const emails = data.emails ?? existing?.emails ?? []
  const phones = data.phones ?? existing?.phones ?? []
  if (!existing) Object.assign(data, { emails, phones })
  const first = 'firstName' in data ? data.firstName : existing?.firstName
  const last = 'lastName' in data ? data.lastName : existing?.lastName
  if (!first && !emails.length && !phones.length) throw validationError({ firstName: 'Enter a name, phone or email' })
  Object.assign(data, primaryColumns(emails, phones), { displayName: buildDisplayName({ firstName: first, lastName: last }, emails, phones) })
  if ('sourceId' in input && input.sourceId !== existing?.sourceId) {
    await assertSource(ctx, input.sourceId, db)
    data.sourceId = input.sourceId
  }
  if ('customFields' in input || !existing) {
    data.customFields = await validateCustomFields(ctx, ENTITY, input.customFields ?? {}, { existing: existing?.customFields, isCreate: !existing && !capture })
  }
  return data
}

// ---------- List & read ----------

const SORTABLE = { createdAt: 'date', score: 'number', lastActivityAt: 'date', displayName: 'string', updatedAt: 'date' }

async function listWhere(ctx, query, { withStatus = true } = {}) {
  const and = [{ organizationId: ctx.orgId }, query.deleted ? { deletedAt: { not: null } } : { deletedAt: null }, visibilityWhere(ctx, RESOURCE, 'read')]
  if (withStatus && query.status) and.push({ status: { in: listParam(query.status) } })
  if (query.q) {
    const q = query.q.trim()
    const phone = phoneSearchTerm(q, ctx.country)
    and.push({
      OR: [
        { displayName: { contains: q, mode: 'insensitive' } },
        { companyName: { contains: q, mode: 'insensitive' } },
        { emailLookups: { some: { email: { contains: q.toLowerCase() } } } },
        ...(phone ? [{ phoneLookups: { some: { e164: phone } } }] : []),
      ],
    })
  }
  if (query.ownerId) and.push(ownerFilter(ctx, query.ownerId))
  if (query.sourceId) and.push({ sourceId: { in: listParam(query.sourceId) } })
  if (query.campaignId) and.push({ campaignId: query.campaignId })
  if (query.scoreMin !== undefined) and.push({ score: { gte: query.scoreMin } })
  if (query.city) and.push({ city: { equals: query.city, mode: 'insensitive' } })
  if (query.stateCode) and.push({ stateCode: { in: listParam(query.stateCode) } })
  if (query.tag) and.push({ id: { in: await tagFilterIds(ctx.orgId, ENTITY, listParam(query.tag)) } })
  const created = dateRange(query.createdFrom, query.createdTo, ctx.timezone)
  if (created) and.push({ createdAt: created })
  and.push(...(await customFieldWhere(ctx.orgId, ENTITY, query)))
  return and
}

/** GET /leads. `counts=true` adds per-status counts for the tabs (same filters, ignoring status). */
export async function listLeads(ctx, query) {
  const page = parseListQuery(query, { sortable: SORTABLE, defaultSort: '-createdAt' })
  // Resolve tag IDs and custom-field definitions once for both rows and status tabs.
  const base = await listWhere(ctx, query, { withStatus: false })
  const and = query.status ? [...base, { status: { in: listParam(query.status) } }] : base
  const [rows, counted, grouped] = await Promise.all([
    prisma.lead.findMany({ where: { AND: [...and, page.cursorWhere] }, orderBy: page.orderBy, take: page.take, select: leadSelect }),
    query.count && !query.counts ? prisma.lead.count({ where: { AND: and } }) : null,
    query.counts ? prisma.lead.groupBy({ by: ['status'], where: { AND: base }, _count: { _all: true } }) : null,
  ])
  // The tab aggregation already contains the exact total for the current status filter.
  const statuses = query.status ? new Set(listParam(query.status)) : null
  const total = query.count && grouped
    ? grouped.reduce((n, group) => n + (!statuses || statuses.has(group.status) ? group._count._all : 0), 0)
    : counted
  const result = buildPage(rows, page)
  let counts
  if (grouped) {
    counts = Object.fromEntries(Object.keys(TRANSITIONS).map((s) => [s, 0]))
    for (const g of grouped) counts[g.status] = g._count._all
    counts.all = Object.values(counts).reduce((a, b) => a + b, 0)
  }
  return { items: await present(result.items), nextCursor: result.nextCursor, ...(total !== null && { total }), ...(counts && { counts }) }
}

export async function getLead(ctx, id) {
  return present(await getForAction(ctx, id, 'read', { includeDeleted: true }))
}

// ---------- Create ----------

/** Inserts a lead (+ lookups, tags, score, event) inside `tx`. Checks the records limit. */
async function insertLeadTx(tx, ctx, data, { tagIds, extra = {} } = {}) {
  await assertWithinLimit(ctx, 'records', 1, tx)
  const campaignId = await resolveCampaignId(tx, ctx.orgId, data)
  const ownerId = 'ownerId' in data ? data.ownerId : null
  let lead = await tx.lead.create({
    data: { ...data, ...extra, campaignId, organizationId: ctx.orgId, ownerId, assignedAt: ownerId ? new Date() : null, createdById: ctx.userId ?? null },
    select: leadSelect,
  })
  await syncLeadLookups(tx, ctx.orgId, lead.id, lead.emails, lead.phones)
  if (tagIds?.length) await setRecordTags(tx, ctx, ENTITY, lead.id, tagIds)
  lead = await scoreTx(tx, lead)
  await emit(tx, ctx, 'lead.created', { entityType: ENTITY, entityId: lead.id }, { sourceId: lead.sourceId, ownerId: lead.ownerId, ...(extra.contactId && { contactId: extra.contactId }) })
  if (ownerId) await emit(tx, ctx, 'lead.assigned', { entityType: ENTITY, entityId: lead.id }, { changes: { ownerId: [null, ownerId] } })
  return lead
}

/**
 * Manual create. Duplicates (open leads or contacts sharing a phone/email) → 409 DUPLICATE_FOUND
 * unless `allowDuplicate` (audited). The creator owns it unless `ownerId` says otherwise (null = unassigned).
 */
export async function createLead(ctx, input, { allowDuplicate = false, tx: externalTx, linkedContactId = null } = {}) {
  const data = await prepare(ctx, input, null, { db: externalTx ?? prisma })
  const ownerId = 'ownerId' in input ? input.ownerId : ctx.userId
  await assertAssignableOwner(ctx, ownerId)
  if (!allowDuplicate) {
    const duplicates = await findDuplicates(ctx.orgId, data.emails, data.phones)
    if (duplicates.length) throw duplicateError(duplicates)
  }
  const lead = await (externalTx ? (fn) => fn(externalTx) : (fn) => prisma.$transaction(fn))(async (tx) => {
    if (linkedContactId && !await tx.contact.count({ where: { id: linkedContactId, organizationId: ctx.orgId, deletedAt: null } })) throw validationError({ contactId: 'This contact no longer exists' })
    const created = await insertLeadTx(tx, ctx, { ...data, ownerId }, { tagIds: input.tagIds, extra: linkedContactId ? { contactId: linkedContactId } : {} })
    if (allowDuplicate) await recordAudit(tx, ctx, { action: 'lead.create_duplicate', entityType: ENTITY, entityId: created.id, changes: { displayName: [null, created.displayName] } })
    return created
  })
  return externalTx ? lead : present(lead)
}

/**
 * Automated capture (web forms M14, IndiaMART/JustDial M14, WhatsApp M19, API M20, import M13).
 * With `dedupe` (default):
 * - matches an open lead → its enquiry count and last activity are bumped, `lead.repeat_enquiry`
 *   is emitted (timeline entry M10, owner notification M11); nothing is created;
 * - matches a contact → a new lead linked to it (`isExistingCustomer`);
 * - matches only closed leads → a new lead linked via `previousLeadId`.
 *
 * `ctx` is a workspace context; connectors pass a system context { orgId, actorType: 'system' }.
 * @returns {Promise<{ lead: object, outcome: 'created' | 'merged_into_open' | 'linked_contact' }>}
 */
export async function createLeadFromCapture(ctx, payload, { sourceKey, dedupe = true, tx: externalTx } = {}) {
  const source = sourceKey ? await getSourceByKey(ctx.orgId, sourceKey, externalTx ?? prisma) : null
  const { sourceId: _ignored, ownerId: _owner, tagIds: _tags, ...fields } = payload
  const data = await prepare({ ...ctx, actorType: 'system' }, fields, null, { capture: true, db: externalTx ?? prisma })
  if (source) data.sourceId = source.id

  const result = await (externalTx ? (fn) => fn(externalTx) : (fn) => prisma.$transaction(fn))(async (tx) => {
    // Serialise captures for the same phone/email so two webhooks can't both create a lead.
    const keys = [...data.emails.map((e) => e.value), ...data.phones.map((p) => p.e164).filter(Boolean)].sort()
    for (const k of keys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lead:${ctx.orgId}:${k}`}))`

    const key = { emails: data.emails.map((e) => e.value), phones: data.phones.map((p) => p.e164) }
    if (dedupe) {
      const [open] = await findLeadMatches(ctx.orgId, key, { statuses: OPEN_STATUSES, db: tx })
      if (open) {
        const lead = await tx.lead.update({
          where: { id: open.id },
          data: { enquiryCount: { increment: 1 }, lastActivityAt: new Date() },
          select: leadSelect,
        })
        await emit(tx, ctx, 'lead.repeat_enquiry', { entityType: ENTITY, entityId: lead.id }, {
          sourceId: data.sourceId ?? null,
          sourceName: source?.name ?? null,
          requirement: data.requirement ?? null,
          ownerId: lead.ownerId,
        })
        return { lead: await scoreTx(tx, lead), outcome: 'merged_into_open' }
      }
    }
    const [contact] = dedupe ? await findContactMatches(ctx.orgId, key, { db: tx }) : []
    const [closed] = dedupe && !contact ? await findLeadMatches(ctx.orgId, key, { statuses: ['converted', 'lost', 'junk'], db: tx }) : []
    const extra = {
      ...(contact && { contactId: contact.id, isExistingCustomer: true }),
      ...(closed && { previousLeadId: closed.id }),
    }
    const lead = await insertLeadTx(tx, { ...ctx, actorType: 'system' }, { ...data, ownerId: payload.ownerId ?? null }, { tagIds: payload.tagIds, extra })
    return { lead, outcome: contact ? 'linked_contact' : 'created' }
  })
  return { lead: externalTx ? result.lead : await present(result.lead), outcome: result.outcome }
}

// ---------- Update ----------

export async function updateLead(ctx, id, input, { expectedUpdatedAt, allowDuplicate = false, tx: externalTx } = {}) {
  const before = await getForAction(ctx, id, 'update', {}, externalTx ?? prisma)
  assertOpen(before)
  assertNotStale(before, expectedUpdatedAt)
  const data = await prepare(ctx, input, before, { db: externalTx ?? prisma })
  if (!allowDuplicate && (data.emails || data.phones)) {
    const duplicates = await findDuplicates(ctx.orgId, data.emails ?? [], data.phones ?? [], id)
    if (duplicates.length) throw duplicateError(duplicates)
  }
  const after = await (externalTx ? (fn) => fn(externalTx) : (fn) => prisma.$transaction(fn))(async (tx) => {
    if ('utm' in input || 'sourceDetail' in input) data.campaignId = await resolveCampaignId(tx, ctx.orgId, { utm: 'utm' in input ? input.utm : before.utm, sourceDetail: 'sourceDetail' in input ? input.sourceDetail : before.sourceDetail })
    let row = await versionedUpdate(tx, 'lead', ctx, before, data, leadSelect)
    if (data.emails || data.phones) await syncLeadLookups(tx, ctx.orgId, id, row.emails, row.phones)
    if (input.tagIds) await setRecordTags(tx, ctx, ENTITY, id, input.tagIds)
    row = await scoreTx(tx, row)
    const changes = diff(before, row, AUDITED)
    if (changes || input.tagIds) await emit(tx, ctx, 'lead.updated', { entityType: ENTITY, entityId: id }, { changes: changes ?? {} })
    return row
  })
  return externalTx ? after : present(after)
}

/** POST /leads/:id/status — enforces the status machine; lost needs a reason, junk a junk reason. */
async function changeStatusTx(tx, ctx, lead, { status, lostReasonId, junkReason, note }) {
  await tx.$queryRaw`SELECT id FROM leads WHERE id = ${lead.id}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`
  lead = await getForAction(ctx, lead.id, 'update', {}, tx)
  if (lead.status === status) return lead
  if (!TRANSITIONS[lead.status]?.includes(status)) {
    throw new ApiError(400, `A ${lead.status} lead can’t be moved to ${status}.`, { code: 'INVALID_TRANSITION', details: { from: lead.status, to: status, allowed: TRANSITIONS[lead.status] } })
  }
  const data = { status, lostReasonId: null, lostNote: null, junkReason: null }
  if (status === 'lost') {
    if (!lostReasonId) throw validationError({ lostReasonId: 'Choose why this lead was lost' })
    const reason = await tx.lostReason.findFirst({ where: { id: lostReasonId, organizationId: ctx.orgId, entityType: 'lead', archivedAt: null }, select: { id: true } })
    if (!reason) throw validationError({ lostReasonId: 'Choose why this lead was lost' })
    data.lostReasonId = lostReasonId
    data.lostNote = note ?? null
  }
  if (status === 'junk') {
    if (!JUNK_REASONS.includes(junkReason)) throw validationError({ junkReason: 'Choose why this is junk' })
    data.junkReason = junkReason
    data.lostNote = note ?? null
  }
  const now = new Date()
  if (status === 'contacted' && !lead.firstRespondedAt) data.firstRespondedAt = now
  data.lastActivityAt = now
  let row = await tx.lead.update({ where: { id: lead.id }, data, select: leadSelect })
  // Re-opened leads start scoring again; closing freezes the current score.
  row = await scoreTx(tx, row)
  await emit(tx, ctx, 'lead.status_changed', { entityType: ENTITY, entityId: lead.id }, {
    changes: { status: [lead.status, status] },
    ...(data.lostReasonId && { lostReasonId: data.lostReasonId }),
    ...(data.junkReason && { junkReason: data.junkReason }),
  })
  return row
}

export async function changeStatus(ctx, id, input) {
  const lead = await getForAction(ctx, id, 'update')
  assertOpen(lead)
  const row = await prisma.$transaction((tx) => changeStatusTx(tx, ctx, lead, input))
  return present(row)
}

/**
 * Inbound/outbound activity hook for later modules: the first outbound call/WhatsApp/email moves a
 * new lead to contacted and records first response (M10/M19 call this).
 */
export async function recordLeadActivity(ctx, leadId, { outbound = false, at = new Date() } = {}, db = null) {
  const run = async (tx) => {
    await tx.$queryRaw`SELECT id FROM leads WHERE id = ${leadId}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`
    const lead = await tx.lead.findFirst({ where: { id: leadId, organizationId: ctx.orgId, deletedAt: null }, select: leadSelect })
    if (!lead || FROZEN_STATUSES.includes(lead.status)) return
    const lastActivityAt = lead.lastActivityAt && lead.lastActivityAt > at ? lead.lastActivityAt : at
    const data = { lastActivityAt }
    if (outbound && !lead.firstRespondedAt) data.firstRespondedAt = new Date(Math.max(at.getTime(), lead.createdAt.getTime()))
    if (outbound && lead.status === 'new') data.status = 'contacted'
    const row = await tx.lead.update({ where: { id: leadId, organizationId: ctx.orgId }, data, select: leadSelect })
    if (data.status) await emit(tx, ctx, 'lead.status_changed', { entityType: ENTITY, entityId: leadId }, { changes: { status: [lead.status, data.status] } })
    await scoreTx(tx, row)
  }
  if (db) await run(db)
  else await prisma.$transaction(run)
}

// ---------- Ownership ----------

/** Race-safe claim of an unassigned lead: exactly one of two simultaneous claims wins. */
export async function claimLead(ctx, id) {
  if (!ctx.permissions.some((p) => p === 'records.claim' || p.startsWith('records.assign'))) {
    throw new ApiError(403, 'You don’t have permission to claim leads.', { code: 'FORBIDDEN' })
  }
  const lead = await getForAction(ctx, id, 'read')
  assertOpen(lead)
  const row = await prisma.$transaction(async (tx) => {
    const now = new Date()
    const claimed = await tx.lead.updateMany({
      where: { id, organizationId: ctx.orgId, ownerId: null, deletedAt: null, status: { in: OPEN_STATUSES } },
      data: { ownerId: ctx.userId, assignedAt: now },
    })
    if (claimed.count !== 1) throw new ApiError(409, 'Someone else already took this lead.', { code: 'ALREADY_ASSIGNED' })
    await emit(tx, ctx, 'lead.assigned', { entityType: ENTITY, entityId: id }, { changes: { ownerId: [null, ctx.userId] }, claimed: true })
    return tx.lead.findUnique({ where: { id }, select: leadSelect })
  })
  return present(row)
}

export async function assignLead(ctx, id, ownerId) {
  const lead = await getForAction(ctx, id, 'read')
  assertOpen(lead)
  if (!ctx.permissions.some((p) => p.startsWith('records.assign'))) throw new ApiError(403, 'You don’t have permission to assign leads.', { code: 'FORBIDDEN' })
  // Team-scoped managers can only reassign leads they can see as theirs/their team's (or unassigned ones).
  if (lead.ownerId && !canAccessRecord(ctx, RESOURCE, 'update', lead.ownerId)) throw new ApiError(403, 'You don’t have permission to reassign this lead.', { code: 'FORBIDDEN' })
  await assertAssignableOwner(ctx, ownerId)
  if (lead.ownerId === ownerId) return present(lead)
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.lead.update({ where: { id }, data: { ownerId, assignedAt: ownerId ? new Date() : null }, select: leadSelect })
    await emit(tx, ctx, 'lead.assigned', { entityType: ENTITY, entityId: id }, { changes: { ownerId: [lead.ownerId, ownerId] } })
    await recordAudit(tx, ctx, { action: 'lead.assign', entityType: ENTITY, entityId: id, changes: { ownerId: [lead.ownerId, ownerId] } })
    return updated
  })
  return present(row)
}

// ---------- Delete / restore ----------

export async function deleteLead(ctx, id) {
  const lead = await getForAction(ctx, id, 'delete')
  await prisma.$transaction(async (tx) => {
    await tx.lead.update({ where: { id }, data: { deletedAt: new Date() } })
    await emit(tx, ctx, 'lead.deleted', { entityType: ENTITY, entityId: id })
    await recordAudit(tx, ctx, { action: 'lead.delete', entityType: ENTITY, entityId: id, changes: { displayName: [lead.displayName, null] } })
  })
}

export async function restoreLead(ctx, id) {
  const lead = await getForAction(ctx, id, 'delete', { includeDeleted: true })
  assertRestorable({ ...lead, mergedIntoId: null })
  const row = await prisma.$transaction(async (tx) => {
    if (lead.status !== 'converted') await assertWithinLimit(ctx, 'records', 1, tx)
    const restored = await tx.lead.update({ where: { id }, data: { deletedAt: null }, select: leadSelect })
    await emit(tx, ctx, 'lead.restored', { entityType: ENTITY, entityId: id })
    await recordAudit(tx, ctx, { action: 'lead.restore', entityType: ENTITY, entityId: id })
    return restored
  })
  return present(row)
}

// ---------- Bulk ----------

/** { ids, action: assign | status | tag | untag | delete, payload } → { succeeded, failed: [{ id, code }] } */
export async function bulkLeads(ctx, { ids, action, payload = {} }) {
  const needs = action === 'delete' ? 'delete' : 'update'
  const rows = await prisma.lead.findMany({
    where: { AND: [{ id: { in: ids }, organizationId: ctx.orgId, deletedAt: null }, visibilityWhere(ctx, RESOURCE, 'read')] },
    select: leadSelect,
  })
  const found = new Map(rows.map((r) => [r.id, r]))
  const failed = []
  const allowed = []
  for (const id of ids) {
    const row = found.get(id)
    if (!row) failed.push({ id, code: 'NOT_FOUND' })
    else if (row.status === 'converted') failed.push({ id, code: 'LEAD_CONVERTED' })
    else if (!(action === 'assign' && row.ownerId === null) && !canAccessRecord(ctx, RESOURCE, needs, row.ownerId)) failed.push({ id, code: 'FORBIDDEN' })
    else allowed.push(id)
  }
  if (action === 'assign') {
    if (!ctx.permissions.some((p) => p.startsWith('records.assign'))) throw new ApiError(403, 'You don’t have permission to assign leads.', { code: 'FORBIDDEN' })
    await assertAssignableOwner(ctx, payload.ownerId ?? null)
  }

  const done = []
  if (action === 'status') {
    // Per lead, so each transition is validated and gets its own event.
    for (const id of allowed) {
      try {
        await prisma.$transaction((tx) => changeStatusTx(tx, ctx, found.get(id), payload))
        done.push(id)
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
        failed.push({ id, code: err.code ?? 'FAILED' })
      }
    }
  } else if (allowed.length) {
    await prisma.$transaction(async (tx) => {
      if (action === 'assign') {
        const ownerId = payload.ownerId ?? null
        await tx.lead.updateMany({ where: { id: { in: allowed } }, data: { ownerId, assignedAt: ownerId ? new Date() : null } })
        for (const id of allowed) await emit(tx, ctx, 'lead.assigned', { entityType: ENTITY, entityId: id }, { changes: { ownerId: [found.get(id).ownerId, ownerId] }, bulk: true })
      }
      if (action === 'tag') {
        const { skipped } = await addTagsToRecords(tx, ctx, ENTITY, allowed, payload.tagIds ?? [])
        for (const id of skipped) failed.push({ id, code: 'TOO_MANY_TAGS' })
      }
      if (action === 'untag') await removeTagsFromRecords(tx, ctx, ENTITY, allowed, payload.tagIds ?? [])
      if (action === 'delete') {
        await tx.lead.updateMany({ where: { id: { in: allowed } }, data: { deletedAt: new Date() } })
        for (const id of allowed) await emit(tx, ctx, 'lead.deleted', { entityType: ENTITY, entityId: id }, { bulk: true })
      }
    })
    done.push(...allowed)
  }
  if (done.length) await recordAudit(prisma, ctx, { action: `lead.bulk_${action}`, entityType: ENTITY, changes: { ids: done, ...payload } })
  const failedIds = new Set(failed.map((f) => f.id))
  return { succeeded: done.filter((id) => !failedIds.has(id)), failed }
}

// ---------- Conversion ----------

/**
 * Converts an open lead (any open status — SMEs skip steps) in one transaction:
 * - contact: create from the lead's details, or link an existing one (the lead's missing
 *   emails/phones are added to it when the caller may edit it);
 * - company: create (from `name` or the lead's company name), link, or none;
 * - deal (optional): in the chosen pipeline stage, linked to the contact and company, with the
 *   lead's source, owner, tags and matching custom fields; value defaults to the lead's budget;
 * - matching custom fields (same key and type) and tags are copied; history registered with
 *   registerConversionHook steps run (activities re-linked, open tasks moved — M10);
 * - the lead becomes `converted` and read-only. Net zero for the `records` limit.
 */
export async function convertLead(ctx, id, input) {
  const lead = await getForAction(ctx, id, 'update')
  assertOpen(lead)
  if (!OPEN_STATUSES.includes(lead.status)) throw new ApiError(400, 'Reopen this lead before converting it.', { code: 'INVALID_TRANSITION' })
  if (input.deal?.create && !ctx.permissions.includes('deals.create')) throw new ApiError(403, 'You don’t have permission to create deals.', { code: 'FORBIDDEN' })
  if (input.contact.mode === 'create' && !ctx.permissions.includes('contacts.create')) throw new ApiError(403, 'You don’t have permission to create contacts.', { code: 'FORBIDDEN' })
  if (input.company.mode === 'create' && !ctx.permissions.includes('companies.create')) throw new ApiError(403, 'You don’t have permission to create companies.', { code: 'FORBIDDEN' })

  const result = await prisma.$transaction(async (tx) => {
    // Lock the lead so a double-click can't convert it twice.
    await tx.$queryRaw`SELECT id FROM leads WHERE id = ${id}::uuid FOR UPDATE`
    const current = await getForAction(ctx, id, 'update', {}, tx)
    if (current.deletedAt || current.status === 'converted') throw new ApiError(409, 'This lead has already been converted.', { code: 'LEAD_CONVERTED' })
    if (!OPEN_STATUSES.includes(current.status)) throw new ApiError(400, 'Reopen this lead before converting it.', { code: 'INVALID_TRANSITION' })
    assertNotStale(current, lead.updatedAt.toISOString())
    const now = new Date()
    const tagRows = await tx.recordTag.findMany({ where: { organizationId: ctx.orgId, entityType: ENTITY, entityId: id }, select: { tagId: true } })
    const tagIds = tagRows.map((t) => t.tagId)

    // Company
    let companyId = null
    if (input.company.mode === 'link') {
      const company = await tx.company.findFirst({ where: { AND: [{ id: input.company.companyId, organizationId: ctx.orgId, deletedAt: null }, visibilityWhere(ctx, 'companies', 'read')] }, select: { id: true } })
      if (!company) throw validationError({ 'company.companyId': 'This company no longer exists' })
      companyId = company.id
    } else if (input.company.mode === 'create') {
      const name = input.company.name?.trim() || lead.companyName
      if (!name) throw validationError({ 'company.name': 'Enter the company name' })
      const company = await tx.company.create({
        data: {
          organizationId: ctx.orgId,
          name,
          ownerId: lead.ownerId ?? ctx.userId,
          createdById: ctx.userId,
          customFields: await copyMatchingCustomFields(ctx.orgId, ENTITY, 'company', lead.customFields, tx),
          billingAddress: lead.city || lead.stateCode || lead.pincode ? { line1: null, line2: null, city: lead.city, stateCode: lead.stateCode, pincode: lead.pincode, country: 'IN' } : undefined,
        },
        select: { id: true },
      })
      if (tagIds.length) await setRecordTags(tx, ctx, 'company', company.id, tagIds)
      await emit(tx, ctx, 'company.created', { entityType: 'company', entityId: company.id }, { fromLeadId: id })
      companyId = company.id
    }

    // Contact
    let contactId
    let contactCanEdit = true
    if (input.contact.mode === 'link') {
      const contact = await tx.contact.findFirst({
        where: { AND: [{ id: input.contact.contactId, organizationId: ctx.orgId, deletedAt: null }, visibilityWhere(ctx, 'contacts', 'read')] },
        select: { id: true, ownerId: true, emails: true, phones: true, firstName: true, lastName: true },
      })
      if (!contact) throw validationError({ 'contact.contactId': 'This contact no longer exists — choose another or create a new one' })
      contactId = contact.id
      contactCanEdit = canAccessRecord(ctx, 'contacts', 'update', contact.ownerId)
      if (contactCanEdit) {
        const emails = normalizeEmails([...contact.emails, ...lead.emails.map((e) => ({ ...e, primary: false }))]).slice(0, MAX_CONTACT_POINTS)
        const phones = normalizePhones([...contact.phones, ...lead.phones.map((p) => ({ ...p, primary: false }))], ctx.country).slice(0, MAX_CONTACT_POINTS)
        await tx.contact.update({ where: { id: contact.id }, data: { emails, phones, ...primaryColumns(emails, phones), lastActivityAt: now } })
        await syncContactLookups(tx, ctx.orgId, contact.id, emails, phones)
        if (tagIds.length) await addTagsToRecords(tx, ctx, 'contact', [contact.id], tagIds)
        await emit(tx, ctx, 'contact.updated', { entityType: 'contact', entityId: contact.id }, { fromLeadId: id })
      }
    } else {
      const contact = await tx.contact.create({
        data: {
          organizationId: ctx.orgId,
          firstName: lead.firstName,
          lastName: lead.lastName,
          displayName: lead.displayName,
          emails: lead.emails,
          phones: lead.phones,
          primaryEmail: lead.primaryEmail,
          primaryPhoneE164: lead.primaryPhoneE164,
          lifecycleStage: 'lead',
          source: lead.source?.name ?? null,
          ownerId: lead.ownerId ?? ctx.userId,
          createdById: ctx.userId,
          customFields: await copyMatchingCustomFields(ctx.orgId, ENTITY, 'contact', lead.customFields, tx),
        },
        select: { id: true, emails: true, phones: true },
      })
      await syncContactLookups(tx, ctx.orgId, contact.id, contact.emails, contact.phones)
      if (tagIds.length) await setRecordTags(tx, ctx, 'contact', contact.id, tagIds)
      await emit(tx, ctx, 'contact.created', { entityType: 'contact', entityId: contact.id }, { fromLeadId: id })
      contactId = contact.id
    }
    if (companyId) {
      if (!contactCanEdit) throw validationError({ 'contact.contactId': 'Choose a contact you can edit to change its company links' })
      const existing = await tx.contactCompany.findMany({ where: { contactId }, select: { companyId: true, role: true, isPrimary: true } })
      if (!existing.some((l) => l.companyId === companyId)) {
        await setCompanies(tx, ctx, contactId, [...existing, { companyId, role: input.company.role ?? null, isPrimary: !existing.some((l) => l.isPrimary) }])
      }
    }

    // Deal (M09): in the chosen stage (default pipeline's first stage otherwise).
    let dealId = null
    if (input.deal?.create) {
      const placement = input.deal.stageId ? { stageId: input.deal.stageId, pipelineId: input.deal.pipelineId } : await defaultStage(ctx.orgId, tx)
      if (!placement) throw validationError({ 'deal.stageId': 'Set up a pipeline first' })
      const deal = await createDealTx(tx, ctx, {
        ...placement,
        title: input.deal.title || `${lead.companyName || lead.displayName}${lead.requirement ? ` — ${lead.requirement.slice(0, 40)}` : ''}`,
        valueMinor: input.deal.valueMinor ?? (lead.budgetMinor !== null ? Number(lead.budgetMinor) : 0),
        expectedCloseDate: input.deal.expectedCloseDate ?? null,
        companyId,
        contacts: [{ contactId, isPrimary: true }],
        ownerId: lead.ownerId ?? ctx.userId,
        sourceId: lead.sourceId,
        leadId: id,
        tagIds,
        customFields: { ...(await copyMatchingCustomFields(ctx.orgId, ENTITY, 'deal', lead.customFields, tx)), ...(input.deal.customFields ?? {}) },
        skipRequiredCustomFields: true,
      })
      dealId = deal.id
    }

    // History follows the customer (activities, open tasks — registered by M10).
    await runConversionHooks(tx, ctx, { leadId: id, contactId, companyId, dealId })

    const converted = await tx.lead.update({
      where: { id },
      data: { status: 'converted', convertedAt: now, convertedById: ctx.userId, convertedContactId: contactId, convertedCompanyId: companyId, convertedDealId: dealId, lastActivityAt: now },
      select: leadSelect,
    })
    await emit(tx, ctx, 'lead.converted', { entityType: ENTITY, entityId: id }, { contactId, companyId, dealId, changes: { status: [lead.status, 'converted'] } })
    await recordAudit(tx, ctx, { action: 'lead.convert', entityType: ENTITY, entityId: id, changes: { contactId, companyId, dealId, contactMode: input.contact.mode, companyMode: input.company.mode } })
    return { lead: converted, contactId, companyId, dealId }
  })
  return { lead: await present(result.lead), contactId: result.contactId, companyId: result.companyId, dealId: result.dealId }
}

/**
 * Suggestions for the convert dialog: contacts matching the lead's phones/emails, and companies
 * matching its company name.
 */
export async function conversionSuggestions(ctx, id) {
  const lead = await getForAction(ctx, id, 'read')
  const key = { emails: lead.emails.map((e) => e.value), phones: lead.phones.map((p) => p.e164) }
  const [contacts, companies] = await Promise.all([
    findContactMatches(ctx.orgId, key),
    lead.companyName
      ? prisma.company.findMany({
          where: { AND: [{ organizationId: ctx.orgId, deletedAt: null, name: { contains: lead.companyName.trim(), mode: 'insensitive' } }, visibilityWhere(ctx, 'companies', 'read')] },
          select: { id: true, name: true, domain: true },
          take: 5,
        })
      : [],
  ])
  const visible = contacts.filter((c) => canAccessRecord(ctx, 'contacts', 'read', c.ownerId))
  const placement = await defaultStage(ctx.orgId)
  return {
    contacts: visible.map(({ ownerId: _o, ...c }) => c),
    companies,
    dealTitle: `${lead.companyName || lead.displayName}${lead.requirement ? ` — ${lead.requirement.slice(0, 40)}` : ''}`,
    dealValueMinor: lead.budgetMinor !== null ? Number(lead.budgetMinor) : null,
    dealsAvailable: Boolean(placement) && ctx.permissions.includes('deals.create'),
    defaultPipelineId: placement?.pipelineId ?? null,
    defaultStageId: placement?.stageId ?? null,
  }
}
