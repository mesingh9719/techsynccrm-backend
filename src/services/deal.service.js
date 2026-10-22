import { versionedUpdate } from '../lib/versionedUpdate.js'
import { prisma } from '../db/prisma.js'
import { diff, emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { registerMergeable, registerMergeHook } from '../lib/merge.js'
import { buildPage, parseListQuery } from '../lib/pagination.js'
import { assertAssignableOwner, assertNotStale, assertRestorable, bigToNumber, dateRange, listParam, ownerFilter, usersById, validationError } from '../lib/records.js'
import { parseIsoDate } from '../lib/time.js'
import { canAccessRecord, registerReassignable, visibilityWhere } from '../lib/visibility.js'
import { logger } from '../lib/logger.js'
import { percentOf } from '../lib/money.js'
import { ApiError } from '../utils/ApiError.js'
import { customFieldWhere, validateCustomFields } from './customField.service.js'
import { writablePipelineIds } from './pipeline.service.js'
import { addTagsToRecords, removeTagsFromRecords, setRecordTags, tagFilterIds, tagsFor } from './tag.service.js'

/**
 * Deals (M09): pipeline/stage placement, the single move endpoint behind the board (required
 * fields, won/lost rules, stage history), board aggregation, forecast and rotting.
 */

const log = logger.child({ component: 'deals' })
const RESOURCE = 'deals'
const ENTITY = 'deal'
const DAY_MS = 86_400_000
const BOARD_PAGE = 50
/** Won/Lost board columns show deals closed this recently (totals likewise). */
export const BOARD_CLOSED_DAYS = 30

registerReassignable({ entity: 'deal', model: 'deal', openWhere: { deletedAt: null, status: 'open' } })
registerMergeable('company', { model: 'deal', field: 'companyId' })
// deal_contacts has a composite key: drop rows the survivor already has, re-point the rest.
registerMergeHook('contact', async (tx, ctx, { primaryId, ids }) => {
  const existing = await tx.dealContact.findMany({ where: { organizationId: ctx.orgId, contactId: { in: [primaryId, ...ids] } }, select: { dealId: true, contactId: true, isPrimary: true } })
  const kept = new Map()
  const duplicates = []
  for (const link of existing.sort((a, b) => Number(b.contactId === primaryId) - Number(a.contactId === primaryId))) {
    const survivor = kept.get(link.dealId)
    if (!survivor) kept.set(link.dealId, link)
    else {
      duplicates.push({ dealId: link.dealId, contactId: link.contactId })
      if (link.isPrimary && !survivor.isPrimary) {
        await tx.dealContact.updateMany({ where: { organizationId: ctx.orgId, dealId: survivor.dealId, contactId: survivor.contactId }, data: { isPrimary: true } })
        survivor.isPrimary = true
      }
    }
  }
  if (duplicates.length) await tx.dealContact.deleteMany({ where: { organizationId: ctx.orgId, OR: duplicates } })
  await tx.dealContact.updateMany({ where: { organizationId: ctx.orgId, contactId: { in: ids } }, data: { contactId: primaryId } })
})

const stageSelect = { id: true, pipelineId: true, name: true, type: true, position: true, probability: true, rottingDays: true, requiredFields: true }

const dealSelect = {
  id: true,
  organizationId: true,
  title: true,
  pipelineId: true,
  stageId: true,
  status: true,
  valueMinor: true,
  currency: true,
  probabilityOverride: true,
  expectedCloseDate: true,
  companyId: true,
  leadId: true,
  sourceId: true,
  ownerId: true,
  position: true,
  stageEnteredAt: true,
  lastActivityAt: true,
  wonAt: true,
  lostAt: true,
  closedAt: true,
  lostReasonId: true,
  lostNote: true,
  customFields: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  stage: { select: stageSelect },
  pipeline: { select: { id: true, name: true } },
  contacts: { select: { contactId: true, role: true, isPrimary: true }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
}

const AUDITED = ['title', 'valueMinor', 'probabilityOverride', 'expectedCloseDate', 'companyId', 'ownerId', 'sourceId', 'customFields']

// ---------- Derived values ----------

export function isRotting(deal, now = new Date()) {
  if (deal.status !== 'open' || deal.stage?.rottingDays == null) return false
  const last = Math.max(new Date(deal.lastActivityAt).getTime(), new Date(deal.stageEnteredAt).getTime())
  return now.getTime() - last > deal.stage.rottingDays * DAY_MS
}

const probabilityOf = (deal) => deal.probabilityOverride ?? deal.stage?.probability ?? 0
export const weightedMinor = (deal) => (deal.status === 'open' ? Number(percentOf(deal.valueMinor, probabilityOf(deal) * 100)) : 0)
const isoDate = (d) => (d ? d.toISOString().slice(0, 10) : null)

async function present(rows) {
  const list = Array.isArray(rows) ? rows : [rows]
  if (!list.length) return Array.isArray(rows) ? [] : null
  const orgId = list[0].organizationId
  const contactIds = [...new Set(list.flatMap((d) => d.contacts.map((c) => c.contactId)))]
  const companyIds = [...new Set(list.map((d) => d.companyId).filter(Boolean))]
  const reasonIds = [...new Set(list.map((d) => d.lostReasonId).filter(Boolean))]
  const sourceIds = [...new Set(list.map((d) => d.sourceId).filter(Boolean))]
  const [owners, tags, contacts, companies, reasons, sources] = await Promise.all([
    usersById(list.map((d) => d.ownerId)),
    tagsFor(orgId, ENTITY, list.map((d) => d.id)),
    contactIds.length ? prisma.contact.findMany({ where: { organizationId: orgId, id: { in: contactIds } }, select: { id: true, displayName: true, primaryEmail: true, primaryPhoneE164: true, deletedAt: true } }) : [],
    companyIds.length ? prisma.company.findMany({ where: { organizationId: orgId, id: { in: companyIds } }, select: { id: true, name: true, deletedAt: true } }) : [],
    reasonIds.length ? prisma.lostReason.findMany({ where: { organizationId: orgId, id: { in: reasonIds } }, select: { id: true, name: true } }) : [],
    sourceIds.length ? prisma.leadSource.findMany({ where: { organizationId: orgId, id: { in: sourceIds } }, select: { id: true, name: true } }) : [],
  ])
  const byId = (arr) => new Map(arr.map((x) => [x.id, x]))
  const [contactMap, companyMap, reasonMap, sourceMap] = [byId(contacts), byId(companies), byId(reasons), byId(sources)]
  const now = new Date()
  const out = list.map(({ organizationId: _o, ...d }) => ({
    ...d,
    valueMinor: bigToNumber(d.valueMinor),
    expectedCloseDate: isoDate(d.expectedCloseDate),
    weightedMinor: weightedMinor(d),
    probability: probabilityOf(d),
    daysInStage: Math.floor((now - d.stageEnteredAt) / DAY_MS),
    isRotting: isRotting(d, now),
    owner: d.ownerId ? (owners.get(d.ownerId) ?? null) : null,
    tags: tags.get(d.id) ?? [],
    company: d.companyId && companyMap.get(d.companyId) ? { id: d.companyId, name: companyMap.get(d.companyId).name } : null,
    contacts: d.contacts
      .filter((c) => contactMap.get(c.contactId) && !contactMap.get(c.contactId).deletedAt)
      .map((c) => ({ ...c, displayName: contactMap.get(c.contactId).displayName, primaryEmail: contactMap.get(c.contactId).primaryEmail, primaryPhoneE164: contactMap.get(c.contactId).primaryPhoneE164 })),
    lostReason: d.lostReasonId ? (reasonMap.get(d.lostReasonId) ?? null) : null,
    source: d.sourceId ? (sourceMap.get(d.sourceId) ?? null) : null,
  }))
  return Array.isArray(rows) ? out : out[0]
}

async function getForAction(ctx, id, action, { includeDeleted = false } = {}, db = prisma) {
  const row = await db.deal.findFirst({
    where: { AND: [{ id, organizationId: ctx.orgId }, includeDeleted ? {} : { deletedAt: null }, visibilityWhere(ctx, RESOURCE, 'read')] },
    select: dealSelect,
  })
  if (!row) throw ApiError.notFound('Deal not found')
  if (action !== 'read' && !canAccessRecord(ctx, RESOURCE, action, row.ownerId)) {
    throw new ApiError(403, 'You don’t have permission to change this deal.', { code: 'FORBIDDEN' })
  }
  return row
}

// ---------- Validation ----------

async function getStage(ctx, stageId, db = prisma) {
  const stage = await db.pipelineStage.findFirst({ where: { id: stageId, organizationId: ctx.orgId, pipeline: { archivedAt: null } }, select: stageSelect })
  if (!stage) throw new ApiError(404, 'That stage no longer exists. Refresh the board.', { code: 'STAGE_NOT_FOUND' })
  return stage
}

async function assertWritable(ctx, pipelineId, targetType, db = prisma) {
  const writable = await writablePipelineIds(ctx.orgId, ctx.plan, db)
  if (writable && !writable.has(pipelineId) && targetType === 'open') {
    throw new ApiError(403, 'This pipeline is read-only on your plan. Deals in it can only be marked won or lost — upgrade to keep using it.', {
      code: 'PIPELINE_READ_ONLY',
      details: { pipelineId },
    })
  }
}

async function prepare(ctx, input, existing = null, db = prisma) {
  const data = {}
  if ('title' in input) data.title = input.title
  if ('valueMinor' in input) data.valueMinor = BigInt(input.valueMinor ?? 0)
  if ('probabilityOverride' in input) data.probabilityOverride = input.probabilityOverride
  if ('expectedCloseDate' in input) {
    const d = input.expectedCloseDate ? parseIsoDate(input.expectedCloseDate) : null
    if (input.expectedCloseDate && !d) throw validationError({ expectedCloseDate: 'Enter a date' })
    data.expectedCloseDate = d ? new Date(Date.UTC(d.year, d.month - 1, d.day)) : null
  }
  if ('companyId' in input && input.companyId !== existing?.companyId) {
    if (input.companyId) {
      const company = await db.company.findFirst({ where: { id: input.companyId, organizationId: ctx.orgId, deletedAt: null }, select: { id: true } })
      if (!company) throw validationError({ companyId: 'This company no longer exists' })
    }
    data.companyId = input.companyId
  }
  if ('sourceId' in input && input.sourceId !== existing?.sourceId) {
    if (input.sourceId && !(await db.leadSource.count({ where: { id: input.sourceId, organizationId: ctx.orgId } }))) throw validationError({ sourceId: 'Choose a source' })
    data.sourceId = input.sourceId
  }
  if ('ownerId' in input && input.ownerId !== existing?.ownerId) {
    await assertAssignableOwner(ctx, input.ownerId, db)
    data.ownerId = input.ownerId
  }
  if ('customFields' in input || !existing) {
    data.customFields = await validateCustomFields(ctx, ENTITY, input.customFields ?? {}, { existing: existing?.customFields, isCreate: !existing && !input.skipRequiredCustomFields, db })
  }
  return data
}

/** Replaces a deal's contacts: live contacts of the workspace, exactly one primary when any. */
export async function setDealContacts(tx, ctx, dealId, links) {
  const unique = [...new Map(links.map((l) => [l.contactId, l])).values()]
  if (unique.length > 20) throw validationError({ contacts: 'Add at most 20 contacts' })
  if (unique.length) {
    const n = await tx.contact.count({ where: { id: { in: unique.map((l) => l.contactId) }, organizationId: ctx.orgId, deletedAt: null } })
    if (n !== unique.length) throw validationError({ contacts: 'One of these contacts no longer exists' })
  }
  const primary = Math.max(0, unique.findIndex((l) => l.isPrimary))
  await tx.dealContact.deleteMany({ where: { dealId } })
  if (unique.length) {
    await tx.dealContact.createMany({ data: unique.map((l, i) => ({ organizationId: ctx.orgId, dealId, contactId: l.contactId, role: l.role ?? null, isPrimary: i === primary })) })
  }
}

/** Fields `stage` requires that `deal` lacks (Won also needs a value). */
export function missingFor(stage, deal, contactCount) {
  const required = [...stage.requiredFields, ...(stage.type === 'won' ? ['valueMinor'] : [])]
  const missing = []
  for (const field of new Set(required)) {
    if (field === 'valueMinor' && !(Number(deal.valueMinor) > 0)) missing.push(field)
    else if (field === 'contacts' && !contactCount) missing.push(field)
    else if (field.startsWith('cf.')) {
      const v = deal.customFields?.[field.slice(3)]
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) missing.push(field)
    } else if (!['valueMinor', 'contacts'].includes(field) && (deal[field] === null || deal[field] === undefined)) missing.push(field)
  }
  return missing
}

const requirementsError = (stage, missing) =>
  new ApiError(422, `Fill in ${missing.length === 1 ? 'this field' : 'these fields'} to move the deal to ${stage.name}.`, {
    code: 'STAGE_REQUIREMENTS',
    details: { stageId: stage.id, missing },
  })

async function assertLostReason(ctx, lostReasonId, db = prisma) {
  if (!lostReasonId) throw validationError({ lostReasonId: 'Choose why this deal was lost' })
  const reason = await db.lostReason.findFirst({ where: { id: lostReasonId, organizationId: ctx.orgId, entityType: 'deal', archivedAt: null }, select: { id: true } })
  if (!reason) throw validationError({ lostReasonId: 'Choose why this deal was lost' })
}

/** Top of a stage (positions ascending; new and moved deals go first). */
async function topPosition(db, stageId) {
  const first = await db.deal.aggregate({ where: { stageId, deletedAt: null }, _min: { position: true } })
  return (first._min.position ?? 1) - 1
}

/** Linked contacts become customers when a deal is won. */
async function markContactsCustomers(tx, ctx, dealId) {
  const links = await tx.dealContact.findMany({ where: { dealId }, select: { contactId: true } })
  if (!links.length) return
  await tx.contact.updateMany({ where: { id: { in: links.map((l) => l.contactId) }, organizationId: ctx.orgId, lifecycleStage: { in: ['subscriber', 'lead'] } }, data: { lifecycleStage: 'customer' } })
}

// ---------- Create ----------

/**
 * Creates a deal inside `tx` (also used by lead conversion). `input` is API-shaped; `stageId`
 * decides the pipeline. Creating straight into Won/Lost applies their rules.
 */
export async function createDealTx(tx, ctx, input) {
  const stage = await getStage(ctx, input.stageId, tx)
  if (input.pipelineId && input.pipelineId !== stage.pipelineId) throw validationError({ stageId: 'This stage belongs to another pipeline' })
  await assertWritable(ctx, stage.pipelineId, 'open', tx)
  const data = await prepare(ctx, input, null, tx)
  // prepare() already checked an explicit owner; the creator owns it otherwise.
  const ownerId = 'ownerId' in input ? (input.ownerId ?? null) : (ctx.userId ?? null)
  const now = new Date()
  const status = stage.type
  const contactCount = input.contacts?.length ?? 0
  const missing = missingFor(stage, { ...data, ownerId }, contactCount)
  if (missing.length) throw requirementsError(stage, missing)
  if (status === 'lost') await assertLostReason(ctx, input.lostReasonId, tx)

  const deal = await tx.deal.create({
    data: {
      ...data,
      organizationId: ctx.orgId,
      pipelineId: stage.pipelineId,
      stageId: stage.id,
      status,
      currency: ctx.currency ?? 'INR',
      ownerId: ownerId ?? null,
      leadId: input.leadId ?? null,
      position: await topPosition(tx, stage.id),
      stageEnteredAt: now,
      lastActivityAt: now,
      createdById: ctx.userId ?? null,
      ...(status === 'won' && { wonAt: now, closedAt: now }),
      ...(status === 'lost' && { lostAt: now, closedAt: now, lostReasonId: input.lostReasonId, lostNote: input.lostNote ?? null }),
    },
    select: { id: true },
  })
  if (input.contacts?.length) await setDealContacts(tx, ctx, deal.id, input.contacts)
  if (input.tagIds?.length) await setRecordTags(tx, ctx, ENTITY, deal.id, input.tagIds)
  await tx.dealStageHistory.create({ data: { organizationId: ctx.orgId, dealId: deal.id, fromStageId: null, toStageId: stage.id, fromPipelineId: null, toPipelineId: stage.pipelineId, movedById: ctx.userId ?? null, movedAt: now } })
  await emit(tx, ctx, 'deal.created', { entityType: ENTITY, entityId: deal.id }, { pipelineId: stage.pipelineId, stageId: stage.id, valueMinor: data.valueMinor ?? 0, companyId: data.companyId ?? null, leadId: input.leadId ?? null })
  if (ownerId && ownerId !== ctx.userId) await emit(tx, ctx, 'deal.assigned', { entityType: ENTITY, entityId: deal.id }, { changes: { ownerId: [null, ownerId] } })
  if (status === 'won') {
    await markContactsCustomers(tx, ctx, deal.id)
    await emit(tx, ctx, 'deal.won', { entityType: ENTITY, entityId: deal.id }, { valueMinor: data.valueMinor ?? 0 })
  }
  return deal
}

export async function createDeal(ctx, input) {
  const deal = await prisma.$transaction((tx) => createDealTx(tx, ctx, input))
  return getDeal(ctx, deal.id)
}

// ---------- Read ----------

const SORTABLE = { createdAt: 'date', updatedAt: 'date', valueMinor: 'bigint', stageEnteredAt: 'date', title: 'string', position: 'number' }

async function rottingIds(orgId) {
  const rows = await prisma.$queryRaw`
    SELECT d.id FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id
    WHERE d.organization_id = ${orgId}::uuid AND d.deleted_at IS NULL AND d.status = 'open' AND s.rotting_days IS NOT NULL
      AND GREATEST(d.last_activity_at, d.stage_entered_at) < now() - make_interval(days => s.rotting_days)`
  return rows.map((r) => r.id)
}

async function listWhere(ctx, query) {
  const and = [{ organizationId: ctx.orgId }, query.deleted ? { deletedAt: { not: null } } : { deletedAt: null }, visibilityWhere(ctx, RESOURCE, 'read')]
  if (query.status) and.push({ status: { in: listParam(query.status) } })
  if (query.pipelineId) and.push({ pipelineId: query.pipelineId })
  if (query.stageId) and.push({ stageId: { in: listParam(query.stageId) } })
  if (query.ownerId) and.push(ownerFilter(ctx, query.ownerId))
  if (query.companyId) and.push({ companyId: query.companyId })
  if (query.contactId) and.push({ contacts: { some: { contactId: query.contactId } } })
  if (query.leadId) and.push({ leadId: query.leadId })
  if (query.q) {
    const q = query.q.trim()
    const companies = await prisma.company.findMany({ where: { organizationId: ctx.orgId, deletedAt: null, name: { contains: q, mode: 'insensitive' } }, select: { id: true }, take: 200 })
    and.push({ OR: [{ title: { contains: q, mode: 'insensitive' } }, ...(companies.length ? [{ companyId: { in: companies.map((c) => c.id) } }] : [])] })
  }
  if (query.closeFrom || query.closeTo) {
    const range = {}
    if (query.closeFrom) range.gte = new Date(`${query.closeFrom}T00:00:00Z`)
    if (query.closeTo) range.lte = new Date(`${query.closeTo}T00:00:00Z`)
    and.push({ expectedCloseDate: range })
  }
  if (query.closedFrom) and.push({ closedAt: { gte: new Date(query.closedFrom) } })
  if (query.valueMin !== undefined) and.push({ valueMinor: { gte: BigInt(query.valueMin) } })
  if (query.valueMax !== undefined) and.push({ valueMinor: { lte: BigInt(query.valueMax) } })
  if (query.rotting) and.push({ id: { in: await rottingIds(ctx.orgId) } })
  if (query.tag) and.push({ id: { in: await tagFilterIds(ctx.orgId, ENTITY, listParam(query.tag)) } })
  const created = dateRange(query.createdFrom, query.createdTo, ctx.timezone)
  if (created) and.push({ createdAt: created })
  and.push(...(await customFieldWhere(ctx.orgId, ENTITY, query)))
  return and
}

export async function listDeals(ctx, query) {
  const page = parseListQuery(query, { sortable: SORTABLE, defaultSort: query.stageId ? 'position' : '-createdAt' })
  const and = await listWhere(ctx, query)
  const [rows, total] = await Promise.all([
    prisma.deal.findMany({ where: { AND: [...and, page.cursorWhere] }, orderBy: page.orderBy, take: page.take, select: dealSelect }),
    query.count ? prisma.deal.count({ where: { AND: and } }) : null,
  ])
  const result = buildPage(rows, page)
  return { items: await present(result.items), nextCursor: result.nextCursor, ...(total !== null && { total }) }
}

export async function getDeal(ctx, id) {
  return present(await getForAction(ctx, id, 'read', { includeDeleted: true }))
}

/**
 * GET /deals/board — one pipeline, per stage: totals, weighted totals, count and the first 50
 * deals (by manual position). Won/Lost columns cover deals closed in the last 30 days.
 */
export async function board(ctx, query) {
  const pipeline = query.pipelineId
    ? await prisma.pipeline.findFirst({ where: { id: query.pipelineId, organizationId: ctx.orgId, archivedAt: null }, select: { id: true, name: true } })
    : await prisma.pipeline.findFirst({ where: { organizationId: ctx.orgId, archivedAt: null }, orderBy: [{ isDefault: 'desc' }, { position: 'asc' }], select: { id: true, name: true } })
  if (!pipeline) throw ApiError.notFound('Pipeline not found')
  const stages = await prisma.pipelineStage.findMany({ where: { pipelineId: pipeline.id }, orderBy: { position: 'asc' }, select: stageSelect })
  const base = await listWhere(ctx, { ...query, pipelineId: pipeline.id, status: undefined, stageId: undefined })
  const since = new Date(Date.now() - BOARD_CLOSED_DAYS * DAY_MS)
  const scope = { OR: [{ status: 'open' }, { closedAt: { gte: since } }] }
  const where = { AND: [...base, scope] }

  const [groups, ...columns] = await Promise.all([
    prisma.deal.groupBy({ by: ['stageId', 'probabilityOverride', 'valueMinor'], where, _sum: { valueMinor: true }, _count: { _all: true } }),
    ...stages.map((s) =>
      prisma.deal.findMany({ where: { AND: [...base, scope, { stageId: s.id }] }, orderBy: [{ position: 'asc' }, { id: 'asc' }], take: BOARD_PAGE + 1, select: dealSelect }),
    ),
  ])
  const writable = await writablePipelineIds(ctx.orgId, ctx.plan)
  // Hydrate the visible cards together. Per-column hydration repeated the same owner,
  // tag, contact, company, reason and source queries for every non-empty stage.
  const cards = await present(columns.flatMap((rows) => rows.slice(0, BOARD_PAGE)))
  const cardsById = new Map(cards.map((card) => [card.id, card]))
  const result = []
  for (const [i, stage] of stages.entries()) {
    const g = groups.filter((x) => x.stageId === stage.id)
    const totalMinor = g.reduce((n, x) => n + Number(x._sum.valueMinor ?? 0), 0)
    const weighted = stage.type === 'open' ? g.reduce((n, x) => n + Number(percentOf(x.valueMinor, (x.probabilityOverride ?? stage.probability) * 100)) * x._count._all, 0) : 0
    const rows = columns[i]
    result.push({
      ...stage,
      count: g.reduce((n, x) => n + x._count._all, 0),
      totalMinor,
      weightedMinor: weighted,
      hasMore: rows.length > BOARD_PAGE,
      deals: rows.slice(0, BOARD_PAGE).map((row) => cardsById.get(row.id)),
    })
  }
  return { pipeline: { ...pipeline, readOnly: writable ? !writable.has(pipeline.id) : false }, closedWithinDays: BOARD_CLOSED_DAYS, stages: result }
}

export async function getHistory(ctx, id) {
  await getForAction(ctx, id, 'read', { includeDeleted: true })
  const rows = await prisma.dealStageHistory.findMany({ where: { dealId: id, organizationId: ctx.orgId }, orderBy: { movedAt: 'desc' }, take: 200 })
  const stageIds = [...new Set(rows.flatMap((r) => [r.fromStageId, r.toStageId]).filter(Boolean))]
  const [stages, users] = await Promise.all([
    prisma.pipelineStage.findMany({ where: { id: { in: stageIds } }, select: { id: true, name: true, type: true } }),
    usersById(rows.map((r) => r.movedById)),
  ])
  const stageMap = new Map(stages.map((s) => [s.id, s]))
  return rows.map((r) => ({
    id: r.id,
    movedAt: r.movedAt,
    secondsInPrevStage: r.secondsInPrevStage,
    from: r.fromStageId ? (stageMap.get(r.fromStageId) ?? { id: r.fromStageId, name: 'Deleted stage', type: 'open' }) : null,
    to: stageMap.get(r.toStageId) ?? { id: r.toStageId, name: 'Deleted stage', type: 'open' },
    pipelineChanged: Boolean(r.fromPipelineId && r.fromPipelineId !== r.toPipelineId),
    movedBy: r.movedById ? (users.get(r.movedById) ?? null) : null,
  }))
}

// ---------- Update ----------

export async function updateDeal(ctx, id, input, { expectedUpdatedAt, tx: externalTx } = {}) {
  const before = await getForAction(ctx, id, 'update', {}, externalTx ?? prisma)
  await assertWritable(ctx, before.pipelineId, 'open')
  assertNotStale(before, expectedUpdatedAt)
  const data = await prepare(ctx, input, before)
  // Edits can't sneak a deal past its stage's requirements.
  const merged = { ...before, ...data }
  const contactCount = input.contacts ? input.contacts.length : before.contacts.length
  const missing = missingFor(before.stage, merged, contactCount)
  if (missing.length && missing.some((f) => f in data || (f === 'contacts' && input.contacts) || (f.startsWith('cf.') && 'customFields' in input))) throw requirementsError(before.stage, missing)

  await (externalTx ? (fn) => fn(externalTx) : (fn) => prisma.$transaction(fn))(async (tx) => {
    const row = await versionedUpdate(tx, 'deal', ctx, before, data, dealSelect)
    if (input.contacts) await setDealContacts(tx, ctx, id, input.contacts)
    if (input.tagIds) await setRecordTags(tx, ctx, ENTITY, id, input.tagIds)
    const changes = diff(before, row, AUDITED)
    if (changes || input.contacts || input.tagIds) await emit(tx, ctx, 'deal.updated', { entityType: ENTITY, entityId: id }, { changes: changes ?? {} })
    if (changes?.ownerId) await emit(tx, ctx, 'deal.assigned', { entityType: ENTITY, entityId: id }, { changes: { ownerId: changes.ownerId } })
  })
  return externalTx ? externalTx.deal.findFirst({ where: { id, organizationId: ctx.orgId } }) : getDeal(ctx, id)
}

/**
 * Moves a deal (board drag-and-drop, stage stepper, Won/Lost buttons) — the only way to change
 * stage. Applies `fields` first (the board's mini-form for required fields), then checks the
 * target stage's requirements (422 STAGE_REQUIREMENTS), Won's value > 0 and Lost's reason.
 * Records stage history; moving out of Won/Lost reopens the deal.
 */
export async function moveDealTx(tx, ctx, deal, { stageId, pipelineId, position, fields, lostReasonId, lostNote }) {
  const target = await getStage(ctx, stageId, tx)
  if (pipelineId && pipelineId !== target.pipelineId) throw validationError({ stageId: 'This stage belongs to another pipeline' })
  const sameStage = target.id === deal.stageId
  if (sameStage) {
    if (position === undefined) return deal
    await assertWritable(ctx, deal.pipelineId, 'open', tx)
    return tx.deal.update({ where: { id: deal.id }, data: { position }, select: dealSelect })
  }
  await assertWritable(ctx, deal.pipelineId, target.type, tx)
  if (target.pipelineId !== deal.pipelineId) await assertWritable(ctx, target.pipelineId, target.type, tx)

  const data = fields ? await prepare(ctx, fields, deal, tx) : {}
  const contactCount = fields?.contacts ? fields.contacts.length : deal.contacts.length
  const missing = missingFor(target, { ...deal, ...data }, contactCount)
  if (missing.length) throw requirementsError(target, missing)
  if (target.type === 'lost') await assertLostReason(ctx, lostReasonId, tx)

  const now = new Date()
  const from = deal.status
  const to = target.type
  Object.assign(data, {
    stageId: target.id,
    pipelineId: target.pipelineId,
    status: to,
    stageEnteredAt: now,
    position: position ?? (await topPosition(tx, target.id)),
    ...(to === 'open' && { wonAt: null, lostAt: null, closedAt: null, lostReasonId: null, lostNote: null }),
    ...(to === 'won' && { wonAt: now, lostAt: null, closedAt: now, lostReasonId: null, lostNote: null }),
    ...(to === 'lost' && { lostAt: now, wonAt: null, closedAt: now, lostReasonId, lostNote: lostNote ?? null }),
  })
  if (from === to && to !== 'open') Object.assign(data, { wonAt: deal.wonAt, lostAt: deal.lostAt, closedAt: deal.closedAt })
  const row = await tx.deal.update({ where: { id: deal.id }, data, select: dealSelect })
  if (fields?.contacts) await setDealContacts(tx, ctx, deal.id, fields.contacts)
  await tx.dealStageHistory.create({
    data: {
      organizationId: ctx.orgId,
      dealId: deal.id,
      fromStageId: deal.stageId,
      toStageId: target.id,
      fromPipelineId: deal.pipelineId,
      toPipelineId: target.pipelineId,
      movedById: ctx.userId ?? null,
      movedAt: now,
      secondsInPrevStage: Math.round((now - deal.stageEnteredAt) / 1000),
    },
  })
  const ref = { entityType: ENTITY, entityId: deal.id }
  await emit(tx, ctx, 'deal.stage_changed', ref, {
    changes: { stageId: [deal.stageId, target.id], ...(target.pipelineId !== deal.pipelineId && { pipelineId: [deal.pipelineId, target.pipelineId] }) },
    fromStageName: deal.stage.name,
    toStageName: target.name,
  })
  if (to === 'won' && from !== 'won') {
    await markContactsCustomers(tx, ctx, deal.id)
    await emit(tx, ctx, 'deal.won', ref, { valueMinor: row.valueMinor })
  }
  if (to === 'lost' && from !== 'lost') await emit(tx, ctx, 'deal.lost', ref, { lostReasonId, valueMinor: row.valueMinor })
  if (to === 'open' && from !== 'open') {
    await emit(tx, ctx, 'deal.reopened', ref, { from })
    await recordAudit(tx, ctx, { action: 'deal.reopen', entityType: ENTITY, entityId: deal.id, changes: { status: [from, 'open'], stageId: [deal.stageId, target.id] } })
  }
  return row
}

export async function moveDeal(ctx, id, input, { expectedUpdatedAt } = {}) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM deals WHERE id = ${id}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`
    const deal = await getForAction(ctx, id, 'update', {}, tx)
    assertNotStale(deal, expectedUpdatedAt)
    await moveDealTx(tx, ctx, deal, input)
  })
  return getDeal(ctx, id)
}

/** Stage/pipeline deletion must obey the same destination requirements and history rules. */
export async function moveDealsForRemovalTx(tx, ctx, ids, stageForStatus) {
  for (const id of [...ids].sort()) {
    await tx.$queryRaw`SELECT id FROM deals WHERE id = ${id}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`
    const deal = await tx.deal.findFirst({ where: { id, organizationId: ctx.orgId }, select: dealSelect })
    if (!deal) continue
    await moveDealTx(tx, ctx, deal, { stageId: stageForStatus[deal.status], lostReasonId: deal.lostReasonId, lostNote: deal.lostNote })
  }
}

export async function addDealContact(ctx, id, { contactId, role, isPrimary }) {
  const deal = await getForAction(ctx, id, 'update')
  await assertWritable(ctx, deal.pipelineId, 'open')
  const links = deal.contacts.filter((c) => c.contactId !== contactId).map((c) => ({ ...c, isPrimary: isPrimary ? false : c.isPrimary }))
  await prisma.$transaction(async (tx) => {
    await setDealContacts(tx, ctx, id, [...(isPrimary ? [{ contactId, role, isPrimary: true }] : []), ...links, ...(!isPrimary ? [{ contactId, role, isPrimary: !links.length }] : [])])
    await emit(tx, ctx, 'deal.updated', { entityType: ENTITY, entityId: id }, { changes: { contacts: ['added', contactId] } })
  })
  return getDeal(ctx, id)
}

export async function removeDealContact(ctx, id, contactId) {
  const deal = await getForAction(ctx, id, 'update')
  await assertWritable(ctx, deal.pipelineId, 'open')
  if (deal.stage.requiredFields.includes('contacts') && deal.contacts.length <= 1) {
    throw requirementsError(deal.stage, ['contacts'])
  }
  await prisma.$transaction(async (tx) => {
    await setDealContacts(tx, ctx, id, deal.contacts.filter((c) => c.contactId !== contactId))
    await emit(tx, ctx, 'deal.updated', { entityType: ENTITY, entityId: id }, { changes: { contacts: ['removed', contactId] } })
  })
  return getDeal(ctx, id)
}

export async function deleteDeal(ctx, id) {
  const deal = await getForAction(ctx, id, 'delete')
  await prisma.$transaction(async (tx) => {
    await tx.deal.update({ where: { id }, data: { deletedAt: new Date() } })
    await emit(tx, ctx, 'deal.deleted', { entityType: ENTITY, entityId: id })
    await recordAudit(tx, ctx, { action: 'deal.delete', entityType: ENTITY, entityId: id, changes: { title: [deal.title, null] } })
  })
}

export async function restoreDeal(ctx, id) {
  const deal = await getForAction(ctx, id, 'delete', { includeDeleted: true })
  assertRestorable({ ...deal, mergedIntoId: null })
  // The deal's stage may have been deleted meanwhile (FK keeps it, but check the pipeline is live).
  await getStage(ctx, deal.stageId)
  await prisma.$transaction(async (tx) => {
    await tx.deal.update({ where: { id }, data: { deletedAt: null } })
    await emit(tx, ctx, 'deal.restored', { entityType: ENTITY, entityId: id })
    await recordAudit(tx, ctx, { action: 'deal.restore', entityType: ENTITY, entityId: id })
  })
  return getDeal(ctx, id)
}

// ---------- Bulk ----------

/** { ids, action: assign | move | tag | untag | delete, payload } → { succeeded, failed: [{ id, code }] } */
export async function bulkDeals(ctx, { ids, action, payload = {} }) {
  const needs = action === 'delete' ? 'delete' : 'update'
  const rows = await prisma.deal.findMany({ where: { AND: [{ id: { in: ids }, organizationId: ctx.orgId, deletedAt: null }, visibilityWhere(ctx, RESOURCE, 'read')] }, select: dealSelect })
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
  const done = []
  if (action === 'move') {
    for (const id of allowed) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM deals WHERE id = ${id}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`
          const current = await getForAction(ctx, id, 'update', {}, tx)
          await moveDealTx(tx, ctx, current, payload)
        })
        done.push(id)
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
        failed.push({ id, code: err.code ?? 'FAILED' })
      }
    }
  } else if (allowed.length) {
    await prisma.$transaction(async (tx) => {
      if (action === 'assign') {
        await tx.deal.updateMany({ where: { id: { in: allowed } }, data: { ownerId: payload.ownerId ?? null } })
        for (const id of allowed) await emit(tx, ctx, 'deal.assigned', { entityType: ENTITY, entityId: id }, { changes: { ownerId: [found.get(id).ownerId, payload.ownerId ?? null] }, bulk: true })
      }
      if (action === 'tag') {
        const { skipped } = await addTagsToRecords(tx, ctx, ENTITY, allowed, payload.tagIds ?? [])
        for (const id of skipped) failed.push({ id, code: 'TOO_MANY_TAGS' })
      }
      if (action === 'untag') await removeTagsFromRecords(tx, ctx, ENTITY, allowed, payload.tagIds ?? [])
      if (action === 'delete') {
        await tx.deal.updateMany({ where: { id: { in: allowed } }, data: { deletedAt: new Date() } })
        for (const id of allowed) await emit(tx, ctx, 'deal.deleted', { entityType: ENTITY, entityId: id }, { bulk: true })
      }
    })
    done.push(...allowed)
  }
  if (done.length) await recordAudit(prisma, ctx, { action: `deal.bulk_${action}`, entityType: ENTITY, changes: { ids: done, ...payload } })
  const failedIds = new Set(failed.map((f) => f.id))
  return { succeeded: done.filter((id) => !failedIds.has(id)), failed }
}

// ---------- Forecast ----------

export function periodKey(date, period, fyStartMonth) {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth() + 1
  if (period === 'month') return { key: `${y}-${String(m).padStart(2, '0')}`, label: new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date) }
  // Financial-year quarters: Q1 starts in the FY's first month (April in India).
  const offset = (m - fyStartMonth + 12) % 12
  const q = Math.floor(offset / 3) + 1
  const fyStart = m >= fyStartMonth ? y : y - 1
  const fyLabel = fyStartMonth === 1 ? String(fyStart) : `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`
  return { key: `${fyStart}-Q${q}`, label: `Q${q} FY${fyLabel}` }
}

/**
 * GET /deals/forecast — open deals bucketed by expected close month or (financial-year) quarter:
 * total, weighted (value × stage probability, or the deal's override) and count, overall and by
 * owner. Deals without a close date are reported separately.
 */
export async function forecast(ctx, { pipelineId, period = 'month', ownerId }) {
  const and = [{ organizationId: ctx.orgId, deletedAt: null, status: 'open' }, visibilityWhere(ctx, RESOURCE, 'read')]
  if (pipelineId) and.push({ pipelineId })
  if (ownerId) and.push(ownerFilter(ctx, ownerId))
  const deals = await prisma.deal.findMany({
    where: { AND: and },
    select: { valueMinor: true, probabilityOverride: true, expectedCloseDate: true, ownerId: true, status: true, stage: { select: { probability: true } } },
  })
  const owners = await usersById(deals.map((d) => d.ownerId))
  const buckets = new Map()
  const noDate = { totalMinor: 0, weightedMinor: 0, count: 0 }
  const fy = ctx.fiscalYearStartMonth ?? 4
  for (const d of deals) {
    const value = Number(d.valueMinor)
    const w = weightedMinor(d)
    if (!d.expectedCloseDate) {
      noDate.totalMinor += value
      noDate.weightedMinor += w
      noDate.count++
      continue
    }
    const { key, label } = periodKey(d.expectedCloseDate, period, fy)
    if (!buckets.has(key)) buckets.set(key, { period: key, label, totalMinor: 0, weightedMinor: 0, count: 0, byOwner: new Map() })
    const b = buckets.get(key)
    b.totalMinor += value
    b.weightedMinor += w
    b.count++
    const ok = d.ownerId ?? 'none'
    if (!b.byOwner.has(ok)) b.byOwner.set(ok, { ownerId: d.ownerId, name: d.ownerId ? (owners.get(d.ownerId)?.fullName ?? 'Member') : 'Unassigned', totalMinor: 0, weightedMinor: 0, count: 0 })
    const o = b.byOwner.get(ok)
    o.totalMinor += value
    o.weightedMinor += w
    o.count++
  }
  const periods = [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period)).map((b) => ({ ...b, byOwner: [...b.byOwner.values()].sort((x, y) => y.weightedMinor - x.weightedMinor) }))
  const totals = periods.reduce((t, b) => ({ totalMinor: t.totalMinor + b.totalMinor, weightedMinor: t.weightedMinor + b.weightedMinor, count: t.count + b.count }), { ...noDate })
  return { period, currency: ctx.currency ?? 'INR', periods, noCloseDate: noDate, totals }
}

// ---------- Rotting ----------

/**
 * `deals.rotting_scan` (daily): emits `deal.rotting` once per deal per stage entry for open deals
 * idle longer than their stage's rotting days (M11 notifies the owner).
 */
export async function scanRottingDeals() {
  const rows = await prisma.$queryRaw`
    SELECT d.id, d.organization_id AS "organizationId", d.owner_id AS "ownerId", d.stage_id AS "stageId", d.stage_entered_at AS "stageEnteredAt", s.rotting_days AS "rottingDays",
           GREATEST(d.last_activity_at, d.stage_entered_at) AS "lastTouch"
    FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id
    WHERE d.deleted_at IS NULL AND d.status = 'open' AND s.rotting_days IS NOT NULL
      AND GREATEST(d.last_activity_at, d.stage_entered_at) < now() - make_interval(days => s.rotting_days)
      AND (d.rotting_notified_at IS NULL OR d.rotting_notified_at < d.stage_entered_at)
    LIMIT 5000`
  let emitted = 0
  for (const r of rows) {
    try {
      await prisma.$transaction(async (tx) => {
        // Atomic claim: a parallel scan (or a re-run) finds nothing left to notify.
        const claimed = await tx.$executeRaw`
          UPDATE deals d SET rotting_notified_at = now()
          FROM pipeline_stages s
          WHERE d.id = ${r.id}::uuid AND d.organization_id = ${r.organizationId}::uuid
            AND d.stage_id = s.id AND d.stage_id = ${r.stageId}::uuid AND d.stage_entered_at = ${r.stageEnteredAt}
            AND d.status = 'open' AND d.deleted_at IS NULL AND s.rotting_days IS NOT NULL
            AND GREATEST(d.last_activity_at, d.stage_entered_at) < now() - make_interval(days => s.rotting_days)
            AND (d.rotting_notified_at IS NULL OR d.rotting_notified_at < d.stage_entered_at)`
        if (claimed !== 1) return
        const idleDays = Math.floor((Date.now() - new Date(r.lastTouch).getTime()) / DAY_MS)
        await emit(tx, { orgId: r.organizationId, userId: null }, 'deal.rotting', { entityType: ENTITY, entityId: r.id }, { ownerId: r.ownerId, stageId: r.stageId, idleDays, rottingDays: r.rottingDays })
        emitted++
      })
    } catch (err) {
      log.error({ err, dealId: r.id }, 'rotting scan failed for deal')
    }
  }
  return { rotting: rows.length, emitted }
}

/** Deals linked to a contact or company (their detail pages). */
export async function dealsFor(ctx, { contactId, companyId }) {
  const result = await listDeals(ctx, { ...(contactId && { contactId }), ...(companyId && { companyId }), limit: 100, sort: '-createdAt' })
  return result.items
}
