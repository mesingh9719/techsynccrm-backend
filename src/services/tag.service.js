import { prisma, UNIQUE_VIOLATION } from '../db/prisma.js'
import { recordAudit } from '../lib/audit.js'
import { validationError } from '../lib/records.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * Workspace tags (M07) and the polymorphic record_tags join used by contacts, companies, leads
 * and deals.
 */

export const TAG_COLORS = ['zinc', 'brand', 'emerald', 'amber', 'red', 'violet', 'sky', 'pink']
export const MAX_TAGS_PER_RECORD = 20

const tagSelect = { id: true, name: true, color: true }

export async function listTags(ctx) {
  const tags = await prisma.tag.findMany({ where: { organizationId: ctx.orgId }, orderBy: { name: 'asc' }, select: { ...tagSelect, _count: { select: { records: true } } } })
  return tags.map(({ _count, ...t }) => ({ ...t, usage: _count.records }))
}

export async function createTag(ctx, { name, color }) {
  try {
    return await prisma.tag.create({ data: { organizationId: ctx.orgId, name, color: color ?? 'zinc' }, select: tagSelect })
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw validationError({ name: 'A tag with this name already exists' })
    throw err
  }
}

async function getTag(ctx, id) {
  const tag = await prisma.tag.findFirst({ where: { id, organizationId: ctx.orgId }, select: tagSelect })
  if (!tag) throw ApiError.notFound('Tag not found')
  return tag
}

export async function updateTag(ctx, id, input) {
  await getTag(ctx, id)
  try {
    return await prisma.tag.update({ where: { id }, data: input, select: tagSelect })
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw validationError({ name: 'A tag with this name already exists' })
    throw err
  }
}

/** Removes the tag from every record. */
export async function deleteTag(ctx, id) {
  const tag = await getTag(ctx, id)
  await prisma.$transaction(async (tx) => {
    await tx.tag.delete({ where: { id } })
    await recordAudit(tx, ctx, { action: 'tag.delete', entityType: 'tag', entityId: id, changes: { name: [tag.name, null] } })
  })
}

/** Throws unless every id is a tag of this workspace. */
export async function assertTags(ctx, tagIds, db = prisma) {
  const unique = [...new Set(tagIds ?? [])]
  if (unique.length > MAX_TAGS_PER_RECORD) throw validationError({ tagIds: `Use at most ${MAX_TAGS_PER_RECORD} tags` })
  if (!unique.length) return unique
  const n = await db.tag.count({ where: { id: { in: unique }, organizationId: ctx.orgId } })
  if (n !== unique.length) throw validationError({ tagIds: 'One of these tags no longer exists' })
  return unique
}

/** Replaces a record's tags (inside the caller's transaction). */
export async function setRecordTags(tx, ctx, entityType, entityId, tagIds) {
  const ids = await assertTags(ctx, tagIds, tx)
  await tx.recordTag.deleteMany({ where: { organizationId: ctx.orgId, entityType, entityId, ...(ids.length && { tagId: { notIn: ids } }) } })
  if (ids.length) {
    await tx.recordTag.createMany({ data: ids.map((tagId) => ({ organizationId: ctx.orgId, tagId, entityType, entityId })), skipDuplicates: true })
  }
}

/** Adds/removes tags on many records (bulk actions). Respects the per-record maximum on add. */
export async function addTagsToRecords(tx, ctx, entityType, entityIds, tagIds) {
  const ids = await assertTags(ctx, tagIds, tx)
  const counts = await tx.recordTag.groupBy({ by: ['entityId'], where: { organizationId: ctx.orgId, entityType, entityId: { in: entityIds } }, _count: { _all: true } })
  const full = new Set(counts.filter((c) => c._count._all + ids.length > MAX_TAGS_PER_RECORD).map((c) => c.entityId))
  const data = entityIds.filter((id) => !full.has(id)).flatMap((entityId) => ids.map((tagId) => ({ organizationId: ctx.orgId, tagId, entityType, entityId })))
  if (data.length) await tx.recordTag.createMany({ data, skipDuplicates: true })
  return { skipped: [...full] }
}

export async function removeTagsFromRecords(tx, ctx, entityType, entityIds, tagIds) {
  await tx.recordTag.deleteMany({ where: { organizationId: ctx.orgId, entityType, entityId: { in: entityIds }, tagId: { in: tagIds } } })
}

/** Tags for a page of records: Map<entityId, [{ id, name, color }]>. */
export async function tagsFor(orgId, entityType, entityIds, db = prisma) {
  const map = new Map()
  if (!entityIds.length) return map
  const rows = await db.recordTag.findMany({
    where: { organizationId: orgId, entityType, entityId: { in: entityIds } },
    select: { entityId: true, tag: { select: tagSelect } },
    orderBy: { tag: { name: 'asc' } },
  })
  for (const r of rows) {
    if (!map.has(r.entityId)) map.set(r.entityId, [])
    map.get(r.entityId).push(r.tag)
  }
  return map
}

/** `tag=<id>[,<id>]` filter → `{ id: { in } }` for the entity (records with any of the tags). */
export async function tagFilterIds(orgId, entityType, tagIds) {
  const rows = await prisma.recordTag.findMany({ where: { organizationId: orgId, entityType, tagId: { in: tagIds } }, select: { entityId: true }, distinct: ['entityId'] })
  return rows.map((r) => r.entityId)
}

/** Union of tags across records (merge): the survivor gets every tag the duplicates had. */
export async function moveTags(tx, ctx, entityType, fromIds, toId) {
  const rows = await tx.recordTag.findMany({ where: { organizationId: ctx.orgId, entityType, entityId: { in: fromIds } }, select: { tagId: true } })
  if (rows.length) {
    await tx.recordTag.createMany({ data: [...new Set(rows.map((r) => r.tagId))].map((tagId) => ({ organizationId: ctx.orgId, tagId, entityType, entityId: toId })), skipDuplicates: true })
  }
  await tx.recordTag.deleteMany({ where: { organizationId: ctx.orgId, entityType, entityId: { in: fromIds } } })
}

/** Removes the join rows of hard-deleted records (purge job). */
export async function deleteTagsOf(tx, orgId, entityType, entityIds) {
  if (entityIds.length) await tx.recordTag.deleteMany({ where: { organizationId: orgId, entityType, entityId: { in: entityIds } } })
}
