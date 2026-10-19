import crypto from 'node:crypto'
import { env } from '../config/env.js'

/**
 * Encryption at rest for secrets we must read back (2FA secrets now; integration credentials later).
 * AES-256-GCM with a random 96-bit IV; output is "v1.<iv>.<tag>.<ciphertext>" in base64url, so the
 * key can be rotated later by introducing "v2".
 */

const key = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64')

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  return ['v1', iv, cipher.getAuthTag(), data].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.')
}

export function decrypt(payload) {
  const [version, iv, tag, data] = String(payload).split('.')
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised encrypted value')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
}

export { sha256, safeEqual } from './hash.js'
