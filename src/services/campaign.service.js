import { Prisma } from '../generated/prisma/client.js'
import { prisma } from '../db/prisma.js'
import { hasPermission, scopeFor } from '../config/permissions.js'
import { visibilityWhere, registerReassignable } from '../lib/visibility.js'
import { assertAssignableOwner, validationError } from '../lib/records.js'
import { recordAudit } from '../lib/audit.js'
import { versionedUpdate } from '../lib/versionedUpdate.js'
import { minorToJson, divideHalfEven } from '../lib/money.js'
import { parseListQuery, buildPage } from '../lib/pagination.js'
import { isoDateInTz } from '../lib/time.js'
import { decrypt } from '../lib/crypto.js'
import { connectionFor } from '../integrations/facebook/connection.js'
import { graph, graphPage } from '../integrations/facebook/graph.js'
import { isMetaCampaign, metaConfiguredStatus, presentMetaState, readMetaCampaign, changeMetaCampaignStatus } from '../integrations/facebook/campaigns.js'
import { ApiError } from '../utils/ApiError.js'

registerReassignable({
  entity: 'campaign',
  model: 'campaign',
  openWhere: { deletedAt: null, status: { in: ['draft', 'scheduled', 'active', 'paused'] } },
})

export async function campaignFor(ctx, id, action = 'read', db = prisma) {
  const row = await db.campaign.findFirst({
    where: { AND: [{ id, organizationId: ctx.orgId, deletedAt: null }, visibilityWhere(ctx, 'campaigns', action)] },
  })
  if (!row) throw ApiError.notFound('Campaign not found')
  return row
}

function ownerSql(ctx, resource, alias, unowned = false) {
  const scope = scopeFor(ctx.permissions, resource, 'read')
  if (scope === 'all') return Prisma.sql`TRUE`
  if (!scope) return Prisma.sql`FALSE`
  const ids = scope === 'team' ? [ctx.userId, ...(ctx.managedUserIds ?? [])] : [ctx.userId]
  const column = Prisma.raw(`${alias}.owner_id`)
  const own = Prisma.sql`${column} IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`
  return unowned ? Prisma.sql`(${own} OR ${column} IS NULL)` : own
}

/** Two aggregate queries for an entire page, independent of the number of leads. */
async function present(ctx, rows) {
  if (!rows.length) return []
  const ids = rows.map((row) => row.id)
  const [groups, revenue, owners, sources] = await Promise.all([
    prisma.lead.groupBy({
      by: ['campaignId', 'status'],
      where: {
        AND: [{ organizationId: ctx.orgId, campaignId: { in: ids }, deletedAt: null }, visibilityWhere(ctx, 'leads')],
      },
      _count: { _all: true },
    }),
    prisma.$queryRaw(Prisma.sql`
      SELECT l.campaign_id AS "campaignId", COUNT(*)::int AS count, SUM(d.value_minor) AS revenue
      FROM deals d JOIN leads l ON l.id = d.lead_id AND l.organization_id = d.organization_id
      JOIN campaigns c ON c.id = l.campaign_id AND c.organization_id = l.organization_id
      WHERE d.organization_id = ${ctx.orgId}::uuid AND d.deleted_at IS NULL AND l.deleted_at IS NULL
        AND d.status = 'won' AND d.currency = c.currency
        AND l.campaign_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        AND ${ownerSql(ctx, 'deals', 'd')} AND ${ownerSql(ctx, 'leads', 'l', true)}
      GROUP BY l.campaign_id`),
    prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.ownerId).filter(Boolean))] } },
      select: { id: true, fullName: true },
    }),
    prisma.leadSource.findMany({
      where: { organizationId: ctx.orgId, id: { in: [...new Set(rows.map((row) => row.sourceId).filter(Boolean))] } },
      select: { id: true, name: true },
    }),
  ])
  const ownerNames = new Map(owners.map((owner) => [owner.id, owner.fullName]))
  const sourceNames = new Map(sources.map((source) => [source.id, source.name]))
  const revenueById = new Map(revenue.map((row) => [row.campaignId, row]))
  return rows.map((row) => {
    const counts = groups.filter((group) => group.campaignId === row.id)
    const leadsCount = counts.reduce((sum, group) => sum + group._count._all, 0)
    const count = (status) => counts.find((group) => group.status === status)?._count._all ?? 0
    const won = revenueById.get(row.id)
    const revenueWonMinor = minorToJson(won?.revenue ?? 0n)
    const { deletedAt: _deleted, createdById: _creator, ...campaign } = row
    return {
      ...campaign,
      startDate: row.startDate.toISOString().slice(0, 10),
      endDate: row.endDate?.toISOString().slice(0, 10) ?? null,
      budgetMinor: row.budgetMinor == null ? null : minorToJson(row.budgetMinor),
      actualSpendMinor: row.actualSpendMinor == null ? null : minorToJson(row.actualSpendMinor),
      ownerName: ownerNames.get(row.ownerId) ?? null,
      sourceName: sourceNames.get(row.sourceId) ?? null,
      metrics: {
        leadsCount,
        contactedCount: count('contacted'),
        qualifiedCount: count('qualified'),
        convertedCount: count('converted'),
        dealsWonCount: won?.count ?? 0,
        revenueWonMinor,
        costPerLeadMinor:
          row.actualSpendMinor != null && leadsCount
            ? minorToJson(divideHalfEven(row.actualSpendMinor, BigInt(leadsCount)))
            : null,
        conversionRate: leadsCount ? Math.round((count('converted') / leadsCount) * 1000) / 10 : 0,
        roas:
          row.actualSpendMinor > 0n ? Math.round((revenueWonMinor / Number(row.actualSpendMinor)) * 100) / 100 : null,
      },
    }
  })
}

export async function listCampaigns(ctx, query = {}) {
  const page = parseListQuery(query, {
    sortable: { createdAt: 'date', name: 'string', updatedAt: 'date' },
    defaultSort: '-createdAt',
  })
  const filters = [{ organizationId: ctx.orgId, deletedAt: null }, visibilityWhere(ctx, 'campaigns')]
  if (query.status) filters.push({ status: query.status })
  if (query.type) filters.push({ type: query.type })
  if (query.q)
    filters.push({
      OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { code: { contains: query.q, mode: 'insensitive' } }],
    })
  const rows = await prisma.campaign.findMany({
    where: { AND: [...filters, page.cursorWhere] },
    orderBy: page.orderBy,
    take: page.take,
  })
  const result = buildPage(rows, page)
  return { ...result, items: await present(ctx, result.items) }
}

export async function getCampaign(ctx, id) {
  return (await present(ctx, [await campaignFor(ctx, id)]))[0]
}

async function prepare(ctx, input, before, db) {
  const { expectedUpdatedAt: _expected, ...data } = input
  if (before && data.code && data.code !== before.code)
    throw validationError({
      code: 'Tracking codes cannot change after creation. Create another campaign for a new code.',
    })
  if (
    'sourceId' in data &&
    data.sourceId &&
    !(await db.leadSource.count({ where: { id: data.sourceId, organizationId: ctx.orgId, archivedAt: null } }))
  )
    throw validationError({ sourceId: 'Choose an active workspace source' })
  if (!before || 'ownerId' in data) await assertAssignableOwner(ctx, 'ownerId' in data ? data.ownerId : ctx.userId, db)
  if ('startDate' in data) data.startDate = new Date(`${data.startDate}T00:00:00Z`)
  if ('endDate' in data) data.endDate = data.endDate ? new Date(`${data.endDate}T00:00:00Z`) : null
  const endDate = 'endDate' in data ? data.endDate : before?.endDate
  const startDate = data.startDate ?? before?.startDate
  if (endDate && endDate < startDate) throw validationError({ endDate: 'End date must be on or after start date' })
  for (const key of ['budgetMinor', 'actualSpendMinor'])
    if (key in data) data[key] = data[key] == null ? null : BigInt(data[key])
  if (!before) {
    data.currency ??= ctx.currency
    if (!('ownerId' in data)) data.ownerId = ctx.userId
    data.utm ??= {}
  }
  const code = before?.code ?? data.code
  if (data.utm) data.utm = { ...data.utm, utm_campaign: code }
  if (data.externalCampaignId && !data.externalPlatform)
    data.externalPlatform =
      (data.type ?? before?.type) === 'meta_ads'
        ? 'facebook'
        : (data.type ?? before?.type) === 'google_ads'
          ? 'google'
          : null
  return data
}

/** Backfill only previously unattributed leads, including the Facebook connector's legacy keys. */
async function attributeExisting(db, ctx, campaign) {
  await db.$executeRaw(Prisma.sql`
    UPDATE leads SET campaign_id = ${campaign.id}::uuid, updated_at = NOW()
    WHERE organization_id = ${ctx.orgId}::uuid AND campaign_id IS NULL AND deleted_at IS NULL
      AND (LOWER(BTRIM(COALESCE(utm->>'utm_campaign', ''))) = ${campaign.code}
        OR (${campaign.externalCampaignId ?? null}::text IS NOT NULL
          AND COALESCE(NULLIF(utm->>'campaign_id', ''), utm->>'campaign') = ${campaign.externalCampaignId ?? null}
          AND COALESCE(NULLIF(BTRIM(utm->>'utm_campaign'), ''), ${campaign.code}) = ${campaign.code})
        OR (COALESCE(NULLIF(utm->>'utm_campaign', ''), NULLIF(utm->>'campaign_id', ''), NULLIF(utm->>'campaign', '')) IS NULL
          AND LOWER(BTRIM(source_detail)) = ${campaign.code}))`)
}

function uniqueError(error) {
  if (error.code === 'P2002')
    throw ApiError.conflict('This tracking code or external campaign is already used in this workspace.', 'code')
  throw error
}

export async function createCampaign(ctx, input) {
  if (!hasPermission(ctx.permissions, 'campaigns.create')) throw ApiError.forbidden()
  let row
  try {
    row = await prisma.$transaction(async (tx) => {
      const data = await prepare(ctx, input, null, tx)
      const created = await tx.campaign.create({
        data: { ...data, organizationId: ctx.orgId, createdById: ctx.userId },
      })
      await attributeExisting(tx, ctx, created)
      await recordAudit(tx, ctx, { action: 'campaign.created', entityType: 'campaign', entityId: created.id })
      return created
    })
  } catch (error) {
    uniqueError(error)
  }
  return (await present(ctx, [row]))[0]
}

export async function updateCampaign(ctx, id, input, { expectedUpdatedAt, fromMetaSync = false } = {}) {
  let row
  try {
    row = await prisma.$transaction(async (tx) => {
      const before = await campaignFor(ctx, id, 'update', tx)
      if (expectedUpdatedAt && new Date(expectedUpdatedAt).getTime() !== before.updatedAt.getTime())
        throw new ApiError(409, 'This campaign changed. Refresh and try again.', { code: 'STALE_UPDATE' })
      if (isMetaCampaign(before) && !fromMetaSync) {
        const fields = {}
        for (const key of ['name', 'type', 'externalPlatform', 'externalCampaignId', 'externalAccountId', 'status', 'startDate', 'endDate']) {
          const old = before[key] instanceof Date ? before[key].toISOString().slice(0, 10) : before[key] ?? null
          if (key in input && (input[key] ?? null) !== old)
            fields[key] = key === 'status' ? 'Use Enable on Meta or Pause on Meta to change this campaign’s status.' : 'This field is managed by Meta. Make changes in Ads Manager, then Sync Meta.'
        }
        if (Object.keys(fields).length) throw validationError(fields)
      }
      const data = await prepare(ctx, input, before, tx)
      const updated = await versionedUpdate(tx, 'campaign', ctx, before, data)
      if (data.externalCampaignId) await attributeExisting(tx, ctx, updated)
      await recordAudit(tx, ctx, { action: 'campaign.updated', entityType: 'campaign', entityId: id })
      return updated
    })
  } catch (error) {
    uniqueError(error)
  }
  return (await present(ctx, [row]))[0]
}

export async function getMetaCampaignState(ctx, id) {
  return presentMetaState(await readMetaCampaign(ctx, await campaignFor(ctx, id)))
}

export async function setCampaignStatus(ctx, id, status, { expectedUpdatedAt } = {}) {
  const before = await campaignFor(ctx, id, 'update')
  if (expectedUpdatedAt && new Date(expectedUpdatedAt).getTime() !== before.updatedAt.getTime())
    throw new ApiError(409, 'This campaign changed. Refresh and try again.', { code: 'STALE_UPDATE' })
  if (!isMetaCampaign(before)) return updateCampaign(ctx, id, { status }, { expectedUpdatedAt: before.updatedAt })
  const remote = await changeMetaCampaignStatus(ctx, before, status)
  try {
    return await updateCampaign(ctx, id, { status: metaConfiguredStatus(remote) }, { expectedUpdatedAt: before.updatedAt, fromMetaSync: true })
  } catch {
    throw new ApiError(409, 'Meta confirmed the status, but the CRM record changed before it could be saved. Sync Meta to reconcile the record before retrying.', { code: 'META_STATUS_RECONCILE_REQUIRED' })
  }
}

export async function deleteCampaign(ctx, id, { expectedUpdatedAt } = {}) {
  await prisma.$transaction(async (tx) => {
    const before = await campaignFor(ctx, id, 'delete', tx)
    if (expectedUpdatedAt && before.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime())
      throw new ApiError(409, 'This campaign changed. Refresh and try again.', { code: 'STALE_UPDATE' })
    await versionedUpdate(tx, 'campaign', ctx, before, { deletedAt: new Date() })
    await recordAudit(tx, ctx, { action: 'campaign.deleted', entityType: 'campaign', entityId: id })
  })
}

/** Import one bounded provider page; the client follows its opaque cursor. No spend is invented. */
export async function syncMetaCampaigns(ctx, { adAccountId, after }) {
  if (!hasPermission(ctx.permissions, 'settings.workspace.manage')) throw ApiError.forbidden()
  const syncStartedAt = new Date()
  const connection = await connectionFor(ctx)
  const token = decrypt(connection.tokenEnc)
  const account = await graph(adAccountId, token, { fields: 'id,currency' })
  if (!['INR', 'USD'].includes(account.currency))
    throw validationError({ adAccountId: 'This account currency is not supported by this workspace' })
  const page = graphPage(
    await graph(`${adAccountId}/campaigns`, token, {
      fields: 'id,name,status,effective_status,objective,start_time,stop_time',
      limit: 100,
      after,
    }),
  )
  let synced = 0
  for (const remote of page.items) {
    const status = metaConfiguredStatus(remote)
    const before = await prisma.campaign.findUnique({
      where: {
        organizationId_externalPlatform_externalCampaignId: {
          organizationId: ctx.orgId,
          externalPlatform: 'facebook',
          externalCampaignId: remote.id,
        },
      },
    })
    if (before?.deletedAt) continue
    // Do not overwrite a status change made while this provider page was in flight.
    if (before && before.updatedAt > syncStartedAt) continue
    const input = { name: String(remote.name).slice(0, 160), status, type: 'meta_ads', externalPlatform: 'facebook', externalAccountId: adAccountId }
    if (remote.start_time) input.startDate = remote.start_time.slice(0, 10)
    input.endDate = remote.stop_time?.slice(0, 10) ?? null
    if (before) {
      try { await updateCampaign(ctx, before.id, input, { expectedUpdatedAt: before.updatedAt, fromMetaSync: true }) }
      catch (error) { if (error.code === 'STALE_UPDATE') continue; throw error }
    }
    else {
      const code = `meta-${remote.id}`
      await createCampaign(ctx, {
        ...input,
        code,
        type: 'meta_ads',
        objective: 'lead_generation',
        startDate: remote.start_time?.slice(0, 10) ?? remote.stop_time?.slice(0, 10) ?? isoDateInTz(new Date(), ctx.timezone),
        endDate: remote.stop_time?.slice(0, 10) ?? null,
        currency: account.currency,
        externalAccountId: adAccountId,
        externalCampaignId: remote.id,
        externalPlatform: 'facebook',
        utm: { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: code },
      })
    }
    synced++
  }
  return { synced, nextCursor: page.nextCursor }
}
