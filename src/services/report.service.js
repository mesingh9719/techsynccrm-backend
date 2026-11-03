import { prisma } from '../db/prisma.js'
import { Prisma } from '../generated/prisma/client.js'
import { scopeFor } from '../config/permissions.js'
import { dateRange } from '../lib/records.js'
import { DEFAULT_TZ, isoDateInTz } from '../lib/time.js'
import { divideHalfEven, minorToJson } from '../lib/money.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from '../utils/ApiError.js'
import { targetsFor } from './target.service.js'

/**
 * Standard reports (M15) behind the dashboard and /app/reports. Metric definitions follow
 * docs/modules/M15-dashboards-reports.md §3; periods are whole days in the workspace time zone.
 *
 * The funnel uses the existing transactional, retained status events, including both sides of
 * a transition. No invented history/backfill for records without events. Targets live in
 * target.service.js and emailed summaries in reportSchedule.service.js. All queries aggregate in
 * Postgres rather than loading the workspace into JS.
 */

const ACTIVITY_TYPES = ['call', 'meeting', 'site_visit', 'whatsapp', 'email', 'sms']
const DAY = 86_400_000

// ---------- Scope & filters ----------

/** Owner ids the caller may report on (null = everyone), narrowed by an `ownerId` filter. */
export function ownerIds(ctx, ownerId) {
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
  // Wider custom ranges still reconcile with the KPI total; short ranges are padded to 12 months.
  const months = Math.max(query.months ?? 12, (year - fromYear) * 12 + month - fromMonth + 1)
  const labels = Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(year, month - 1 - (months - 1 - i), 1))
    return d.toISOString().slice(0, 7)
  })
  // Padded months are queried too, so they show real revenue rather than a misleading zero.
  const range = dateRange(`${labels[0]}-01`, query.to, f.tz)
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT to_char(d.won_at AT TIME ZONE ${f.tz}, 'YYYY-MM') AS period,
           SUM(d.value_minor)::bigint AS total
    FROM deals d WHERE ${dealSql(ctx, f)} AND d.status = 'won'
      AND d.won_at >= ${range.gte} AND d.won_at <= ${range.lte}
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

/** Per active member in scope: revenue and deals won, win rate, activities logged, target attainment. */
export async function leaderboard(ctx, query) {
  const f = filters(ctx, query)
  const members = await membersInScope(ctx, f)
  const ids = members.map((m) => m.userId)
  if (!ids.length) return []
  const base = { ...dealBase(ctx, f), ownerId: { in: ids } }
  // With the whole workspace in view, deals of former members and unassigned deals get their own
  // row so the team total reconciles with the KPI revenue (PR-023).
  const others = !f.owners ? { ...dealBase(ctx, f), OR: [{ ownerId: null }, { ownerId: { notIn: ids } }] } : null
  const [won, lost, activities, targets, othersWon, othersLost] = await Promise.all([
    prisma.deal.groupBy({ by: ['ownerId'], where: { ...base, status: 'won', wonAt: f.current }, _sum: { valueMinor: true }, _count: { _all: true } }),
    prisma.deal.groupBy({ by: ['ownerId'], where: { ...base, status: 'lost', closedAt: f.current }, _count: { _all: true } }),
    activityCounts(ctx, f, ids),
    targetsFor(ctx.orgId, ids, query.from, query.to),
    others ? prisma.deal.aggregate({ where: { ...others, status: 'won', wonAt: f.current }, _sum: { valueMinor: true }, _count: { _all: true } }) : null,
    others ? prisma.deal.count({ where: { ...others, status: 'lost', closedAt: f.current } }) : 0,
  ])
  const by = (rows, field = 'ownerId') => new Map(rows.map((r) => [r[field], r]))
  const wonBy = by(won), lostBy = by(lost)
  const activitiesBy = new Map()
  for (const r of activities) activitiesBy.set(r.actorId, (activitiesBy.get(r.actorId) ?? 0) + r.count)
  const row = (ownerId, name, w, dealsLost, activityCount, target) => {
    const dealsWon = w?._count._all ?? 0
    const revenueMinor = minorToJson(w?._sum.valueMinor ?? 0n)
    return {
      ownerId,
      name,
      revenueMinor,
      dealsWon,
      dealsLost,
      winRate: dealsWon + dealsLost ? Math.round((dealsWon / (dealsWon + dealsLost)) * 100) : null,
      activities: activityCount,
      targetMinor: target?.revenueMinor ?? null,
      targetDeals: target?.dealsWon ?? null,
      attainment: target?.revenueMinor ? Math.round((revenueMinor / target.revenueMinor) * 1000) / 10 : null,
    }
  }
  const rows = members
    .map((m) => row(m.userId, m.user.fullName || m.user.email, wonBy.get(m.userId), lostBy.get(m.userId)?._count._all ?? 0, activitiesBy.get(m.userId) ?? 0, targets.get(m.userId)))
    .sort((a, b) => b.revenueMinor - a.revenueMinor || b.dealsWon - a.dealsWon || b.activities - a.activities)
  if (othersWon?._count._all || othersLost) rows.push({ ...row('others', 'Former members & unassigned', othersWon, othersLost, 0, null), activities: null })
  return rows
}

/**
 * Activity counts per actor and type. An activity only counts when it is linked to a record the
 * report may include, so source and owner filters apply consistently.
 */
async function activityCounts(ctx, f, actorIds) {
  return prisma.$queryRaw(Prisma.sql`
    SELECT a.actor_id AS "actorId", a.type::text AS type, COUNT(*)::int AS count FROM activities a
    WHERE a.organization_id = ${ctx.orgId}::uuid AND a.deleted_at IS NULL
      AND a.actor_id = ANY(${actorIds}::uuid[]) AND a.type::text = ANY(${ACTIVITY_TYPES}::text[])
      AND a.occurred_at >= ${f.current.gte} AND a.occurred_at <= ${f.current.lte}
      AND EXISTS (SELECT 1 FROM activity_links al WHERE al.organization_id = ${ctx.orgId}::uuid
        AND al.activity_id = a.id AND (
          (al.entity_type = 'lead' AND EXISTS (SELECT 1 FROM leads l WHERE l.id = al.entity_id AND ${leadSql(ctx, f)}))
          OR (al.entity_type = 'deal' AND EXISTS (SELECT 1 FROM deals d WHERE d.id = al.entity_id AND ${dealSql(ctx, f)}))
          ${!f.sourceId ? Prisma.sql`OR (al.entity_type = 'contact' AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = al.entity_id AND c.organization_id = ${ctx.orgId}::uuid AND c.deleted_at IS NULL ${ownerSql(f, 'c', true)}))
            OR (al.entity_type = 'company' AND EXISTS (SELECT 1 FROM companies c WHERE c.id = al.entity_id AND c.organization_id = ${ctx.orgId}::uuid AND c.deleted_at IS NULL ${ownerSql(f, 'c', true)}))` : Prisma.empty}
        )) GROUP BY a.actor_id, a.type`)
}

/** Active members the caller may report on, capped like the leaderboard. */
async function membersInScope(ctx, f) {
  const members = await prisma.membership.findMany({
    where: { organizationId: ctx.orgId, status: 'active', ...ownerWhere(f.owners, 'userId') },
    select: { userId: true, user: { select: { fullName: true, email: true } } },
    take: 501,
    orderBy: { userId: 'asc' },
  })
  if (members.length > 500) throw new ApiError(400, 'Choose an owner to report on a team with more than 500 members.', { code: 'VALIDATION_ERROR' })
  return members
}

// ---------- Trend, pipeline, forecast, lost reasons, campaigns, activity ----------

const shiftDay = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10)
const daysIn = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY) + 1
const monthStart = (iso) => `${iso.slice(0, 7)}-01`
const addMonths = (iso, n) => {
  const d = new Date(`${monthStart(iso)}T12:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + n)
  return d.toISOString().slice(0, 10)
}

/** Bucket size that keeps a chart readable: daily up to ~6 weeks, weekly up to ~6 months, then monthly. */
export function intervalFor(from, to, requested) {
  if (requested && requested !== 'auto') return requested
  const days = daysIn(from, to)
  return days <= 45 ? 'day' : days <= 190 ? 'week' : 'month'
}

/** Bucket start dates (YYYY-MM-DD) covering from..to; weeks start on Monday like Postgres date_trunc. */
export function bucketStarts(from, to, interval) {
  const out = []
  if (interval === 'day') for (let d = from; d <= to; d = shiftDay(d, 1)) out.push(d)
  else if (interval === 'week') {
    const weekday = (new Date(`${from}T12:00:00Z`).getUTCDay() + 6) % 7
    for (let d = shiftDay(from, -weekday); d <= to; d = shiftDay(d, 7)) out.push(d)
  } else for (let d = monthStart(from); d <= to; d = addMonths(d, 1)) out.push(d)
  return out
}

/** New leads, conversions, deals won and won revenue per day, week or month of the selected period. */
export async function trend(ctx, query) {
  const f = filters(ctx, query)
  const interval = intervalFor(query.from, query.to, query.interval)
  const bucket = (column) => Prisma.sql`to_char(date_trunc(${interval}, ${Prisma.raw(column)} AT TIME ZONE ${f.tz}), 'YYYY-MM-DD')`
  const [leads, deals] = await Promise.all([
    prisma.$queryRaw(Prisma.sql`
      SELECT ${bucket('l.created_at')} AS period, COUNT(*)::int AS leads, COUNT(*) FILTER (WHERE l.status = 'converted')::int AS converted
      FROM leads l WHERE ${leadSql(ctx, f)} AND l.created_at >= ${f.current.gte} AND l.created_at <= ${f.current.lte}
      GROUP BY 1`),
    prisma.$queryRaw(Prisma.sql`
      SELECT ${bucket('d.won_at')} AS period, COUNT(*)::int AS won, SUM(d.value_minor)::bigint AS total
      FROM deals d WHERE ${dealSql(ctx, f)} AND d.status = 'won' AND d.won_at >= ${f.current.gte} AND d.won_at <= ${f.current.lte}
      GROUP BY 1`),
  ])
  const leadsBy = new Map(leads.map((r) => [r.period, r]))
  const dealsBy = new Map(deals.map((r) => [r.period, r]))
  return {
    interval,
    points: bucketStarts(query.from, query.to, interval).map((period) => ({
      period,
      leads: leadsBy.get(period)?.leads ?? 0,
      converted: leadsBy.get(period)?.converted ?? 0,
      dealsWon: dealsBy.get(period)?.won ?? 0,
      revenueMinor: minorToJson(dealsBy.get(period)?.total ?? 0n),
    })),
  }
}

/**
 * Open pipeline right now, by stage: deals, value, probability-weighted value, average days in
 * stage and stuck deals (no activity or stage change within the stage's rotting window).
 * Owner and source filters apply; the date range does not (it is a snapshot).
 */
export async function pipeline(ctx, query, now = new Date()) {
  const f = filters(ctx, query)
  const pipelines = await prisma.pipeline.findMany({
    where: { organizationId: ctx.orgId, archivedAt: null },
    select: { id: true, name: true, isDefault: true },
    orderBy: [{ isDefault: 'desc' }, { position: 'asc' }, { createdAt: 'asc' }],
  })
  const selected = pipelines.find((p) => p.id === query.pipelineId) ?? pipelines[0]
  if (!selected) return { pipelines: [], pipelineId: null, stages: [] }
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT s.id, s.name, s.probability, s.rotting_days AS "rottingDays",
      COUNT(d.id)::int AS count, COALESCE(SUM(d.value_minor), 0)::bigint AS value,
      COALESCE(SUM(d.value_minor * COALESCE(d.probability_override, s.probability)), 0)::bigint AS weighted100,
      AVG(EXTRACT(EPOCH FROM (${now}::timestamptz - d.stage_entered_at)) / 86400)::float8 AS "avgDays",
      COUNT(d.id) FILTER (WHERE s.rotting_days IS NOT NULL
        AND GREATEST(d.last_activity_at, d.stage_entered_at) < ${now}::timestamptz - make_interval(days => s.rotting_days))::int AS stuck
    FROM pipeline_stages s
    LEFT JOIN deals d ON d.stage_id = s.id AND d.status = 'open' AND ${dealSql(ctx, f)}
    WHERE s.organization_id = ${ctx.orgId}::uuid AND s.pipeline_id = ${selected.id}::uuid AND s.type = 'open'
    GROUP BY s.id ORDER BY s.position`)
  return {
    pipelines,
    pipelineId: selected.id,
    stages: rows.map((r) => ({
      stageId: r.id,
      stage: r.name,
      probability: r.probability,
      count: r.count,
      valueMinor: minorToJson(r.value),
      weightedMinor: minorToJson(divideHalfEven(BigInt(r.weighted100), 100n)),
      avgDaysInStage: r.avgDays === null ? null : Math.round(r.avgDays * 10) / 10,
      stuck: r.stuck,
      rottingDays: r.rottingDays,
    })),
  }
}

/**
 * Open deals by expected close month for the next six months (weighted and best case), with
 * overdue, later and undated buckets, beside revenue already won in those months.
 */
export async function forecast(ctx, query, now = new Date()) {
  const f = filters(ctx, query)
  const today = isoDateInTz(now, f.tz)
  const months = Array.from({ length: 6 }, (_, i) => addMonths(today, i).slice(0, 7))
  const end = shiftDay(addMonths(today, 6), -1)
  const won = dateRange(monthStart(today), end, f.tz)
  const [open, closed] = await Promise.all([
    prisma.$queryRaw(Prisma.sql`
      SELECT CASE WHEN d.expected_close_date IS NULL THEN 'none'
          WHEN d.expected_close_date < ${today}::date THEN 'overdue'
          WHEN d.expected_close_date > ${end}::date THEN 'later'
          ELSE to_char(d.expected_close_date, 'YYYY-MM') END AS bucket,
        COUNT(*)::int AS count, SUM(d.value_minor)::bigint AS value,
        SUM(d.value_minor * COALESCE(d.probability_override, s.probability))::bigint AS weighted100
      FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id
      WHERE ${dealSql(ctx, f)} AND d.status = 'open' GROUP BY 1`),
    prisma.$queryRaw(Prisma.sql`
      SELECT to_char(d.won_at AT TIME ZONE ${f.tz}, 'YYYY-MM') AS bucket, SUM(d.value_minor)::bigint AS value
      FROM deals d WHERE ${dealSql(ctx, f)} AND d.status = 'won' AND d.won_at >= ${won.gte} AND d.won_at <= ${won.lte}
      GROUP BY 1`),
  ])
  const openBy = new Map(open.map((r) => [r.bucket, r]))
  const wonBy = new Map(closed.map((r) => [r.bucket, r.value]))
  const cell = (bucket) => {
    const r = openBy.get(bucket)
    return { count: r?.count ?? 0, valueMinor: minorToJson(r?.value ?? 0n), weightedMinor: minorToJson(divideHalfEven(BigInt(r?.weighted100 ?? 0), 100n)) }
  }
  return {
    months: months.map((month) => ({ month, ...cell(month), wonMinor: minorToJson(wonBy.get(month) ?? 0n) })),
    overdue: cell('overdue'),
    later: cell('later'),
    noDate: cell('none'),
  }
}

/** Why deals closed lost in the period (count and value) and why leads from the period's cohort are lost now. */
export async function lostReasons(ctx, query) {
  const f = filters(ctx, query)
  const [deals, leads] = await Promise.all([
    prisma.deal.groupBy({ by: ['lostReasonId'], where: { ...dealBase(ctx, f), status: 'lost', closedAt: f.current }, _count: { _all: true }, _sum: { valueMinor: true } }),
    prisma.lead.groupBy({ by: ['lostReasonId'], where: { ...leadBase(ctx, f), status: 'lost', createdAt: f.current }, _count: { _all: true } }),
  ])
  const ids = [...new Set([...deals, ...leads].map((r) => r.lostReasonId).filter(Boolean))]
  const names = new Map((await prisma.lostReason.findMany({ where: { organizationId: ctx.orgId, id: { in: ids } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]))
  const label = (id) => (id ? (names.get(id) ?? 'Removed reason') : 'No reason given')
  return {
    deals: deals
      .map((r) => ({ reasonId: r.lostReasonId ?? 'none', reason: label(r.lostReasonId), count: r._count._all, valueMinor: minorToJson(r._sum.valueMinor ?? 0n) }))
      .sort((a, b) => b.count - a.count || b.valueMinor - a.valueMinor),
    leads: leads.map((r) => ({ reasonId: r.lostReasonId ?? 'none', reason: label(r.lostReasonId), count: r._count._all })).sort((a, b) => b.count - a.count),
  }
}

/**
 * Campaign results: leads, conversions and won revenue in the period, plus spend-based ratios to
 * date (spend is recorded per campaign, not per day). Ratios need the workspace currency.
 */
export async function campaigns(ctx, query) {
  const f = filters(ctx, query)
  const currency = ctx.currency ?? 'INR'
  const inPeriod = (column) => Prisma.sql`${Prisma.raw(column)} >= ${f.current.gte} AND ${Prisma.raw(column)} <= ${f.current.lte}`
  const rows = await prisma.$queryRaw(Prisma.sql`
    WITH leads_all AS (
      SELECT l.campaign_id, COUNT(*)::int AS leads,
        COUNT(*) FILTER (WHERE ${inPeriod('l.created_at')})::int AS period_leads,
        COUNT(*) FILTER (WHERE ${inPeriod('l.created_at')} AND l.status = 'converted')::int AS period_converted
      FROM leads l WHERE ${leadSql(ctx, f)} AND l.campaign_id IS NOT NULL GROUP BY 1
    ), won AS (
      SELECT l.campaign_id, COUNT(*)::int AS won, SUM(d.value_minor)::bigint AS revenue,
        COUNT(*) FILTER (WHERE ${inPeriod('d.won_at')})::int AS period_won,
        COALESCE(SUM(d.value_minor) FILTER (WHERE ${inPeriod('d.won_at')}), 0)::bigint AS period_revenue
      FROM deals d JOIN leads l ON l.id = d.lead_id AND l.organization_id = d.organization_id
      WHERE ${dealSql(ctx, f)} AND d.status = 'won' AND l.campaign_id IS NOT NULL GROUP BY 1
    )
    SELECT c.id, c.name, c.status, c.currency, c.budget_minor AS budget, c.actual_spend_minor AS spend,
      COALESCE(la.leads, 0) AS leads, COALESCE(la.period_leads, 0) AS "periodLeads", COALESCE(la.period_converted, 0) AS "periodConverted",
      COALESCE(w.won, 0) AS won, COALESCE(w.revenue, 0)::bigint AS revenue,
      COALESCE(w.period_won, 0) AS "periodWon", COALESCE(w.period_revenue, 0)::bigint AS "periodRevenue"
    FROM campaigns c
    LEFT JOIN leads_all la ON la.campaign_id = c.id
    LEFT JOIN won w ON w.campaign_id = c.id
    WHERE c.organization_id = ${ctx.orgId}::uuid AND c.deleted_at IS NULL
      AND (la.period_leads > 0 OR w.period_won > 0 ${!f.owners ? Prisma.sql`OR c.status = 'active'` : Prisma.empty})
    ORDER BY COALESCE(la.period_leads, 0) DESC, COALESCE(w.period_revenue, 0) DESC, c.name
    LIMIT 200`)
  return rows.map((r) => {
    const spend = r.spend === null ? null : BigInt(r.spend)
    const comparable = spend !== null && spend > 0n && r.currency === currency
    return {
      campaignId: r.id,
      name: r.name,
      status: r.status,
      leads: r.periodLeads,
      converted: r.periodConverted,
      dealsWon: r.periodWon,
      revenueMinor: minorToJson(r.periodRevenue),
      spendMinor: spend === null ? null : minorToJson(spend),
      budgetMinor: r.budget === null ? null : minorToJson(r.budget),
      spendCurrency: r.currency,
      leadsToDate: r.leads,
      revenueToDateMinor: minorToJson(r.revenue),
      costPerLeadMinor: comparable && r.leads ? minorToJson(divideHalfEven(spend, BigInt(r.leads))) : null,
      costPerWonMinor: comparable && r.won ? minorToJson(divideHalfEven(spend, BigInt(r.won))) : null,
      returnOnSpend: comparable ? Math.round((Number(r.revenue) / Number(spend)) * 100) / 100 : null,
    }
  })
}

/** Calls, meetings, visits and messages logged per member in the period, by type. */
export async function activity(ctx, query) {
  const f = filters(ctx, query)
  const members = await membersInScope(ctx, f)
  if (!members.length) return { types: ACTIVITY_TYPES, rows: [] }
  const counts = await activityCounts(ctx, f, members.map((m) => m.userId))
  const rows = new Map(members.map((m) => [m.userId, { ownerId: m.userId, name: m.user.fullName || m.user.email, total: 0, ...Object.fromEntries(ACTIVITY_TYPES.map((t) => [t, 0])) }]))
  for (const c of counts) {
    const row = rows.get(c.actorId)
    if (!row) continue
    row[c.type] += c.count
    row.total += c.count
  }
  return { types: ACTIVITY_TYPES, rows: [...rows.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)) }
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

const rate = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : '')
const orBlank = (value) => value ?? ''

/** Each export: the rows to write (from the report's data) and how to write them. */
const EXPORTS = {
  kpis: { load: kpis, headers: ['Metric', 'Value', 'Change', 'Context'], row: (r) => [r.label, r.value, r.delta, r.context] },
  trend: {
    load: async (ctx, q) => (await trend(ctx, q)).points,
    headers: ['Period start', 'New leads', 'Converted', 'Deals won', 'Revenue (minor units)', 'Currency'],
    row: (r, c) => [r.period, r.leads, r.converted, r.dealsWon, r.revenueMinor, c],
  },
  revenue: { load: revenueSeries, headers: ['Month', 'Revenue (minor units)', 'Currency'], row: (r, c) => [r.period, r.valueMinor, c] },
  sources: {
    load: leadsBySource,
    headers: ['Source', 'New leads', 'Converted', 'Conversion (%)', 'Revenue (minor units)', 'Currency', 'From', 'To'],
    row: (r, c, q) => [r.source, r.leads, r.converted, rate(r.converted, r.leads), r.revenueMinor, c, q.from, q.to],
  },
  funnel: {
    load: async (ctx, q) => {
      const stages = await funnel(ctx, q)
      return stages.map((s, i) => ({ ...s, ofTotal: rate(s.count, stages[0].count), ofPrevious: i ? rate(s.count, stages[i - 1].count) : '' }))
    },
    headers: ['Stage', 'Leads', 'Of first stage (%)', 'Of previous stage (%)'],
    row: (r) => [r.stage, r.count, r.ofTotal, r.ofPrevious],
  },
  team: {
    load: leaderboard,
    headers: ['Team member', 'Revenue (minor units)', 'Currency', 'Deals won', 'Deals lost', 'Win rate (%)', 'Activities', 'Revenue target (minor units)', 'Attainment (%)'],
    row: (r, c) => [r.name, r.revenueMinor, c, r.dealsWon, r.dealsLost, orBlank(r.winRate), orBlank(r.activities), orBlank(r.targetMinor), orBlank(r.attainment)],
  },
  pipeline: {
    load: async (ctx, q) => (await pipeline(ctx, q)).stages,
    headers: ['Stage', 'Open deals', 'Value (minor units)', 'Weighted value (minor units)', 'Currency', 'Probability (%)', 'Avg. days in stage', 'Stuck deals'],
    row: (r, c) => [r.stage, r.count, r.valueMinor, r.weightedMinor, c, r.probability, orBlank(r.avgDaysInStage), r.stuck],
  },
  forecast: {
    load: async (ctx, q) => {
      const data = await forecast(ctx, q)
      return [...data.months.map((m) => ({ bucket: m.month, ...m })), { bucket: 'Overdue', ...data.overdue }, { bucket: 'Later', ...data.later }, { bucket: 'No close date', ...data.noDate }]
    },
    headers: ['Expected close', 'Open deals', 'Best case (minor units)', 'Weighted (minor units)', 'Already won (minor units)', 'Currency'],
    row: (r, c) => [r.bucket, r.count, r.valueMinor, r.weightedMinor, orBlank(r.wonMinor), c],
  },
  lost: {
    load: async (ctx, q) => {
      const data = await lostReasons(ctx, q)
      return [...data.deals.map((r) => ({ type: 'Deal', ...r })), ...data.leads.map((r) => ({ type: 'Lead', ...r }))]
    },
    headers: ['Record', 'Reason', 'Count', 'Value lost (minor units)', 'Currency'],
    row: (r, c) => [r.type, r.reason, r.count, orBlank(r.valueMinor), r.valueMinor === undefined ? '' : c],
  },
  campaigns: {
    load: campaigns,
    headers: ['Campaign', 'Status', 'New leads', 'Converted', 'Deals won', 'Revenue (minor units)', 'Currency', 'Spend to date (minor units)', 'Spend currency', 'Cost per lead (minor units)', 'Return on spend (x)'],
    row: (r, c) => [r.name, r.status, r.leads, r.converted, r.dealsWon, r.revenueMinor, c, orBlank(r.spendMinor), r.spendCurrency, orBlank(r.costPerLeadMinor), orBlank(r.returnOnSpend)],
  },
  activity: {
    load: async (ctx, q) => (await activity(ctx, q)).rows,
    headers: ['Team member', 'Total', ...ACTIVITY_TYPES.map((t) => t.replace('_', ' '))],
    row: (r) => [r.name, r.total, ...ACTIVITY_TYPES.map((t) => r[t])],
  },
  'follow-ups': {
    load: async (ctx, q) => {
      const [response, tasks] = await Promise.all([firstResponse(ctx, q), followUps(ctx, q)])
      return [
        { metric: 'Enquiries in period', value: response.total },
        { metric: 'Median first response (minutes)', value: orBlank(response.medianMinutes) },
        ...response.buckets.map((b) => ({ metric: `First response ${b.label.toLowerCase()}`, value: b.count })),
        { metric: 'Still without a response', value: response.unresponded },
        { metric: 'Tasks due in period', value: tasks.due },
        { metric: 'Completed in period', value: tasks.completed },
        { metric: 'Completed on time', value: tasks.onTime },
        { metric: 'On-time completion (%)', value: orBlank(tasks.compliancePercent) },
        { metric: 'Overdue now', value: tasks.overdueNow },
      ]
    },
    headers: ['Metric', 'Value'],
    row: (r) => [r.metric, r.value],
  },
}
export const EXPORT_TYPES = Object.keys(EXPORTS)

export async function exportReport(ctx, type, query) {
  if (!Object.hasOwn(EXPORTS, type)) throw ApiError.notFound('Report not found')
  const scoped = { ...ctx, forExport: true }
  // Reject export requests even when the resulting report is empty.
  ownerIds(scoped, query.ownerId)
  const { load, headers, row } = EXPORTS[type]
  const data = await load(scoped, query), currency = ctx.currency ?? 'INR'
  await recordAudit(prisma, ctx, { action: 'report.export', entityType: 'report', changes: { report: type, filters: query, rows: data.length } })
  return { filename: `${type}-report-${query.from}-to-${query.to}.csv`, headers, rows: data.map((r) => row(r, currency, query)) }
}

