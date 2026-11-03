import { prisma } from '../db/prisma.js'
import { env } from '../config/env.js'
import { hasPermission } from '../config/permissions.js'
import { planHasFeature } from '../config/plans.js'
import { queueEmail } from '../email/mailer.js'
import { reportSummaryEmail } from '../email/templates.js'
import { logger } from '../lib/logger.js'
import { formatMoney } from '../lib/money.js'
import { DEFAULT_TZ, isoDateInTz, zonedParts } from '../lib/time.js'
import { assertFeature, hasFeature } from './entitlements.service.js'
import { notificationContext } from './notificationAccess.service.js'
import { firstResponse, followUps, kpis, leaderboard, leadsBySource, ownerIds } from './report.service.js'

/**
 * Emailed report summaries (M15, Growth plan and above). Each member subscribes themselves, so a
 * summary never shows more than the recipient could open in Reports. The hourly job sends each
 * due period once from 08:00 in the workspace time zone; `lastPeriodKey` is the idempotency claim.
 */

export const FREQUENCIES = ['weekly', 'monthly']
const SEND_FROM_HOUR = 8
const log = logger.child({ component: 'report-schedules' })
const DAY = 86_400_000
const shiftDay = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10)
const label = (iso, options) => new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', ...options }).format(new Date(`${iso}T12:00:00Z`))

/** The last complete period for a frequency, its claim key and whether it is due to send. */
export function periodFor(frequency, now = new Date(), tz = DEFAULT_TZ) {
  const today = isoDateInTz(now, tz)
  const due = zonedParts(now, tz).hour >= SEND_FROM_HOUR
  if (frequency === 'weekly') {
    const monday = shiftDay(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7))
    const from = shiftDay(monday, -7), to = shiftDay(monday, -1)
    return { key: from, from, to, due, label: `last week (${label(from, { day: 'numeric', month: 'short' })} – ${label(to, { day: 'numeric', month: 'short' })})` }
  }
  const first = `${today.slice(0, 7)}-01`
  const to = shiftDay(first, -1), from = `${to.slice(0, 7)}-01`
  return { key: from.slice(0, 7), from, to, due, label: `in ${label(from, { month: 'long', year: 'numeric' })}` }
}

const cleanFilters = (filters) => Object.fromEntries(Object.entries(filters ?? {}).filter(([k, v]) => ['ownerId', 'sourceId'].includes(k) && typeof v === 'string' && v))

export async function listSchedules(ctx) {
  const rows = await prisma.reportSchedule.findMany({
    where: { organizationId: ctx.orgId, userId: ctx.userId },
    select: { frequency: true, enabled: true, filters: true, lastSentAt: true },
  })
  return {
    available: hasFeature(ctx, 'scheduledReports'),
    schedules: FREQUENCIES.map((frequency) => {
      const row = rows.find((r) => r.frequency === frequency)
      return { frequency, enabled: Boolean(row?.enabled), filters: row?.filters ?? {}, lastSentAt: row?.lastSentAt ?? null }
    }),
  }
}

/** Subscribes or unsubscribes the caller. Filters are checked against the caller's report scope now and at each send. */
export async function saveSchedule(ctx, frequency, { enabled, filters }) {
  if (enabled) assertFeature(ctx, 'scheduledReports')
  const clean = cleanFilters(filters)
  ownerIds(ctx, clean.ownerId)
  await prisma.reportSchedule.upsert({
    where: { organizationId_userId_frequency: { organizationId: ctx.orgId, userId: ctx.userId, frequency } },
    update: { enabled, filters: clean },
    create: { organizationId: ctx.orgId, userId: ctx.userId, frequency, enabled, filters: clean },
  })
  return listSchedules(ctx)
}

/** The figures in one summary email, computed with the recipient's scope. */
export async function buildSummary(ctx, query) {
  const currency = ctx.currency ?? 'INR'
  const money = (minor) => formatMoney(BigInt(minor), currency)
  const [tiles, sources, team, response, tasks] = await Promise.all([
    kpis(ctx, query),
    leadsBySource(ctx, query),
    leaderboard(ctx, query),
    firstResponse(ctx, query),
    followUps(ctx, query),
  ])
  return {
    kpis: tiles,
    sources: sources.slice(0, 5).map((s) => ({ label: s.source, value: `${s.leads} leads · ${money(s.revenueMinor)}` })),
    // A single-person scope makes the team table redundant with the KPIs.
    team: team.length > 1 ? team.slice(0, 5).map((t) => ({ label: t.name, value: `${money(t.revenueMinor)} · ${t.dealsWon} won` })) : [],
    followUps: [
      { label: 'Median first response', value: response.medianMinutes === null ? '—' : `${response.medianMinutes} min` },
      { label: 'Enquiries without a response', value: String(response.unresponded) },
      { label: 'On-time follow-ups', value: tasks.compliancePercent === null ? '—' : `${tasks.compliancePercent}%` },
      { label: 'Overdue tasks now', value: String(tasks.overdueNow) },
    ],
  }
}

/** Hourly job: sends every due, unsent summary. Returns counts for the job log. */
export async function sendScheduledReports(now = new Date()) {
  const schedules = await prisma.reportSchedule.findMany({
    where: { enabled: true, organization: { deletedAt: null } },
    select: {
      id: true, organizationId: true, userId: true, frequency: true, filters: true, lastPeriodKey: true,
      organization: { select: { name: true, timezone: true, currency: true, plan: true } },
    },
    take: 2000,
  })
  let sent = 0, skipped = 0
  for (const s of schedules) {
    const org = s.organization
    const period = periodFor(s.frequency, now, org.timezone)
    if (!period.due || s.lastPeriodKey === period.key) continue
    if (!planHasFeature(org.plan, 'scheduledReports')) { skipped++; continue }
    const access = await notificationContext(s.organizationId, s.userId)
    if (!access || !hasPermission(access.permissions, 'reports.read')) { skipped++; continue }
    const ctx = { orgId: s.organizationId, userId: s.userId, permissions: access.permissions, managedUserIds: access.managedUserIds, timezone: org.timezone, currency: org.currency, plan: org.plan, actorType: 'system' }
    const filters = cleanFilters(s.filters)
    let summary
    try {
      summary = await buildSummary(ctx, { ...filters, from: period.from, to: period.to })
    } catch (err) {
      // A saved owner filter outside the recipient's current scope is skipped, not widened.
      log.warn({ err, scheduleId: s.id }, 'scheduled report could not be built')
      skipped++
      continue
    }
    const claimed = await prisma.reportSchedule.updateMany({
      where: { id: s.id, enabled: true, OR: [{ lastPeriodKey: null }, { lastPeriodKey: { not: period.key } }] },
      data: { lastPeriodKey: period.key, lastSentAt: now },
    })
    if (claimed.count !== 1) continue
    const params = new URLSearchParams({ from: period.from, to: period.to, ...filters })
    await queueEmail({
      to: access.user.email,
      ...reportSummaryEmail({
        name: access.user.fullName || access.user.email,
        organizationName: org.name,
        frequency: s.frequency,
        periodLabel: period.label,
        ...summary,
        reportUrl: `${env.FRONTEND_URL}/app/reports?${params}`,
        settingsUrl: `${env.FRONTEND_URL}/app/reports?tab=overview`,
      }),
    })
    sent++
  }
  return { checked: schedules.length, sent, skipped }
}
