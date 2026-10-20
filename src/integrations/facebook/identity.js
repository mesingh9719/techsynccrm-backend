import crypto from 'node:crypto'
import { env } from '../../config/env.js'
import { safeEqual } from '../../lib/crypto.js'
import { ApiError } from '../../utils/ApiError.js'
import { graph } from './graph.js'

const invalid = () => new ApiError(400, 'Invalid Facebook signed request.', { code: 'FACEBOOK_INVALID_SIGNATURE' })
export function parseFacebookSignedRequest(value) {
  if (!env.FACEBOOK_APP_SECRET) throw new ApiError(503, 'Facebook App Secret is not configured.', { code: 'FACEBOOK_NOT_CONFIGURED' })
  if (typeof value !== 'string' || value.length > 20000) throw invalid()
  const [signature, payload, extra] = value.split('.')
  if (!signature || !payload || extra || !/^[\w-]+={0,2}$/.test(signature) || !/^[\w-]+={0,2}$/.test(payload)) throw invalid()
  const expected = crypto.createHmac('sha256', env.FACEBOOK_APP_SECRET).update(payload).digest()
  const supplied = Buffer.from(signature, 'base64url')
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw invalid()
  let data
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { throw invalid() }
  if (!data || data.algorithm !== 'HMAC-SHA256' || typeof data.user_id !== 'string' || !/^\d{1,40}$/.test(data.user_id)) throw invalid()
  if (data.issued_at != null && (!Number.isSafeInteger(data.issued_at) || data.issued_at < 0 || data.issued_at > Date.now() / 1000 + 300)) throw invalid()
  return data
}

// Keyed pseudonyms prevent a database reader from enumerating Facebook numeric user IDs.
export const facebookSubjectHash = (userId) => crypto.createHmac('sha256', Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64')).update(`facebook-subject:${env.FACEBOOK_APP_ID}:${userId}`).digest('hex')
export async function lockFacebookSubject(tx, userId) {
  const hash = facebookSubjectHash(userId)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`facebook:${hash}`}, 0))`
  return hash
}

export async function verifyFacebookUserToken(accessToken, expectedUserId) {
  const appToken = `${env.FACEBOOK_APP_ID}|${env.FACEBOOK_APP_SECRET}`
  const result = await graph('debug_token', appToken, { input_token: accessToken })
  const data = result.data
  const now = Math.floor(Date.now() / 1000)
  if (!data?.is_valid || data.type !== 'USER' || !safeEqual(String(data.app_id ?? ''), env.FACEBOOK_APP_ID) || typeof data.user_id !== 'string' || !/^\d{1,40}$/.test(data.user_id) || (expectedUserId && !safeEqual(data.user_id, expectedUserId)) || (data.expires_at && data.expires_at <= now + 30) || (data.data_access_expires_at && data.data_access_expires_at <= now)) {
    throw new ApiError(400, 'Facebook did not return a valid User access token for this app. Check the login configuration and reconnect.', { code: 'FACEBOOK_INVALID_TOKEN' })
  }
  return data
}

/** Callback timestamps describe the original grant/removal, not a later retry delivery time. */
export function facebookRequestCutoff(signed) {
  return new Date(Number.isSafeInteger(signed.issued_at) && signed.issued_at > 0 ? Math.min(Date.now(), signed.issued_at * 1000 + 999) : Date.now())
}
