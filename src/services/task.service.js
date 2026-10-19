import { env } from '../config/env.js'
import { DB_NULL, prisma } from '../db/prisma.js'
import { queueEmail } from '../email/mailer.js'
import { taskReminderEmail } from '../email/templates.js'
import { emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { registerConversionHook, registerMergeHook } from '../lib/merge.js'
import { listParam, usersById, validationError } from '../lib/records.js'
import { DEFAULT_TZ, parseIsoDate, startOfDayInTz, zonedParts, zonedTimeToUtc } from '../lib/time.js'
import { canAccessRecord, registerReassignable, visibilityWhere } from '../lib/visibility.js'
import { ApiError } from '../utils/ApiError.js'
import { logActivityTx } from './activity.service.js'
import { loadRecord, memberCanRead, namesFor } from './recordRef.service.js'

/**
 * Tasks (M10): due dates in the workspace time zone, reminders, recurrence, overdue events,
 * complete-with-log and reassignment. Visibility: tasks you're assigned (or, by role, your team's
 * or everyone's) plus tasks you created.
 */

const RESOURCE = 'tasks'
const DAY_MS = 86_400_000
export const TASK_TYPES = ['todo', 'call', 'meeting', 'follow_up', 'email', 'whatsapp']
export const PRIORITIES = ['low', 'normal', 'high']
const MAX_LIST = 200

registerReassignable({ entity: 'task', model: 'task', ownerField: 'assigneeId', openWhere: { status: 'open', deletedAt: null } })

const taskSelect = {
  id: true,
  organizationId: true,
  title: true,
  description: true,
  type: true,
  priority: true,
  status: true,
  dueAt: true,
  allDay: true,
  reminderOffsetMinutes: true,
  remindAt: true,
  recurrence: true,
  seriesId: true,
  entityType: true,
  entityId: true,
  assigneeId: true,
  createdById: true,
  completedAt: true,
  completedById: true,
  createdAt: true,
  updatedAt: true,
}

// ---------- Time ----------

/** Today's [start, end] in the workspace time zone. */
function todayRange(tz, now = new Date()) {
  const start = startOfDayInTz(now, tz)
  const end = new Date(startOfDayInTz(new Date(start.getTime() + 36 * 3600_000), tz).getTime() - 1)
  return { start, end }
}

/** "2026-10-21" → 23:59:59.999 that day in `tz` (all-day tasks are due by end of day). */
function endOfDate(dateString, tz) {
  const d = parseIsoDate(dateString)
  if (!d) throw validationError({ dueDate: 'Enter a date' })
  return new Date(zonedTimeToUtc({ ...d, hour: 23, minute: 59, second: 59 }, tz).getTime() + 999)
}

/** due_at / all-day from input: `dueAt` (ISO instant) or `dueDate` (YYYY-MM-DD, all day). */
function dueFrom(input, tz) {
  if (input.dueDate) return { dueAt: endOfDate(input.dueDate, tz), allDay: true }
  if (input.dueAt) return { dueAt: new Date(input.dueAt), allDay: false }
  if (input.dueAt === null || input.dueDate === null) return { dueAt: null, allDay: false }
  return {}
}

/**
 * When to remind: due − offset. No reminder for tasks already past due; a task due sooner than its
 * offset is reminded straight away (next scan).
 */
function remindAtFor(dueAt, offset, now = new Date()) {
  if (!dueAt || offset === null || offset === undefined || dueAt <= now) return null
  return new Date(Math.max(dueAt.getTime() - offset * 60_000, now.getTime()))
}

const WEEK_ANCHOR = (y, m, d) => Math.floor((Date.UTC(y, m - 1, d) / DAY_MS + 3) / 7) // Monday-based week number

/**
 * Next occurrence of a recurring task after `dueAt`, keeping the wall-clock time in `tz`.
 * rule: { freq: daily|weekly|monthly, interval?, byWeekday?: [0–6, 0 = Sunday], byMonthDay?, count?, until? }
 * Returns null when the series has ended.
 */
export function nextOccurrence(dueAt, rule, tz, { occurrences = 1, allDay = false } = {}) {
  if (!rule || !dueAt) return null
  if (rule.count && occurrences >= rule.count) return null
  const interval = Math.max(1, rule.interval ?? 1)
  const p = zonedParts(dueAt, tz)
  let { year, month, day } = p
  const shift = (days) => {
    const d = new Date(Date.UTC(year, month - 1, day + days))
    year = d.getUTCFullYear()
    month = d.getUTCMonth() + 1
    day = d.getUTCDate()
  }
  if (rule.freq === 'daily') shift(interval)
  else if (rule.freq === 'weekly') {
    const days = new Set(rule.byWeekday?.length ? rule.byWeekday : [p.weekday])
    const startWeek = WEEK_ANCHOR(year, month, day)
    for (let i = 0; i < 7 * interval + 7; i++) {
      shift(1)
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
      if (!days.has(weekday)) continue
      const weeksAhead = WEEK_ANCHOR(year, month, day) - startWeek
      if (weeksAhead === 0 || weeksAhead % interval === 0) break
    }
  } else if (rule.freq === 'monthly') {
    const want = rule.byMonthDay ?? p.day
    let m = month - 1 + interval
    year += Math.floor(m / 12)
    month = (m % 12) + 1
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
    day = Math.min(want, last)
  } else return null
  const next = zonedTimeToUtc({ year, month, day, hour: p.hour, minute: p.minute, second: p.second }, tz)
  const at = allDay ? new Date(next.getTime() + 999) : next
  if (rule.until) {
    const until = parseIsoDate(rule.until)
    if (until && Date.UTC(year, month - 1, day) > Date.UTC(until.year, until.month - 1, until.day)) return null
  }
  return at
}

// ---------- Presentation & access ----------

async function present(rows, tz = DEFAULT_TZ) {
  const list = Array.isArray(rows) ? rows : [rows]
  if (!list.length) return Array.isArray(rows) ? [] : null
  const [users, records] = await Promise.all([
    usersById(list.flatMap((t) => [t.assigneeId, t.createdById, t.completedById])),
    namesFor(list.filter((t) => t.entityType).map((t) => ({ entityType: t.entityType, entityId: t.entityId })), prisma, list[0].organizationId),
  ])
  const now = new Date()
  const { end } = todayRange(tz, now)
  const out = list.map(({ organizationId: _o, ...t }) => ({
    ...t,
    assignee: users.get(t.assigneeId) ?? null,
    createdBy: t.createdById ? (users.get(t.createdById) ?? null) : null,
    record: t.entityType ? { entityType: t.entityType, entityId: t.entityId, name: records.get(`${t.entityType}:${t.entityId}`)?.name ?? null } : null,
    isOverdue: t.status === 'open' && Boolean(t.dueAt) && t.dueAt < now,
    isDueToday: t.status === 'open' && Boolean(t.dueAt) && t.dueAt >= startOfDayInTz(now, tz) && t.dueAt <= end,
  }))
  return Array.isArray(rows) ? out : out[0]
}

/** Tasks the caller can see: by role scope on the assignee, plus tasks they created. */
const readWhere = (ctx) => ({ OR: [visibilityWhere(ctx, RESOURCE, 'read', 'assigneeId'), { createdById: ctx.userId }] })

async function getForAction(ctx, id, action, db = prisma) {
  const task = await db.task.findFirst({ where: { AND: [{ id, organizationId: ctx.orgId, deletedAt: null }, readWhere(ctx)] }, select: taskSelect })
  if (!task) throw ApiError.notFound('Task not found')
  if (action !== 'read' && task.createdById !== ctx.userId && !canAccessRecord(ctx, RESOURCE, action, task.assigneeId)) {
    throw new ApiError(403, 'You don’t have permission to change this task.', { code: 'FORBIDDEN' })
  }
  return task
}

/** The assignee must be an active member who can see the linked record. */
async function assertAssignee(ctx, assigneeId, record) {
  if (!(await memberCanRead(ctx.orgId, assigneeId, record?.entityType ?? null, record?.ownerId ?? null))) {
    throw validationError({ assigneeId: record ? 'This member can’t see the linked record' : 'Choose an active member' })
  }
}

// ---------- Create & update ----------

export async function createTask(ctx, input) {
  const tz = ctx.timezone ?? DEFAULT_TZ
  const record = input.entityType ? await loadRecord(ctx, input.entityType, input.entityId, 'read') : null
  const assigneeId = input.assigneeId ?? ctx.userId
  await assertAssignee(ctx, assigneeId, record)
  const due = dueFrom(input, tz)
  const offset = input.reminderOffsetMinutes === undefined ? 15 : input.reminderOffsetMinutes
  const run = async (tx) => {
    const task = await tx.task.create({
      data: {
        organizationId: ctx.orgId,
        title: input.title,
        description: input.description ?? null,
        type: input.type ?? 'todo',
        priority: input.priority ?? 'normal',
        dueAt: due.dueAt ?? null,
        allDay: due.allDay ?? false,
        reminderOffsetMinutes: offset,
        remindAt: remindAtFor(due.dueAt ?? null, offset),
        recurrence: input.recurrence ?? undefined,
        seriesId: input.seriesId ?? null,
        entityType: record?.entityType ?? null,
        entityId: record?.id ?? null,
        assigneeId,
        createdById: ctx.userId ?? null,
      },
      select: taskSelect,
    })
    if (input.recurrence && !input.seriesId) await tx.task.update({ where: { id: task.id }, data: { seriesId: task.id } })
    const ref = { entityType: 'task', entityId: task.id }
    await emit(tx, ctx, 'task.created', ref, { assigneeId, recordType: task.entityType, recordId: task.entityId, dueAt: task.dueAt })
    await recordAudit(tx, ctx, { action: 'task.create', entityType: 'task', entityId: task.id, changes: { title: [null, task.title] } })
    if (assigneeId !== ctx.userId) await emit(tx, ctx, 'task.assigned', ref, { changes: { assigneeId: [null, assigneeId] } })
    return task
  }
  const task = await prisma.$transaction(run)
  return getTask(ctx, task.id)
}

export async function getTask(ctx, id) {
  return present(await getForAction(ctx, id, 'read'), ctx.timezone)
}

export async function updateTask(ctx, id, input) {
  const before = await getForAction(ctx, id, 'update')
  if (before.status !== 'open' && Object.keys(input).some((k) => k !== 'title' && k !== 'description')) {
    throw new ApiError(409, 'Reopen the task to change it.', { code: 'TASK_CLOSED' })
  }
  const tz = ctx.timezone ?? DEFAULT_TZ
  const data = {}
  for (const f of ['title', 'description', 'type', 'priority', 'reminderOffsetMinutes']) if (f in input) data[f] = input[f]
  if ('recurrence' in input) data.recurrence = input.recurrence ?? DB_NULL
  if (input.recurrence && !before.seriesId) data.seriesId = before.id
  Object.assign(data, dueFrom(input, tz))
  let record = null
  if ('entityType' in input || 'entityId' in input) {
    record = input.entityType ? await loadRecord(ctx, input.entityType, input.entityId, 'read') : null
    data.entityType = record?.entityType ?? null
    data.entityId = record?.id ?? null
  } else if (before.entityType) {
    record = await loadRecord(ctx, before.entityType, before.entityId, 'read').catch(() => null)
  }
  if ('entityType' in input || 'entityId' in input || ('assigneeId' in input && input.assigneeId !== before.assigneeId)) {
    await assertAssignee(ctx, input.assigneeId ?? before.assigneeId, record)
  }
  if ('assigneeId' in input && input.assigneeId !== before.assigneeId) {
    await assertAssignee(ctx, input.assigneeId, record)
    data.assigneeId = input.assigneeId
  }
  const dueAt = 'dueAt' in data ? data.dueAt : before.dueAt
  const offset = 'reminderOffsetMinutes' in data ? data.reminderOffsetMinutes : before.reminderOffsetMinutes
  const rule = 'recurrence' in input ? input.recurrence : before.recurrence
  if (rule && !dueAt) throw validationError({ recurrence: 'Recurring tasks need a due date' })
  if ('dueAt' in data || 'reminderOffsetMinutes' in data || 'assigneeId' in data) {
    data.remindAt = remindAtFor(dueAt, offset)
    data.reminderSentAt = null
  }
  if ('dueAt' in data && data.dueAt?.getTime() !== before.dueAt?.getTime()) data.overdueNotifiedAt = null

  await prisma.$transaction(async (tx) => {
    const changed = await tx.task.updateMany({ where: { id, organizationId: ctx.orgId, deletedAt: null, updatedAt: before.updatedAt, status: before.status }, data })
    if (changed.count !== 1) throw new ApiError(409, 'The task changed. Refresh and try again.', { code: 'STALE_UPDATE' })
    const ref = { entityType: 'task', entityId: id }
    await emit(tx, ctx, 'task.updated', ref, { fields: Object.keys(data) })
    if (data.assigneeId) await emit(tx, ctx, 'task.assigned', ref, { changes: { assigneeId: [before.assigneeId, data.assigneeId] } })
    await recordAudit(tx, ctx, { action: 'task.update', entityType: 'task', entityId: id, changes: { fields: Object.keys(data) } })
  })
  return getTask(ctx, id)
}

/** Activity type logged when completing a task of this type. */
const LOG_TYPE = { call: 'call', meeting: 'meeting', email: 'email', whatsapp: 'whatsapp' }

/**
 * Completes a task. `logActivity` (call/meeting/email/WhatsApp tasks on a record) logs the matching
 * activity in one go. A recurring task's next occurrence is created now (not all upfront).
 */
export async function completeTask(ctx, id, { logActivity: logInput = null } = {}) {
  const task = await getForAction(ctx, id, 'update')
  if (task.status === 'completed') return getTask(ctx, id)
  if (task.status === 'cancelled') throw new ApiError(409, 'Reopen the task first.', { code: 'TASK_CLOSED' })
  const tz = ctx.timezone ?? DEFAULT_TZ
  const occurrences = task.seriesId ? await prisma.task.count({ where: { organizationId: ctx.orgId, seriesId: task.seriesId } }) : 1
  const successor = task.seriesId ? await prisma.task.findFirst({ where: { organizationId: ctx.orgId, seriesId: task.seriesId, createdAt: { gt: task.createdAt } }, select: { id: true } }) : null
  const nextDue = task.recurrence && !successor ? nextOccurrence(task.dueAt, task.recurrence, tz, { occurrences, allDay: task.allDay }) : null

  await prisma.$transaction(async (tx) => {
    const now = new Date()
    const done = await tx.task.updateMany({ where: { id, organizationId: ctx.orgId, status: 'open', deletedAt: null, updatedAt: task.updatedAt }, data: { status: 'completed', completedAt: now, completedById: ctx.userId } })
    if (done.count !== 1) throw new ApiError(409, 'The task changed. Refresh and try again.', { code: 'STALE_UPDATE' })
    await emit(tx, ctx, 'task.completed', { entityType: 'task', entityId: id }, { title: task.title, recordType: task.entityType, recordId: task.entityId, assigneeId: task.assigneeId })
    await recordAudit(tx, ctx, { action: 'task.complete', entityType: 'task', entityId: id, changes: { status: ['open', 'completed'] } })
    if (logInput && task.entityType && LOG_TYPE[task.type]) {
      await logActivityTx(tx, ctx, {
        type: LOG_TYPE[task.type],
        entityType: task.entityType,
        entityId: task.entityId,
        subject: task.title,
        body: logInput.notes ?? null,
        outcome: task.type === 'call' ? (logInput.outcome ?? 'connected') : null,
        durationSeconds: logInput.durationSeconds ?? null,
        direction: task.type === 'meeting' ? null : 'outbound',
      })
    }

    if (nextDue) {
      await tx.task.create({
        data: {
          organizationId: ctx.orgId,
          title: task.title,
          description: task.description,
          type: task.type,
          priority: task.priority,
          dueAt: nextDue,
          allDay: task.allDay,
          reminderOffsetMinutes: task.reminderOffsetMinutes,
          remindAt: remindAtFor(nextDue, task.reminderOffsetMinutes),
          recurrence: task.recurrence.freq === 'monthly' ? { ...task.recurrence, byMonthDay: task.recurrence.byMonthDay ?? zonedParts(task.dueAt, tz).day } : task.recurrence,
          seriesId: task.seriesId ?? task.id,
          entityType: task.entityType,
          entityId: task.entityId,
          assigneeId: task.assigneeId,
          createdById: task.createdById,
        },
      })
    }
  })

  return getTask(ctx, id)
}

export async function reopenTask(ctx, id) {
  const task = await getForAction(ctx, id, 'update')
  if (task.status === 'open') return getTask(ctx, id)
  await prisma.$transaction(async (tx) => {
    await tx.task.update({
      where: { id },
      data: { status: 'open', completedAt: null, completedById: null, remindAt: task.dueAt && task.dueAt > new Date() ? remindAtFor(task.dueAt, task.reminderOffsetMinutes) : null, reminderSentAt: null, overdueNotifiedAt: null },
    })
    await emit(tx, ctx, 'task.reopened', { entityType: 'task', entityId: id })
  })
  return getTask(ctx, id)
}

export async function cancelTask(ctx, id) {
  const task = await getForAction(ctx, id, 'update')
  if (task.status !== 'open') return getTask(ctx, id)
  await prisma.$transaction(async (tx) => {
    await tx.task.update({ where: { id }, data: { status: 'cancelled', remindAt: null } })
    await emit(tx, ctx, 'task.cancelled', { entityType: 'task', entityId: id })
  })
  return getTask(ctx, id)
}

export async function deleteTask(ctx, id) {
  const task = await getForAction(ctx, id, 'update')
  await prisma.$transaction(async (tx) => {
    await tx.task.update({ where: { id }, data: { deletedAt: new Date(), remindAt: null } })
    await recordAudit(tx, ctx, { action: 'task.delete', entityType: 'task', entityId: id, changes: { title: [task.title, null] } })
  })
}

// ---------- Lists ----------

/**
 * GET /tasks?view=today|overdue|upcoming|completed|all — computed in the workspace time zone.
 * `counts=true` adds the number in each view (same assignee/record filters).
 */
export async function listTasks(ctx, query) {
  const tz = ctx.timezone ?? DEFAULT_TZ
  const now = new Date()
  const { start, end } = todayRange(tz, now)
  const base = [{ organizationId: ctx.orgId, deletedAt: null }, readWhere(ctx)]
  if (query.assigneeId) {
    const ids = listParam(query.assigneeId).map((v) => (v === 'me' ? ctx.userId : v))
    base.push({ assigneeId: { in: ids } })
  }
  if (query.entityType && query.entityId) {
    await loadRecord(ctx, query.entityType, query.entityId, 'read')
    base.push({ entityType: query.entityType, entityId: query.entityId })
  }
  if (query.q) base.push({ title: { contains: query.q, mode: 'insensitive' } })
  const views = {
    today: { status: 'open', dueAt: { gte: start, lte: end } },
    overdue: { status: 'open', dueAt: { lt: now } },
    upcoming: { status: 'open', OR: [{ dueAt: { gt: end } }, { dueAt: null }] },
    completed: { status: 'completed' },
    all: { status: { in: ['open', 'completed'] } },
    open: { status: 'open' },
  }
  const view = views[query.view] ? query.view : 'today'
  const orderBy = view === 'completed' ? [{ completedAt: 'desc' }, { id: 'asc' }] : [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }]
  const limit = Math.min(query.limit ?? 100, MAX_LIST)
  const offset = query.cursor ? Number(query.cursor) || 0 : 0
  const [rows, counts] = await Promise.all([
    prisma.task.findMany({ where: { AND: [...base, views[view]] }, orderBy, skip: offset, take: limit + 1, select: taskSelect }),
    query.counts
      ? Promise.all(['today', 'overdue', 'upcoming', 'completed'].map((v) => prisma.task.count({ where: { AND: [...base, views[v]] } }))).then(([today, overdue, upcoming, completed]) => ({ today, overdue, upcoming, completed }))
      : null,
  ])
  const hasMore = rows.length > limit
  return { items: await present(rows.slice(0, limit), tz), nextCursor: hasMore ? String(offset + limit) : null, ...(counts && { counts }) }
}

/** "My day" widget and the sidebar badge: my open tasks due today and overdue. */
export async function mySummary(ctx) {
  const tz = ctx.timezone ?? DEFAULT_TZ
  const now = new Date()
  const { start, end } = todayRange(tz, now)
  const mine = { organizationId: ctx.orgId, deletedAt: null, assigneeId: ctx.userId, status: 'open' }
  const [today, overdue, next] = await Promise.all([
    prisma.task.count({ where: { ...mine, dueAt: { gte: start, lte: end } } }),
    prisma.task.count({ where: { ...mine, dueAt: { lt: now } } }),
    prisma.task.findMany({ where: { ...mine, dueAt: { lte: end } }, orderBy: [{ dueAt: 'asc' }], take: 8, select: taskSelect }),
  ])
  return { today, overdue, tasks: await present(next, tz) }
}

// ---------- Bulk ----------

/** { ids, action: complete | reassign | reschedule | delete, payload } → { succeeded, failed } */
export async function bulkTasks(ctx, { ids, action, payload = {} }) {
  const succeeded = []
  const failed = []
  for (const id of ids) {
    try {
      if (action === 'complete') await completeTask(ctx, id)
      if (action === 'reassign') await updateTask(ctx, id, { assigneeId: payload.assigneeId })
      if (action === 'reschedule') await updateTask(ctx, id, payload.dueDate ? { dueDate: payload.dueDate } : { dueAt: payload.dueAt })
      if (action === 'delete') await deleteTask(ctx, id)
      succeeded.push(id)
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      failed.push({ id, code: err.code ?? 'FAILED' })
    }
  }
  return { succeeded, failed }
}

// ---------- Jobs ----------

/**
 * `tasks.reminders` (every minute): sends reminders whose time has come — an in-app event
 * (`task.reminder_due`, delivered by M11) and an email to the assignee. Each is claimed atomically,
 * so overlapping runs never double-send; edits recompute remind_at and re-arm it.
 */
export async function sendDueReminders(now = new Date()) {
  const due = await prisma.task.findMany({
    where: { status: 'open', deletedAt: null, reminderSentAt: null, remindAt: { lte: now } },
    select: { ...taskSelect, organization: { select: { timezone: true } } },
    take: 500,
  })
  let sent = 0
  for (const task of due) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.task.updateMany({
        where: { id: task.id, organizationId: task.organizationId, status: 'open', deletedAt: null, reminderSentAt: null, remindAt: task.remindAt, updatedAt: task.updatedAt },
        data: { reminderSentAt: now },
      })
      if (claimed.count !== 1) return
      await emit(tx, { orgId: task.organizationId, userId: null }, 'task.reminder_due', { entityType: 'task', entityId: task.id }, { assigneeId: task.assigneeId, dueAt: task.dueAt, remindAt: task.remindAt })
      sent++
    })
  }
  return { due: due.length, sent }
}

/** Outbox subscriber: failed delivery retries without losing the reminder. */
export async function deliverTaskReminder(event) {
  const task = await prisma.task.findFirst({
    where: { id: event.entityId, organizationId: event.organizationId, status: 'open', deletedAt: null, assigneeId: event.payload.assigneeId, dueAt: new Date(event.payload.dueAt), ...(event.payload.remindAt && { remindAt: new Date(event.payload.remindAt) }) },
    select: { ...taskSelect, organization: { select: { timezone: true } } },
  })
  if (!task) return // Cancelled, completed, deleted or rescheduled since the scan.
  const [assignee, names, membership] = await Promise.all([
    prisma.user.findUnique({ where: { id: task.assigneeId }, select: { email: true, fullName: true, deletedAt: true } }),
    task.entityType ? namesFor([{ entityType: task.entityType, entityId: task.entityId }], prisma, task.organizationId) : new Map(),
    prisma.membership.findUnique({ where: { organizationId_userId: { organizationId: task.organizationId, userId: task.assigneeId } }, select: { status: true } }),
  ])
  if (!assignee || assignee.deletedAt || membership?.status !== 'active') return
  const dueLabel = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', ...(!task.allDay && { timeStyle: 'short' }), timeZone: task.organization.timezone }).format(task.dueAt)
  const recordName = names.get(`${task.entityType}:${task.entityId}`)?.name
  await queueEmail({ to: assignee.email, ...taskReminderEmail({ name: assignee.fullName, title: task.title, dueLabel, recordLabel: recordName ?? null, url: `${env.FRONTEND_URL}/app/tasks` }) })
}

/** `tasks.overdue_scan` (every 15 min): emits `task.overdue` once per task (until it's rescheduled). */
export async function scanOverdueTasks(now = new Date()) {
  const rows = await prisma.task.findMany({ where: { status: 'open', deletedAt: null, overdueNotifiedAt: null, dueAt: { lt: now } }, select: { id: true, organizationId: true, assigneeId: true, dueAt: true }, take: 2000 })
  let emitted = 0
  for (const t of rows) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.task.updateMany({ where: { id: t.id, organizationId: t.organizationId, status: 'open', deletedAt: null, dueAt: t.dueAt, assigneeId: t.assigneeId, overdueNotifiedAt: null }, data: { overdueNotifiedAt: now } })
      if (claimed.count !== 1) return
      await emit(tx, { orgId: t.organizationId, userId: null }, 'task.overdue', { entityType: 'task', entityId: t.id }, { assigneeId: t.assigneeId, dueAt: t.dueAt })
      emitted++
    })
  }
  return { overdue: rows.length, emitted }
}

// ---------- Merge & conversion ----------

for (const entityType of ['contact', 'company']) {
  registerMergeHook(entityType, async (tx, ctx, { primaryId, ids }) => {
    await tx.task.updateMany({ where: { organizationId: ctx.orgId, entityType, entityId: { in: ids } }, data: { entityId: primaryId } })
  })
}

/** On conversion, the lead's open tasks move to the deal if one was created, else the contact. */
registerConversionHook(async (tx, ctx, { leadId, contactId, dealId }) => {
  await tx.task.updateMany({
    where: { organizationId: ctx.orgId, entityType: 'lead', entityId: leadId, status: 'open', deletedAt: null },
    data: dealId ? { entityType: 'deal', entityId: dealId } : { entityType: 'contact', entityId: contactId },
  })
})
