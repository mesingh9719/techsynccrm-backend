import * as invitations from '../services/invitation.service.js'
import * as members from '../services/members.service.js'
import * as teams from '../services/team.service.js'

/** Team management for the current workspace (M04): members, invitations, teams. */

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data })

export async function listMembers(req, res) {
  ok(res, { members: await members.listMembers(req.ctx, req.validated.query) })
}

export async function memberOptions(req, res) {
  ok(res, { members: await members.memberOptions(req.ctx, req.validated.query.q) })
}

export async function updateMember(req, res) {
  ok(res, { member: await members.updateMember(req.ctx, req.validated.params.userId, req.body) })
}

export async function deactivateMember(req, res) {
  await members.deactivateMember(req.ctx, req.validated.params.userId, req.body)
  ok(res, { deactivated: true })
}

export async function reactivateMember(req, res) {
  await members.reactivateMember(req.ctx, req.validated.params.userId)
  ok(res, { reactivated: true })
}

export async function transferOwnership(req, res) {
  await members.transferOwnership(req.ctx, req.body)
  ok(res, { transferred: true })
}

export async function listInvitations(req, res) {
  ok(res, { invitations: await invitations.listInvitations(req.ctx) })
}

export async function createInvitations(req, res) {
  ok(res, { results: await invitations.createInvitations(req.ctx, req.body) }, 201)
}

export async function resendInvitation(req, res) {
  await invitations.resendInvitation(req.ctx, req.validated.params.id)
  ok(res, { resent: true })
}

export async function revokeInvitation(req, res) {
  await invitations.revokeInvitation(req.ctx, req.validated.params.id)
  res.status(204).end()
}

export async function lookupInvitation(req, res) {
  ok(res, { invitation: await invitations.lookupInvitation(req.validated.params.token) })
}

export async function listTeams(req, res) {
  ok(res, { teams: await teams.listTeams(req.ctx) })
}

export async function createTeam(req, res) {
  ok(res, { team: await teams.createTeam(req.ctx, req.body) }, 201)
}

export async function updateTeam(req, res) {
  ok(res, { team: await teams.updateTeam(req.ctx, req.validated.params.id, req.body) })
}

export async function deleteTeam(req, res) {
  await teams.deleteTeam(req.ctx, req.validated.params.id)
  res.status(204).end()
}
