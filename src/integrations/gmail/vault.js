import crypto from 'node:crypto'
import { provider } from './provider.js'

const aad = (account, purpose) => Buffer.from(`${account.organizationId}:${account.id}:v1:${purpose}`)
export async function newEnvelope() {
  const key = crypto.randomBytes(32)
  return { key, ...(await provider.wrapKey(key)) }
}
export function seal(key, account, purpose, value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(account, purpose))
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), bytes.toString('base64url')].join('.')
}
export function open(key, account, purpose, value) {
  const [version, iv, tag, bytes] = String(value).split('.')
  if (version !== 'v1') throw new Error('Invalid encrypted Gmail data')
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  cipher.setAAD(aad(account, purpose)); cipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(bytes, 'base64url')), cipher.final()]).toString('utf8'))
}
