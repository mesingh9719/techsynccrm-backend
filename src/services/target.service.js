import { prisma } from '../db/prisma.js'
import { scopeFor } from '../config/permissions.js'
import { dateRange } from '../lib/records.js'
import { DEFAULT_TZ } from '../lib/time.js'
import { minorToJson } from '../lib/money.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from '../utils/ApiError.js'
import { ownerIds } from './report.service.js'

/**
 * Monthly sales targets (M15): revenue (workspace currency, minor units) and deals won, per member.
 * Team and workspace targets are sums of member targets. Reports prorate a month's target by the
 * days of that month inside the selected period.
 */

export const TARGET_METRICS = ['revenue', 'deals_won']
const DAY = 86_400_000
const monthDate = (month) => new Date(`${month}-01T00:00:00Z`)
const daysInMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()
const toTime = (iso) => Date.parse(`${iso}T12:00:00Z`)

/** Months touched by from..to, each with the share of its days inside the period. */
export function periodMonths(from, to) {
  const out = []
  for (let month = from.slice(0, 7); month <= to.slice(0, 7); ) {
    const first = `${month}-01`
    const last = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`
    const start = from > first ? from : first
    const end = to < last ? to : last
    out.push({ month, fraction: (Math.round((toTime(end) - toTime(start)) / DAY) + 1) / daysInMonth(month) })
    const d = monthDate(month)
    d.setUTCMonth(d.getUTCMonth() + 1)
    month = d.toISOString().slice(0, 7)
  }
  return out
}

/** userId → { revenueMinor, dealsWon } prorated to from..to; members without targets are absent. */
export async function targetsFor(orgId, userIds, from, to) {
  const months = periodMonths(from, to)
  if (!userIds.length || !months.length) return new Map()
  const share = new Map(months.map((m) => [m.month, m.fraction]))
  const rows = await prisma.salesTarget.findMany({
    where: { organizationId: orgId, userId: { in: userIds }, month: { in: months.map((m) => monthDate(m.month)) } },
    select: { userId: true, month: true, metric: true, amount: true },
  })
  const totals = new Map()
  for (const r of rows) {
    const t = totals.get(r.userId) ?? { revenue: 0, deals_won: 0, has: new Set() }
    t[r.metric] += Number(r.amount) * share.get(r.month.toISOString().slice(0, 7))
    t.has.add(r.metric)
    totals.set(r.userId, t)
  }
  return new Map(
    [...totals].map(([userId, t]) => [
      userId,
      { revenueMinor: t.has.has('revenue') ? Math.round(t.revenue) : null, dealsWon: t.has.has('deals_won') ? Math.round(t.deals_won * 10) / 10 : null },
    ]),
  )
}

/** Members whose targets the caller may set: everyone (owner/admin) or their team and themselves (manager). */
function manageableIds(ctx) {
  const scope = scopeFor(ctx.permissions, 'targets', 'manage')
  if (!scope) return []
  return scope === 'all' ? null : [ctx.userId, ...(ctx.managedUserIds ?? [])]
}

/** Targets and month-to-date results for every member the caller can report on. */
export async function listTargets(ctx, month) {
  const allowed = ownerIds(ctx)
  const manageable = manageableIds(ctx)
  const members = await prisma.membership.findMany({
    where: { organizationId: ctx.orgId, status: 'active', ...(allowed ? { userId: { in: allowed } } : {}) },
    select: { userId: true, role: true, user: { select: { fullName: true, email: true } } },
    orderBy: { user: { fullName: 'asc' } },
    take: 500,
  })
  const ids = members.map((m) => m.userId)
  const range = dateRange(`${month}-01`, `${month}-${String(daysInMonth(month)).padStart(2, '0')}`, ctx.timezone ?? DEFAULT_TZ)
  const [targets, won] = await Promise.all([
    prisma.salesTarget.findMany({ where: { organizationId: ctx.orgId, month: monthDate(month), userId: { in: ids } }, select: { userId: true, metric: true, amount: true } }),
    prisma.deal.groupBy({
      by: ['ownerId'],
      where: { organizationId: ctx.orgId, deletedAt: null, status: 'won', currency: ctx.currency ?? 'INR', wonAt: range, ownerId: { in: ids } },
      _sum: { valueMinor: true },
      _count: { _all: true },
    }),
  ])
  const targetOf = (userId, metric) => targets.find((t) => t.userId === userId && t.metric === metric)?.amount ?? null
  const wonBy = new Map(won.map((w) => [w.ownerId, w]))
  return {
    month,
    currency: ctx.currency ?? 'INR',
    members: members.map((m) => {
      const revenueTarget = targetOf(m.userId, 'revenue')
      const dealsTarget = targetOf(m.userId, 'deals_won')
      return {
        userId: m.userId,
        name: m.user.fullName || m.user.email,
        role: m.role,
        canEdit: manageable === null || manageable.includes(m.userId),
        revenueTargetMinor: revenueTarget === null ? null : minorToJson(revenueTarget),
        dealsTarget: dealsTarget === null ? null : Number(dealsTarget),
        revenueMinor: minorToJson(wonBy.get(m.userId)?._sum.valueMinor ?? 0n),
        dealsWon: wonBy.get(m.userId)?._count._all ?? 0,
      }
    }),
  }
}

/**
 * Sets (or clears, with null) one month's targets. Every member must be active in the workspace
 * and inside the caller's target scope; the whole save is rejected otherwise.
 */
export async function saveTargets(ctx, { month, targets }) {
  const manageable = manageableIds(ctx)
  if (manageable && !manageable.length) throw new ApiError(403, 'You don’t have permission to set targets.', { code: 'FORBIDDEN' })
  const ids = [...new Set(targets.map((t) => t.userId))]
  const active = await prisma.membership.count({ where: { organizationId: ctx.orgId, status: 'active', userId: { in: ids } } })
  if (active !== ids.length) throw ApiError.badRequest('Targets can only be set for active members of this workspace.')
  if (manageable && ids.some((id) => !manageable.includes(id))) throw new ApiError(403, 'You can only set targets for yourself and your team.', { code: 'FORBIDDEN' })
  const date = monthDate(month)
  await prisma.$transaction(async (tx) => {
    for (const t of targets) {
      for (const [metric, value] of [['revenue', t.revenueMinor], ['deals_won', t.dealsWon]]) {
        if (value === undefined) continue
        const key = { organizationId_userId_month_metric: { organizationId: ctx.orgId, userId: t.userId, month: date, metric } }
        if (value === null) await tx.salesTarget.deleteMany({ where: { organizationId: ctx.orgId, userId: t.userId, month: date, metric } })
        else await tx.salesTarget.upsert({ where: key, update: { amount: BigInt(value) }, create: { organizationId: ctx.orgId, userId: t.userId, month: date, metric, amount: BigInt(value), createdById: ctx.userId } })
      }
    }
    await recordAudit(tx, ctx, { action: 'targets.update', entityType: 'organization', entityId: ctx.orgId, changes: { month, members: ids.length } })
  })
  return listTargets(ctx, month)
}
