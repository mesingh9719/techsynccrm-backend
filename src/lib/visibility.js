import { scopeFor } from '../config/permissions.js'
import { ApiError } from '../utils/ApiError.js'

/** Unowned records anyone with read access can see: unassigned leads (to claim them — D10), and contacts/companies without an owner (M07). */
const UNOWNED_READABLE = new Set(['leads', 'contacts', 'companies'])

/**
 * Record visibility (M04). Every CRM list/get/update/delete query merges the `where` from here:
 *
 *   const where = { organizationId: ctx.orgId, ...visibilityWhere(ctx, 'leads') }
 *
 * - all  → no extra condition
 * - team → owned by me or by members of teams I manage
 * - own  → owned by me
 * For reads of leads, contacts and companies, team/own scopes also see unowned records.
 *
 * Throws 403 when the role has no access at all for that action.
 */
export function visibilityWhere(ctx, resource, action = 'read', ownerField = 'ownerId') {
  const scope = scopeFor(ctx.permissions, resource, action)
  if (scope === 'all') return {}
  if (scope === 'team' || scope === 'own') {
    const ids = scope === 'team' ? [ctx.userId, ...(ctx.managedUserIds ?? [])] : [ctx.userId]
    const owned = ids.length === 1 ? { [ownerField]: ids[0] } : { [ownerField]: { in: ids } }
    if (action === 'read' && !ctx.forExport && UNOWNED_READABLE.has(resource)) return { OR: [owned, { [ownerField]: null }] }
    return owned
  }
  throw new ApiError(403, 'You don’t have permission to do this in this workspace.', { code: 'FORBIDDEN' })
}

/** For in-memory checks on a loaded record (e.g. before an update). */
export function canAccessRecord(ctx, resource, action, ownerId) {
  const scope = scopeFor(ctx.permissions, resource, action)
  if (scope === 'all') return true
  if (!scope) return false
  if (ownerId === null && action === 'read' && UNOWNED_READABLE.has(resource)) return true
  if (scope === 'team') return ownerId === ctx.userId || (ctx.managedUserIds ?? []).includes(ownerId)
  return ownerId === ctx.userId
}

/** The caller's scope for an action, or null — e.g. to decide whether "update" is allowed at all. */
export function recordScope(ctx, resource, action) {
  return scopeFor(ctx.permissions, resource, action)
}

// ---------- Reassignment registry ----------

/**
 * Tables with an owner column, so a deactivated member's open records can be handed to someone else
 * (members.reassign job). CRM modules register theirs at import time, e.g. in leads.service.js:
 *
 *   registerReassignable({ entity: 'lead', model: 'lead', ownerField: 'ownerId', openWhere: { status: { notIn: ['converted', 'lost', 'junk'] } } })
 */
const reassignables = []

/**
 * @param {{ entity: string, model: string, ownerField?: string, openWhere?: object }} definition
 *   `model` is the Prisma delegate name; `openWhere` limits reassignment to open records.
 */
export function registerReassignable({ entity, model, ownerField = 'ownerId', openWhere = {} }) {
  if (reassignables.some((r) => r.entity === entity)) return
  reassignables.push({ entity, model, ownerField, openWhere })
}

export function listReassignables() {
  return [...reassignables]
}

/** An all-scope empty condition must not be nested inside Prisma OR: it would be discarded. */
export function taskVisibilityWhere(ctx) {
  const assigned = visibilityWhere(ctx, 'tasks', 'read', 'assigneeId')
  return Object.keys(assigned).length ? { OR: [assigned, { createdById: ctx.userId }] } : {}
}
