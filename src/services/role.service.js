import { ASSIGNABLE_ROLES, LOCKED_ROLES, MODULES, ROLES, ROLE_INFO, SCOPES, hasPermission, permissionsFor, rolePermissionProblems, sanitizePermissions } from '../config/permissions.js'
import { prisma } from '../db/prisma.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from '../utils/ApiError.js'
import { resolvePermissions } from './roleAccess.service.js'

/**
 * Roles of the current workspace (Settings → Team & roles), on every plan. Everyone can read
 * them, so members can see what they can do; owners and admins (`roles.manage`) edit the built-in
 * Manager, Sales rep and Viewer roles and create their own (custom roles).
 *
 * A role's `id` is its key for built-in roles (`manager`) and the row id for custom ones.
 * A built-in role has a `roles` row only while it differs from the defaults (version 0 without).
 * Custom-role members have `memberships.role = 'sales_rep'` (their tier for rank-based rules such
 * as admin protection) and `role_id` pointing at the role. Every change bumps
 * organizations.roles_version, which refreshes permissions everywhere.
 */

const roleRowSelect = { id: true, systemKey: true, name: true, description: true, color: true, permissions: true, version: true, updatedAt: true, archivedAt: true }

/** Chip accents a role can use (Tailwind palette names). */
export const ROLE_COLORS = ['slate', 'brand', 'violet', 'emerald', 'amber', 'rose', 'sky', 'teal']

/** Membership tier stored for members of a custom role. */
export const CUSTOM_ROLE_TIER = 'sales_rep'

const MAX_CUSTOM_ROLES = 50
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const sameSet = (a, b) => a.length === b.length && a.every((p) => b.includes(p))

/** `{ added, removed }` between two permission lists. */
export function permissionDiff(before, after) {
  return { added: after.filter((p) => !before.includes(p)), removed: before.filter((p) => !after.includes(p)) }
}

const STALE = () => new ApiError(409, 'Someone else changed this role. Refresh and try again.', { code: 'STALE_UPDATE' })
const nameTaken = () => new ApiError(409, 'A role with this name already exists.', { code: 'VALIDATION_ERROR', details: { fields: { name: 'A role with this name already exists' } } })

// ---------- Reading ----------

function presentSystem(key, row, { canManage, memberCount }) {
  const locked = LOCKED_ROLES.includes(key)
  return {
    id: key,
    system: true,
    key,
    name: ROLE_INFO[key].name,
    description: ROLE_INFO[key].description,
    color: row?.color ?? null,
    locked,
    customised: Boolean(row) && !locked,
    editable: canManage && !locked,
    permissions: resolvePermissions({ role: key, systemOverride: row }),
    defaults: permissionsFor(key),
    memberCount,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
  }
}

function presentCustom(row, { canManage, memberCount }) {
  return {
    id: row.id,
    system: false,
    key: null,
    name: row.name,
    description: row.description,
    color: row.color,
    locked: false,
    customised: true,
    editable: canManage,
    permissions: sanitizePermissions(row.permissions),
    defaults: null,
    memberCount,
    version: row.version,
    updatedAt: row.updatedAt,
  }
}

export async function listRoles(ctx) {
  const [rows, counts] = await Promise.all([
    prisma.role.findMany({ where: { organizationId: ctx.orgId, archivedAt: null }, select: roleRowSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    prisma.membership.groupBy({ by: ['role', 'roleId'], where: { organizationId: ctx.orgId, status: 'active' }, _count: { _all: true } }),
  ])
  const canManage = hasPermission(ctx.permissions, 'roles.manage')
  const customIds = new Set(rows.filter((r) => !r.systemKey).map((r) => r.id))
  const countOf = (match) => counts.filter(match).reduce((sum, c) => sum + c._count._all, 0)
  const system = ROLES.map((key) =>
    presentSystem(key, rows.find((r) => r.systemKey === key) ?? null, { canManage, memberCount: countOf((c) => c.role === key && !customIds.has(c.roleId)) }),
  )
  const custom = rows.filter((r) => !r.systemKey).map((row) => presentCustom(row, { canManage, memberCount: countOf((c) => c.roleId === row.id) }))
  return { roles: [...system, ...custom], canManage }
}

/** The module catalogue for the role editor, plus each built-in role's defaults. */
export function getCatalogue() {
  return { modules: MODULES, scopes: SCOPES, defaults: Object.fromEntries(ROLES.map((r) => [r, permissionsFor(r)])), colors: ROLE_COLORS }
}

/** The caller's own role and effective permissions ("what can I do"). */
export async function myRole(ctx) {
  const row = ctx.roleId ? await prisma.role.findFirst({ where: { id: ctx.roleId, organizationId: ctx.orgId }, select: { name: true, description: true, archivedAt: true } }) : null
  const custom = row && !row.archivedAt ? row : null
  return {
    role: ctx.role,
    roleId: custom ? ctx.roleId : null,
    name: custom?.name ?? ROLE_INFO[ctx.role]?.name ?? ctx.role,
    description: custom ? custom.description : (ROLE_INFO[ctx.role]?.description ?? null),
    permissions: ctx.permissions,
  }
}

/**
 * Turns a role choice from a member or invitation form — a built-in key (`viewer`) or a custom
 * role id — into what memberships store: `{ role, roleId }`.
 */
export async function resolveRoleChoice(db, orgId, value) {
  if (ASSIGNABLE_ROLES.includes(value)) return { role: value, roleId: null, name: ROLE_INFO[value].name }
  if (!UUID.test(String(value))) throw new ApiError(400, 'Choose a role', { code: 'VALIDATION_ERROR', details: { fields: { role: 'Choose a role' } } })
  const row = await db.role.findFirst({ where: { id: value, organizationId: orgId, systemKey: null, archivedAt: null }, select: { id: true, name: true } })
  if (!row) throw new ApiError(400, 'This role no longer exists', { code: 'VALIDATION_ERROR', details: { fields: { role: 'This role no longer exists' } } })
  return { role: CUSTOM_ROLE_TIER, roleId: row.id, name: row.name }
}

// ---------- Guards ----------

/** Loads the role `id` names for editing: a built-in key (not Owner/Admin) or a live custom role. */
async function editableRole(db, ctx, id) {
  if (ROLES.includes(id)) {
    if (LOCKED_ROLES.includes(id)) throw new ApiError(403, `The ${ROLE_INFO[id].name} role can’t be changed.`, { code: 'ROLE_LOCKED' })
    if (ctx.role === id && !ctx.roleId) throw new ApiError(403, 'You can’t change your own role.', { code: 'OWN_ROLE' })
    const row = await db.role.findUnique({ where: { organizationId_systemKey: { organizationId: ctx.orgId, systemKey: id } }, select: roleRowSelect })
    return { key: id, row }
  }
  if (!UUID.test(id)) throw ApiError.notFound('This role doesn’t exist')
  const row = await db.role.findFirst({ where: { id, organizationId: ctx.orgId, systemKey: null, archivedAt: null }, select: roleRowSelect })
  if (!row) throw ApiError.notFound('This role doesn’t exist')
  if (ctx.roleId === id) throw new ApiError(403, 'You can’t change your own role.', { code: 'OWN_ROLE' })
  return { key: null, row }
}

/** Whether `held` covers `permission` (the same string, or the same action with a wider scope). */
function holds(held, permission) {
  if (held.includes(permission)) return true
  const scope = SCOPES.find((s) => permission.endsWith(`.${s}`))
  if (!scope) return false
  const base = permission.slice(0, -scope.length - 1)
  return SCOPES.slice(0, SCOPES.indexOf(scope)).some((wider) => held.includes(`${base}.${wider}`))
}

/** 400 with every problem, or 403 when granting something the editor doesn't hold (owners and admins may grant anything grantable). */
function assertGrantable(ctx, permissions) {
  const problems = rolePermissionProblems(permissions)
  if (problems.length) throw new ApiError(400, problems[0].message, { code: 'VALIDATION_ERROR', details: { fields: { permissions: problems[0].message }, problems } })
  if (LOCKED_ROLES.includes(ctx.role)) return
  const beyond = permissions.filter((p) => !holds(ctx.permissions, p))
  if (beyond.length) throw new ApiError(403, 'You can only grant permissions you have yourself.', { code: 'FORBIDDEN', details: { permissions: beyond } })
}

async function assertNameFree(db, orgId, name, exceptId = null) {
  const lower = name.trim().toLowerCase()
  if (Object.values(ROLE_INFO).some((r) => r.name.toLowerCase() === lower)) throw nameTaken()
  const clash = await db.role.findFirst({ where: { organizationId: orgId, archivedAt: null, name: { equals: name.trim(), mode: 'insensitive' }, ...(exceptId && { id: { not: exceptId } }) }, select: { id: true } })
  if (clash) throw nameTaken()
}

const bumpVersion = (tx, orgId) => tx.organization.update({ where: { id: orgId }, data: { rolesVersion: { increment: 1 } } })

async function presentOne(ctx, id) {
  const { roles } = await listRoles(ctx)
  return roles.find((r) => r.id === id)
}

// ---------- Writing ----------

/** Creates a custom role, starting from another role's permissions (or a list given). */
export async function createRole(ctx, { name, description = null, color = null, copyFrom = null, permissions }) {
  let start = permissions
  if (!start) {
    if (copyFrom && ROLES.includes(copyFrom)) {
      const row = LOCKED_ROLES.includes(copyFrom) ? null : await prisma.role.findUnique({ where: { organizationId_systemKey: { organizationId: ctx.orgId, systemKey: copyFrom } }, select: { permissions: true } })
      start = [...resolvePermissions({ role: copyFrom, systemOverride: row })]
    } else if (copyFrom) {
      const row = UUID.test(copyFrom) ? await prisma.role.findFirst({ where: { id: copyFrom, organizationId: ctx.orgId, archivedAt: null }, select: { permissions: true } }) : null
      if (!row) throw new ApiError(400, 'The role to copy no longer exists', { code: 'VALIDATION_ERROR', details: { fields: { copyFrom: 'Choose another role to start from' } } })
      start = row.permissions
    } else start = []
  }
  // Copying Owner or Admin keeps only what an editable role may hold.
  const next = [...sanitizePermissions(start)]
  assertGrantable(ctx, next)

  const id = await prisma.$transaction(async (tx) => {
    await assertNameFree(tx, ctx.orgId, name)
    if ((await tx.role.count({ where: { organizationId: ctx.orgId, systemKey: null, archivedAt: null } })) >= MAX_CUSTOM_ROLES) {
      throw new ApiError(400, `You can have up to ${MAX_CUSTOM_ROLES} custom roles.`, { code: 'ROLE_LIMIT' })
    }
    const row = await tx.role.create({ data: { organizationId: ctx.orgId, name: name.trim(), description, color, permissions: next, createdById: ctx.userId }, select: { id: true } })
    await bumpVersion(tx, ctx.orgId)
    await recordAudit(tx, ctx, { action: 'role.create', entityType: 'role', entityId: row.id, changes: { name: [null, name.trim()], copyFrom, added: next } })
    return row.id
  })
  return presentOne(ctx, id)
}

/**
 * Changes a role. Built-in roles: permissions and colour (their name is fixed); saving the
 * defaults with no colour removes the stored row. Custom roles: also name and description.
 * `expectedVersion` is the version the editor loaded; a mismatch is 409 STALE_UPDATE.
 */
export async function updateRole(ctx, id, { name, description, color, permissions, expectedVersion }) {
  if (permissions) assertGrantable(ctx, permissions)
  await prisma.$transaction(async (tx) => {
    const { key, row } = await editableRole(tx, ctx, id)
    if ((row?.version ?? 0) !== expectedVersion) throw STALE()
    const defaults = key ? sanitizePermissions(permissionsFor(key)) : null
    const before = row ? sanitizePermissions(row.permissions) : defaults
    const next = permissions ? sanitizePermissions(permissions) : before
    const nextColor = color === undefined ? (row?.color ?? null) : color
    const nextName = key || name === undefined ? row?.name : name.trim()
    const nextDescription = key || description === undefined ? (row?.description ?? null) : description
    if (!key && nextName !== row.name) await assertNameFree(tx, ctx.orgId, nextName, row.id)
    const unchanged = sameSet(before, next) && nextColor === (row?.color ?? null) && nextName === row?.name && nextDescription === (row?.description ?? null)
    if (unchanged) return

    let savedId = row?.id
    if (key && sameSet(next, defaults) && !nextColor) {
      const { count } = await tx.role.deleteMany({ where: { id: row.id, version: expectedVersion } })
      if (!count) throw STALE()
    } else if (row) {
      const { count } = await tx.role.updateMany({
        where: { id: row.id, version: expectedVersion },
        data: { permissions: next, color: nextColor, ...(!key && { name: nextName, description: nextDescription }), version: { increment: 1 } },
      })
      if (!count) throw STALE()
    } else {
      try {
        savedId = (await tx.role.create({ data: { organizationId: ctx.orgId, systemKey: key, name: ROLE_INFO[key].name, permissions: next, color: nextColor, createdById: ctx.userId }, select: { id: true } })).id
      } catch (err) {
        if (err.code === 'P2002') throw STALE()
        throw err
      }
    }
    await bumpVersion(tx, ctx.orgId)
    await recordAudit(tx, ctx, {
      action: 'role.update',
      entityType: 'role',
      entityId: savedId,
      changes: {
        role: key ?? row.name,
        ...permissionDiff(before, next),
        ...(nextColor !== (row?.color ?? null) && { color: [row?.color ?? null, nextColor] }),
        ...(!key && nextName !== row.name && { name: [row.name, nextName] }),
      },
    })
  })
  return presentOne(ctx, id)
}

/** Puts a built-in role back to its defaults. */
export async function resetSystemRole(ctx, id, { expectedVersion }) {
  if (!ROLES.includes(id)) throw new ApiError(400, 'Only built-in roles can be reset.', { code: 'VALIDATION_ERROR' })
  await prisma.$transaction(async (tx) => {
    const { key, row } = await editableRole(tx, ctx, id)
    if (!row) return
    if (row.version !== expectedVersion) throw STALE()
    const { count } = await tx.role.deleteMany({ where: { id: row.id, version: expectedVersion } })
    if (!count) throw STALE()
    await bumpVersion(tx, ctx.orgId)
    await recordAudit(tx, ctx, { action: 'role.reset', entityType: 'role', entityId: row.id, changes: { role: key, ...permissionDiff(sanitizePermissions(row.permissions), sanitizePermissions(permissionsFor(key))) } })
  })
  return presentOne(ctx, id)
}

/**
 * Deletes a custom role. Its members and pending invitations move to `reassignTo` (a built-in key
 * or another custom role) in the same transaction; the row is archived, freeing its name.
 */
export async function deleteRole(ctx, id, { reassignTo }) {
  if (ROLES.includes(id)) throw new ApiError(400, 'Built-in roles can’t be deleted.', { code: 'ROLE_LOCKED' })
  await prisma.$transaction(async (tx) => {
    const { row } = await editableRole(tx, ctx, id)
    if (reassignTo === id) throw new ApiError(400, 'Choose a different role', { code: 'VALIDATION_ERROR', details: { fields: { reassignTo: 'Choose a different role' } } })
    const target = await resolveRoleChoice(tx, ctx.orgId, reassignTo)
    if (target.role === 'admin' && !hasPermission(ctx.permissions, 'members.manage.admins')) throw new ApiError(403, 'Only the workspace owner can make people admins.', { code: 'FORBIDDEN' })
    const [members, invitations] = await Promise.all([
      tx.membership.updateMany({ where: { organizationId: ctx.orgId, roleId: row.id }, data: { role: target.role, roleId: target.roleId } }),
      tx.invitation.updateMany({ where: { organizationId: ctx.orgId, roleId: row.id }, data: { role: target.role, roleId: target.roleId } }),
    ])
    await tx.role.update({ where: { id: row.id }, data: { archivedAt: new Date(), version: { increment: 1 } } })
    await bumpVersion(tx, ctx.orgId)
    await recordAudit(tx, ctx, { action: 'role.delete', entityType: 'role', entityId: row.id, changes: { name: [row.name, null], movedTo: target.name, members: members.count, invitations: invitations.count } })
  })
  return { deleted: true }
}

/**
 * Checks a draft without saving: problems, what changes against the role as it is now, and who
 * it affects. Powers the confirm step before saving.
 */
export async function previewRole(ctx, { roleId, permissions }) {
  const { key, row } = await editableRole(prisma, ctx, roleId)
  const problems = rolePermissionProblems(permissions)
  const who = key ? { role: key, roleId: null } : { roleId: row.id }
  const [members, count] = await Promise.all([
    prisma.membership.findMany({ where: { organizationId: ctx.orgId, status: 'active', ...who }, select: { userId: true, user: { select: { fullName: true } } }, orderBy: { joinedAt: 'asc' }, take: 5 }),
    prisma.membership.count({ where: { organizationId: ctx.orgId, status: 'active', ...who } }),
  ])
  const current = key ? resolvePermissions({ role: key, systemOverride: row }) : sanitizePermissions(row.permissions)
  const next = problems.some((p) => p.kind === 'invalid') ? current : sanitizePermissions(permissions)
  return {
    problems,
    permissions: next,
    changes: permissionDiff(current, next),
    affected: { count, members: members.map((m) => ({ userId: m.userId, fullName: m.user.fullName })) },
  }
}
