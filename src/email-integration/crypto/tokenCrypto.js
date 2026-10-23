import crypto from 'node:crypto'

/** Versioned AES-GCM keyring. Old versions must remain configured until rotation finishes. */
export function keyring(source = process.env) {
  const version = source.EMAIL_TOKEN_KEY_VERSION || '1'
  const keys = new Map()
  let entries
  try { entries = source.EMAIL_TOKEN_ENCRYPTION_KEYS ? JSON.parse(source.EMAIL_TOKEN_ENCRYPTION_KEYS) : {} }
  catch { throw new Error('Invalid email encryption keyring JSON') }
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Invalid email encryption keyring configuration')
  if (source.EMAIL_TOKEN_ENCRYPTION_KEY) entries[version] = source.EMAIL_TOKEN_ENCRYPTION_KEY
  for (const [id, encoded] of Object.entries(entries)) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('Invalid email encryption key configuration')
    const key = Buffer.from(encoded, 'base64')
    if (key.length !== 32) throw new Error('Email encryption keys must contain 32 bytes')
    keys.set(id, key)
  }
  if (!keys.has(version)) throw new Error('Missing active EMAIL_TOKEN_ENCRYPTION_KEY')
  return { version, keys }
}

export function encryptToken(value, context, ring = keyring()) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', ring.keys.get(ring.version), iv)
  cipher.setAAD(Buffer.from(`${context}:${ring.version}`))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64')
  return { ciphertext, iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), keyVersion: ring.version }
}

export function decryptToken(record, context, ring = keyring()) {
  const key = ring.keys.get(record.keyVersion)
  if (!key) throw new Error('Email encryption key version is unavailable')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'))
  decipher.setAAD(Buffer.from(`${context}:${record.keyVersion}`))
  decipher.setAuthTag(Buffer.from(record.authTag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8')
}

export const rotateToken = (record, context, ring = keyring()) => encryptToken(decryptToken(record, context, ring), context, ring)
