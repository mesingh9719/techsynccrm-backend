import crypto from 'node:crypto'
import { prisma } from '../../db/prisma.js'
import { googleError, fingerprint } from './config.js'
import { currentContext, auditGoogle } from './access.js'
import { ownResourceContext, resourceRequest, requirePermission, eventId, meetUrl, retryAt, safeCode } from './resourceAccess.js'
import { createTask } from '../../services/task.service.js'
import { loadRecord, RECORD_TYPES } from '../../services/recordRef.service.js'
import { visibilityWhere, recordScope } from '../../lib/visibility.js'
import { enqueue } from '../../jobs/queue.js'
import { emit } from '../../events/outbox.js'

const calendarDto = (row) => row ? { id: row.id, status: row.status, meetSupported: row.meetSupported, lastError: row.lastError, googleUrl: row.providerCalendarId ? `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(row.providerCalendarId)}` : null } : null
const eventDto = (row) => ({ id: row.id, taskId: row.taskId, leadId: row.leadId, title: row.title, startAt: row.startAt, endAt: row.endAt, timeZone: row.timeZone, location: row.location, includeMeet: row.includeMeet, attendees: row.attendees,
  status: row.status, meetUrl: row.meetUrl, meetStatus: row.meetStatus, revision: row.revision, lastError: row.lastError, cancelRequested: row.cancelRequested, reminderOffsetMinutes: row.task?.reminderOffsetMinutes ?? null, notes: row.task?.description || '', record: row.record || null })
function assertBinding(row, connection) {
  if (row.calendar.googleSubject !== connection.googleSubject || row.calendar.connectionId !== connection.id || row.calendar.projectNumber !== connection.projectNumber) throw googleError('GOOGLE_ACCOUNT_CHANGED', 'This meeting belongs to a previous Google account.')
}
const identity = (ctx, connection) => ({ organizationId: ctx.orgId, connectionId: connection.id, googleSubject: connection.googleSubject })
const projection = (event) => ({ summary: event.summary || '', start: event.start?.dateTime ? new Date(event.start.dateTime).toISOString() : event.start?.date, end: event.end?.dateTime ? new Date(event.end.dateTime).toISOString() : event.end?.date,
  location: event.location || '', attendees: (event.attendees || []).map((a) => a.email.toLowerCase()).sort() })
const same = (a, b) => ['summary', 'start', 'end', 'location', 'attendees'].every((key) => JSON.stringify(a?.[key]) === JSON.stringify(b?.[key]))
const unlocked = () => ({ OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] })
const marker = (id) => `TechSync CRM connection ${id}`
const eventPath = (row) => `calendars/${encodeURIComponent(row.calendar.providerCalendarId)}/events/${eventId(row.id)}`
const kick = (id) => enqueue('google.calendar.sync', { id }).catch(() => {})
async function ownLink(ctx, connection, db = prisma) {
  const row = await db.googleCalendarLink.findUnique({ where: { organizationId_connectionId_googleSubject: identity(ctx, connection) } })
  if (row && row.projectNumber !== connection.projectNumber) throw googleError('GOOGLE_ACCOUNT_CHANGED', 'This calendar belongs to the previous Google project.')
  return row
}
async function ownEvent(ctx, id, db = prisma) {
  const row = await db.googleCalendarEvent.findFirst({ where: { id, organizationId: ctx.orgId, calendar: { connection: { userId: ctx.userId } } }, include: { calendar: { include: { connection: true } }, task: true } })
  if (!row) throw googleError('GOOGLE_EVENT_NOT_FOUND', 'Meeting not found.', 404)
  row.record = row.task.entityType ? await loadRecord(ctx, row.task.entityType, row.task.entityId, 'read', db) : null
  return row
}
export async function calendarStatus(ctx) {
  const { connection } = await ownResourceContext(ctx, 'calendar')
  return calendarDto(await ownLink(ctx, connection))
}
export async function setupCalendar(ctx, input = {}) {
  const { ctx: fresh, connection } = await ownResourceContext(ctx, 'calendar')
  requirePermission(fresh, 'tasks.create')
  let row = await prisma.googleCalendarLink.upsert({ where: { organizationId_connectionId_googleSubject: identity(ctx, connection) }, create: { ...identity(ctx, connection), projectNumber: connection.projectNumber }, update: {} })
  if (row.projectNumber !== connection.projectNumber) throw googleError('GOOGLE_ACCOUNT_CHANGED', 'Google project changed. Review calendar setup.')
  if (row.status === 'ready' && !input.refresh) return calendarDto(row)
  if (input.calendarId || row.providerCalendarId) {
    const id = input.calendarId || row.providerCalendarId
    const remote = await resourceRequest(ctx, connection, 'calendar', 'calendar', `calendars/${encodeURIComponent(id)}`)
    if (input.calendarId && remote.description !== marker(row.id)) throw googleError('GOOGLE_CALENDAR_MISMATCH', 'Choose the TechSync calendar created for this workspace.', 400)
    row = await prisma.googleCalendarLink.update({ where: { id: row.id, organizationId: ctx.orgId }, data: { providerCalendarId: remote.id, status: 'ready', meetSupported: remote.conferenceProperties?.allowedConferenceSolutionTypes?.includes('hangoutsMeet') || false, lastError: null } })
    return calendarDto(row)
  }
  if (!['pending', 'failed'].includes(row.status)) throw googleError('GOOGLE_CALENDAR_UNCERTAIN', 'Calendar creation was not confirmed. Find the TechSync calendar in Google Calendar settings and recover it using its calendar ID.')
  if (!(await prisma.googleCalendarLink.updateMany({ where: { id: row.id, organizationId: ctx.orgId, status: { in: ['pending', 'failed'] } }, data: { status: 'creating', lastError: null } })).count) throw googleError('GOOGLE_OPERATION_BUSY', 'Calendar setup is already running.')
  try {
    const remote = await resourceRequest(ctx, connection, 'calendar', 'calendar', 'calendars', { method: 'POST', body: { summary: 'TechSync CRM', description: marker(row.id), timeZone: fresh.timezone || 'Asia/Kolkata' } })
    if (typeof remote.id !== 'string' || !remote.id) throw googleError('GOOGLE_REMOTE_UNCERTAIN', 'Google did not confirm the new calendar.', 503)
    row = await prisma.googleCalendarLink.update({ where: { id: row.id, organizationId: ctx.orgId }, data: { providerCalendarId: remote.id, status: 'ready', meetSupported: remote.conferenceProperties?.allowedConferenceSolutionTypes?.includes('hangoutsMeet') || false } })
    await auditGoogle(prisma, ctx, 'calendar_created', { connectionId: connection.id, service: 'calendar' })
    return calendarDto(row)
  } catch (error) {
    const definitive = error.providerStatus && error.providerStatus < 500 || ['GOOGLE_ACCOUNT_CHANGED', 'GOOGLE_CONSENT_REQUIRED', 'GOOGLE_TENANT_DISABLED', 'GOOGLE_SERVICE_DISABLED', 'GOOGLE_RECONNECT_REQUIRED'].includes(error.code)
    await prisma.googleCalendarLink.updateMany({ where: { id: row.id, organizationId: ctx.orgId, status: 'creating' }, data: { status: definitive ? 'failed' : 'unknown', lastError: safeCode(error) } })
    throw error
  }
}
export async function listCalendarEvents(ctx, { from, to, leadId }) {
  const { connection } = await ownResourceContext(ctx, 'calendar')
  if (leadId) await loadRecord(ctx, 'lead', leadId)
  const calendar = await ownLink(ctx, connection)
  if (!calendar) return { items: [], calendar: null }
  const items = await prisma.googleCalendarEvent.findMany({ where: { organizationId: ctx.orgId, calendarLinkId: calendar.id, ...(leadId && { leadId }), startAt: { lt: new Date(to) }, endAt: { gt: new Date(from) },
    OR: [{ leadId: null }, { lead: { is: { AND: [{ deletedAt: null }, visibilityWhere(ctx, 'leads')] } } }] }, orderBy: [{ startAt: 'asc' }, { id: 'asc' }], take: 201, include: { task: { select: { entityType: true, entityId: true, reminderOffsetMinutes: true, description: true } } } })
  // Batch only this bounded page's linked records, applying the same tenant/role visibility as CRM lists.
  const records = new Map()
  await Promise.all(Object.entries(RECORD_TYPES).map(async ([type, definition]) => {
    const ids = items.filter((item) => item.task.entityType === type).map((item) => item.task.entityId)
    if (!ids.length || !recordScope(ctx, definition.resource, 'read')) return
    const rows = await prisma[definition.model].findMany({ where: { AND: [{ organizationId: ctx.orgId, id: { in: ids }, deletedAt: null }, visibilityWhere(ctx, definition.resource)] }, select: { id: true, [definition.name]: true } })
    for (const row of rows) records.set(`${type}:${row.id}`, { entityType: type, entityId: row.id, name: row[definition.name] })
  }))
  const visible = items.slice(0, 200).filter((item) => !item.task.entityType || records.has(`${item.task.entityType}:${item.task.entityId}`))
  return { calendar: calendarDto(calendar), items: visible.map((row) => eventDto({ ...row, record: records.get(`${row.task.entityType}:${row.task.entityId}`) })), limited: items.length > 200 }
}
export async function createCalendarEvent(ctx, input) {
  const { ctx: fresh, connection } = await ownResourceContext(ctx, 'calendar')
  requirePermission(fresh, 'tasks.create')
  const reference = input.entityType ? { entityType: input.entityType, entityId: input.entityId } : input.leadId ? { entityType: 'lead', entityId: input.leadId } : null
  const linked = reference ? await loadRecord(fresh, reference.entityType, reference.entityId) : null
  const record = linked ? { entityType: linked.entityType, entityId: linked.id, name: linked.name } : null
  const calendar = await ownLink(ctx, connection)
  if (!calendar || calendar.status !== 'ready') throw googleError('GOOGLE_CALENDAR_REQUIRED', 'Set up your TechSync calendar first.')
  if (input.includeMeet && !calendar.meetSupported) throw googleError('GOOGLE_MEET_UNAVAILABLE', 'This Google calendar does not support Meet conferences. Check your Google account and calendar capabilities.')
  const hash = fingerprint(JSON.stringify({ ...input, requestId: undefined }))
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM memberships WHERE organization_id = ${ctx.orgId}::uuid AND user_id = ${ctx.userId}::uuid FOR UPDATE`
    await currentContext(ctx.orgId, ctx.userId, tx)
    const existing = await tx.googleCalendarEvent.findUnique({ where: { organizationId_calendarLinkId_requestId: { organizationId: ctx.orgId, calendarLinkId: calendar.id, requestId: input.requestId } } })
    if (existing) { if (existing.requestHash !== hash) throw googleError('GOOGLE_REQUEST_CHANGED', 'This request was already used for a different meeting.'); return { ...existing, task: await tx.task.findUnique({ where: { id: existing.taskId, organizationId: ctx.orgId } }) } }
    const task = await createTask(fresh, { title: input.title, description: input.notes || null, type: 'meeting', dueAt: input.startAt, reminderOffsetMinutes: 15, ...(reference || {}) }, { db: tx })
    const row = await tx.googleCalendarEvent.create({ data: { organizationId: ctx.orgId, calendarLinkId: calendar.id, taskId: task.id, leadId: reference?.entityType === 'lead' ? reference.entityId : null, requestId: input.requestId, requestHash: hash, connectionGeneration: connection.generation,
      title: input.title, startAt: new Date(input.startAt), endAt: new Date(input.endAt), timeZone: input.timeZone, location: input.location || null, includeMeet: input.includeMeet, attendees: input.attendees, meetStatus: input.includeMeet ? 'pending' : 'none' } })
    await auditGoogle(tx, ctx, 'meeting_scheduled', { connectionId: connection.id, service: 'calendar', status: 'pending' })
    return { ...row, task }
  })
  await kick(result.id)
  return eventDto({ ...result, record })
}
export async function updateCalendarEvent(ctx, id, input) {
  const { ctx: fresh, connection } = await ownResourceContext(ctx, 'calendar')
  requirePermission(fresh, 'tasks.update')
  const before = await ownEvent(fresh, id)
  assertBinding(before, connection)
  if (before.task.status !== 'open' || before.task.deletedAt || before.task.assigneeId !== ctx.userId || before.task.createdById !== ctx.userId) throw googleError('GOOGLE_TASK_CHANGED', 'The task is closed, removed or reassigned. Manage it from Tasks.')
  if (input.includeMeet && !before.includeMeet && !before.calendar.meetSupported) throw googleError('GOOGLE_MEET_UNAVAILABLE', 'This calendar does not support Meet.')
  if (before.includeMeet && !input.includeMeet) throw googleError('GOOGLE_MEET_IMMUTABLE', 'Keep the existing Meet conference or cancel this meeting and create a new one.')
  if (before.status === 'conflict') throw googleError('GOOGLE_REMOTE_CONFLICT', 'This meeting changed in Google Calendar. Review it there before creating a replacement.')
  const row = await prisma.$transaction(async (tx) => {
    const changed = await tx.googleCalendarEvent.updateMany({ where: { id, organizationId: ctx.orgId, revision: input.revision, ...unlocked() }, data: { title: input.title, startAt: new Date(input.startAt), endAt: new Date(input.endAt), timeZone: input.timeZone, location: input.location || null,
      includeMeet: input.includeMeet, attendees: input.attendees, revision: { increment: 1 }, status: 'queued', attempts: 0, nextAttemptAt: new Date(), lastError: null, connectionGeneration: connection.generation } })
    if (!changed.count) throw googleError('GOOGLE_REQUEST_CHANGED', 'This meeting changed. Refresh before editing.')
    const start = new Date(input.startAt), offset = before.task.reminderOffsetMinutes
    const taskChanged = await tx.task.updateMany({ where: { id: before.taskId, organizationId: ctx.orgId, updatedAt: before.task.updatedAt, status: 'open', deletedAt: null, assigneeId: ctx.userId }, data: { title: input.title, ...(input.notes !== undefined && { description: input.notes || null }), dueAt: start, remindAt: offset != null && start > new Date() ? new Date(Math.max(Date.now(), +start - offset * 60000)) : null, reminderSentAt: null, overdueNotifiedAt: null } })
    if (!taskChanged.count) throw googleError('GOOGLE_TASK_CHANGED', 'The task changed. Refresh before editing.')
    await emit(tx, ctx, 'task.updated', { entityType: 'task', entityId: before.taskId }, { fields: ['title', 'dueAt'] })
    return tx.googleCalendarEvent.findUnique({ where: { id, organizationId: ctx.orgId }, include: { task: true } })
  })
  await kick(id); return eventDto({ ...row, record: before.record ? { entityType: before.record.entityType, entityId: before.record.id, name: before.record.name } : null })
}
export async function cancelCalendarEvent(ctx, id) {
  const { ctx: fresh, connection } = await ownResourceContext(ctx, 'calendar')
  requirePermission(fresh, 'tasks.update')
  const before = await ownEvent(fresh, id)
  assertBinding(before, connection)
  if (before.task.assigneeId !== ctx.userId || before.task.createdById !== ctx.userId) throw googleError('GOOGLE_TASK_CHANGED', 'This task was reassigned. Manage it from Tasks.')
  const row = await prisma.$transaction(async (tx) => {
    const changed = await tx.task.updateMany({ where: { id: before.taskId, organizationId: ctx.orgId, updatedAt: before.task.updatedAt, assigneeId: ctx.userId }, data: { status: 'cancelled', remindAt: null } })
    if (!changed.count) throw googleError('GOOGLE_TASK_CHANGED', 'The task changed. Refresh before cancelling.')
    const changedEvent = await tx.googleCalendarEvent.updateMany({ where: { id, organizationId: ctx.orgId, revision: before.revision, ...unlocked() }, data: { cancelRequested: true, status: 'queued', revision: { increment: 1 }, connectionGeneration: connection.generation, nextAttemptAt: new Date(), attempts: 0, lastError: null } })
    if (!changedEvent.count) throw googleError('GOOGLE_OPERATION_BUSY', 'Meeting sync is running or the meeting changed. Refresh and try again.')
    await emit(tx, ctx, 'task.cancelled', { entityType: 'task', entityId: before.taskId }); return tx.googleCalendarEvent.findUnique({ where: { id, organizationId: ctx.orgId }, include: { task: true } })
  })
  await kick(id); return eventDto({ ...row, record: before.record ? { entityType: before.record.entityType, entityId: before.record.id, name: before.record.name } : null })
}
export async function retryCalendarEvent(ctx, id) {
  const { ctx: fresh, connection } = await ownResourceContext(ctx, 'calendar'), before = await ownEvent(ctx, id)
  requirePermission(fresh, 'tasks.update')
  assertBinding(before, connection)
  if (before.status === 'conflict') throw googleError('GOOGLE_REMOTE_CONFLICT', 'Review conflicting changes in Google Calendar. Cancel or create a replacement from the CRM.')
  const changed = await prisma.googleCalendarEvent.updateMany({ where: { id, organizationId: ctx.orgId, revision: before.revision, ...unlocked() }, data: { status: 'queued', connectionGeneration: connection.generation, nextAttemptAt: new Date(), attempts: 0, lastError: null } })
  if (!changed.count) throw googleError('GOOGLE_OPERATION_BUSY', 'Meeting sync is running or the meeting changed. Refresh and try again.')
  const row = await prisma.googleCalendarEvent.findUnique({ where: { id, organizationId: ctx.orgId }, include: { task: true } })
  await kick(id); return eventDto({ ...row, record: before.record ? { entityType: before.record.entityType, entityId: before.record.id, name: before.record.name } : null })
}
function desiredEvent(row) {
  return { id: eventId(row.id), summary: row.title, start: { dateTime: row.startAt.toISOString(), timeZone: row.timeZone }, end: { dateTime: row.endAt.toISOString(), timeZone: row.timeZone }, location: row.location || '',
    attendees: row.attendees.map((email) => ({ email })), reminders: { useDefault: false }, extendedProperties: { private: { techsyncOperation: row.id } },
    ...(row.includeMeet && !row.meetUrl && { conferenceData: { createRequest: { requestId: row.id, conferenceSolutionKey: { type: 'hangoutsMeet' } } } }) }
}
export async function syncCalendarEvent(id) {
  let row = await prisma.googleCalendarEvent.findUnique({ where: { id }, include: { calendar: { include: { connection: true } }, task: true, lead: true } })
  if (!row || ['cancelled', 'paused', 'conflict'].includes(row.status)) return
  const leaseToken = crypto.randomUUID(), now = new Date()
  if (!(await prisma.googleCalendarEvent.updateMany({ where: { id, revision: row.revision, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseToken, leaseUntil: new Date(Date.now() + 120000) } })).count) return
  const update = (data) => prisma.googleCalendarEvent.updateMany({ where: { id, organizationId: row.organizationId, revision: row.revision, leaseToken }, data })
  try {
    const connection = row.calendar.connection, ctx = await currentContext(row.organizationId, connection.userId)
    requirePermission(ctx, 'tasks.update')
    assertBinding(row, connection)
    const request = async (path, options) => {
      if (!(await update({ leaseUntil: new Date(Date.now() + 120000) })).count) throw googleError('GOOGLE_OPERATION_BUSY', 'The meeting changed during sync.')
      const fresh = await currentContext(ctx.orgId, ctx.userId)
      requirePermission(fresh, 'tasks.update')
      if (!cancel && row.task.entityType) await loadRecord(fresh, row.task.entityType, row.task.entityId)
      const task = await prisma.task.findUnique({ where: { id: row.taskId, organizationId: row.organizationId } })
      if (!cancel && (!task || task.updatedAt.getTime() !== row.task.updatedAt.getTime())) throw googleError('GOOGLE_TASK_CHANGED', 'The linked task changed during sync.')
      return resourceRequest(fresh, { ...connection, generation: row.connectionGeneration }, 'calendar', 'calendar', path, options)
    }
    const linked = row.task.entityType ? await prisma[RECORD_TYPES[row.task.entityType].model].findFirst({ where: { id: row.task.entityId, organizationId: row.organizationId }, select: { deletedAt: true } }) : undefined
    const cancel = row.task.entityType && (!linked || linked.deletedAt) || row.cancelRequested || row.task.deletedAt || row.task.status === 'cancelled' || row.task.assigneeId !== connection.userId || row.lead?.deletedAt
    if (!cancel && row.task.entityType) await loadRecord(ctx, row.task.entityType, row.task.entityId)
    if (!cancel && row.task.status === 'open' && (row.task.title !== row.title || row.task.dueAt?.getTime() !== row.startAt.getTime())) {
      if (!row.task.dueAt) { await update({ status: 'paused', lastError: 'GOOGLE_TASK_CHANGED' }); return }
      const duration = row.endAt - row.startAt, startAt = row.task.dueAt
      await update({ title: row.task.title, startAt, endAt: new Date(+startAt + duration), revision: { increment: 1 }, status: 'queued', nextAttemptAt: new Date() }); return
    }
    if (!cancel && row.status === 'ready' && row.syncedRevision === row.revision && row.meetStatus !== 'pending') { await update({ nextAttemptAt: new Date(Date.now() + 60000) }); return }
    if (row.calendar.status !== 'ready') throw googleError('GOOGLE_CALENDAR_REQUIRED', 'Calendar setup is required.')
    if (cancel) {
      try {
        const remote = await request(eventPath(row))
        if (remote.extendedProperties?.private?.techsyncOperation !== row.id) throw googleError('GOOGLE_REMOTE_CONFLICT', 'The Google event does not match this meeting.')
        if (!remote.etag) throw googleError('GOOGLE_REMOTE_CONFLICT', 'Google did not return an event version.')
        await request(eventPath(row), { method: 'DELETE', headers: { 'If-Match': remote.etag }, query: { sendUpdates: (remote.attendees || []).length ? 'all' : 'none' } })
      } catch (error) { if (error.code !== 'GOOGLE_REMOTE_NOT_FOUND') throw error }
      await update({ status: 'cancelled', cancelRequested: true, syncedRevision: row.revision, lastError: null }); return
    }
    let remote
    try { remote = await request(eventPath(row)) } catch (error) { if (error.code !== 'GOOGLE_REMOTE_NOT_FOUND') throw error }
    const desired = desiredEvent(row)
    if (!remote) {
      if (row.syncedRevision) { await update({ status: 'conflict', lastError: 'GOOGLE_REMOTE_NOT_FOUND' }); return }
      try { remote = await request(`calendars/${encodeURIComponent(row.calendar.providerCalendarId)}/events`, { method: 'POST', query: { conferenceDataVersion: 1, sendUpdates: row.attendees.length ? 'all' : 'none' }, body: desired }) }
      catch (error) { if (error.code !== 'GOOGLE_REMOTE_EXISTS') throw error; remote = await request(eventPath(row)) }
    } else {
      if (remote.extendedProperties?.private?.techsyncOperation !== row.id) throw googleError('GOOGLE_REMOTE_CONFLICT', 'This Google event no longer matches its CRM meeting.')
      if (!same(projection(remote), projection(desired))) {
        if (row.projection && !same(projection(remote), row.projection)) throw googleError('GOOGLE_REMOTE_CONFLICT', 'This meeting changed in Google Calendar. Review both versions.')
        if (!remote.etag) throw googleError('GOOGLE_REMOTE_CONFLICT', 'Google did not return an event version.')
        const { id: _id, ...body } = desired
        remote = await request(eventPath(row), { method: 'PATCH', query: { conferenceDataVersion: 1, sendUpdates: row.attendees.length || row.projection?.attendees?.length ? 'all' : 'none' }, headers: { 'If-Match': remote.etag }, body })
      }
    }
    const url = meetUrl(remote.hangoutLink || remote.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri)
    if (remote.extendedProperties?.private?.techsyncOperation !== row.id) throw googleError('GOOGLE_REMOTE_CONFLICT', 'This event does not match its CRM meeting.')
    const conference = remote.conferenceData?.createRequest?.status?.statusCode
    const meetFailed = conference === 'failure' || row.includeMeet && !url && Date.now() - row.createdAt.getTime() > 5 * 60000
    await update({ status: 'ready', syncedRevision: row.revision, etag: remote.etag || null, projection: projection(remote), meetUrl: url, meetStatus: !row.includeMeet ? 'none' : url ? 'ready' : meetFailed ? 'unavailable' : 'pending',
      attempts: 0, lastError: null, nextAttemptAt: new Date(Date.now() + (row.includeMeet && !url && !meetFailed ? 15000 : 60000)) })
    if (!row.syncedRevision) await auditGoogle(prisma, { orgId: row.organizationId, userId: connection.userId }, 'meeting_synced', { connectionId: connection.id, service: 'calendar' })
  } catch (error) {
    const code = safeCode(error), conflict = ['GOOGLE_REMOTE_CONFLICT', 'GOOGLE_REMOTE_EXISTS'].includes(code), paused = ['GOOGLE_ACCESS_DENIED', 'GOOGLE_ACCOUNT_CHANGED', 'GOOGLE_TASK_CHANGED', 'GOOGLE_RECONNECT_REQUIRED', 'GOOGLE_CONSENT_REQUIRED', 'GOOGLE_TENANT_DISABLED', 'GOOGLE_SERVICE_DISABLED'].includes(code)
    await update({ status: conflict ? 'conflict' : paused ? 'paused' : 'failed', lastError: code, attempts: { increment: 1 }, nextAttemptAt: retryAt(row.attempts) })
  } finally { await prisma.googleCalendarEvent.updateMany({ where: { id, organizationId: row.organizationId, leaseToken }, data: { leaseToken: null, leaseUntil: null } }) }
}
export async function recoverCalendarEvents() {
  const rows = await prisma.googleCalendarEvent.findMany({ where: { status: { in: ['queued', 'failed', 'ready'] }, nextAttemptAt: { lte: new Date() } }, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: 50, select: { id: true } })
  for (const row of rows) await syncCalendarEvent(row.id)
}
