import { prisma } from '../db/prisma.js'
import { Prisma } from '../generated/prisma/client.js'
import { scopeFor } from '../config/permissions.js'
import { dateRange } from '../lib/records.js'
import { DEFAULT_TZ, isoDateInTz } from '../lib/time.js'
import { divideHalfEven, minorToJson } from '../lib/money.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * Standard reports (M15) behind the dashboard and /app/reports. Metric definitions follow
 * docs/modules/M15-dashboards-reports.md §3; periods are whole days in the workspace time zone.
 *
 * The funnel uses the existing transactional, retained status events, including both sides of
 * a transition. No invented history/backfill for records without events. Targets/schedules remain
 * separate M15 work. All queries aggregate in Postgres rather than loading the workspace into JS.
 */

const ACTIVITY_TYPES = ['call', 'meeting', 'site_visit', 'whatsapp', 'email', 'sms']
const DAY = 86_400_000

// ---------- Scope & filters ----------

/** Owner ids the caller may report on (null = everyone), narrowed by an `ownerId` filter. */
function ownerIds(ctx, ownerId) {
  const scope = scopeFor(ctx.permissions, 'reports', 'read')
  if (!scope) throw new ApiError(403, 'You don’t have permission to view reports.', { code: 'FORBIDDEN' })
  let allowed = scope === 'all' ? null : scope === 'team' ? [ctx.userId, ...(ctx.managedUserIds ?? [])] : [ctx.userId]
  if (ctx.forExport) {
    const exportScope = scopeFor(ctx.permissions, 'records', 'export')
    if (!exportScope) throw new ApiError(403, 'You don’t have permission to export reports.', { code: 'FORBIDDEN' })
    const exportIds = exportScope === 'all' ? null : exportScope === 'team' ? [ctx.userId, ...(ctx.managedUserIds ?? [])] : [ctx.userId]
    if (exportIds) allowed = allowed ? allowed.filter((id) => exportIds.includes(id)) : exportIds
  }
  if (!ownerId) return allowed
  const wanted = ownerId === 'me' ? ctx.userId : ownerId
  if (allowed && !allowed.includes(wanted)) throw new ApiError(403, 'You can only report on your own or your team’s records.', { code: 'FORBIDDEN' })
  return [wanted]
}

const ownerWhere = (ids, field = 'ownerId') => (ids ? { [field]: { in: ids } } : {})
const sourceWhere = (sourceId) => (!sourceId ? {} : { sourceId: sourceId === 'none' ? null : sourceId })

/** The selected period and the previous period of equal length, as UTC ranges. */
function periods({ from, to }, tz) {
  const days = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY) + 1
  const shift = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10)
  const prevTo = shift(from, -1)
  return { current: dateRange(from, to, tz), previous: dateRange(shift(prevTo, -(days - 1)), prevTo, tz) }
}

function filters(ctx, query) {
  const tz = ctx.timezone ?? DEFAULT_TZ
  return { tz, owners: ownerIds(ctx, query.ownerId), includeUnowned: !ctx.forExport && !query.ownerId, sourceId: query.sourceId, ...periods(query, tz) }
}

const leadOwners = (f) => f.owners && f.includeUnowned ? { OR: [ownerWhere(f.owners), { ownerId: null }] } : ownerWhere(f.owners)
const leadBase = (ctx, f) => ({ organizationId: ctx.orgId, deletedAt: null, status: { not: 'junk' }, ...leadOwners(f), ...sourceWhere(f.sourceId) })
// Revenue is reported in the workspace currency; deals in other currencies aren't converted.
const dealBase = (ctx, f) => ({ organizationId: ctx.orgId, deletedAt: null, currency: ctx.currency ?? 'INR', ...ownerWhere(f.owners), ...sourceWhere(f.sourceId) })
const sum = (agg) => minorToJson(agg._sum.valueMinor ?? 0n)
const ownerSql = (f, alias, unowned = false) => !f.owners ? Prisma.empty : Prisma.sql`AND (${Prisma.raw(alias)}.owner_id = ANY(${f.owners}::uuid[]) ${unowned && f.includeUnowned ? Prisma.sql`OR ${Prisma.raw(alias)}.owner_id IS NULL` : Prisma.empty})`
const sourceSql = (f, alias) => !f.sourceId ? Prisma.empty : f.sourceId === 'none' ? Prisma.sql`AND ${Prisma.raw(alias)}.source_id IS NULL` : Prisma.sql`AND ${Prisma.raw(alias)}.source_id = ${f.sourceId}::uuid`
const leadSql = (ctx, f, alias = 'l') => Prisma.sql`${Prisma.raw(alias)}.organization_id = ${ctx.orgId}::uuid AND ${Prisma.raw(alias)}.deleted_at IS NULL AND ${Prisma.raw(alias)}.status <> 'junk' ${ownerSql(f, alias, true)} ${sourceSql(f, alias)}`
const dealSql = (ctx, f, alias = 'd') => Prisma.sql`${Prisma.raw(alias)}.organization_id = ${ctx.orgId}::uuid AND ${Prisma.raw(alias)}.deleted_at IS NULL AND ${Prisma.raw(alias)}.currency = ${ctx.currency ?? 'INR'} ${ownerSql(f, alias)} ${sourceSql(f, alias)}`
/** KPI tiles show whole rupees (₹26,000), not paise. */
const money = (minor, currency) => new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100)

// ---------- Metrics ----------

async function leadCohort(ctx, f, range) {
  const where = { ...leadBase(ctx, f), createdAt: range }
  const [total, converted] = await Promise.all([prisma.lead.count({ where }), prisma.lead.count({ where: { ...where, status: 'converted' } })])
  return { total, converted, rate: total ? (converted / total) * 100 : null }
}

async function dealResults(ctx, f, range) {
  const base = dealBase(ctx, f)
  const [won, lost] = await Promise.all([
    prisma.deal.aggregate({ where: { ...base, status: 'won', wonAt: range }, _sum: { valueMinor: true }, _count: { _all: true } }),
    prisma.deal.count({ where: { ...base, status: 'lost', closedAt: range } }),
  ])
  const wonCount = won._count._all
  return { revenue: sum(won), won: wonCount, lost, winRate: wonCount + lost ? (wonCount / (wonCount + lost)) * 100 : null }
}

const pct = (value, previous) => (previous ? `${value >= previous ? '+' : '−'}${Math.abs(((value - previous) / previous) * 100).toFixed(1)}%` : '—')
const points = (value, previous) => (value === null || previous === null ? '—' : `${value >= previous ? '+' : '−'}${Math.abs(value - previous).toFixed(1)} pp`)

export async function kpis(ctx, query) {
  const f = filters(ctx, query)
  const currency = ctx.currency ?? 'INR'
  const [leads, prevLeads, deals, prevDeals] = await Promise.all([leadCohort(ctx, f, f.current), leadCohort(ctx, f, f.previous), dealResults(ctx, f, f.current), dealResults(ctx, f, f.previous)])
  const avg = deals.won ? minorToJson(divideHalfEven(BigInt(deals.revenue), BigInt(deals.won))) : 0
  const prevAvg = prevDeals.won ? minorToJson(divideHalfEven(BigInt(prevDeals.revenue), BigInt(prevDeals.won))) : 0
  return [
    { key: 'leads', label: 'New leads', value: String(leads.total), delta: pct(leads.total, prevLeads.total), positive: leads.total >= prevLeads.total, context: 'vs previous period' },
    { key: 'revenue', label: 'Revenue won', value: money(deals.revenue, currency), valueMinor: deals.revenue, delta: pct(deals.revenue, prevDeals.revenue), positive: deals.revenue >= prevDeals.revenue, context: 'vs previous period' },
    { key: 'conversion', label: 'Lead conversion', value: leads.rate === null ? '—' : `${leads.rate.toFixed(1)}%`, delta: points(leads.rate, prevLeads.rate), positive: (leads.rate ?? 0) >= (prevLeads.rate ?? 0), context: 'vs previous cohort' },
    { key: 'winRate', label: 'Deal win rate', value: deals.winRate === null ? '—' : `${Math.round(deals.winRate)}%`, delta: points(deals.winRate, prevDeals.winRate), positive: (deals.winRate ?? 0) >= (prevDeals.winRate ?? 0), context: 'won / closed deals in period' },
    { key: 'avgDeal', label: 'Avg. deal size', value: deals.won ? money(avg, currency) : '—', valueMinor: avg, delta: pct(avg, prevAvg), positive: avg >= prevAvg, context: 'vs previous period' },
  ]
}

/** Won revenue per calendar month (workspace time zone), the last `months` months up to `to`. */
export async function revenueSeries(ctx, query) {
  const f = filters(ctx, query)
  const [year, month] = query.to.split('-').map(Number)
  const [fromYear, fromMonth] = query.from.split('-').map(Number)
  // Wider custom ranges still reconcile with the KPI total; pad short ranges to 12 months.
  const months = Math.max(query.months ?? 12, (year - fromYear) * 12 + month - fromMonth + 1)
  const labels = Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(year, month - 1 - (months - 1 - i), 1))
    return d.toISOString().slice(0, 7)
  })
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT to_char(d.won_at AT TIME ZONE ${f.tz}, 'YYYY-MM') AS period,
           SUM(d.value_minor)::bigint AS total
    FROM deals d WHERE ${dealSql(ctx, f)} AND d.status = 'won'
      AND d.won_at >= ${f.current.gte} AND d.won_at <= ${f.current.lte}
    GROUP BY period`)
  const totals = new Map(labels.map((l) => [l, 0]))
  for (const r of rows) {
    if (totals.has(r.period)) totals.set(r.period, minorToJson(r.total))
  }
  return labels.map((period) => ({ period, valueMinor: totals.get(period) }))
}

/** New leads, converted leads and won revenue per source for the period. */
export async function leadsBySource(ctx, query) {
  const f = filters(ctx, query)
  const where = { ...leadBase(ctx, f), createdAt: f.current }
  const [all, converted, revenue] = await Promise.all([
    prisma.lead.groupBy({ by: ['sourceId'], where, _count: { _all: true } }),
    prisma.lead.groupBy({ by: ['sourceId'], where: { ...where, status: 'converted' }, _count: { _all: true } }),
    prisma.deal.groupBy({ by: ['sourceId'], where: { ...dealBase(ctx, f), status: 'won', wonAt: f.current }, _sum: { valueMinor: true } }),
  ])
  const ids = [...new Set([...all, ...revenue].map((r) => r.sourceId).filter(Boolean))]
  const names = new Map((await prisma.leadSource.findMany({ where: { organizationId: ctx.orgId, id: { in: ids } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]))
  const rows = new Map()
  const row = (id) => {
    const key = id ?? 'none'
    if (!rows.has(key)) rows.set(key, { sourceId: key, source: id ? (names.get(id) ?? 'Removed source') : 'No source', leads: 0, converted: 0, revenueMinor: 0 })
    return rows.get(key)
  }
  for (const r of all) row(r.sourceId).leads = r._count._all
  for (const r of converted) row(r.sourceId).converted = r._count._all
  for (const r of revenue) row(r.sourceId).revenueMinor = minorToJson(r._sum.valueMinor ?? 0n)
  return [...rows.values()].sort((a, b) => b.leads - a.leads || b.revenueMinor - a.revenueMinor)
}

/**
 * Leads created in the period and the highest progress evidenced by current state, timestamps
 * or retained transactional status events. Reopening/loss does not erase an earlier milestone.
 */
export async function funnel(ctx, query) {
  const f = filters(ctx, query)
  const [counts] = await prisma.$queryRaw(Prisma.sql`
    WITH cohort AS MATERIALIZED (
      SELECT l.id, l.status, l.first_responded_at, l.converted_at, l.converted_deal_id
      FROM leads l WHERE ${leadSql(ctx, f)} AND l.created_at >= ${f.current.gte} AND l.created_at <= ${f.current.lte}
    ), progress AS (
      SELECT e.entity_id, MAX(CASE WHEN jsonb_typeof(e.payload->'changes'->'status') = 'array' THEN
        CASE WHEN (e.payload->'changes'->'status') ? 'converted' THEN 3
          WHEN (e.payload->'changes'->'status') ? 'qualified' THEN 2
          WHEN (e.payload->'changes'->'status') ? 'contacted' THEN 1 ELSE 0 END ELSE 0 END) AS reached
      FROM domain_events e JOIN cohort c ON c.id = e.entity_id
      WHERE e.organization_id = ${ctx.orgId}::uuid AND e.entity_type = 'lead'
        AND e.type IN ('lead.status_changed', 'lead.converted') GROUP BY e.entity_id
    )
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE c.first_responded_at IS NOT NULL OR p.reached >= 1 OR c.status IN ('contacted','qualified','converted'))::int AS contacted,
      COUNT(*) FILTER (WHERE p.reached >= 2 OR c.status IN ('qualified','converted'))::int AS qualified,
      COUNT(*) FILTER (WHERE c.converted_at IS NOT NULL OR p.reached >= 3 OR c.status = 'converted')::int AS converted,
      COUNT(*) FILTER (WHERE d.id IS NOT NULL)::int AS won
    FROM cohort c LEFT JOIN progress p ON p.entity_id = c.id
    LEFT JOIN deals d ON d.id = c.converted_deal_id AND ${dealSql(ctx, f)} AND d.status = 'won'`)
  return [
    { stage: 'New enquiries', count: counts.total },
    { stage: 'Contacted', count: counts.contacted },
    { stage: 'Qualified', count: counts.qualified },
    { stage: 'Converted', count: counts.converted },
    { stage: 'Deal won', count: counts.won },
  ]
}

/** Per active member in scope: revenue and deals won, win rate, activities logged. */
export async function leaderboard(ctx, query) {
  const f = filters(ctx, query)
  const members = await prisma.membership.findMany({
    where: { organizationId: ctx.orgId, status: 'active', ...ownerWhere(f.owners, 'userId') },
    select: { userId: true, user: { select: { fullName: true, email: true } } },
    take: 501,
    orderBy: { userId: 'asc' },
  })
  if (members.length > 500) throw new ApiError(400, 'Choose an owner to report on a team with more than 500 members.', { code: 'VALIDATION_ERROR' })
  const ids = members.map((m) => m.userId)
  if (!ids.length) return []
  const base = { ...dealBase(ctx, f), ownerId: { in: ids } }
  const [won, lost, activities] = await Promise.all([
    prisma.deal.groupBy({ by: ['ownerId'], where: { ...base, status: 'won', wonAt: f.current }, _sum: { valueMinor: true }, _count: { _all: true } }),
    prisma.deal.groupBy({ by: ['ownerId'], where: { ...base, status: 'lost', closedAt: f.current }, _count: { _all: true } }),
    prisma.$queryRaw(Prisma.sql`
      SELECT a.actor_id AS "actorId", COUNT(*)::int AS count FROM activities a
      WHERE a.organization_id = ${ctx.orgId}::uuid AND a.deleted_at IS NULL
        AND a.actor_id = ANY(${ids}::uuid[]) AND a.type::text = ANY(${ACTIVITY_TYPES}::text[])
        AND a.occurred_at >= ${f.current.gte} AND a.occurred_at <= ${f.current.lte}
        AND EXISTS (SELECT 1 FROM activity_links al WHERE al.organization_id = ${ctx.orgId}::uuid
          AND al.activity_id = a.id AND (
            (al.entity_type = 'lead' AND EXISTS (SELECT 1 FROM leads l WHERE l.id = al.entity_id AND ${leadSql(ctx, f)}))
            OR (al.entity_type = 'deal' AND EXISTS (SELECT 1 FROM deals d WHERE d.id = al.entity_id AND ${dealSql(ctx, f)}))
            ${!f.sourceId ? Prisma.sql`OR (al.entity_type = 'contact' AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = al.entity_id AND c.organization_id = ${ctx.orgId}::uuid AND c.deleted_at IS NULL ${ownerSql(f, 'c', true)}))
              OR (al.entity_type = 'company' AND EXISTS (SELECT 1 FROM companies c WHERE c.id = al.entity_id AND c.organization_id = ${ctx.orgId}::uuid AND c.deleted_at IS NULL ${ownerSql(f, 'c', true)}))` : Prisma.empty}
          )) GROUP BY a.actor_id`),
  ])
  const by = (rows, field = 'ownerId') => new Map(rows.map((r) => [r[field], r]))
  const wonBy = by(won), lostBy = by(lost), actBy = by(activities, 'actorId')
  return members
    .map((m) => {
      const w = wonBy.get(m.userId)
      const dealsWon = w?._count._all ?? 0
      const dealsLost = lostBy.get(m.userId)?._count._all ?? 0
      return {
        ownerId: m.userId,
        name: m.user.fullName || m.user.email,
        revenueMinor: minorToJson(w?._sum.valueMinor ?? 0n),
        dealsWon,
        winRate: dealsWon + dealsLost ? Math.round((dealsWon / (dealsWon + dealsLost)) * 100) : 0,
        activities: actBy.get(m.userId)?.count ?? 0,
        targetMinor: null,
      }
    })
    .sort((a, b) => b.revenueMinor - a.revenueMinor || b.dealsWon - a.dealsWon || b.activities - a.activities)
}

/** Default period when none is given: the last 30 days in the workspace time zone. */
export function defaultPeriod(tz = DEFAULT_TZ) {
  const to = isoDateInTz(new Date(), tz)
  return { from: new Date(Date.parse(`${to}T12:00:00Z`) - 29 * DAY).toISOString().slice(0, 10), to }
}

/** Median wall-clock first response for the selected lead cohort; no response is not zero. */
export async function firstResponse(ctx, query) {
  const f = filters(ctx, query)
  const [row] = await prisma.$queryRaw(Prisma.sql`
    WITH cohort AS (SELECT CASE WHEN l.first_responded_at >= l.created_at
      THEN EXTRACT(EPOCH FROM l.first_responded_at - l.created_at) / 60.0 ELSE NULL END AS minutes
      FROM leads l WHERE ${leadSql(ctx, f)} AND l.created_at >= ${f.current.gte} AND l.created_at <= ${f.current.lte})
    SELECT COUNT(*)::int AS total, COUNT(minutes)::int AS responded,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes)::float8 AS median,
      COUNT(*) FILTER (WHERE minutes <= 5)::int AS fast,
      COUNT(*) FILTER (WHERE minutes > 5 AND minutes <= 30)::int AS normal,
      COUNT(*) FILTER (WHERE minutes > 30)::int AS slow FROM cohort`)
  return { total: row.total, responded: row.responded, unresponded: row.total - row.responded,
    medianMinutes: row.median === null ? null : Math.round(row.median * 10) / 10,
    buckets: [{ label: 'Within 5 minutes', count: row.fast }, { label: '5–30 minutes', count: row.normal }, { label: 'Over 30 minutes', count: row.slow }] }
}

/** Task compliance by due-date cohort, plus the current backlog. Only readable linked records count. */
export async function followUps(ctx, query, now = new Date()) {
  const f = filters(ctx, query)
  const [row] = await prisma.$queryRaw(Prisma.sql`
    WITH readable AS (
      SELECT 'lead' AS type, l.id FROM leads l WHERE ${leadSql(ctx, f)}
      UNION ALL SELECT 'deal', d.id FROM deals d WHERE ${dealSql(ctx, f)}
      ${!f.sourceId ? Prisma.sql`UNION ALL SELECT 'contact', c.id FROM contacts c WHERE c.organization_id = ${ctx.orgId}::uuid AND c.deleted_at IS NULL ${ownerSql(f, 'c', true)}
        UNION ALL SELECT 'company', c.id FROM companies c WHERE c.organization_id = ${ctx.orgId}::uuid AND c.deleted_at IS NULL ${ownerSql(f, 'c', true)}` : Prisma.empty}
    ), visible AS (
      SELECT t.status, t.due_at, t.completed_at FROM tasks t
      LEFT JOIN readable r ON r.type = t.entity_type AND r.id = t.entity_id
      WHERE t.organization_id = ${ctx.orgId}::uuid AND t.deleted_at IS NULL
      ${f.owners ? Prisma.sql`AND (t.assignee_id = ANY(${f.owners}::uuid[]) ${!query.ownerId && !ctx.forExport ? Prisma.sql`OR t.created_by_id = ${ctx.userId}::uuid` : Prisma.empty})` : Prisma.empty}
      AND (r.id IS NOT NULL ${!f.sourceId ? Prisma.sql`OR t.entity_id IS NULL` : Prisma.empty})
    )
    SELECT COUNT(*) FILTER (WHERE status <> 'cancelled' AND due_at >= ${f.current.gte} AND due_at <= ${f.current.lte})::int AS due,
      COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= ${f.current.gte} AND completed_at <= ${f.current.lte})::int AS completed,
      COUNT(*) FILTER (WHERE status = 'completed' AND due_at >= ${f.current.gte} AND due_at <= ${f.current.lte} AND completed_at <= due_at)::int AS on_time,
      COUNT(*) FILTER (WHERE status = 'open' AND due_at < ${now})::int AS overdue FROM visible`)
  return { due: row.due, completed: row.completed, onTime: row.on_time, overdueNow: row.overdue, compliancePercent: row.due ? Math.round(row.on_time / row.due * 1000) / 10 : null }
}

export async function exportReport(ctx, type, query) {
  const functions = { sources: leadsBySource, funnel, team: leaderboard, revenue: revenueSeries, kpis }
  if (!Object.hasOwn(functions, type)) throw ApiError.notFound('Report not found')
  const scoped = { ...ctx, forExport: true }
  // Reject export requests even when the resulting report is empty.
  ownerIds(scoped, query.ownerId)
  const data = await functions[type](scoped, query), currency = ctx.currency ?? 'INR'
  const formats = {
    sources: [['Source', 'New leads', 'Converted', 'Revenue (minor units)', 'Currency', 'From', 'To'], (r) => [r.source, r.leads, r.converted, r.revenueMinor, currency, query.from, query.to]],
    funnel: [['Stage', 'Leads'], (r) => [r.stage, r.count]],
    team: [['Team member', 'Revenue (minor units)', 'Currency', 'Deals won', 'Win rate (%)', 'Activities'], (r) => [r.name, r.revenueMinor, currency, r.dealsWon, r.winRate, r.activities]],
    revenue: [['Month', 'Revenue (minor units)', 'Currency'], (r) => [r.period, r.valueMinor, currency]],
    kpis: [['Metric', 'Value', 'Change', 'Context'], (r) => [r.label, r.value, r.delta, r.context]],
  }
  const [headers, row] = formats[type]
  await recordAudit(prisma, ctx, { action: 'report.export', entityType: 'report', changes: { report: type, filters: query, rows: data.length } })
  return { filename: `${type}-report.csv`, headers, rows: data.map(row) }
}

