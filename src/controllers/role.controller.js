import * as roles from '../services/role.service.js'

/** Workspace roles (RBAC). */

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data })

export async function list(req, res) {
  ok(res, await roles.listRoles(req.ctx))
}

export function catalogue(_req, res) {
  ok(res, roles.getCatalogue())
}

export async function me(req, res) {
  ok(res, { role: await roles.myRole(req.ctx) })
}

export async function create(req, res) {
  ok(res, { role: await roles.createRole(req.ctx, req.body) }, 201)
}

export async function update(req, res) {
  ok(res, { role: await roles.updateRole(req.ctx, req.validated.params.id, req.body) })
}

export async function reset(req, res) {
  ok(res, { role: await roles.resetSystemRole(req.ctx, req.validated.params.id, req.body) })
}

export async function remove(req, res) {
  ok(res, await roles.deleteRole(req.ctx, req.validated.params.id, req.body))
}

export async function preview(req, res) {
  ok(res, await roles.previewRole(req.ctx, req.body))
}
