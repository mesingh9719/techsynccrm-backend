import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { env } from '../config/env.js'
import { validate } from '../middlewares/validate.js'
import { requestMeta, sendSession } from '../controllers/auth.controller.js'
import { ApiError } from '../utils/ApiError.js'
import { logger } from '../lib/logger.js'
import { googleConfiguration } from '../services/googleIdentity.js'
import { startGoogle, finishGoogle, completeGoogle, googleCookieOptions, FLOW_COOKIE, RESULT_COOKIE } from '../services/googleAuth.service.js'

const router = Router()
const startSchema = z.object({ intent: z.enum(['signin', 'signup']), plan: z.enum(['starter', 'growth', 'business']).default('starter'), acceptTerms: z.boolean().default(false), remember: z.boolean().default(false), returnTo: z.string().max(500).optional() }).strict()
router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next() })
router.use(rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { success: false, error: { code: 'RATE_LIMITED', message: 'Wait a moment before trying Google sign-in again.' } } }))
const guarded = (fn) => async (req, res, next) => {
  try {
    const origin = req.get('origin')
    if (req.method === 'POST' && origin && ![...(env.CORS_ORIGINS || []), new URL(env.FRONTEND_URL).origin].includes(origin)) throw new ApiError(403, 'Use the TechSync website to sign in.', { code: 'GOOGLE_ORIGIN_INVALID' })
    await fn(req, res)
  } catch (error) { next(error instanceof ApiError ? error : new ApiError(503, 'Google sign-in is temporarily unavailable.', { code: 'GOOGLE_AUTH_UNAVAILABLE' })) }
}
const clearCookie = (res, name) => { const { maxAge: _age, ...options } = googleCookieOptions(); res.clearCookie(name, options) }
router.get('/config', (_req, res) => res.json({ success: true, data: googleConfiguration() }))
router.post('/start', validate(startSchema), guarded(async (req, res) => {
  const result = await startGoogle(req.body)
  clearCookie(res, RESULT_COOKIE); res.cookie(FLOW_COOKIE, result.cookie, googleCookieOptions())
  res.json({ success: true, data: { url: result.url } })
}))
router.get('/callback', async (req, res) => {
  const target = new URL('/auth/google/complete', env.FRONTEND_URL)
  try { res.cookie(RESULT_COOKIE, await finishGoogle(req.query, req.cookies?.[FLOW_COOKIE], requestMeta(req)), googleCookieOptions(300000)) }
  catch (error) {
    const safe = ['GOOGLE_FLOW_EXPIRED', 'GOOGLE_CANCELLED', 'GOOGLE_AUTH_FAILED', 'GOOGLE_IDENTITY_INVALID', 'GOOGLE_ACCOUNT_UNAVAILABLE', 'GOOGLE_LINK_REQUIRED', 'GOOGLE_SIGNUP_REQUIRED', 'GOOGLE_NOT_CONFIGURED', 'TERMS_OUTDATED']
    const code = safe.includes(error.code) ? error.code : 'GOOGLE_AUTH_UNAVAILABLE'
    clearCookie(res, RESULT_COOKIE); target.searchParams.set('error', code); logger.warn({ code }, 'Google sign-in did not complete')
  }
  clearCookie(res, FLOW_COOKIE); res.redirect(303, target.toString())
})
router.post('/complete', guarded(async (req, res) => {
  clearCookie(res, RESULT_COOKIE)
  const { session, returnTo } = await completeGoogle(req.cookies?.[RESULT_COOKIE], requestMeta(req))
  if (session.twoFactorRequired) return res.json({ success: true, data: { ...session, returnTo } })
  sendSession(res, 200, session, { returnTo })
}))
export default router
