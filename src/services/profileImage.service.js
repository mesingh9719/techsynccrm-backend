import crypto from 'node:crypto'
import { prisma } from '../db/prisma.js'
import { env } from '../config/env.js'
import { assertFileSize, sniffFile } from '../lib/fileSafety.js'
import { objectStore } from '../storage/objectStore.js'
/** Profile/branding references are preauthorized at assignment; still validate legacy bytes. */
export async function profileImageUrl(id) {
  if (!id) return null
  const file = await prisma.file.findFirst({ where: { id, status: 'ready', deletedAt: null, contentType: { in: ['image/png', 'image/jpeg', 'image/webp'] } } })
  if (!file) return null
  try {
    if (!file.sha256) {
      const head = await objectStore.head(file.storageKey)
      assertFileSize(file.originalName, Number(head.ContentLength), env.MAX_UPLOAD_MB)
      const bytes = await objectStore.bytes(file.storageKey)
      const contentType = await sniffFile(file.originalName, bytes)
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) return null
      file.contentType = contentType
      await prisma.file.update({ where: { id }, data: { contentType, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } })
    }
    return await objectStore.url(file.storageKey, file.contentType, 'inline', env.STORAGE_URL_EXPIRES_IN)
  } catch { return null }
}
