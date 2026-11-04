import crypto from 'node:crypto'
import { LOCKED_ROLES, ROLE_INFO, permissionsFor, sanitizePermissions } from '../config/permissions.js'

/**
 * A member's effective permissions (RBAC), on every plan. In order:
 *   owner / admin                           → code defaults (locked)
 *   custom role (Membership.roleId)         → its permissions
 *   edited built-in role (roles.system_key) → its permissions
 *   otherwise                               → code defaults for Membership.role
 * Stored lists are sanitised, so a bad row can never grant owner- or admin-only permissions.
 */
export function resolvePermissions({ role, customRole = null, systemOverride = null }) {
  if (LOCKED_ROLES.includes(role)) return permissionsFor(role)
  if (customRole && !customRole.archivedAt) return sanitizePermissions(customRole.permissions)
  if (systemOverride) return sanitizePermissions(systemOverride.permissions)
  return permissionsFor(role)
}

// ---------- Per-request lookup (cached) ----------

const CACHE_LIMIT = 2000
const cache = new Map()

/**
 * Effective permissions for the request path. Workspaces that never edited a role
 * (`rolesVersion` 0) need no query; otherwise the result is cached per role version, so an edit
 * (which bumps organizations.roles_version) is picked up on the next request by every process.
 */
export async function memberPermissions(db, { orgId, role, roleId = null, rolesVersion = 0 }) {
  if (LOCKED_ROLES.includes(role) || (!rolesVersion && !roleId)) return permissionsFor(role)
  const key = `${orgId}:${rolesVersion}:${role}:${roleId ?? ''}`
  const hit = cache.get(key)
  if (hit) return hit
  const rows = await db.role.findMany({
    where: { organizationId: orgId, OR: [...(roleId ? [{ id: roleId }] : []), { systemKey: role }] },
    select: { id: true, systemKey: true, permissions: true, archivedAt: true },
  })
  const permissions = resolvePermissions({
    role,
    customRole: (roleId && rows.find((r) => r.id === roleId)) || null,
    systemOverride: rows.find((r) => r.systemKey === role) ?? null,
  })
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
  cache.set(key, permissions)
  return permissions
}

/** For tests. */
export function clearPermissionCache() {
  cache.clear()
}

// ---------- Session summary ----------

/** Membership fields for `summaryAccess` (nest under a membership select). */
export const summaryMembershipSelect = { role: true, roleId: true, customRole: { select: { id: true, name: true, permissions: true, archivedAt: true } } }

/** Organization fields for `summaryAccess` (nest under an organization select). */
export const summaryOrganizationSelect = { plan: true, rolesVersion: true, roles: { where: { systemKey: { not: null } }, select: { systemKey: true, permissions: true } } }

/**
 * Role and permissions embedded in the signed-in user's workspace summary. `accessVersion` is
 * also sent as the X-Access-Version header on every workspace response, so the app can tell when
 * its copy is out of date and reload the session.
 */
export function summaryAccess(org, membership) {
  const { role, customRole = null } = membership
  const permissions = resolvePermissions({ role, customRole,systemOverride: org.roles?.find((r) => r.systemKey === role) ?? null })
  const custom = customRole && !customRole.archivedAt && !LOCKED_ROLES.includes(role) ? customRole : null
  return { role, roleId: custom?.id ?? null, roleName: custom?.name ?? ROLE_INFO[role]?.name ?? role, permissions, accessVersion: accessVersion(permissions) }
}

const versions = new WeakMap()

/** Short fingerprint of a permission list (order-insensitive). */
export function accessVersion(permissions) {
  let version = versions.get(permissions)
  if (!version) {
    version = crypto.createHash('sha256').update([...permissions].sort().join(',')).digest('base64url').slice(0, 12)
    versions.set(permissions, version)
  }
  return version
}
