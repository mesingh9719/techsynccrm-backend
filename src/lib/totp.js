import crypto from 'node:crypto'
import { safeEqual } from './hash.js'

/**
 * Time-based one-time passwords (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits) — what Google
 * Authenticator, Microsoft Authenticator, Authy, 1Password etc. use.
 */

const STEP_SECONDS = 30
const DIGITS = 6
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buffer) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text) {
  const clean = text.replace(/=+$/, '').replace(/\s/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index < 0) throw new Error('Invalid base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A new random secret (160 bits), base32-encoded for authenticator apps. */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20))
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS)

/** The code for a given time step. */
export function codeAt(secret, step) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS
  return String(binary).padStart(DIGITS, '0')
}

/**
 * Checks `code` against the current step ±`window` (clock drift). Returns the matched step, or null.
 * Callers must reject steps ≤ the last accepted one so a code can't be replayed.
 */
export function verifyCode(secret, code, { window = 1, now = Date.now() } = {}) {
  const clean = String(code ?? '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(clean)) return null
  const step = currentStep(now)
  for (let delta = -window; delta <= window; delta++) {
    if (safeEqual(codeAt(secret, step + delta), clean)) return step + delta
  }
  return null
}

/** otpauth:// URI that authenticator apps read from the QR code. */
export function otpauthUrl({ secret, accountName, issuer }) {
  const label = encodeURIComponent(`${issuer}:${accountName}`)
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) })
  return `otpauth://totp/${label}?${params}`
}
