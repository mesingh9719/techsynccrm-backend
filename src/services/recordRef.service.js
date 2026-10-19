import { permissionsFor } from '../config/permissions.js'
import { prisma } from '../db/prisma.js'
import { validationError } from '../lib/records.js'
import { canAccessRecord, visibilityWhere } from '../lib/visibility.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * References to CRM records by (entityType, entityId) — used by activities and tasks (M10), which
 * can hang off a lead, contact, company or deal.
 */

export const RECORD_TYPES = {
  lead: { model: 'lead', resource: 'leads', label: 'lead', name: 'displayName' },
  contact: { model: 'contact', resource: 'contacts', label: 'contact', name: 'displayName' },
  company: { model: 'company', resource: 'companies', label: 'company', name: 'name' },
  deal: { model: 'deal', resource: 'deals', label: 'deal', name: 'title' },
}
export const RECORD_ENTITY_TYPES = Object.keys(RECORD_TYPES)

function typeOf(entityType) {
  const t = RECORD_TYPES[entityType]
  if (!t) throw validationError({ entityType: 'Choose a lead, contact, company or deal' })
  return t
}

/**
 * Loads a live record the caller may `action` (read/update). Not visible → 404 (also for other
 * workspaces); visible but not allowed → 403.
 * @returns {Promise<{ id: string, ownerId: string|null, name: string, entityType: string }>}
 */
export async function loadRecord(ctx, entityType, entityId, action = 'read', db = prisma) {
  const t = typeOf(entityType)
  const row = await db[t.model].findFirst({
    where: { AND: [{ id: entityId, organizationId: ctx.orgId, deletedAt: null }, visibilityWhere(ctx, t.resource, 'read')] },
    select: { id: true, ownerId: true, [t.name]: true },
  })
  if (!row) throw ApiError.notFound(`This ${t.label} doesn’t exist or you can’t see it`)
  if (action !== 'read' && !canAccessRecord(ctx, t.resource, action, row.ownerId)) {
    throw new ApiError(403, `You don’t have permission to change this ${t.label}.`, { code: 'FORBIDDEN' })
  }
  return { id: row.id, ownerId: row.ownerId, name: row[t.name], entityType }
}

/** Display names for a set of refs: Map<"type:id", name>. Missing/deleted records are skipped. */
export async function namesFor(refs, db = prisma, orgId) {
  const out = new Map()
  for (const [entityType, t] of Object.entries(RECORD_TYPES)) {
    const ids = [...new Set(refs.filter((r) => r.entityType === entityType).map((r) => r.entityId))]
    if (!ids.length) continue
    const rows = await db[t.model].findMany({ where: { id: { in: ids }, ...(orgId && { organizationId: orgId }) }, select: { id: true, [t.name]: true, deletedAt: true } })
    for (const r of rows) out.set(`${entityType}:${r.id}`, { name: r[t.name], deleted: Boolean(r.deletedAt) })
  }
  return out
}

/**
 * Records an activity on `entityType/entityId` should also show on: a deal's company and contacts,
 * a contact's companies, an existing customer's contact for a lead.
 * @returns {Promise<{ entityType: string, entityId: string }[]>}
 */
export async function relatedRefs(orgId, entityType, entityId, db = prisma) {
  if (entityType === 'deal') {
    const deal = await db.deal.findFirst({ where: { id: entityId, organizationId: orgId }, select: { companyId: true, contacts: { select: { contactId: true } } } })
    if (!deal) return []
    return [...(deal.companyId ? [{ entityType: 'company', entityId: deal.companyId }] : []), ...deal.contacts.map((c) => ({ entityType: 'contact', entityId: c.contactId }))]
  }
  if (entityType === 'contact') {
    const links = await db.contactCompany.findMany({ where: { contactId: entityId, organizationId: orgId }, select: { companyId: true, isPrimary: true } })
    return links.filter((l) => l.isPrimary || links.length === 1).map((l) => ({ entityType: 'company', entityId: l.companyId }))
  }
  if (entityType === 'lead') {
    const lead = await db.lead.findFirst({ where: { id: entityId, organizationId: orgId }, select: { contactId: true, convertedContactId: true, convertedDealId: true } })
    const out = []
    if (lead?.contactId) out.push({ entityType: 'contact', entityId: lead.contactId })
    if (lead?.convertedContactId) out.push({ entityType: 'contact', entityId: lead.convertedContactId })
    if (lead?.convertedDealId) out.push({ entityType: 'deal', entityId: lead.convertedDealId })
    return out
  }
  return []
}

/**
 * Whether another member can read a record (mentions, task assignees). Mirrors requireOrg's
 * context for that member: role permissions plus the teams they manage.
 */
export async function memberCanRead(orgId, userId, entityType, ownerId, db = prisma) {
  const membership = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: orgId, userId } }, select: { role: true, status: true } })
  if (membership?.status !== 'active') return false
  if (!entityType) return true
  let managedUserIds = []
  if (membership.role === 'manager') {
    const rows = await db.teamMember.findMany({ where: { team: { organizationId: orgId, members: { some: { userId, isManager: true } } } }, select: { userId: true } })
    managedUserIds = rows.map((r) => r.userId)
  }
  return canAccessRecord({ userId, permissions: permissionsFor(membership.role), managedUserIds }, RECORD_TYPES[entityType].resource, 'read', ownerId)
}
