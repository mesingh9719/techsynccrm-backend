import crypto from 'node:crypto'
import { notificationChannels } from '../config/notifications.js'
import { env } from '../config/env.js'
import { prisma } from '../db/prisma.js'
import { sendEmail } from '../email/mailer.js'
import { notificationSummaryEmail } from '../email/templates.js'
import { enqueue } from '../jobs/queue.js'
import { logger } from '../lib/logger.js'
import { dayBounds, digestDay, emailAllowedAt } from '../lib/notificationTime.js'
import { isoDateInTz } from '../lib/time.js'
import { notificationContext, notificationRecord } from './notificationAccess.service.js'
import { lockNotificationUser, notificationScope } from './notification.service.js'

const log = logger.child({ component: 'notifications' })
const DAY_MS = 86400000
const MAX_ATTEMPTS = 10

/** Reserve one durable batch for all the user's pending events, including later items in this window. */
export async function reserveNotificationBatch(orgId, userId, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    await lockNotificationUser(tx, orgId, userId)
    const scope = { organizationId: orgId, userId }
    const due = await tx.notification.findFirst({ where: { ...scope, emailPendingAt: { lte: now } }, select: { id: true } })
    if (!due) return null
    const rows = await tx.notification.findMany({ where: { ...scope, emailPendingAt: { not: null } }, orderBy: { createdAt: 'asc' }, take: 500, select: { id: true } })
    const ids = rows.map((r) => r.id)
    const batch = await tx.notificationEmailBatch.create({ data: { ...scope, kind: 'batch', key: crypto.randomUUID(), notificationIds: ids, availableAt: now } })
    await tx.notification.updateMany({ where: { ...scope, id: { in: ids } }, data: { emailPendingAt: null } })
    return batch
  })
}

/** Queued minute scan. Unsent batch rows survive API/worker restarts and queue outages. */
export async function queueNotificationEmails(now = new Date()) {
  const pending = await prisma.notification.findMany({ where: { emailPendingAt: { lte: now } }, select: { organizationId: true, userId: true }, take: 2000 })
  const recipients = new Map(pending.map((n) => [`${n.organizationId}:${n.userId}`, n]))
  for (const { organizationId, userId } of recipients.values()) await reserveNotificationBatch(organizationId, userId, now)
  const batches = await prisma.notificationEmailBatch.findMany({ where: { sentAt: null, attempts: { lt: MAX_ATTEMPTS }, availableAt: { lte: now }, OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }] }, select: { id: true }, orderBy: { availableAt: 'asc' }, take: 500 })
  for (const b of batches) await enqueue('notifications.deliver', { batchId: b.id })
  return { queued: batches.length }
}

export async function digestSections(ctx, now = new Date(), db = prisma) {
  const { start, end } = dayBounds(now, ctx.timezone)
  const [tasks, deals, mentions] = await Promise.all([
    db.task.findMany({ where: { organizationId: ctx.orgId, assigneeId: ctx.userId, status: 'open', deletedAt: null, dueAt: { lt: end } }, orderBy: { dueAt: 'asc' }, take: 200 }),
    db.deal.findMany({ where: { organizationId: ctx.orgId, ownerId: ctx.userId, deletedAt: null, status: 'open', stage: { rottingDays: { not: null } } }, include: { stage: true }, orderBy: { stageEnteredAt: 'asc' }, take: 200 }),
    db.notification.findMany({ where: { ...notificationScope(ctx), type: 'mention', inApp: true, readAt: null }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ])
  const sections = [{ label: 'Overdue tasks', items: [] }, { label: 'Today’s tasks', items: [] }, { label: 'Idle deals', items: [] }, { label: 'Unread mentions', items: [] }]
  for (const task of tasks) {
    if (!(await notificationRecord(ctx, { type: 'task_overdue_digest', entityType: 'task', entityId: task.id }, db, now))) continue
    const item = { title: task.title, body: new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', ...(!task.allDay && { timeStyle: 'short' }), timeZone: ctx.timezone }).format(task.dueAt), url: '/app/tasks' }
    // An already-overdue task appears once, including tasks that became overdue today.
    sections[task.dueAt < now ? 0 : task.dueAt >= start ? 1 : 0].items.push(item)
  }
  for (const deal of deals) {
    const last = Math.max(deal.lastActivityAt?.getTime() ?? 0, deal.stageEnteredAt.getTime())
    if (now.getTime() - last > deal.stage.rottingDays * DAY_MS) sections[2].items.push({ title: deal.title, url: `/app/deals/${deal.id}` })
  }
  for (const mention of mentions) {
    const record = await notificationRecord(ctx, mention, db, now)
    if (record) sections[3].items.push({ title: mention.title, body: record.name, url: mention.url })
  }
  return sections.filter((s) => s.items.length)
}

/** Once per workspace/user/local date, at or after 08:30; empty summaries do not send email. */
export async function queueNotificationDigests(now = new Date()) {
  let cursor
  let scheduled = 0
  for (;;) {
    const members = await prisma.membership.findMany({ where: { status: 'active', user: { digestEnabled: true, deletedAt: null }, organization: { deletedAt: null } }, orderBy: { id: 'asc' }, take: 200, ...(cursor && { cursor: { id: cursor }, skip: 1 }), select: { id: true, organizationId: true, userId: true, user: { select: { timezone: true } }, organization: { select: { timezone: true } } } })
    if (!members.length) break
    for (const member of members) {
      const key = digestDay(now, member.user.timezone || member.organization.timezone)
      if (!key) continue
      const created = await prisma.notificationEmailBatch.createMany({ data: [{ organizationId: member.organizationId, userId: member.userId, kind: 'digest', key, notificationIds: [], availableAt: now }], skipDuplicates: true })
      scheduled += created.count
    }
    cursor = members.at(-1).id
  }
  return { scheduled }
}

/** Runs as a pg-boss delivery job. SMTP is outside transactions; every retry rebuilds safe content. */
export async function deliverNotificationBatch(batchId, now = new Date()) {
  const batch = await prisma.notificationEmailBatch.findFirst({ where: { id: batchId, sentAt: null, availableAt: { lte: now }, attempts: { lt: MAX_ATTEMPTS } } })
  if (!batch) return { skipped: true }
  const claimed = await prisma.notificationEmailBatch.updateMany({ where: { id: batchId, organizationId: batch.organizationId, sentAt: null, availableAt: { lte: now }, attempts: batch.attempts, OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }] }, data: { claimedUntil: new Date(now.getTime() + 5 * 60_000), attempts: { increment: 1 } } })
  if (!claimed.count) return { skipped: true }
  try {
    const ctx = await notificationContext(batch.organizationId, batch.userId)
    let sections = []
    if (ctx) {
      const allowedAt = emailAllowedAt(now, ctx.user.quietHours, ctx.timezone)
      if (allowedAt > now) {
        await prisma.notificationEmailBatch.update({ where: { id: batchId }, data: { availableAt: allowedAt, claimedUntil: null, attempts: { decrement: 1 } } })
        return { deferred: true }
      }
      if (batch.kind === 'digest') {
        if (ctx.user.digestEnabled && batch.key === isoDateInTz(now, ctx.timezone)) sections = await digestSections(ctx, now)
      } else {
        const [rows, preferences] = await Promise.all([
          prisma.notification.findMany({ where: { ...notificationScope(ctx), id: { in: batch.notificationIds } }, orderBy: { createdAt: 'asc' } }),
          prisma.notificationPreference.findMany({ where: notificationScope(ctx) }),
        ])
        const prefs = new Map(preferences.map((p) => [p.type, p]))
        const items = []
        for (const row of rows) {
          if (!notificationChannels(row.type, prefs.get(row.type)).email) continue
          const record = await notificationRecord(ctx, row, prisma, now)
          if (record) items.push({ title: row.title, body: record.name || row.body, url: row.url, count: row.groupCount })
        }
        if (items.length) sections = [{ label: 'Updates for you', items }]
      }
      if (sections.length) await sendEmail({ to: ctx.user.email, ...notificationSummaryEmail({ name: ctx.user.fullName, organizationName: ctx.organization.name, digest: batch.kind === 'digest', sections, baseUrl: env.FRONTEND_URL }) })
    }
    await prisma.$transaction(async (tx) => {
      await tx.notificationEmailBatch.update({ where: { id: batchId, organizationId: batch.organizationId }, data: { sentAt: new Date(), claimedUntil: null, lastError: null } })
      if (batch.notificationIds.length && sections.length) await tx.notification.updateMany({ where: { organizationId: batch.organizationId, userId: batch.userId, id: { in: batch.notificationIds } }, data: { emailedAt: new Date() } })
    })
    return { sent: sections.length > 0 }
  } catch (err) {
    await prisma.notificationEmailBatch.update({ where: { id: batchId, organizationId: batch.organizationId }, data: { claimedUntil: null, availableAt: new Date(now.getTime() + Math.min(900, 30 * 2 ** batch.attempts) * 1000), lastError: String(err.message).slice(0, 1000) } })
    log.warn({ batchId, err }, 'notification delivery will retry')
    throw err
  }
}

export async function cleanupNotifications(now = new Date()) {
  const deleted = await prisma.notification.deleteMany({ where: { OR: [{ readAt: { lt: new Date(now.getTime() - 90 * DAY_MS) } }, { readAt: null, createdAt: { lt: new Date(now.getTime() - 180 * DAY_MS) } }] } })
  await prisma.notificationReceipt.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 180 * DAY_MS) } } })
  await prisma.notificationEmailBatch.deleteMany({ where: { sentAt: { lt: new Date(now.getTime() - 90 * DAY_MS) } } })
  await prisma.notificationStreamTicket.deleteMany({ where: { expiresAt: { lt: now } } })
  return deleted
}
