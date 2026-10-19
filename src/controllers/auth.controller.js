import { env } from '../config/env.js'
import * as accountService from '../services/account.service.js'
import * as authService from '../services/auth.service.js'
import * as invitationService from '../services/invitation.service.js'
import * as orgService from '../services/organization.service.js'

const REFRESH_COOKIE = 'ts_refresh'

export function cookieOptions(expiresAt) {
  return {
    httpOnly: true,
    secure: env.isProduction || env.COOKIE_SAMESITE === 'none',
    sameSite: env.COOKIE_SAMESITE,
    path: '/api/auth', // only sent to the auth endpoints
    ...(expiresAt && { expires: new Date(expiresAt) }),
  }
}

/** Clears the refresh cookie — works from any route, since the cookie's path is set explicitly. */
export const clearRefreshCookie = (res) => res.clearCookie(REFRESH_COOKIE, cookieOptions())

export const requestMeta = (req) => ({ userAgent: req.get('user-agent'), ip: req.ip, sessionId: req.user?.sid ?? null, orgId: req.user?.orgId ?? null })

/** Sets the refresh cookie and returns the access token + user in the body. */
function sendSession(res, status, session, extra = {}) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, cookieOptions(session.refreshExpiresAt))
  res.status(status).json({
    success: true,
    data: { user: session.user, accessToken: session.accessToken, accessTokenExpiresAt: session.expiresAt, ...extra },
  })
}

/**
 * Responds with a new access token + user after the active workspace changed. The refresh
 * cookie is untouched — refreshes issue tokens for the last active workspace.
 */
export function sendAccess(res, status, access) {
  res.status(status).json({
    success: true,
    data: { user: access.user, accessToken: access.accessToken, accessTokenExpiresAt: access.expiresAt },
  })
}

export async function signup(req, res) {
  const session = await authService.signup(req.body, requestMeta(req))
  sendSession(res, 201, session, { verificationEmailSent: session.verificationEmailSent })
}

/** Step 1. With 2FA on, answers `{ twoFactorRequired, challengeToken }` and sets no cookie yet. */
export async function login(req, res) {
  const result = await authService.login(req.body, requestMeta(req))
  if (result.twoFactorRequired) return res.json({ success: true, data: { twoFactorRequired: true, challengeToken: result.challengeToken } })
  sendSession(res, 200, result)
}

/** Step 2 for 2FA accounts. */
export async function loginSecondFactor(req, res) {
  sendSession(res, 200, await authService.loginWithSecondFactor(req.body, requestMeta(req)))
}

export async function refresh(req, res) {
  try {
    sendSession(res, 200, await authService.refresh(req.cookies[REFRESH_COOKIE], requestMeta(req)))
  } catch (err) {
    // A superseded token means a parallel request already set a newer cookie — don't clobber it.
    if (err.code !== 'REFRESH_TOKEN_SUPERSEDED') clearRefreshCookie(res)
    throw err
  }
}

export async function logout(req, res) {
  await authService.logout(req.cookies[REFRESH_COOKIE])
  clearRefreshCookie(res)
  res.json({ success: true, data: { loggedOut: true } })
}

export async function logoutAll(req, res) {
  await authService.logoutEverywhere(req.user.id)
  clearRefreshCookie(res)
  res.json({ success: true, data: { loggedOut: true } })
}

export async function me(req, res) {
  res.json({ success: true, data: { user: await authService.getUserById(req.user.id, req.user.orgId) } })
}

export async function verifyEmail(req, res) {
  sendSession(res, 200, await authService.verifyEmail(req.body.token, requestMeta(req)))
}

export async function resendVerification(req, res) {
  res.json({ success: true, data: await authService.resendVerification(req.user.id) })
}

export async function forgotPassword(req, res) {
  await authService.forgotPassword(req.body.email)
  res.json({ success: true, data: { message: 'If an account exists for that email, a reset link is on its way.' } })
}

export async function resetPassword(req, res) {
  await authService.resetPassword(req.body.token, req.body.password)
  clearRefreshCookie(res)
  res.json({ success: true, data: { passwordReset: true } })
}

export async function completeOnboarding(req, res) {
  sendAccess(res, 200, await authService.completeOnboarding(req.user.id, req.body, requestMeta(req)))
}

export async function switchOrganization(req, res) {
  await orgService.switchOrganization(req.user.id, req.body.organizationId)
  sendAccess(res, 200, await authService.sessionForUser(req.user.id, req.user.sid))
}

export async function acceptTerms(req, res) {
  await authService.acceptTerms(req.user.id, req.body, requestMeta(req))
  res.json({ success: true, data: { user: await authService.getUserById(req.user.id, req.user.orgId) } })
}

// ---------- Email change links (from email; the person may be signed out) ----------

export async function confirmEmailChange(req, res) {
  res.json({ success: true, data: await accountService.confirmEmailChange(req.body.token, requestMeta(req)) })
}

export async function cancelEmailChange(req, res) {
  const result = await accountService.cancelEmailChange(req.body.token, requestMeta(req))
  clearRefreshCookie(res)
  res.json({ success: true, data: result })
}

// ---------- Invitations ----------

/** New person: create the account from the invitation and sign them in (full session). */
export async function signupWithInvite(req, res) {
  const userId = await invitationService.signupWithInvite(req.body, requestMeta(req))
  sendSession(res, 201, await authService.startSession(userId, requestMeta(req)))
}

/** Signed-in person accepts → switched to the workspace. */
export async function acceptInvitation(req, res) {
  await invitationService.acceptInvitation(req.user.id, req.body.token, requestMeta(req))
  sendAccess(res, 200, await authService.sessionForUser(req.user.id, req.user.sid))
}
