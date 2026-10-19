import * as accountService from '../services/account.service.js'
import * as twoFactor from '../services/twoFactor.service.js'
import { clearRefreshCookie, requestMeta } from './auth.controller.js'

/** /api/users/me — the signed-in person's own profile and security settings (M05). */

const ok = (res, data) => res.json({ success: true, data })

export async function updateProfile(req, res) {
  ok(res, { user: await accountService.updateProfile(req.user.id, req.body, requestMeta(req)) })
}

export async function changePassword(req, res) {
  await accountService.changePassword(req.user.id, req.body, requestMeta(req))
  ok(res, { passwordChanged: true })
}

export async function requestEmailChange(req, res) {
  ok(res, await accountService.requestEmailChange(req.user.id, req.body, requestMeta(req)))
}

export async function discardEmailChange(req, res) {
  await accountService.discardEmailChange(req.user.id)
  ok(res, { pendingEmail: null })
}

export async function listSessions(req, res) {
  ok(res, { sessions: await accountService.getSessions(req.user.id, req.user.sid) })
}

export async function revokeSession(req, res) {
  await accountService.signOutSession(req.user.id, req.validated.params.sessionId, requestMeta(req))
  ok(res, { revoked: true })
}

export async function revokeOtherSessions(req, res) {
  await accountService.signOutOtherSessions(req.user.id, requestMeta(req))
  ok(res, { revoked: true })
}

export async function twoFactorStatus(req, res) {
  ok(res, await twoFactor.status(req.user.id))
}

export async function twoFactorSetup(req, res) {
  ok(res, await twoFactor.startSetup(req.user.id))
}

export async function twoFactorEnable(req, res) {
  ok(res, await twoFactor.enable(req.user.id, req.body.code, requestMeta(req)))
}

export async function twoFactorDisable(req, res) {
  await twoFactor.disable(req.user.id, req.body, requestMeta(req))
  ok(res, { enabled: false })
}

export async function twoFactorRecoveryCodes(req, res) {
  ok(res, await twoFactor.regenerateRecoveryCodes(req.user.id, req.body, requestMeta(req)))
}

export async function deleteAccount(req, res) {
  await accountService.deleteAccount(req.user.id, req.body, requestMeta(req))
  clearRefreshCookie(res)
  ok(res, { deleted: true })
}
