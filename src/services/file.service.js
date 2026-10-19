import crypto from 'node:crypto'
import path from 'node:path'
import { env } from '../config/env.js'
import { prisma } from '../db/prisma.js'
import { storage } from '../storage/files.js'
import { ApiError } from '../utils/ApiError.js'
import { assertWithinLimit } from './entitlements.service.js'

const publicFileSelect = { id: true, originalName: true, contentType: true, sizeBytes: true, createdAt: true }

function toPublicFile(row) {
  return {
    id: row.id,
    name: row.originalName,
    contentType: row.contentType,
    size: Number(row.sizeBytes), // BigInt in Postgres; JSON can't serialise BigInt
    createdAt: row.createdAt,
  }
}

/** Keeps a readable, URL-safe name in the key; the UUID guarantees uniqueness. */
function buildKey(userId, originalName) {
  const ext = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10)
  const base = path.basename(originalName, path.extname(originalName)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60)
  return `users/${userId}/${crypto.randomUUID()}${base ? `-${base}` : ''}${ext}`
}

/**
 * Stores the bytes in Object Storage and the key + metadata in Postgres.
 * `organizationId` is the uploader's active workspace (files become fully workspace-scoped in M12).
 */
export async function uploadFile(userId, file, organizationId = null) {
  // Plan storage quota (M06). Checked before the upload; a race can overshoot by one file, which is
  // acceptable for storage (records and seats are checked under a lock).
  if (organizationId) await assertWithinLimit({ orgId: organizationId }, 'storage', file.size)
  const storageKey = buildKey(userId, file.originalname)
  const contentType = file.mimetype || 'application/octet-stream'
  await storage.upload(storageKey, file.buffer, { contentType })
  try {
    const row = await prisma.file.create({
      data: { userId, organizationId, storageKey, originalName: file.originalname.slice(0, 255), contentType, sizeBytes: BigInt(file.size) },
      select: publicFileSelect,
    })
    return toPublicFile(row)
  } catch (err) {
    // Don't leave an orphaned object if the row couldn't be written.
    await storage.delete(storageKey).catch(() => {})
    throw err
  }
}

export async function listFiles(userId) {
  const rows = await prisma.file.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: publicFileSelect,
  })
  return rows.map(toPublicFile)
}

async function getOwnedFile(userId, fileId) {
  const file = await prisma.file.findFirst({ where: { id: fileId, userId } })
  if (!file) throw ApiError.notFound('File not found')
  return file
}

/** Returns file metadata plus a short-lived presigned download URL. */
export async function getFileWithUrl(userId, fileId) {
  const file = await getOwnedFile(userId, fileId)
  const url = await storage.url(file.storageKey, { expiresIn: env.STORAGE_URL_EXPIRES_IN })
  return { ...toPublicFile(file), url, urlExpiresIn: env.STORAGE_URL_EXPIRES_IN }
}

export async function deleteFile(userId, fileId) {
  const file = await getOwnedFile(userId, fileId)
  await storage.delete(file.storageKey)
  await prisma.file.delete({ where: { id: file.id } })
}
