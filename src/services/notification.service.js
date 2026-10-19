import crypto from 'node:crypto'
import { NOTIFICATION_CHANNEL, NOTIFICATION_TYPES, EMAIL_BATCH_MS, GROUP_WINDOW_MS, notificationChannels } from '../config/notifications.js'
import { DB_NULL, prisma } from '../db/prisma.js'
import { recordAudit } from '../lib/audit.js'
import { sha256 } from '../lib/hash.js'
import { buildPage, parseListQuery } from '../lib/pagination.js'
import { ApiError } from '../utils/ApiError.js'
import { visibilityWhere } from '../lib/visibility.js'
import { RECORD_TYPES } from './recordRef.service.js'
import { notificationContext, notificationRecord } from './notificationAccess.service.js'

export const notificationScope = (ctx) => ({ organizationId: ctx.orgId, userId: ctx.userId })
export async function lockNotificationUser(tx, orgId, userId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`notification:${orgId}:${userId}`}, 0))`
}
export async function signalNotifications(tx, orgId, userId) {
  await tx.$executeRaw`SELECT pg_notify(${NOTIFICATION_CHANNEL}, ${JSON.stringify({ orgId, userId })})`
}

const recordPath = (type, id) => `/app/${{ lead: 'leads', contact: 'contacts', company: 'companies', deal: 'deals' }[type]}/${id}`
const membersOf = (orgId, roles, db) => db.membership.findMany({ where: { organizationId: orgId, status: 'active', ...(roles && { role: { in: roles } }) }, select: { userId: true, role: true } })

/** Event adapters deliberately use current tenant records rather than trusting names/owners in payloads. */
export async function notificationFromEvent(event, db = prisma) {
  const orgId = event.organizationId
  if (!orgId) return null
  const p = event.payload ?? {}
  const base = { context: {}, entityId: event.entityId, body: null }
  if (event.type.startsWith('lead.')) {
    const lead = await db.lead.findFirst({ where: { id: event.entityId, organizationId: orgId, deletedAt: null }, select: { id: true, ownerId: true, displayName: true } })
    if (!lead) return null
    const out = { ...base, entityType: 'lead', url: recordPath('lead', lead.id), body: lead.displayName }
    if (event.type === 'lead.assigned') return { ...out, type: 'lead_assigned', title: 'A lead was assigned to you', recipients: [p.changes?.ownerId?.[1] ?? lead.ownerId] }
    if (event.type === 'lead.repeat_enquiry') return { ...out, type: 'lead_repeat_enquiry', title: 'A lead enquired again', recipients: [lead.ownerId] }
    if (event.type === 'lead.created' && !lead.ownerId) return { ...out, type: 'new_unassigned_lead', title: 'New unassigned lead', recipients: (await membersOf(orgId, ['owner', 'admin', 'manager'], db)).map((m) => m.userId) }
  }
  if (event.type.startsWith('deal.')) {
    const deal = await db.deal.findFirst({ where: { id: event.entityId, organizationId: orgId, deletedAt: null }, select: { id: true, ownerId: true, title: true } })
    if (!deal) return null
    const out = { ...base, entityType: 'deal', url: recordPath('deal', deal.id), body: deal.title }
    if (event.type === 'deal.assigned') return { ...out, type: 'deal_assigned', title: 'A deal was assigned to you', recipients: [p.changes?.ownerId?.[1] ?? deal.ownerId] }
    if (event.type === 'deal.rotting') return { ...out, type: 'deal_rotting', title: 'A deal needs your attention', recipients: [deal.ownerId] }
    if (event.type === 'deal.won') {
      const admins = await membersOf(orgId, ['owner', 'admin'], db)
      const managers = deal.ownerId ? await db.teamMember.findMany({ where: { isManager: true, team: { organizationId: orgId, members: { some: { userId: deal.ownerId } } } }, select: { userId: true } }) : []
      return { ...out, type: 'deal_won', title: 'Your team won a deal', recipients: [...admins, ...managers].map((m) => m.userId) }
    }
  }
  if (event.type.startsWith('task.')) {
    const task = await db.task.findFirst({ where: { id: event.entityId, organizationId: orgId, deletedAt: null }, select: { id: true, title: true, assigneeId: true } })
    if (!task) return null
    const types = { 'task.assigned': ['task_assigned', 'A task was assigned to you'], 'task.reminder_due': ['task_reminder', 'Task reminder'], 'task.overdue': ['task_overdue', 'A task is overdue'] }
    const mapped = types[event.type]
    if (mapped) return { ...base, entityType: 'task', url: '/app/tasks', body: task.title, context: { dueAt: p.dueAt, remindAt: p.remindAt }, type: mapped[0], title: mapped[1], recipients: [p.changes?.assigneeId?.[1] ?? p.assigneeId ?? task.assigneeId] }
  }
  if (event.type === 'mention.created') {
    const activity = await db.activity.findFirst({ where: { id: event.entityId, organizationId: orgId, deletedAt: null }, select: { entityType: true, entityId: true } })
    if (!activity) return null
    return { ...base, ...activity, type: 'mention', title: 'You were mentioned in a note', url: recordPath(activity.entityType, activity.entityId), context: { activityId: event.entityId }, recipients: [p.userId] }
  }
  if (event.type === 'member.joined') return { ...base, entityType: null, entityId: null, type: 'member_joined', title: 'Your invited teammate joined the workspace', url: '/app/settings/team', recipients: [p.invitedById] }
  if (['import.completed', 'import.failed'].includes(event.type)) return { ...base, entityType: null, entityId: null, type: 'import_finished', title: event.type === 'import.failed' ? 'Your import failed' : 'Your import finished', url: '/app/notifications', recipients: [p.importerId ?? p.createdById ?? p.userId] }
  if (event.type === 'trial.ending') return { ...base, entityType: 'organization', entityId: orgId, type: 'trial_ending', title: p.daysLeft === 0 ? 'Your trial ends today' : `Your trial ends in ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}`, url: '/app/settings/plan', context: { trialEndsAt: p.trialEndsAt }, recipients: (await membersOf(orgId, ['owner', 'admin'], db)).map((m) => m.userId) }
  if (event.type === 'notification.announced') return { ...base, entityType: null, entityId: null, type: 'system', title: String(p.title ?? 'Workspace announcement').slice(0, 200), body: p.body ? String(p.body).slice(0, 1000) : null, url: '/app/notifications', recipients: (await membersOf(orgId, null, db)).map((m) => m.userId) }
  return null
}

export async function createNotificationFor(event, descriptor, userId, now = new Date()) {
  if (!userId || userId === event.actorId) return null
  const ctx = await notificationContext(event.organizationId, userId)
  if (!ctx) return null
  return prisma.$transaction(async (tx) => {
    await lockNotificationUser(tx, ctx.orgId, userId)
    const receipt = await tx.notificationReceipt.createMany({ data: [{ ...notificationScope(ctx), sourceEventId: event.id }], skipDuplicates: true })
    if (!receipt.count) return null
    if (!(await notificationRecord(ctx, descriptor, tx, now))) return null
    const pref = await tx.notificationPreference.findUnique({ where: { organizationId_userId_type: { ...notificationScope(ctx), type: descriptor.type } } })
    const channels = notificationChannels(descriptor.type, pref)
    if (!channels.inApp && !channels.email) return null
    const existing = descriptor.entityId ? await tx.notification.findFirst({ where: { ...notificationScope(ctx), type: descriptor.type, entityType: descriptor.entityType, entityId: descriptor.entityId, readAt: null, createdAt: { gte: new Date(now.getTime() - GROUP_WINDOW_MS) } }, orderBy: { createdAt: 'desc' } }) : null
    const data = {
      type: descriptor.type, title: descriptor.title, body: descriptor.body ?? null,
      entityType: descriptor.entityType, entityId: descriptor.entityId, url: descriptor.url,
      actorId: event.actorId, context: JSON.parse(JSON.stringify(descriptor.context ?? {})),
      inApp: channels.inApp || existing?.inApp || false,
      ...(channels.email && { emailPendingAt: existing?.emailPendingAt ?? new Date(now.getTime() + EMAIL_BATCH_MS) }),
    }
    const notification = existing
      ? await tx.notification.update({ where: { id: existing.id, ...notificationScope(ctx) }, data: { ...data, groupCount: { increment: 1 } } })
      : await tx.notification.create({ data: { ...notificationScope(ctx), ...data, sourceEventId: event.id } })
    if (channels.inApp) await signalNotifications(tx, ctx.orgId, userId)
    return notification
  })
}

export async function handleNotificationEvent(event) {
  const descriptor = await notificationFromEvent(event)
  if (!descriptor) return
  for (const userId of new Set(descriptor.recipients.filter(Boolean))) await createNotificationFor(event, descriptor, userId)
}

/** Old notifications become inaccessible immediately when record access is removed. */
export async function readableNotifications(ctx, rows, db = prisma) {
  const current = ctx.user ? ctx : await notificationContext(ctx.orgId, ctx.userId, db)
  if (!current) return []
  const records = new Map()
  for (const [type, definition] of Object.entries(RECORD_TYPES)) {
    const ids = [...new Set(rows.filter((r) => r.entityType === type).map((r) => r.entityId))]
    if (!ids.length) continue
    const found = await db[definition.model].findMany({ where: { AND: [{ organizationId: ctx.orgId, id: { in: ids }, deletedAt: null }, visibilityWhere(current, definition.resource, 'read')] }, select: { id: true, ownerId: true, [definition.name]: true } })
    for (const record of found) records.set(`${type}:${record.id}`, { id: record.id, ownerId: record.ownerId, name: record[definition.name] })
  }
  const out = []
  for (const row of rows) {
    const record = RECORD_TYPES[row.entityType] ? records.get(`${row.entityType}:${row.entityId}`) ?? null : undefined
    if (await notificationRecord(current, row, db, new Date(), record)) out.push(row)
  }
  return out
}

export async function listNotifications(ctx, query = {}) {
  const page = parseListQuery(query, { sortable: { createdAt: 'date' }, defaultSort: '-createdAt' })
  const current = ctx.user ? ctx : await notificationContext(ctx.orgId, ctx.userId)
  if (!current) return { items: [], nextCursor: null }
  const visible = []
  let cursor = query.cursor
  // Fill the visible page even when older records in front of it are no longer accessible.
  do {
    const scan = parseListQuery({ ...query, cursor }, { sortable: { createdAt: 'date' }, defaultSort: '-createdAt' })
    const rows = await prisma.notification.findMany({ where: { AND: [{ ...notificationScope(ctx), inApp: true, ...(query.unread && { readAt: null }) }, scan.cursorWhere] }, orderBy: scan.orderBy, take: scan.take })
    const result = buildPage(rows, scan)
    visible.push(...await readableNotifications(current, result.items))
    cursor = result.nextCursor
  } while (cursor && visible.length <= page.limit)
  const result = buildPage(visible, page)
  return { items: result.items.map(presentNotification), nextCursor: result.nextCursor }
}
export function presentNotification({ organizationId: _o, userId: _u, context: _c, emailPendingAt: _p, sourceEventId: _s, ...row }) { return row }

export async function unreadCount(ctx) {
  let cursor
  let count = 0
  do {
    const page = await listNotifications(ctx, { unread: true, limit: 100, cursor })
    count += page.items.length
    cursor = page.nextCursor
  } while (cursor)
  return count
}
export async function markNotificationRead(ctx, id) {
  const row = await prisma.notification.findFirst({ where: { id, ...notificationScope(ctx), inApp: true } })
  if (!row || !(await readableNotifications(ctx, [row])).length) throw ApiError.notFound('Notification not found')
  await prisma.$transaction(async (tx) => {
    await lockNotificationUser(tx, ctx.orgId, ctx.userId)
    await tx.notification.updateMany({ where: { id, ...notificationScope(ctx), readAt: null }, data: { readAt: new Date() } })
    await signalNotifications(tx, ctx.orgId, ctx.userId)
  })
}
export async function markAllNotificationsRead(ctx) {
  await prisma.$transaction(async (tx) => {
    await lockNotificationUser(tx, ctx.orgId, ctx.userId)
    await tx.notification.updateMany({ where: { ...notificationScope(ctx), inApp: true, readAt: null }, data: { readAt: new Date() } })
    await signalNotifications(tx, ctx.orgId, ctx.userId)
  })
}

export async function getNotificationPreferences(ctx) {
  const [rows, user] = await Promise.all([
    prisma.notificationPreference.findMany({ where: notificationScope(ctx) }),
    prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { quietHours: true, digestEnabled: true, timezone: true } }),
  ])
  const byType = new Map(rows.map((p) => [p.type, p]))
  return { preferences: Object.entries(NOTIFICATION_TYPES).map(([type, def]) => ({ type, label: def.label, mandatory: Boolean(def.mandatory), ...notificationChannels(type, byType.get(type)) })), quietHours: user.quietHours, digestEnabled: user.digestEnabled, timezone: user.timezone || ctx.timezone }
}
export async function updateNotificationPreferences(ctx, input) {
  await prisma.$transaction(async (tx) => {
    for (const pref of input.preferences) {
      const channels = notificationChannels(pref.type, pref)
      const key = { ...notificationScope(ctx), type: pref.type }
      await tx.notificationPreference.upsert({ where: { organizationId_userId_type: key }, create: { ...key, ...channels }, update: channels })
    }
    await tx.user.update({ where: { id: ctx.userId }, data: { quietHours: input.quietHours ?? DB_NULL, digestEnabled: input.digestEnabled } })
    await recordAudit(tx, ctx, { action: 'notification.preferences_update', entityType: 'user', entityId: ctx.userId })
  })
  return getNotificationPreferences(ctx)
}

export async function createStreamTicket(ctx) {
  const ticket = crypto.randomBytes(32).toString('base64url')
  await prisma.notificationStreamTicket.create({ data: { ...notificationScope(ctx), tokenHash: sha256(ticket), sessionId: ctx.sessionId ?? null, expiresAt: new Date(Date.now() + 30_000) } })
  return { ticket }
}
export async function consumeStreamTicket(ticket) {
  const tokenHash = sha256(ticket)
  return prisma.$transaction(async (tx) => {
    const row = await tx.notificationStreamTicket.findUnique({ where: { tokenHash } })
    if (!row || row.expiresAt <= new Date()) throw ApiError.unauthorized('Stream ticket expired', 'STREAM_TICKET_INVALID')
    const consumed = await tx.notificationStreamTicket.deleteMany({ where: { tokenHash, expiresAt: { gt: new Date() } } })
    if (consumed.count !== 1) throw ApiError.unauthorized('Stream ticket already used', 'STREAM_TICKET_INVALID')
    return { id: row.userId, orgId: row.organizationId, sid: row.sessionId }
  })
}
