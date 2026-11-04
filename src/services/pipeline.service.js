import { Prisma } from '../generated/prisma/client.js'
import { planDefinition } from '../config/plans.js'
import { PIPELINE_TEMPLATES, templateCatalogue, templateKey } from '../config/pipelineTemplates.js'
import { prisma } from '../db/prisma.js'
import { emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { validationError } from '../lib/records.js'
import { visibilityWhere } from '../lib/visibility.js'
import { ApiError } from '../utils/ApiError.js'
import { assertWithinLimit } from './entitlements.service.js'
import { moveDealsForRemovalTx } from './deal.service.js'

/**
 * Pipelines and stages (M09). Each pipeline has its open stages followed by the two system stages
 * Won and Lost, which can be renamed but not deleted or reordered.
 */

/** Core deal fields a stage can require (plus "cf.<key>" for deal custom fields). */
export const REQUIRABLE_FIELDS = ['valueMinor', 'expectedCloseDate', 'companyId', 'contacts', 'ownerId']

const stageSelect = { id: true, pipelineId: true, name: true, type: true, position: true, probability: true, rottingDays: true, requiredFields: true }
const pipelineSelect = { id: true, name: true, isDefault: true, position: true, templateKey: true, archivedAt: true, createdAt: true, updatedAt: true }

// Settings writes serialize per workspace; deal writes retain their existing row/FK locks.
async function lockSettings(tx, orgId) {
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`
}

const forbidden = (message) => new ApiError(403, message, { code: 'FORBIDDEN' })

// ---------- Creation from templates ----------

/** Creates a pipeline with the template's open stages plus Won and Lost (inside `tx`). */
export async function createPipelineFromTemplateTx(tx, orgId, templateKey, { name, isDefault = false, position = 0 } = {}) {
  const template = PIPELINE_TEMPLATES[templateKey] ?? PIPELINE_TEMPLATES.default
  const pipeline = await tx.pipeline.create({
    data: { organizationId: orgId, name: name ?? template.name, isDefault, position, templateKey: PIPELINE_TEMPLATES[templateKey] ? templateKey : 'default' },
    select: pipelineSelect,
  })
  const open = template.stages.map((s, i) => ({ organizationId: orgId, pipelineId: pipeline.id, name: s.name, type: 'open', position: i, probability: s.probability, rottingDays: s.rottingDays }))
  await tx.pipelineStage.createMany({
    data: [
      ...open,
      { organizationId: orgId, pipelineId: pipeline.id, name: 'Won', type: 'won', position: open.length, probability: 100, rottingDays: null },
      { organizationId: orgId, pipelineId: pipeline.id, name: 'Lost', type: 'lost', position: open.length + 1, probability: 0, rottingDays: null },
    ],
  })
  return pipeline
}

/** A new workspace's first pipeline, from the template its industry names. Idempotent. */
export async function ensureDefaultPipeline(tx, orgId, template) {
  const existing = await tx.pipeline.count({ where: { organizationId: orgId } })
  if (existing) return
  await createPipelineFromTemplateTx(tx, orgId, templateKey(template), { isDefault: true })
}

export const listTemplates = () => templateCatalogue()

// ---------- Plan limits ----------

/**
 * Pipelines the workspace may still add deals to. After a downgrade, pipelines beyond the plan's
 * limit (keeping the default first, then by position) are read-only: deals in them can only be
 * moved to Won or Lost (M06 D2).
 * @returns {Promise<Set<string> | null>} writable ids, or null when every pipeline is writable
 */
export async function writablePipelineIds(orgId, plan, db = prisma) {
  const limit = planDefinition(plan).limits.pipelines
  if (!Number.isFinite(limit)) return null
  const rows = await db.pipeline.findMany({
    where: { organizationId: orgId, archivedAt: null },
    orderBy: [{ isDefault: 'desc' }, { position: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  })
  if (rows.length <= limit) return null
  return new Set(rows.slice(0, limit).map((r) => r.id))
}

// ---------- Read ----------

export async function listPipelines(ctx, { includeArchived = false } = {}) {
  const [pipelines, counts, writable] = await Promise.all([
    prisma.pipeline.findMany({
      where: { organizationId: ctx.orgId, ...(!includeArchived && { archivedAt: null }) },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { ...pipelineSelect, stages: { orderBy: { position: 'asc' }, select: stageSelect } },
    }),
    prisma.deal.groupBy({ by: ['stageId'], where: { AND: [{ organizationId: ctx.orgId }, visibilityWhere(ctx, 'deals', 'read')] }, _count: { _all: true, deletedAt: true } }),
    writablePipelineIds(ctx.orgId, ctx.plan),
  ])
  const byStage = new Map(counts.map(c => [c.stageId, c._count._all - (c._count.deletedAt ?? 0)]))
  const totalByStage = new Map(counts.map(c => [c.stageId, c._count._all]))
  return pipelines.map(({ archivedAt, ...p }) => ({
    ...p,
    archived: Boolean(archivedAt),
    readOnly: writable ? !writable.has(p.id) : false,
    stages: p.stages.map((s) => ({ ...s, dealCount: byStage.get(s.id) ?? 0, totalDealCount: totalByStage.get(s.id) ?? 0 })),
    totalDealCount: p.stages.reduce((n, s) => n + (totalByStage.get(s.id) ?? 0), 0),
    dealCount: p.stages.reduce((n, s) => n + (byStage.get(s.id) ?? 0), 0),
  }))
}

export async function getPipeline(ctx, id, db = prisma) {
  const pipeline = await db.pipeline.findFirst({
    where: { id, organizationId: ctx.orgId },
    select: { ...pipelineSelect, stages: { orderBy: { position: 'asc' }, select: stageSelect } },
  })
  if (!pipeline) throw ApiError.notFound('Pipeline not found')
  return pipeline
}

/** The default pipeline and its first open stage (lead conversion, quick-create). */
export async function defaultStage(orgId, db = prisma) {
  const pipeline = await db.pipeline.findFirst({
    where: { organizationId: orgId, archivedAt: null },
    orderBy: [{ isDefault: 'desc' }, { position: 'asc' }],
    select: { id: true, stages: { where: { type: 'open' }, orderBy: { position: 'asc' }, take: 1, select: { id: true } } },
  })
  return pipeline?.stages[0] ? { pipelineId: pipeline.id, stageId: pipeline.stages[0].id } : null
}

// ---------- Pipelines ----------

export async function createPipeline(ctx, { name, templateKey = 'default' }) {
  const pipeline = await prisma.$transaction(async (tx) => {
    await assertWithinLimit(ctx, 'pipelines', 1, tx)
    const last = await tx.pipeline.aggregate({ where: { organizationId: ctx.orgId }, _max: { position: true } })
    const hasDefault = await tx.pipeline.count({ where: { organizationId: ctx.orgId, isDefault: true, archivedAt: null } })
    const created = await createPipelineFromTemplateTx(tx, ctx.orgId, templateKey, { name, isDefault: !hasDefault, position: (last._max.position ?? -1) + 1 })
    await emit(tx, ctx, 'pipeline.created', { entityType: 'pipeline', entityId: created.id }, { templateKey })
    await recordAudit(tx, ctx, { action: 'pipeline.create', entityType: 'pipeline', entityId: created.id, changes: { name: [null, created.name], templateKey } })
    return created
  })
  return getPipeline(ctx, pipeline.id)
}

export async function updatePipeline(ctx, id, { name, isDefault }) {
  await prisma.$transaction(async tx => {
    await lockSettings(tx, ctx.orgId)
    const before = await getPipeline(ctx, id, tx)
    if (isDefault && !before.isDefault) await tx.pipeline.updateMany({ where: { organizationId: ctx.orgId, isDefault: true }, data: { isDefault: false } })
    if (isDefault === false && before.isDefault) throw validationError({ isDefault: 'Make another pipeline the default instead' })
    await tx.pipeline.update({ where: { id, organizationId: ctx.orgId }, data: { ...(name !== undefined && { name }), ...(isDefault && { isDefault: true }) } })
    await recordAudit(tx, ctx, { action: 'pipeline.update', entityType: 'pipeline', entityId: id, changes: { ...(name !== undefined && { name: [before.name, name] }), ...(isDefault && { isDefault: [before.isDefault, true] }) } })
  })
  return getPipeline(ctx, id)
}

/** Preserve every deal (including trash) and its outcome/history when removing a pipeline. */
export async function deletePipeline(ctx, id, { moveDealsToStageId } = {}) {
  try {
    await prisma.$transaction(async tx => {
      await lockSettings(tx, ctx.orgId)
      const pipeline = await getPipeline(ctx, id, tx)
      if (pipeline.isDefault) throw new ApiError(409, 'The default pipeline can’t be deleted. Make another one the default first.', { code: 'PIPELINE_DEFAULT' })
      const dealCount = await tx.deal.count({ where: { organizationId: ctx.orgId, pipelineId: id } })
      if (dealCount) {
        if (!moveDealsToStageId) throw new ApiError(409, 'This pipeline has deals. Choose where to move them.', { code: 'PIPELINE_NOT_EMPTY', details: { dealCount } })
        const target = await tx.pipelineStage.findFirst({ where: { id: moveDealsToStageId, organizationId: ctx.orgId, type: 'open', pipelineId: { not: id }, pipeline: { archivedAt: null } }, select: { id: true, pipelineId: true } })
        if (!target) throw validationError({ moveDealsToStageId: 'Choose an open stage in another pipeline' })
        const outcome = await tx.pipelineStage.findMany({ where: { organizationId: ctx.orgId, pipelineId: target.pipelineId, type: { in: ['won', 'lost'] } }, select: { id: true, type: true } })
        const stageFor = { open: target.id, won: outcome.find(s => s.type === 'won')?.id, lost: outcome.find(s => s.type === 'lost')?.id }
        if (!stageFor.won || !stageFor.lost) throw validationError({ moveDealsToStageId: 'Choose a pipeline with Won and Lost stages' })
        const deals = await tx.deal.findMany({ where: { organizationId: ctx.orgId, pipelineId: id }, select: { id: true } })
        await moveDealsForRemovalTx(tx, ctx, deals.map(d => d.id), stageFor)
      }
      await tx.pipeline.delete({ where: { id, organizationId: ctx.orgId } })
      await recordAudit(tx, ctx, { action: 'pipeline.delete', entityType: 'pipeline', entityId: id, changes: { name: [pipeline.name, null], movedDeals: dealCount } })
    })
  } catch (error) {
    if (error.code === 'P2003') throw new ApiError(409, 'The pipeline received another deal. Refresh and choose where to move its deals.', { code: 'PIPELINE_NOT_EMPTY' })
    throw error
  }
}

// ---------- Stages ----------

async function validateRequiredFields(ctx, fields = [], db = prisma) {
  const unique = [...new Set(fields)]
  const custom = unique.filter((f) => f.startsWith('cf.')).map((f) => f.slice(3))
  const bad = unique.filter((f) => !f.startsWith('cf.') && !REQUIRABLE_FIELDS.includes(f))
  if (custom.length) {
    const defs = await db.customFieldDefinition.findMany({ where: { organizationId: ctx.orgId, entityType: 'deal', key: { in: custom } }, select: { key: true } })
    const known = new Set(defs.map((d) => d.key))
    bad.push(...custom.filter((k) => !known.has(k)).map((k) => `cf.${k}`))
  }
  if (bad.length) throw validationError({ requiredFields: `Unknown field: ${bad.join(', ')}` })
  return unique
}

async function getStage(ctx, pipelineId, stageId, db = prisma) {
  const stage = await db.pipelineStage.findFirst({ where: { id: stageId, pipelineId, organizationId: ctx.orgId }, select: stageSelect })
  if (!stage) throw ApiError.notFound('Stage not found')
  return stage
}

export async function createStage(ctx, pipelineId, input) {
  await prisma.$transaction(async tx => {
    await lockSettings(tx, ctx.orgId)
    const pipeline = await getPipeline(ctx, pipelineId, tx)
    const requiredFields = await validateRequiredFields(ctx, input.requiredFields, tx)
    const openCount = pipeline.stages.filter(s => s.type === 'open').length
    await tx.pipelineStage.updateMany({ where: { organizationId: ctx.orgId, pipelineId, type: { in: ['won', 'lost'] } }, data: { position: { increment: 1 } } })
    const stage = await tx.pipelineStage.create({ data: { organizationId: ctx.orgId, pipelineId, name: input.name, type: 'open', position: openCount, probability: input.probability ?? 50, rottingDays: input.rottingDays ?? null, requiredFields }, select: { id: true } })
    await recordAudit(tx, ctx, { action: 'pipeline.stage_create', entityType: 'pipeline', entityId: pipelineId, changes: { stageId: stage.id, name: input.name } })
  })
  return getPipeline(ctx, pipelineId)
}

export async function updateStage(ctx, pipelineId, stageId, input) {
  await prisma.$transaction(async tx => {
    await lockSettings(tx, ctx.orgId)
    const stage = await getStage(ctx, pipelineId, stageId, tx)
    if (stage.type !== 'open' && (input.probability !== undefined || input.rottingDays !== undefined || (stage.type === 'lost' && input.requiredFields !== undefined))) {
      throw validationError({ [input.probability !== undefined ? 'probability' : input.rottingDays !== undefined ? 'rottingDays' : 'requiredFields']: 'Won and Lost stages can only be renamed (Won may also require fields)' })
    }
    const data = { ...(input.name !== undefined && { name: input.name }), ...(input.probability !== undefined && { probability: input.probability }), ...(input.rottingDays !== undefined && { rottingDays: input.rottingDays }), ...(input.requiredFields !== undefined && { requiredFields: await validateRequiredFields(ctx, input.requiredFields, tx) }) }
    await tx.pipelineStage.update({ where: { id: stageId, organizationId: ctx.orgId, pipelineId }, data })
    await recordAudit(tx, ctx, { action: 'pipeline.stage_update', entityType: 'pipeline', entityId: pipelineId, changes: { stageId, ...data } })
  })
  return getPipeline(ctx, pipelineId)
}

export async function deleteStage(ctx, pipelineId, stageId, { moveDealsToStageId } = {}) {
  try {
    await prisma.$transaction(async tx => {
      await lockSettings(tx, ctx.orgId)
      const pipeline = await getPipeline(ctx, pipelineId, tx)
      const stage = pipeline.stages.find(s => s.id === stageId)
      if (!stage) throw ApiError.notFound('Stage not found')
      if (stage.type !== 'open') throw new ApiError(409, 'Won and Lost stages can’t be deleted.', { code: 'STAGE_SYSTEM' })
      if (pipeline.stages.filter(s => s.type === 'open').length <= 1) throw new ApiError(409, 'A pipeline needs at least one open stage.', { code: 'STAGE_LAST' })
      const deals = await tx.deal.findMany({ where: { organizationId: ctx.orgId, stageId }, select: { id: true } })
      if (deals.length) {
        const target = pipeline.stages.find(s => s.id === moveDealsToStageId && s.type === 'open' && s.id !== stageId)
        if (!target) throw new ApiError(409, 'This stage has deals, including any in the bin. Choose another open stage to move them to.', { code: 'STAGE_NOT_EMPTY', details: { dealCount: deals.length } })
        await moveDealsForRemovalTx(tx, ctx, deals.map(d => d.id), { open: target.id })
      }
      await tx.pipelineStage.delete({ where: { id: stageId, organizationId: ctx.orgId, pipelineId } })
      await tx.pipelineStage.updateMany({ where: { organizationId: ctx.orgId, pipelineId, position: { gt: stage.position } }, data: { position: { decrement: 1 } } })
      await recordAudit(tx, ctx, { action: 'pipeline.stage_delete', entityType: 'pipeline', entityId: pipelineId, changes: { stageId, name: stage.name, movedDeals: deals.length } })
    })
  } catch (error) {
    if (error.code === 'P2003') throw new ApiError(409, 'The stage received another deal. Refresh and choose a destination before deleting it.', { code: 'STAGE_NOT_EMPTY' })
    throw error
  }
  return getPipeline(ctx, pipelineId)
}

export async function reorderStages(ctx, pipelineId, stageIds) {
  await prisma.$transaction(async tx => {
    await lockSettings(tx, ctx.orgId)
    const pipeline = await getPipeline(ctx, pipelineId, tx)
    const open = pipeline.stages.filter(s => s.type === 'open')
    const openIds = new Set(open.map(s => s.id))
    if (stageIds.length !== open.length || new Set(stageIds).size !== stageIds.length || stageIds.some(id => !openIds.has(id))) throw validationError({ stageIds: 'List every open stage exactly once' })
    const system = ['won', 'lost'].flatMap(type => pipeline.stages.filter(s => s.type === type).map(s => s.id))
    const ordering = Prisma.join([...stageIds, ...system].map((id, position) => Prisma.sql`(${id}::uuid, ${position}::integer)`))
    await tx.$executeRaw(Prisma.sql`UPDATE pipeline_stages AS stage SET position = ordering.pos, updated_at = NOW() FROM (VALUES ${ordering}) AS ordering(id, pos) WHERE stage.organization_id = ${ctx.orgId}::uuid AND stage.pipeline_id = ${pipelineId}::uuid AND stage.id = ordering.id`)
    await recordAudit(tx, ctx, { action: 'pipeline.stage_reorder', entityType: 'pipeline', entityId: pipelineId, changes: { stageIds } })
  })
  return getPipeline(ctx, pipelineId)
}

export function assertCanManage(ctx) {
  if (!ctx.permissions.includes('settings.pipelines.manage')) throw forbidden('Only admins can change pipelines.')
}
