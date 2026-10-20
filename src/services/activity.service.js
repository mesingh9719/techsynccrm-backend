import { DB_NULL, prisma, UNIQUE_VIOLATION } from '../db/prisma.js'
import { emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { registerConversionHook, registerMergeHook } from '../lib/merge.js'
import { buildPage, parseListQuery } from '../lib/pagination.js'
import { listParam, usersById, validationError } from '../lib/records.js'
import { canAccessRecord } from '../lib/visibility.js'
import { ApiError } from '../utils/ApiError.js'
import { recordLeadActivity, rescoreLead } from './lead.service.js'
import { loadRecord, memberCanRead, namesFor, RECORD_TYPES, relatedRefs } from './recordRef.service.js'

/**
 * Activities and the timeline (M10): notes (limited Markdown, @mentions), logged calls,
 * meetings, site visits and messages, and system activities generated from domain events.
 * Each activity has one primary record and is linked (activity_links) to every record it shows on.
 */

export const USER_TYPES = ['note', 'call', 'meeting', 'site_visit', 'whatsapp', 'email', 'sms']
export const CALL_OUTCOMES = ['connected', 'no_answer', 'busy', 'wrong_number', 'callback_requested', 'voicemail']
const EDIT_WINDOW_MS = 24 * 3600_000
const MAX_BODY = 10_000

const activitySelect = {
  id: true,
  organizationId: true,
  type: true,
  entityType: true,
  entityId: true,
  subject: true,
  body: true,
  occurredAt: true,
  endAt: true,
  direction: true,
  outcome: true,
  durationSeconds: true,
  location: true,
  meta: true,
  isPinned: true,
  actorId: true,
  editedAt: true,
  createdAt: true,
  participants: { select: { userId: true, contactId: true } },
  mentions: { select: { userId: true } },
}

// ---------- Text ----------

/**
 * Notes are limited Markdown. Raw HTML is never stored: tags are stripped and stray angle brackets
 * escaped, so the frontend's renderer only ever sees text plus **bold**, *italics*, lists and links.
 */
export function sanitizeNote(text) {
  if (text === null || text === undefined) return null
  const clean = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim()
  if (clean.length > MAX_BODY) throw validationError({ body: 'Keep it under 10,000 characters' })
  return clean || null
}

/** Mention tokens in a note: `@[Ravi Kumar](<userId>)`. */
export function parseMentions(body) {
  if (!body) return []
  return [...new Set([...body.matchAll(/@\[[^\]]{1,80}\]\(([0-9a-f-]{36})\)/gi)].map((m) => m[1].toLowerCase()))]
}

const isOutbound = (a) => ['meeting', 'site_visit'].includes(a.type) || (['call', 'whatsapp', 'email', 'sms'].includes(a.type) && a.direction === 'outbound')

// ---------- Presentation ----------

async function present(rows) {
  const list = Array.isArray(rows) ? rows : [rows]
  if (!list.length) return Array.isArray(rows) ? [] : null
  const userIds = list.flatMap((a) => [a.actorId, ...a.participants.map((p) => p.userId), ...a.mentions.map((m) => m.userId)])
  const contactIds = [...new Set(list.flatMap((a) => a.participants.map((p) => p.contactId)).filter(Boolean))]
  const [users, contacts, records] = await Promise.all([
    usersById(userIds),
    contactIds.length ? prisma.contact.findMany({ where: { id: { in: contactIds }, organizationId: list[0].organizationId }, select: { id: true, displayName: true } }) : [],
    namesFor(list.map((a) => ({ entityType: a.entityType, entityId: a.entityId })), prisma, list[0].organizationId),
  ])
  const contactMap = new Map(contacts.map((c) => [c.id, c.displayName]))
  const now = Date.now()
  const out = list.map(({ organizationId: _o, participants, mentions, ...a }) => ({
    ...a,
    actor: a.actorId ? (users.get(a.actorId) ?? null) : null,
    record: { entityType: a.entityType, entityId: a.entityId, name: records.get(`${a.entityType}:${a.entityId}`)?.name ?? null },
    participants: participants.map((p) => (p.userId ? { userId: p.userId, name: users.get(p.userId)?.fullName ?? 'Member' } : { contactId: p.contactId, name: contactMap.get(p.contactId) ?? 'Contact' })),
    mentions: mentions.map((m) => ({ userId: m.userId, name: users.get(m.userId)?.fullName ?? 'Member' })),
    editableUntil: a.type === 'system' ? null : new Date(a.createdAt.getTime() + EDIT_WINDOW_MS),
    canEditNow: a.type !== 'system' && now - a.createdAt.getTime() < EDIT_WINDOW_MS,
  }))
  return Array.isArray(rows) ? out : out[0]
}

// ---------- Side effects ----------

/** last_activity_at = max(current, at) on every linked lead/contact/company/deal. */
async function touchRecords(tx, orgId, refs, at) {
  for (const [entityType, t] of Object.entries(RECORD_TYPES)) {
    const ids = [...new Set(refs.filter((r) => r.entityType === entityType).map((r) => r.entityId))]
    if (ids.length) await tx[t.model].updateMany({ where: { id: { in: ids }, organizationId: orgId, lastActivityAt: { lt: at } }, data: { lastActivityAt: at } })
  }
}

/** Mentioned members must be able to read the record (otherwise a field error lists them). */
async function validateMentions(ctx, body, record, db = prisma) {
  const userIds = parseMentions(body)
  if (!userIds.length) return []
  const denied = []
  for (const userId of userIds) if (!(await memberCanRead(ctx.orgId, userId, record.entityType, record.ownerId, db))) denied.push(userId)
  if (denied.length) {
    const names = await usersById(denied)
    throw validationError({ body: `${denied.map((id) => names.get(id)?.fullName ?? 'Someone').join(', ')} can’t see this ${RECORD_TYPES[record.entityType].label}, so they can’t be mentioned` })
  }
  return userIds
}

// ---------- Log / edit ----------

/**
 * POST /activities — logs a note, call, meeting, site visit or message on a record.
 * Effects: linked to related records; last_activity_at bumped on all of them; an outbound touch
 * on a `new` lead moves it to contacted and records first response (M08); mentions notify (M11).
 */
export async function logActivity(ctx, input) {
  const id = await prisma.$transaction((tx) => logActivityTx(tx, ctx, input))
  return getActivity(ctx, id)
}

/** Also used by task completion so the task, recurrence and logged activity commit together. */
export async function logActivityTx(tx, ctx, input) {
  const record = await loadRecord(ctx, input.entityType, input.entityId, 'read', tx)
  const body = input.type === 'note' || 'body' in input ? sanitizeNote(input.body) : null
  if (input.type === 'note' && !body) throw validationError({ body: 'Write something first' })
  const mentionIds = await validateMentions(ctx, body, record, tx)
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date()
  if (occurredAt.getTime() > Date.now() + 5 * 60_000) {
    throw validationError({ occurredAt: 'Log things that already happened — use a task for the future' })
  }

  if (input.endAt && new Date(input.endAt) < occurredAt) throw validationError({ endAt: 'End time must be after the start' })
  for (const ref of input.relatedRefs ?? []) await loadRecord(ctx, ref.entityType, ref.entityId, 'read', tx)
  for (const userId of new Set(input.participantUserIds ?? [])) {
    if (!(await memberCanRead(ctx.orgId, userId, record.entityType, record.ownerId, tx))) throw validationError({ participantUserIds: 'Choose active members who can see this record' })
  }
  for (const contactId of new Set(input.participantContactIds ?? [])) await loadRecord(ctx, 'contact', contactId, 'read', tx)

  const extra = await relatedRefs(ctx.orgId, record.entityType, record.id, tx)
  const refs = [{ entityType: record.entityType, entityId: record.id }, ...extra, ...(input.relatedRefs ?? [])]
  const unique = [...new Map(refs.map((r) => [`${r.entityType}:${r.entityId}`, r])).values()]

  {
    const row = await tx.activity.create({
      data: {
        organizationId: ctx.orgId,
        type: input.type,
        entityType: record.entityType,
        entityId: record.id,
        subject: input.subject ?? null,
        body,
        occurredAt,
        endAt: input.endAt ? new Date(input.endAt) : null,
        direction: input.direction ?? (input.type === 'meeting' || input.type === 'site_visit' ? null : input.type === 'note' ? null : 'outbound'),
        outcome: input.outcome ?? null,
        durationSeconds: input.durationSeconds ?? null,
        location: input.location ?? undefined,
        actorId: ctx.userId,
      },
      select: { id: true, type: true, direction: true, occurredAt: true },
    })
    await tx.activityLink.createMany({ data: unique.map((r) => ({ activityId: row.id, organizationId: ctx.orgId, entityType: r.entityType, entityId: r.entityId, occurredAt })), skipDuplicates: true })
    const participants = [...new Set(input.participantUserIds ?? [])].map((userId) => ({ userId })).concat([...new Set(input.participantContactIds ?? [])].map((contactId) => ({ contactId })))
    if (participants.length) await tx.activityParticipant.createMany({ data: participants.map((p) => ({ organizationId: ctx.orgId, activityId: row.id, ...p })) })
    if (mentionIds.length) await tx.mention.createMany({ data: mentionIds.map((userId) => ({ organizationId: ctx.orgId, activityId: row.id, userId })), skipDuplicates: true })
    await touchRecords(tx, ctx.orgId, unique, occurredAt)

    const leadId = unique.find((r) => r.entityType === 'lead')?.entityId ?? null
    const ref = { entityType: 'activity', entityId: row.id }
    const payload = { type: row.type, recordType: record.entityType, recordId: record.id, leadId, outbound: isOutbound(row) }
    await emit(tx, ctx, input.type === 'note' ? 'note.created' : 'activity.logged', ref, payload)
    for (const userId of mentionIds) await emit(tx, ctx, 'mention.created', ref, { userId, recordType: record.entityType, recordId: record.id })
    for (const ref of unique.filter((r) => r.entityType === 'lead')) await recordLeadActivity(ctx, ref.entityId, { outbound: isOutbound(row), at: occurredAt }, tx)
    await recordAudit(tx, ctx, { action: 'activity.create', entityType: 'activity', entityId: row.id, changes: { type: row.type, recordType: record.entityType, recordId: record.id } })
    return row.id
  }
}

async function getOwnActivity(ctx, id) {
  const activity = await prisma.activity.findFirst({ where: { id, organizationId: ctx.orgId, deletedAt: null }, select: activitySelect })
  if (!activity) throw ApiError.notFound('Activity not found')
  // Visible if the primary record is.
  await loadRecord(ctx, activity.entityType, activity.entityId, 'read')
  return activity
}

export async function getActivity(ctx, id) {
  return present(await getOwnActivity(ctx, id))
}

const isAdmin = (ctx) => ctx.permissions.includes('settings.workspace.manage')

/** Author only, within 24 hours (shown as "edited"). System activities can't be edited. */
export async function updateActivity(ctx, id, input) {
  const activity = await getOwnActivity(ctx, id)
  if (activity.type === 'system') throw new ApiError(403, 'System entries can’t be edited.', { code: 'FORBIDDEN' })
  if (activity.actorId !== ctx.userId) throw new ApiError(403, 'Only the person who wrote this can edit it.', { code: 'FORBIDDEN' })
  if (Date.now() - activity.createdAt.getTime() > EDIT_WINDOW_MS) throw new ApiError(403, 'Entries can only be edited for 24 hours.', { code: 'EDIT_WINDOW_CLOSED' })
  const record = await loadRecord(ctx, activity.entityType, activity.entityId, 'read')
  const data = {}
  if ('body' in input) {
    data.body = sanitizeNote(input.body)
    if (activity.type === 'note' && !data.body) throw validationError({ body: 'Write something first' })
  }
  for (const f of ['subject', 'outcome', 'durationSeconds', 'direction', 'location']) if (f in input) data[f] = input[f]
  if (data.location === null) data.location = DB_NULL
  if ('occurredAt' in input) data.occurredAt = new Date(input.occurredAt)
  if ('endAt' in input) data.endAt = input.endAt ? new Date(input.endAt) : null
  const occurredAt = data.occurredAt ?? activity.occurredAt
  const endAt = 'endAt' in data ? data.endAt : activity.endAt
  if (occurredAt.getTime() > Date.now() + 5 * 60_000) throw validationError({ occurredAt: 'Log things that already happened — use a task for the future' })
  if (endAt && endAt < occurredAt) throw validationError({ endAt: 'End time must be after the start' })
  const mentionIds = 'body' in input ? await validateMentions(ctx, data.body, record) : null
  await prisma.$transaction(async (tx) => {
    await tx.activity.update({ where: { id }, data: { ...data, editedAt: new Date() } })
    if (data.occurredAt) await tx.activityLink.updateMany({ where: { activityId: id }, data: { occurredAt: data.occurredAt } })
    if (mentionIds) {
      const before = new Set(activity.mentions.map((m) => m.userId))
      await tx.mention.deleteMany({ where: { activityId: id, userId: { notIn: mentionIds } } })
      const added = mentionIds.filter((u) => !before.has(u))
      if (added.length) await tx.mention.createMany({ data: added.map((userId) => ({ organizationId: ctx.orgId, activityId: id, userId })), skipDuplicates: true })
      for (const userId of added) await emit(tx, ctx, 'mention.created', { entityType: 'activity', entityId: id }, { userId, recordType: activity.entityType, recordId: activity.entityId })
    }
    await rescoreActivityLeads(tx, ctx, id)
    await recordAudit(tx, ctx, { action: 'activity.update', entityType: 'activity', entityId: id, changes: { fields: Object.keys(data) } })
  })
  return getActivity(ctx, id)
}

/** The author or an admin. */
export async function deleteActivity(ctx, id) {
  const activity = await getOwnActivity(ctx, id)
  if (activity.type === 'system') throw new ApiError(403, 'System entries can’t be deleted.', { code: 'FORBIDDEN' })
  if (activity.actorId !== ctx.userId && !isAdmin(ctx)) throw new ApiError(403, 'Only the author or an admin can delete this.', { code: 'FORBIDDEN' })
  await prisma.$transaction(async (tx) => {
    await tx.activity.update({ where: { id }, data: { deletedAt: new Date() } })
    await emit(tx, ctx, 'activity.deleted', { entityType: 'activity', entityId: id })
    await recordAudit(tx, ctx, { action: 'activity.delete', entityType: 'activity', entityId: id, changes: { type: activity.type, recordType: activity.entityType, recordId: activity.entityId } })
    await rescoreActivityLeads(tx, ctx, id)
  })
}

async function rescoreActivityLeads(tx, ctx, activityId) {
  const refs = await tx.activityLink.findMany({ where: { organizationId: ctx.orgId, activityId, entityType: 'lead' }, select: { entityId: true } })
  for (const ref of refs) await rescoreLead(ref.entityId, tx)
}

/** Pin/unpin (anyone who can edit the record). Pinned entries show first on the timeline. */
export async function pinActivity(ctx, id, pinned) {
  const activity = await getOwnActivity(ctx, id)
  const record = await loadRecord(ctx, activity.entityType, activity.entityId, 'read')
  if (!canAccessRecord(ctx, RECORD_TYPES[record.entityType].resource, 'update', record.ownerId)) throw new ApiError(403, 'You don’t have permission to pin entries here.', { code: 'FORBIDDEN' })
  await prisma.activity.update({ where: { id }, data: { isPinned: pinned } })
  return getActivity(ctx, id)
}

// ---------- Timeline ----------

/**
 * GET /timeline — every activity linked to the record (its own and related ones), newest first,
 * filterable by type; pinned entries are returned separately on the first page.
 */
export async function timeline(ctx, query) {
  await loadRecord(ctx, query.entityType, query.entityId, 'read')
  const types = listParam(query.types)
  const page = parseListQuery(query, { sortable: { occurredAt: 'date' }, defaultSort: '-occurredAt' })
  const where = {
    organizationId: ctx.orgId,
    deletedAt: null,
    links: { some: { entityType: query.entityType, entityId: query.entityId } },
    ...(types.length && { type: { in: types } }),
  }
  const [rows, pinned] = await Promise.all([
    prisma.activity.findMany({ where: { AND: [where, page.cursorWhere] }, orderBy: page.orderBy, take: page.take, select: activitySelect }),
    query.cursor ? [] : prisma.activity.findMany({ where: { ...where, isPinned: true }, orderBy: { occurredAt: 'desc' }, take: 10, select: activitySelect }),
  ])
  const result = buildPage(rows, page)
  return { items: await present(result.items), nextCursor: result.nextCursor, ...(!query.cursor && { pinned: await present(pinned) }) }
}

// ---------- System activities (timeline subscriber) ----------

/**
 * Creates a system activity for a domain event, once (source_event_id is unique, so redelivery
 * is a no-op). `refs[0]` is the primary record.
 */
export async function createSystemActivity(event, { refs, subject, meta = {} }) {
  if (!refs.length || !event.organizationId) return null
  const [primary] = refs
  const unique = [...new Map(refs.map((r) => [`${r.entityType}:${r.entityId}`, r])).values()]
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.activity.create({
        data: {
          organizationId: event.organizationId,
          type: 'system',
          entityType: primary.entityType,
          entityId: primary.entityId,
          subject,
          occurredAt: event.createdAt,
          meta: { event: event.type, ...meta },
          actorId: event.actorId,
          sourceEventId: event.id,
        },
        select: { id: true },
      })
      await tx.activityLink.createMany({
        data: unique.map((r) => ({ activityId: row.id, organizationId: event.organizationId, entityType: r.entityType, entityId: r.entityId, occurredAt: event.createdAt })),
        skipDuplicates: true,
      })
      return row
    })
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) return null
    throw err
  }
}

// ---------- Merge & conversion ----------

/** activity_links has a composite key: drop links the survivor already has, re-point the rest. */
function relinkOnMerge(entityType) {
  return async (tx, ctx, { primaryId, ids }) => {
    const links = await tx.activityLink.findMany({ where: { organizationId: ctx.orgId, entityType, entityId: { in: [primaryId, ...ids] } }, select: { activityId: true, entityId: true } })
    const seen = new Set()
    const duplicates = []
    // Keep the survivor's link when present, otherwise one source link per activity.
    for (const link of links.sort((a, b) => Number(b.entityId === primaryId) - Number(a.entityId === primaryId))) {
      if (seen.has(link.activityId)) duplicates.push({ activityId: link.activityId, entityId: link.entityId })
      else seen.add(link.activityId)
    }
    if (duplicates.length) await tx.activityLink.deleteMany({ where: { organizationId: ctx.orgId, entityType, OR: duplicates } })
    await tx.activityLink.updateMany({ where: { organizationId: ctx.orgId, entityType, entityId: { in: ids } }, data: { entityId: primaryId } })
    await tx.activity.updateMany({ where: { organizationId: ctx.orgId, entityType, entityId: { in: ids } }, data: { entityId: primaryId } })
    if (entityType === 'contact') await tx.activityParticipant.updateMany({ where: { organizationId: ctx.orgId, contactId: { in: ids } }, data: { contactId: primaryId } })
  }
}
registerMergeHook('contact', relinkOnMerge('contact'))
registerMergeHook('company', relinkOnMerge('company'))

/** On conversion the lead's whole history also shows on the new contact (and deal). */
registerConversionHook(async (tx, ctx, { leadId, contactId, dealId }) => {
  for (const [entityType, entityId] of [['contact', contactId], ['deal', dealId]]) {
    if (!entityId) continue
    await tx.$executeRaw`
      INSERT INTO activity_links (activity_id, organization_id, entity_type, entity_id, occurred_at)
      SELECT activity_id, organization_id, ${entityType}, ${entityId}::uuid, occurred_at
      FROM activity_links WHERE organization_id = ${ctx.orgId}::uuid AND entity_type = 'lead' AND entity_id = ${leadId}::uuid
      ON CONFLICT DO NOTHING`
  }
})
