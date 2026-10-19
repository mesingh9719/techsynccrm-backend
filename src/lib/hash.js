import crypto from 'node:crypto'

/** SHA-256 hex — for high-entropy tokens and codes (not passwords). */
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
