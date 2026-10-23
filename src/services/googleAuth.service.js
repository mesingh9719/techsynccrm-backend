import crypto from 'node:crypto'
import { prisma } from '../db/prisma.js'
import { env } from '../config/env.js'
import { LEGAL_VERSIONS } from '../config/legal.js'
import { encrypt, decrypt, safeEqual } from '../lib/crypto.js'
import { recordAudit } from '../lib/audit.js'
import { createUserToken, consumeUserTokenRecord } from './userToken.service.js'
import { completeExternalLogin, consentFields, resendVerification } from './auth.service.js'
import { googleClient, googleError, googleIdentity } from './googleIdentity.js'

export const FLOW_COOKIE = 'ts_google_flow', RESULT_COOKIE = 'ts_google_result'
export const googleCookieOptions = (ttl = 600000) => ({ httpOnly: true, secure: env.isProduction || env.COOKIE_SAMESITE === 'none' || env.GOOGLE_AUTH_REDIRECT_URI?.startsWith('https:'), sameSite: env.COOKIE_SAMESITE || 'lax', path: '/api/auth/google', maxAge: ttl })
export function safeGoogleReturn(value) {
  if (typeof value !== 'string' || value.length > 500 || /[\\\x00-\x20]/.test(value) || !/^\/(?:app(?:[/?#]|$)|invite(?:[/?#]|$))/.test(value)) return null
  return new URL(value, 'https://crm.invalid').origin === 'https://crm.invalid' ? value : null
}
export async function startGoogle(input) {
  const client = googleClient()
  if (input.intent === 'signup' && input.acceptTerms !== true) throw googleError('TERMS_REQUIRED', 'Accept the Terms and Privacy Policy to sign up.')
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()
  const flow = { purpose: 'google-signin', state: crypto.randomBytes(32).toString('base64url'), nonce: crypto.randomBytes(32).toString('base64url'), verifier: codeVerifier, intent: input.intent, plan: input.plan, remember: input.remember, returnTo: safeGoogleReturn(input.returnTo), legal: LEGAL_VERSIONS, expires: Date.now() + 600000 }
  return {
    cookie: encrypt(JSON.stringify(flow)),
    url: client.generateAuthUrl({ scope: ['openid', 'email', 'profile'], access_type: 'online', prompt: 'select_account', state: flow.state, nonce: flow.nonce, code_challenge: codeChallenge, code_challenge_method: 'S256', include_granted_scopes: false }),
  }
}
function readFlow(cookie, state) {
  try {
    if (typeof cookie !== 'string' || cookie.length > 8000 || typeof state !== 'string' || state.length > 200) throw new Error('invalid')
    const flow = JSON.parse(decrypt(cookie))
    if (flow.purpose !== 'google-signin' || !safeEqual(flow.state, state) || !Number.isFinite(flow.expires) || flow.expires <= Date.now() || !['signin', 'signup'].includes(flow.intent)) throw new Error('invalid')
    return flow
  } catch { throw googleError('GOOGLE_FLOW_EXPIRED', 'Your Google sign-in expired or could not be verified. Start again in the same browser.') }
}
async function userForIdentity(identity, flow, meta) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`google-signin:${identity.subject}`}, 0))`
    let user = await tx.user.findUnique({ where: { googleSubject: identity.subject } })
    if (user) {
      if (user.deletedAt || user.email !== identity.email) throw googleError('GOOGLE_ACCOUNT_UNAVAILABLE', 'Use email sign-in for this account, or contact support.')
      return user
    }
    user = await tx.user.findUnique({ where: { email: identity.email } })
    if (user) {
      // Do not silently take over a pre-registered unverified account or trust an external Google email.
      if (user.deletedAt || user.googleSubject || !user.emailVerifiedAt || !identity.authoritative || user.lockedUntil && user.lockedUntil > new Date()) throw googleError('GOOGLE_LINK_REQUIRED', 'Sign in with your email and password. Verify your email or reset your password before using Google; existing non-Google mailboxes require email sign-in.', 409)
      user = await tx.user.update({ where: { id: user.id, googleSubject: null, email: identity.email, deletedAt: null }, data: { googleSubject: identity.subject } })
      await recordAudit(tx, { userId: user.id, ip: meta.ip, userAgent: meta.userAgent }, { action: 'auth.google_linked', entityType: 'user', entityId: user.id })
      return user
    }
    if (flow.intent !== 'signup') throw googleError('GOOGLE_SIGNUP_REQUIRED', 'Create an account with Google first and accept the Terms and Privacy Policy.', 409)
    if (flow.legal?.terms !== LEGAL_VERSIONS.terms || flow.legal?.privacy !== LEGAL_VERSIONS.privacy) throw googleError('TERMS_OUTDATED', 'The terms changed. Start sign-up again and review the latest version.', 409)
    user = await tx.user.create({ data: { email: identity.email, googleSubject: identity.subject, fullName: identity.fullName, passwordHash: null, signupPlan: flow.plan, emailVerifiedAt: identity.authoritative ? new Date() : null, ...consentFields() } })
    await recordAudit(tx, { userId: user.id, ip: meta.ip, userAgent: meta.userAgent }, { action: 'auth.google_signup', entityType: 'user', entityId: user.id })
    return user
  })
}
export async function finishGoogle(query, cookie, meta) {
  const flow = readFlow(cookie, query.state)
  if (query.error) throw googleError('GOOGLE_CANCELLED', 'Google sign-in was cancelled. You can try again.')
  if (typeof query.code !== 'string' || !query.code || query.code.length > 4096) throw googleError('GOOGLE_AUTH_FAILED', 'Google did not return a valid sign-in code.')
  const identity = await googleIdentity.exchange(query.code, flow.verifier, flow.nonce)
  let user
  try { user = await userForIdentity(identity, flow, meta) }
  catch (error) { if (error.code === 'P2002') throw googleError('GOOGLE_LINK_REQUIRED', 'An account already exists. Please sign in again.', 409); throw error }
  if (!user.emailVerifiedAt) await resendVerification(user.id).catch(() => {})
  // Neither Google tokens nor our access token go into URLs or browser storage.
  return createUserToken(user.id, 'google_signin', 300000, { subject: identity.subject, email: identity.email, remember: flow.remember, returnTo: flow.returnTo })
}
export async function completeGoogle(ticket, meta) {
  const { userId, payload } = await consumeUserTokenRecord(ticket, 'google_signin')
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null, googleSubject: payload.subject, email: payload.email }, select: { id: true } })
  if (!user) throw googleError('GOOGLE_ACCOUNT_UNAVAILABLE', 'This sign-in is no longer valid. Please start again.')
  return { session: await completeExternalLogin(user.id, Boolean(payload.remember), meta), returnTo: safeGoogleReturn(payload.returnTo) }
}
