import { planDefinition } from '../config/plans.js'
import { PIPELINE_TEMPLATES, templateCatalogue, templateForIndustry } from '../config/pipelineTemplates.js'
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

/** A new workspace's first pipeline, from its onboarding industry. Idempotent. */
export async function ensureDefaultPipeline(tx, orgId, industry) {
  const existing = await tx.pipeline.count({ where: { organizationId: orgId } })
  if (existing) return
  await createPipelineFromTemplateTx(tx, orgId, templateForIndustry(industry), { isDefault: true })
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
    prisma.deal.groupBy({ by: ['stageId'], where: { AND: [{ organizationId: ctx.orgId, deletedAt: null }, visibilityWhere(ctx, 'deals', 'read')] }, _count: { _all: true } }),
    writablePipelineIds(ctx.orgId, ctx.plan),
  ])
  const byStage = new Map(counts.map((c) => [c.stageId, c._count._all]))
  return pipelines.map(({ archivedAt, ...p }) => ({
    ...p,
    archived: Boolean(archivedAt),
    readOnly: writable ? !writable.has(p.id) : false,
    stages: p.stages.map((s) => ({ ...s, dealCount: byStage.get(s.id) ?? 0 })),
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
  const before = await getPipeline(ctx, id)
  await prisma.$transaction(async (tx) => {
    if (isDefault && !before.isDefault) await tx.pipeline.updateMany({ where: { organizationId: ctx.orgId, isDefault: true }, data: { isDefault: false } })
    if (isDefault === false && before.isDefault) throw validationError({ isDefault: 'Make another pipeline the default instead' })
    await tx.pipeline.update({ where: { id }, data: { ...(name !== undefined && { name }), ...(isDefault && { isDefault: true }) } })
    await recordAudit(tx, ctx, { action: 'pipeline.update', entityType: 'pipeline', entityId: id, changes: { ...(name !== undefined && { name: [before.name, name] }), ...(isDefault && { isDefault: [false, true] }) } })
  })
  return getPipeline(ctx, id)
}

/**
 * Deletes a pipeline. It can't be the default. If it has deals, `moveDealsToStageId` (an open
 * stage of another pipeline) receives the open ones; won/lost deals go to that pipeline's Won/Lost.
 */
export async function deletePipeline(ctx, id, { moveDealsToStageId } = {}) {
  const pipeline = await getPipeline(ctx, id)
  if (pipeline.isDefault) throw new ApiError(409, 'The default pipeline can’t be deleted. Make another one the default first.', { code: 'PIPELINE_DEFAULT' })
  const dealCount = await prisma.deal.count({ where: { organizationId: ctx.orgId, pipelineId: id } })
  let target = null
  if (dealCount) {
    if (!moveDealsToStageId) throw new ApiError(409, 'This pipeline has deals. Choose where to move them.', { code: 'PIPELINE_NOT_EMPTY', details: { dealCount } })
    target = await prisma.pipelineStage.findFirst({ where: { id: moveDealsToStageId, organizationId: ctx.orgId, type: 'open', pipelineId: { not: id } }, select: { id: true, pipelineId: true } })
    if (!target) throw validationError({ moveDealsToStageId: 'Choose an open stage in another pipeline' })
  }
  await prisma.$transaction(async (tx) => {
    if (target) {
      const outcome = await tx.pipelineStage.findMany({ where: { pipelineId: target.pipelineId, type: { in: ['won', 'lost'] } }, select: { id: true, type: true } })
      const stageFor = { open: target.id, won: outcome.find((s) => s.type === 'won').id, lost: outcome.find((s) => s.type === 'lost').id }
      const deals = await tx.deal.findMany({ where: { organizationId: ctx.orgId, pipelineId: id }, select: { id: true, stageId: true, status: true, stageEnteredAt: true } })
      await moveDealsForRemovalTx(tx, ctx, deals.map((d) => d.id), stageFor)
    }
    // History rows pointing at the deleted pipeline's stages stay (ids only, no FK).
    await tx.pipeline.delete({ where: { id } })
    await recordAudit(tx, ctx, { action: 'pipeline.delete', entityType: 'pipeline', entityId: id, changes: { name: [pipeline.name, null], movedDeals: dealCount } })
  })
}

// ---------- Stages ----------

async function validateRequiredFields(ctx, fields = []) {
  const unique = [...new Set(fields)]
  const custom = unique.filter((f) => f.startsWith('cf.')).map((f) => f.slice(3))
  const bad = unique.filter((f) => !f.startsWith('cf.') && !REQUIRABLE_FIELDS.includes(f))
  if (custom.length) {
    const defs = await prisma.customFieldDefinition.findMany({ where: { organizationId: ctx.orgId, entityType: 'deal', key: { in: custom } }, select: { key: true } })
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
  const pipeline = await getPipeline(ctx, pipelineId)
  const requiredFields = await validateRequiredFields(ctx, input.requiredFields)
  const openCount = pipeline.stages.filter((s) => s.type === 'open').length
  await prisma.$transaction(async (tx) => {
    // New open stage goes after the last open one; Won and Lost shift down.
    await tx.pipelineStage.updateMany({ where: { pipelineId, type: { in: ['won', 'lost'] } }, data: { position: { increment: 1 } } })
    const stage = await tx.pipelineStage.create({
      data: { organizationId: ctx.orgId, pipelineId, name: input.name, type: 'open', position: openCount, probability: input.probability ?? 50, rottingDays: input.rottingDays ?? null, requiredFields },
      select: { id: true },
    })
    await recordAudit(tx, ctx, { action: 'pipeline.stage_create', entityType: 'pipeline', entityId: pipelineId, changes: { stageId: stage.id, name: input.name } })
  })
  return getPipeline(ctx, pipelineId)
}

export async function updateStage(ctx, pipelineId, stageId, input) {
  const stage = await getStage(ctx, pipelineId, stageId)
  const system = stage.type !== 'open'
  if (system && (input.probability !== undefined || input.rottingDays !== undefined || input.requiredFields !== undefined)) {
    // Won/Lost can only be renamed — except required fields on Won, which teams use (e.g. PO number).
    if (input.probability !== undefined || input.rottingDays !== undefined || (stage.type === 'lost' && input.requiredFields !== undefined)) {
      throw validationError({ [input.probability !== undefined ? 'probability' : input.rottingDays !== undefined ? 'rottingDays' : 'requiredFields']: 'Won and Lost stages can only be renamed' })
    }
  }
  const data = {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.probability !== undefined && { probability: input.probability }),
    ...(input.rottingDays !== undefined && { rottingDays: input.rottingDays }),
    ...(input.requiredFields !== undefined && { requiredFields: await validateRequiredFields(ctx, input.requiredFields) }),
  }
  await prisma.$transaction(async (tx) => {
    await tx.pipelineStage.update({ where: { id: stageId }, data })
    await recordAudit(tx, ctx, { action: 'pipeline.stage_update', entityType: 'pipeline', entityId: pipelineId, changes: { stageId, ...data } })
  })
  return getPipeline(ctx, pipelineId)
}

/** Deletes an open stage; its deals (if any) move to `moveDealsToStageId` in the same pipeline. */
export async function deleteStage(ctx, pipelineId, stageId, { moveDealsToStageId } = {}) {
  const pipeline = await getPipeline(ctx, pipelineId)
  const stage = pipeline.stages.find((s) => s.id === stageId)
  if (!stage) throw ApiError.notFound('Stage not found')
  if (stage.type !== 'open') throw new ApiError(409, 'Won and Lost stages can’t be deleted.', { code: 'STAGE_SYSTEM' })
  if (pipeline.stages.filter((s) => s.type === 'open').length <= 1) throw new ApiError(409, 'A pipeline needs at least one open stage.', { code: 'STAGE_LAST' })
  const deals = await prisma.deal.findMany({ where: { organizationId: ctx.orgId, stageId }, select: { id: true, stageEnteredAt: true } })
  let target = null
  if (deals.length) {
    target = pipeline.stages.find((s) => s.id === moveDealsToStageId && s.type === 'open' && s.id !== stageId)
    if (!target) throw new ApiError(409, 'This stage has deals. Choose another open stage to move them to.', { code: 'STAGE_NOT_EMPTY', details: { dealCount: deals.length } })
  }
  await prisma.$transaction(async (tx) => {
    if (target) {
      await moveDealsForRemovalTx(tx, ctx, deals.map((d) => d.id), { open: target.id })
    }
    await tx.pipelineStage.delete({ where: { id: stageId } })
    await tx.pipelineStage.updateMany({ where: { pipelineId, position: { gt: stage.position } }, data: { position: { decrement: 1 } } })
    await recordAudit(tx, ctx, { action: 'pipeline.stage_delete', entityType: 'pipeline', entityId: pipelineId, changes: { stageId, name: stage.name, movedDeals: deals.length } })
  })
  return getPipeline(ctx, pipelineId)
}

/** PATCH /pipelines/:id/stages/order { stageIds } — open stages in their new order; Won/Lost stay last. */
export async function reorderStages(ctx, pipelineId, stageIds) {
  const pipeline = await getPipeline(ctx, pipelineId)
  const open = pipeline.stages.filter((s) => s.type === 'open')
  const openIds = new Set(open.map((s) => s.id))
  const ids = stageIds.filter((id) => openIds.has(id))
  if (ids.length !== open.length || stageIds.length !== open.length || new Set(ids).size !== ids.length) throw validationError({ stageIds: 'List every open stage exactly once' })
  const system = pipeline.stages.filter((s) => s.type !== 'open').sort((a, b) => (a.type === 'won' ? -1 : b.type === 'won' ? 1 : 0))
  await prisma.$transaction([...ids, ...system.map((s) => s.id)].map((id, position) => prisma.pipelineStage.update({ where: { id }, data: { position } })))
  return getPipeline(ctx, pipelineId)
}

export function assertCanManage(ctx) {
  if (!ctx.permissions.includes('settings.pipelines.manage')) throw forbidden('Only admins can change pipelines.')
}
