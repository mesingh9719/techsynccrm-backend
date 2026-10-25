import crypto from 'node:crypto'

/** Context is explicit: legacy Gmail retains its existing byte-for-byte AAD format. */
export function sealValue(key, context, purpose, value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`${context}:v1:${purpose}`))
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), bytes.toString('base64url')].join('.')
}
export function openValue(key, context, purpose, value) {
  const parts = String(value).split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid encrypted data')
  const [, iv, tag, bytes] = parts
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  cipher.setAAD(Buffer.from(`${context}:v1:${purpose}`)); cipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(bytes, 'base64url')), cipher.final()]).toString('utf8'))
}
export const workspaceContext = (row) => `${row.organizationId}:${row.id}:workspace`
