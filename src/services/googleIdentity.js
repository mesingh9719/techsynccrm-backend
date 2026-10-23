import { OAuth2Client } from 'google-auth-library'
import { env } from '../config/env.js'
import { ApiError } from '../utils/ApiError.js'
import { safeEqual } from '../lib/hash.js'

export const googleError = (code, message, status = 400) => new ApiError(status, message, { code })
export function googleConfiguration() {
  let valid = false
  try {
    const url = new URL(env.GOOGLE_AUTH_REDIRECT_URI)
    valid = !url.username && !url.password && !url.search && !url.hash && url.pathname === '/api/auth/google/callback' &&
      (url.protocol === 'https:' || !env.isProduction && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  } catch { /* Remains disabled until a valid callback is configured. */ }
  return { enabled: env.GOOGLE_AUTH_ENABLED !== false && Boolean(env.GOOGLE_AUTH_CLIENT_ID && env.GOOGLE_AUTH_CLIENT_SECRET && valid), redirectUri: valid ? env.GOOGLE_AUTH_REDIRECT_URI : null }
}
export function googleClient() {
  if (!googleConfiguration().enabled) throw googleError('GOOGLE_NOT_CONFIGURED', 'Google sign-in is not configured in this environment.', 503)
  return new OAuth2Client({ clientId: env.GOOGLE_AUTH_CLIENT_ID, clientSecret: env.GOOGLE_AUTH_CLIENT_SECRET, redirectUri: env.GOOGLE_AUTH_REDIRECT_URI, transporterOptions: { timeout: 20000, retry: false } })
}
export function verifiedIdentity(payload, nonce) {
  if (!payload || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255 || payload.email_verified !== true || typeof payload.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) || payload.email.length > 254 || !safeEqual(payload.nonce, nonce) || payload.azp && payload.azp !== env.GOOGLE_AUTH_CLIENT_ID) throw googleError('GOOGLE_IDENTITY_INVALID', 'Google sign-in could not be verified. Please try again.')
  const email = payload.email.toLowerCase()
  return { subject: payload.sub, email, fullName: String(payload.name || email.split('@')[0]).trim().slice(0, 60) || 'Google user', authoritative: email.endsWith('@gmail.com') || Boolean(typeof payload.hd === 'string' && payload.hd.trim()) }
}
/** Narrow mock boundary: production always verifies Google's signature, issuer, audience and expiry. */
export const googleIdentity = {
  async exchange(code, verifier, nonce) {
    try {
      const client = googleClient(), { tokens } = await client.getToken({ code, codeVerifier: verifier })
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_AUTH_CLIENT_ID })
      return verifiedIdentity(ticket.getPayload(), nonce)
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw googleError('GOOGLE_AUTH_FAILED', 'Google sign-in could not be completed. Please try again.')
    }
  },
}
