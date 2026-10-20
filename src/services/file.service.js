import { logger } from '../lib/logger.js'
import crypto from 'node:crypto'
import path from 'node:path'
import sharp from 'sharp'
import { env } from '../config/env.js'
import { prisma } from '../db/prisma.js'
import { emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { assertFileSize, downloadDisposition, sniffFile } from '../lib/fileSafety.js'
import { registerConversionHook, registerMergeHook } from '../lib/merge.js'
import { objectStore } from '../storage/objectStore.js'
import { ApiError } from '../utils/ApiError.js'
import { assertWithinLimit, refreshUsage } from './entitlements.service.js'
import { loadRecord } from './recordRef.service.js'

const notFound = () => ApiError.notFound('File not found')
const forbidden = () => new ApiError(403, 'You cannot change this file.', { code: 'FORBIDDEN' })
export const presentFile = (r) => ({ id: r.id, name: r.originalName, contentType: r.contentType, size: Number(r.sizeBytes), createdAt: r.createdAt, deletedAt: r.deletedAt, status: r.status, uploadedById: r.userId })
const canManage = (ctx, file) => file.userId === ctx.userId || ['owner', 'admin'].includes(ctx.role)
const keyFor = (ctx, name) => `orgs/${ctx.orgId}/${new Date().toISOString().slice(0, 7).replace('-', '/')}/${crypto.randomUUID()}-${path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '-').slice(-100)}`

async function reference(ctx, ref, action = 'read', db = prisma) {
  if (ref.entityType === 'activity') {
    const activity = await db.activity.findFirst({ where: { id: ref.entityId, organizationId: ctx.orgId, deletedAt: null } })
    if (!activity) throw notFound()
    return loadRecord(ctx, activity.entityType, activity.entityId, action, db)
  }
  if (ref.entityType === 'import') {
    const job = await db.importJob.findFirst({ where: { id: ref.entityId, organizationId: ctx.orgId, ...(!['owner', 'admin'].includes(ctx.role) && { createdById: ctx.userId }) } })
    if (!job) throw notFound()
    return job
  }
  return loadRecord(ctx, ref.entityType, ref.entityId, action, db)
}
export async function accessibleFile(ctx, id, { manage = false, deleted = false } = {}) {
  const file = await prisma.file.findFirst({ where: { id, organizationId: ctx.orgId, ...(!deleted && { deletedAt: null }) }, include: { links: { where: { deletedAt: null } } } })
  if (!file || file.status === 'purging' || file.expiresAt && file.expiresAt <= new Date()) throw notFound()
  if (manage) { if (!canManage(ctx, file)) throw forbidden(); return file }
  if (file.userId === ctx.userId) return file
  if (await prisma.organization.count({ where: { id: ctx.orgId, logoFileId: id } })) return file
  if (await prisma.user.count({ where: { avatarFileId: id, deletedAt: null, memberships: { some: { organizationId: ctx.orgId, status: 'active' } } } })) return file
  for (const link of file.links) {
    try { await reference(ctx, link); return file } catch (e) { if (![403, 404].includes(e.statusCode)) throw e }
  }
  throw notFound()
}
async function reserveFile(ctx, name, size, contentType, ref, expiresAt = null) {
  if (ctx.role === 'viewer') throw forbidden()
  if (ref?.entityType) await reference(ctx, ref, 'update')
  return prisma.$transaction(async (tx) => {
    await assertWithinLimit(ctx, 'storage', size, tx)
    const file = await tx.file.create({ data: { userId: ctx.userId, organizationId: ctx.orgId, storageKey: `pending/${ctx.orgId}/${crypto.randomUUID()}`, originalName: name, contentType, sizeBytes: BigInt(size), status: 'pending', expiresAt } })
    if (ref?.entityType) await tx.fileLink.create({ data: { fileId: file.id, organizationId: ctx.orgId, entityType: ref.entityType, entityId: ref.entityId, createdById: ctx.userId } })
    return file
  })
}
export async function createUploadIntent(ctx, { name, size, contentType: _declared, ...ref }) {
  const contentType = assertFileSize(name, size, env.MAX_UPLOAD_MB)
  const file = await reserveFile(ctx, name, size, contentType, ref)
  try { return { fileId: file.id, ...(await objectStore.intent(file.storageKey, contentType, size)) } }
  catch (err) { await prisma.file.delete({ where: { id: file.id } }); throw err }
}
export async function completeUpload(ctx, id) {
  const file = await accessibleFile(ctx, id, { manage: true })
  if (file.status === 'ready') return presentFile(file)
  if (file.status !== 'pending' || file.userId !== ctx.userId) throw notFound()
  const head = await objectStore.head(file.storageKey)
  if (Number(head.ContentLength) !== Number(file.sizeBytes)) throw new ApiError(400, 'Uploaded size differs from the reserved size.', { code: 'INVALID_FILE_SIZE' })
  assertFileSize(file.originalName, Number(head.ContentLength), env.MAX_UPLOAD_MB)
  const bytes = await objectStore.bytes(file.storageKey)
  if (bytes.length !== Number(file.sizeBytes)) throw new ApiError(400, 'Upload changed during verification.', { code: 'INVALID_FILE_SIZE' })
  const contentType = await sniffFile(file.originalName, bytes)
  const finalKey = keyFor(ctx, file.originalName)
  // A still-valid POST may overwrite its pending key. Publish exactly the bytes just verified
  // under a new key that was never covered by a client upload signature. This also avoids relying
  // on provider-specific CopyObject conditional-header enforcement.
  await objectStore.upload(finalKey, bytes, contentType)
  let updated
  try {
    updated = await prisma.$transaction(async (tx) => {
      await assertWithinLimit(ctx, 'storage', 0, tx)
      const current = await tx.file.findFirst({ where: { id, organizationId: ctx.orgId, userId: ctx.userId, status: 'pending', deletedAt: null } })
      if (!current) throw new ApiError(409, 'Upload already completed or removed.', { code: 'CONFLICT' })
      const row = await tx.file.update({ where: { id }, data: { storageKey: finalKey, contentType, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), status: 'ready' } })
      await emit(tx, ctx, 'file.uploaded', { entityType: 'file', entityId: id })
      await recordAudit(tx, ctx, { action: 'file.upload', entityType: 'file', entityId: id })
      return row
    })
  } catch (err) { await objectStore.delete(finalKey).catch(() => {}); throw err }
  await objectStore.delete(file.storageKey).catch(() => {})
  await refreshUsage(ctx.orgId).catch((err) => logger.warn({ err }, 'file usage cache refresh deferred'))
  return presentFile(updated)
}
export async function uploadFile(ctx, file, ref = {}) {
  if (file.size > 10 * 1024 ** 2) throw new ApiError(413, 'Use a direct upload for files larger than 10 MB.', { code: 'DIRECT_UPLOAD_REQUIRED' })
  const contentType = assertFileSize(file.originalname, file.size, env.MAX_UPLOAD_MB)
  await sniffFile(file.originalname, file.buffer)
  const reserved = await reserveFile(ctx, file.originalname, file.size, contentType, ref)
  try {
    await objectStore.upload(reserved.storageKey, file.buffer, contentType)
    return await completeUpload(ctx, reserved.id)
  } catch (err) {
    await objectStore.delete(reserved.storageKey).catch(() => {})
    await prisma.file.deleteMany({ where: { id: reserved.id, status: 'pending' } })
    throw err
  }
}
export async function listFiles(ctx, query = {}) {
  if (query.entityType) await reference(ctx, query)
  const rows = await prisma.file.findMany({ where: { organizationId: ctx.orgId, status: 'ready', deletedAt: query.deleted === 'true' ? { not: null } : null,
    ...(query.entityType ? { links: { some: { entityType: query.entityType, entityId: query.entityId, deletedAt: null } } } : { userId: ctx.userId }) }, orderBy: { createdAt: 'desc' }, take: 200 })
  return rows.map(presentFile)
}
export async function getFileWithUrl(ctx, id) {
  let file = await accessibleFile(ctx, id)
  if (file.status !== 'ready') throw notFound()
  // Existing files were accepted without sniffing. Validate once before ever signing them again.
  if (!file.sha256) {
    const head = await objectStore.head(file.storageKey)
    assertFileSize(file.originalName, Number(head.ContentLength), env.MAX_UPLOAD_MB)
    const bytes = await objectStore.bytes(file.storageKey)
    const contentType = await sniffFile(file.originalName, bytes)
    file = await prisma.file.update({ where: { id }, data: { contentType, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } })
  }
  const ttl = file.expiresAt ? Math.max(1, Math.min(env.STORAGE_URL_EXPIRES_IN, Math.floor((file.expiresAt - Date.now()) / 1000))) : env.STORAGE_URL_EXPIRES_IN
  const url = await objectStore.url(file.storageKey, file.contentType, downloadDisposition(file.originalName, file.contentType), ttl)
  const thumbnailUrl = file.thumbnailKey ? await objectStore.url(file.thumbnailKey, 'image/webp', 'inline') : null
  return { ...presentFile(file), url, thumbnailUrl, urlExpiresIn: ttl }
}
export async function linkFile(ctx, id, ref) {
  const file = await accessibleFile(ctx, id)
  if (ctx.role === 'viewer' || file.status !== 'ready') throw forbidden()
  await reference(ctx, ref, 'update')
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM files WHERE id = ${id}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`
    const current = await tx.file.findFirst({ where: { id, organizationId: ctx.orgId, status: 'ready', deletedAt: null } })
    if (!current) throw notFound()
    await reference(ctx, ref, 'update', tx)
    await tx.fileLink.upsert({ where: { fileId_entityType_entityId: { fileId: id, entityType: ref.entityType, entityId: ref.entityId } }, create: { fileId: id, organizationId: ctx.orgId, ...ref, createdById: ctx.userId }, update: { deletedAt: null } })
  })
}
export async function unlinkFile(ctx, id, ref) {
  await accessibleFile(ctx, id)
  await reference(ctx, ref, 'update')
  await prisma.fileLink.updateMany({ where: { fileId: id, organizationId: ctx.orgId, ...ref }, data: { deletedAt: new Date() } })
}
export async function deleteFile(ctx, id) {
  await accessibleFile(ctx, id, { manage: true })
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM files WHERE id = ${id}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`
    if (await tx.organization.count({ where: { logoFileId: id } }) || await tx.user.count({ where: { avatarFileId: id } })) throw new ApiError(409, 'Remove this image from the profile or workspace before deleting it.', { code: 'FILE_IN_USE' })
    await tx.file.update({ where: { id, organizationId: ctx.orgId }, data: { deletedAt: new Date() } })
    await recordAudit(tx, ctx, { action: 'file.delete', entityType: 'file', entityId: id })
  })
}
export async function restoreFile(ctx, id) {
  await accessibleFile(ctx, id, { manage: true, deleted: true })
  const restored = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM files WHERE id = ${id}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`
    const file = await tx.file.findFirst({ where: { id, organizationId: ctx.orgId } })
    if (!file || file.status === 'purging' || file.expiresAt && file.expiresAt <= new Date()) throw notFound()
    if (!canManage(ctx, file)) throw forbidden()
    if (file.deletedAt && Date.now() - file.deletedAt.getTime() > 30 * 86400000) throw new ApiError(410, 'The restore window has ended.', { code: 'RESTORE_EXPIRED' })
    return tx.file.update({ where: { id, organizationId: ctx.orgId }, data: { deletedAt: null } })
  })
  return presentFile(restored)
}

/** Bounded hourly maintenance. Quota includes pending reservations, deleted files and thumbnails. */
export async function maintainFiles(now = new Date()) {
  const cutoff = new Date(now - 30 * 86400000)
  // Filter protected/actively linked files before the batch limit; otherwise the oldest live
  // attachments can occupy every slot and permanently starve expired uploads behind them.
  const candidates = await prisma.$queryRaw`
    SELECT f.id FROM files f
    WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.logo_file_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM import_jobs i WHERE i.file_id = f.id)
      AND (f.status = 'purging' OR f.expires_at <= ${now}
        OR (f.status = 'pending' AND f.created_at < ${new Date(now - 86400000)})
        OR f.deleted_at < ${cutoff}
        OR (f.status = 'ready' AND f.deleted_at IS NULL AND f.created_at < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM file_links l WHERE l.file_id = f.id
            AND (l.deleted_at IS NULL OR l.deleted_at >= ${cutoff}))))
    ORDER BY f.created_at ASC LIMIT 500`
  const rows = await prisma.file.findMany({ where: { id: { in: candidates.map((f) => f.id) } }, orderBy: { createdAt: 'asc' } })
  for (const candidate of rows) {
    const file = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM files WHERE id = ${candidate.id}::uuid FOR UPDATE`
      const file = await tx.file.findUnique({ where: { id: candidate.id } })
      if (!file) return null
      if (await tx.organization.count({ where: { logoFileId: file.id } }) || await tx.user.count({ where: { avatarFileId: file.id } })) return null
      // Import sources are retained while their durable history references them. Generated report
      // and export FKs are SET NULL on purge and obey expiresAt.
      if (await tx.importJob.count({ where: { fileId: file.id } })) return null
      const expired = file.expiresAt && file.expiresAt <= now
      const deleted = file.deletedAt && file.deletedAt < cutoff
      const pending = file.status === 'pending' && file.createdAt < new Date(now - 86400000)
      if (!expired && !deleted && !pending && file.status !== 'purging') {
        const links = await tx.fileLink.findMany({ where: { fileId: file.id } })
        let lastLinkedAt = file.createdAt
        for (const link of links) {
          let removedAt = link.deletedAt
          if (!removedAt) {
            const model = link.entityType === 'import' ? 'importJob' : link.entityType
            const record = tx[model] ? await tx[model].findFirst({ where: { id: link.entityId, organizationId: file.organizationId } }) : null
            if (record && !record.deletedAt) return null
            removedAt = record?.deletedAt ?? now
            await tx.fileLink.update({ where: { fileId_entityType_entityId: { fileId: file.id, entityType: link.entityType, entityId: link.entityId } }, data: { deletedAt: removedAt } })
          }
          if (removedAt > lastLinkedAt) lastLinkedAt = removedAt
        }
        if (lastLinkedAt >= cutoff) return null
      }
      return tx.file.update({ where: { id: file.id }, data: { status: 'purging' } })
    })
    if (!file) continue
    // Claiming first prevents a new link/profile assignment during slow storage operations.
    await objectStore.delete(file.storageKey)
    if (file.thumbnailKey) await objectStore.delete(file.thumbnailKey)
    await prisma.file.deleteMany({ where: { id: file.id, status: 'purging' } })
    await refreshUsage(file.organizationId)
  }
  // A POST can be replayed until its 15-minute signature expires, even after completion removed
  // the pending row/key. Collect those unreferenced staging objects after 24 hours as well.
  let continuation
  for (let page = 0; page < 5; page++) {
    const listed = await objectStore.pending(continuation)
    for (const object of listed.Contents ?? []) {
      if (!object.Key || !object.LastModified || object.LastModified >= new Date(now - 86400000)) continue
      if (!await prisma.file.count({ where: { storageKey: object.Key, status: 'pending' } })) await objectStore.delete(object.Key)
    }
    continuation = listed.NextContinuationToken
    if (!continuation) break
  }
  const images = await prisma.file.findMany({ where: { status: 'ready', deletedAt: null, thumbnailKey: null, contentType: { in: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] } }, take: 20 })
  for (const file of images) {
    const bytes = await objectStore.bytes(file.storageKey)
    const thumb = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp().toBuffer().catch(() => null)
    if (!thumb) continue
    const key = `${file.storageKey}.${crypto.randomUUID()}.thumbnail.webp`
    await objectStore.upload(key, thumb, 'image/webp')
    try {
      await prisma.$transaction(async (tx) => {
        await assertWithinLimit({ orgId: file.organizationId }, 'storage', thumb.length, tx)
        await tx.file.update({ where: { id: file.id, thumbnailKey: null, status: 'ready', deletedAt: null }, data: { thumbnailKey: key, thumbnailBytes: BigInt(thumb.length) } })
      })
    } catch (err) { await objectStore.delete(key); if (err.code !== 'PLAN_LIMIT_REACHED' && err.code !== 'P2025') throw err }
  }
}
for (const type of ['contact', 'company']) registerMergeHook(type, async (tx, ctx, { primaryId, ids }) => {
  const links = await tx.fileLink.findMany({ where: { organizationId: ctx.orgId, entityType: type, entityId: { in: ids }, deletedAt: null } })
  for (const link of links) await tx.fileLink.upsert({ where: { fileId_entityType_entityId: { fileId: link.fileId, entityType: type, entityId: primaryId } }, create: { fileId: link.fileId, organizationId: ctx.orgId, entityType: type, entityId: primaryId, createdById: ctx.userId }, update: { deletedAt: null } })
  await tx.fileLink.updateMany({ where: { organizationId: ctx.orgId, entityType: type, entityId: { in: ids } }, data: { deletedAt: new Date() } })
})
registerConversionHook(async (tx, ctx, { leadId, contactId, dealId }) => {
  const links = await tx.fileLink.findMany({ where: { organizationId: ctx.orgId, entityType: 'lead', entityId: leadId, deletedAt: null } })
  for (const l of links) for (const [entityType, entityId] of [['contact', contactId], ...(dealId ? [['deal', dealId]] : [])]) await tx.fileLink.upsert({ where: { fileId_entityType_entityId: { fileId: l.fileId, entityType, entityId } }, create: { fileId: l.fileId, organizationId: ctx.orgId, entityType, entityId, createdById: ctx.userId }, update: { deletedAt: null } })
})

/** Trusted server-generated CSV/XLSX outputs still pass the same size, type and quota checks. */
export async function storeGeneratedFile(ctx, name, bytes, expiresInDays = 7) {
  const contentType = assertFileSize(name, bytes.length, 25)
  await sniffFile(name, bytes)
  const row = await reserveFile(ctx, name, bytes.length, contentType, undefined, new Date(Date.now() + expiresInDays * 86400000))
  try {
    await objectStore.upload(row.storageKey, bytes, contentType)
    const file = await completeUpload(ctx, row.id)
    return file
  } catch (err) { await objectStore.delete(row.storageKey).catch(() => {}); await prisma.file.deleteMany({ where: { id: row.id, status: 'pending' } }); throw err }
}
