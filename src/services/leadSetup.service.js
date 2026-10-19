import { prisma, UNIQUE_VIOLATION } from '../db/prisma.js'
import { recordAudit } from '../lib/audit.js'
import { validationError } from '../lib/records.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * Lead sources and lost reasons (M08): workspace lookup lists with defaults.
 * The defaults here must match the backfill in migration 20261019170000_leads.
 */

/** [name, key, isSystem, scoreWeight] — system sources are used by connectors (M14/M19/M20). */
export const DEFAULT_SOURCES = [
  ['Website', 'website', true, 15],
  ['WhatsApp', 'whatsapp', true, 15],
  ['IndiaMART', 'indiamart', true, 15],
  ['JustDial', 'justdial', true, 10],
  ['TradeIndia', 'tradeindia', true, 5],
  ['Facebook Lead Ads', 'facebook_lead_ads', true, 5],
  ['Google Ads', 'google_ads', true, 10],
  ['99acres', 'acres99', true, 5],
  ['MagicBricks', 'magicbricks', true, 5],
  ['Referral', 'referral', false, 20],
  ['Walk-in', 'walk_in', false, 5],
  ['Phone call', 'phone_call', false, 5],
  ['Email', 'email', true, 5],
  ['Other', 'other', false, 5],
]

export const DEFAULT_LOST_REASONS = ['Budget', 'Timing', 'Competitor', 'No response', 'Not a fit', 'Other']
/** Deal lost reasons (M09) — must match the backfill in migration 20261019180000_pipelines_deals. */
export const DEFAULT_DEAL_LOST_REASONS = ['Price', 'Competitor', 'No budget', 'No decision', 'Timing', 'Other']

/** Creates the default sources and lost reasons for a new workspace (idempotent). */
export async function ensureLeadDefaults(tx, orgId) {
  await tx.leadSource.createMany({
    data: DEFAULT_SOURCES.map(([name, key, isSystem, scoreWeight], position) => ({ organizationId: orgId, name, key, isSystem, scoreWeight, position })),
    skipDuplicates: true,
  })
  await tx.lostReason.createMany({
    data: [
      ...DEFAULT_LOST_REASONS.map((name, position) => ({ organizationId: orgId, entityType: 'lead', name, position })),
      ...DEFAULT_DEAL_LOST_REASONS.map((name, position) => ({ organizationId: orgId, entityType: 'deal', name, position })),
    ],
    skipDuplicates: true,
  })
}

// ---------- Sources ----------

const sourceSelect = { id: true, name: true, key: true, isSystem: true, scoreWeight: true, position: true, archivedAt: true }
const presentSource = ({ archivedAt, ...s }) => ({ ...s, archived: Boolean(archivedAt) })

export async function listSources(ctx) {
  const rows = await prisma.leadSource.findMany({
    where: { organizationId: ctx.orgId },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    select: { ...sourceSelect, _count: { select: { leads: { where: { deletedAt: null } } } } },
  })
  return rows.map(({ _count, ...s }) => ({ ...presentSource(s), leadCount: _count.leads }))
}

export async function getSourceByKey(orgId, key, db = prisma) {
  return db.leadSource.findFirst({ where: { organizationId: orgId, key }, select: sourceSelect })
}

export async function createSource(ctx, { name, scoreWeight }) {
  try {
    const last = await prisma.leadSource.aggregate({ where: { organizationId: ctx.orgId }, _max: { position: true } })
    const row = await prisma.leadSource.create({
      data: { organizationId: ctx.orgId, name, scoreWeight: scoreWeight ?? 5, position: (last._max.position ?? -1) + 1 },
      select: sourceSelect,
    })
    return presentSource(row)
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw validationError({ name: 'A source with this name already exists' })
    throw err
  }
}

async function getSource(ctx, id) {
  const row = await prisma.leadSource.findFirst({ where: { id, organizationId: ctx.orgId }, select: sourceSelect })
  if (!row) throw ApiError.notFound('Source not found')
  return row
}

export async function updateSource(ctx, id, { name, scoreWeight, archived }) {
  const source = await getSource(ctx, id)
  try {
    const row = await prisma.leadSource.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(scoreWeight !== undefined && { scoreWeight }),
        ...(archived !== undefined && { archivedAt: archived ? (source.archivedAt ?? new Date()) : null }),
      },
      select: sourceSelect,
    })
    await recordAudit(prisma, ctx, { action: 'lead_source.update', entityType: 'lead_source', entityId: id, changes: { name, scoreWeight, archived } })
    return presentSource(row)
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw validationError({ name: 'A source with this name already exists' })
    throw err
  }
}

/** Only custom sources no lead uses can be deleted; archive the rest. */
export async function deleteSource(ctx, id) {
  const source = await getSource(ctx, id)
  if (source.isSystem) throw new ApiError(409, 'Built-in sources are used by integrations and can’t be deleted. Archive it instead.', { code: 'SOURCE_SYSTEM' })
  const used = await prisma.lead.count({ where: { organizationId: ctx.orgId, sourceId: id } })
  if (used) throw new ApiError(409, 'Leads use this source. Archive it instead.', { code: 'SOURCE_IN_USE' })
  await prisma.leadSource.delete({ where: { id } })
}

// ---------- Lost reasons ----------

const reasonSelect = { id: true, entityType: true, name: true, position: true, archivedAt: true }
const presentReason = ({ archivedAt, ...r }) => ({ ...r, archived: Boolean(archivedAt) })

export async function listLostReasons(ctx, entityType = 'lead') {
  const rows = await prisma.lostReason.findMany({ where: { organizationId: ctx.orgId, entityType }, orderBy: [{ position: 'asc' }, { name: 'asc' }], select: reasonSelect })
  return rows.map(presentReason)
}

export async function createLostReason(ctx, { entityType = 'lead', name }) {
  try {
    const last = await prisma.lostReason.aggregate({ where: { organizationId: ctx.orgId, entityType }, _max: { position: true } })
    const row = await prisma.lostReason.create({ data: { organizationId: ctx.orgId, entityType, name, position: (last._max.position ?? -1) + 1 }, select: reasonSelect })
    return presentReason(row)
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw validationError({ name: 'This reason already exists' })
    throw err
  }
}

export async function updateLostReason(ctx, id, { name, archived }) {
  const reason = await prisma.lostReason.findFirst({ where: { id, organizationId: ctx.orgId }, select: reasonSelect })
  if (!reason) throw ApiError.notFound('Reason not found')
  try {
    const row = await prisma.lostReason.update({
      where: { id },
      data: { ...(name !== undefined && { name }), ...(archived !== undefined && { archivedAt: archived ? (reason.archivedAt ?? new Date()) : null }) },
      select: reasonSelect,
    })
    return presentReason(row)
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw validationError({ name: 'This reason already exists' })
    throw err
  }
}
