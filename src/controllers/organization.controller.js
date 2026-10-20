import { auditContext } from '../lib/audit.js'
import * as authService from '../services/auth.service.js'
import * as orgService from '../services/organization.service.js'
import { sendAccess } from './auth.controller.js'

export async function list(req, res) {
  res.json({ success: true, data: { organizations: await orgService.listMyOrganizations(req.user.id, req.user.orgId) } })
}

/** Creates another workspace and switches to it. */
export async function create(req, res) {
  await orgService.createAdditionalOrganization(auditContext(req), req.body)
  sendAccess(res, 201, await authService.sessionForUser(req.user.id, req.user.sid))
}

export async function getCurrent(req, res) {
  res.json({ success: true, data: await orgService.getCurrentOrganization(req.ctx) })
}

export async function updateCurrent(req, res) {
  res.json({ success: true, data: await orgService.updateCurrentOrganization(req.ctx, req.body) })
}

/** Deletes the workspace and signs the caller in to another one (or none). */
export async function deleteCurrent(req, res) {
  await orgService.deleteCurrentOrganization(req.ctx, req.body.confirmName)
  sendAccess(res, 200, await authService.sessionForUser(req.user.id, req.user.sid))
}

export async function getChecklist(req, res) {
  res.json({ success: true, data: await orgService.getChecklist(req.ctx) })
}

export async function dismissChecklist(req, res) {
  await orgService.dismissChecklist(req.ctx)
  res.json({ success: true, data: { dismissed: true } })
}

export async function getStorage(req, res) {
  res.json({ success: true, data: await orgService.getStorageUsage(req.ctx) })
}
