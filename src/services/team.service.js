import { prisma, UNIQUE_VIOLATION } from '../db/prisma.js'
import { emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * Teams (M04): groups of members with one or more managers. A manager sees and edits records owned
 * by members of the teams they manage (lib/visibility.js).
 */

const fieldError = (fields) => new ApiError(400, 'Validation failed', { code: 'VALIDATION_ERROR', details: { fields } })

async function present(orgId, where = {}) {
  const teams = await prisma.team.findMany({
    where: { organizationId: orgId, ...where },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, createdAt: true, members: { select: { userId: true, isManager: true } } },
  })
  const userIds = [...new Set(teams.flatMap((t) => t.members.map((m) => m.userId)))]
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, email: true } })
  const byId = new Map(users.map((u) => [u.id, u]))
  return teams.map((t) => ({
    ...t,
    members: t.members
      .map((m) => ({ ...m, fullName: byId.get(m.userId)?.fullName ?? 'Unknown', email: byId.get(m.userId)?.email ?? null }))
      .sort((a, b) => Number(b.isManager) - Number(a.isManager) || a.fullName.localeCompare(b.fullName)),
  }))
}

export const listTeams = (ctx) => present(ctx.orgId)

/** Members must be active members of this workspace. */
async function assertMembers(ctx, members) {
  const ids = [...new Set(members.map((m) => m.userId))]
  const active = await prisma.membership.count({ where: { organizationId: ctx.orgId, userId: { in: ids }, status: 'active' } })
  if (active !== ids.length) throw fieldError({ members: 'Every team member must be an active member of the workspace' })
}

function uniqueMembers(members) {
  const map = new Map()
  for (const m of members) map.set(m.userId, { userId: m.userId, isManager: Boolean(m.isManager || map.get(m.userId)?.isManager) })
  return [...map.values()]
}

const nameTaken = () => fieldError({ name: 'There’s already a team with this name' })

export async function createTeam(ctx, { name, members = [] }) {
  const list = uniqueMembers(members)
  await assertMembers(ctx, list)
  try {
    const team = await prisma.$transaction(async (tx) => {
      const created = await tx.team.create({ data: { organizationId: ctx.orgId, name } })
      if (list.length) await tx.teamMember.createMany({ data: list.map((m) => ({ ...m, teamId: created.id })) })
      await emit(tx, ctx, 'team.created', { entityType: 'team', entityId: created.id })
      await recordAudit(tx, ctx, { action: 'team.create', entityType: 'team', entityId: created.id, changes: { name: [null, name] } })
      return created
    })
    return (await present(ctx.orgId, { id: team.id }))[0]
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw nameTaken()
    throw err
  }
}

export async function updateTeam(ctx, id, { name, members }) {
  const team = await prisma.team.findFirst({ where: { id, organizationId: ctx.orgId }, select: { id: true, name: true } })
  if (!team) throw ApiError.notFound('Team not found')
  const list = members ? uniqueMembers(members) : null
  if (list) await assertMembers(ctx, list)
  try {
    await prisma.$transaction(async (tx) => {
      if (name && name !== team.name) await tx.team.update({ where: { id }, data: { name } })
      if (list) {
        await tx.teamMember.deleteMany({ where: { teamId: id } })
        if (list.length) await tx.teamMember.createMany({ data: list.map((m) => ({ ...m, teamId: id })) })
      }
      await emit(tx, ctx, 'team.updated', { entityType: 'team', entityId: id })
      await recordAudit(tx, ctx, { action: 'team.update', entityType: 'team', entityId: id, changes: { ...(name && name !== team.name && { name: [team.name, name] }), ...(list && { members: [null, list.length] }) } })
    })
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw nameTaken()
    throw err
  }
  return (await present(ctx.orgId, { id }))[0]
}

export async function deleteTeam(ctx, id) {
  const team = await prisma.team.findFirst({ where: { id, organizationId: ctx.orgId }, select: { id: true, name: true } })
  if (!team) throw ApiError.notFound('Team not found')
  await prisma.$transaction(async (tx) => {
    await tx.team.delete({ where: { id } })
    await emit(tx, ctx, 'team.deleted', { entityType: 'team', entityId: id })
    await recordAudit(tx, ctx, { action: 'team.delete', entityType: 'team', entityId: id, changes: { name: [team.name, null] } })
  })
}
