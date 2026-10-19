import { prisma } from '../../db/prisma.js'
import { usersById } from '../../lib/records.js'
import { createSystemActivity } from '../../services/activity.service.js'
import { relatedRefs } from '../../services/recordRef.service.js'
import { subscribe } from '../registry.js'

/**
 * Timeline (M10): turns domain events into system activities on the records they concern.
 * Idempotent — activities.source_event_id is unique, so a redelivered event creates nothing.
 */

const STATUS = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', converted: 'Converted', lost: 'Lost', junk: 'Junk' }
const rupees = (minor) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(minor ?? 0) / 100)

async function ownerChange(event, noun) {
  const [from, to] = event.payload?.changes?.ownerId ?? [null, null]
  const users = await usersById([from, to])
  const name = (id) => (id ? (users.get(id)?.fullName ?? 'a member') : 'nobody')
  if (event.payload?.claimed) return `${name(to)} claimed this ${noun}`
  return to ? `Assigned to ${name(to)}${from ? ` (was ${name(from)})` : ''}` : `Unassigned (was ${name(from)})`
}

/** event type → { refs, subject, meta } (or null to skip). */
const HANDLERS = {
  'lead.created': async (e) => {
    const source = e.payload?.sourceId ? await prisma.leadSource.findUnique({ where: { id: e.payload.sourceId }, select: { name: true } }) : null
    return { subject: source ? `Lead created from ${source.name}` : 'Lead created', meta: { sourceId: e.payload?.sourceId ?? null } }
  },
  'lead.status_changed': async (e) => {
    const [from, to] = e.payload?.changes?.status ?? []
    let reason = ''
    if (e.payload?.lostReasonId) reason = ` — ${(await prisma.lostReason.findUnique({ where: { id: e.payload.lostReasonId }, select: { name: true } }))?.name ?? 'reason given'}`
    if (e.payload?.junkReason) reason = ` — ${e.payload.junkReason.replace('_', ' ')}`
    return { subject: `Status changed from ${STATUS[from] ?? from} to ${STATUS[to] ?? to}${reason}`, meta: { changes: e.payload?.changes } }
  },
  'lead.assigned': async (e) => ({ subject: await ownerChange(e, 'lead'), meta: { changes: e.payload?.changes } }),
  'lead.repeat_enquiry': async (e) => ({ subject: `Enquired again${e.payload?.sourceName ? ` via ${e.payload.sourceName}` : ''}${e.payload?.requirement ? `: “${String(e.payload.requirement).slice(0, 120)}”` : ''}`, meta: {} }),
  'lead.converted': async (e) => ({
    subject: e.payload?.dealId ? 'Converted to a contact and a deal' : 'Converted to a contact',
    extraRefs: [
      ...(e.payload?.contactId ? [{ entityType: 'contact', entityId: e.payload.contactId }] : []),
      ...(e.payload?.dealId ? [{ entityType: 'deal', entityId: e.payload.dealId }] : []),
      ...(e.payload?.companyId ? [{ entityType: 'company', entityId: e.payload.companyId }] : []),
    ],
    meta: { contactId: e.payload?.contactId ?? null, dealId: e.payload?.dealId ?? null },
  }),
  'contact.created': async (e) => (e.payload?.fromLeadId ? { subject: 'Created from a lead', meta: { leadId: e.payload.fromLeadId } } : null),
  'contact.assigned': async (e) => ({ subject: await ownerChange(e, 'contact'), meta: { changes: e.payload?.changes } }),
  'contact.merged': async (e) => ({ subject: `Merged with ${e.payload?.mergedIds?.length ?? 1} duplicate${(e.payload?.mergedIds?.length ?? 1) === 1 ? '' : 's'}`, meta: { mergedIds: e.payload?.mergedIds } }),
  'company.merged': async (e) => ({ subject: `Merged with ${e.payload?.mergedIds?.length ?? 1} duplicate${(e.payload?.mergedIds?.length ?? 1) === 1 ? '' : 's'}`, meta: { mergedIds: e.payload?.mergedIds } }),
  'deal.created': async (e) => ({ subject: `Deal created${Number(e.payload?.valueMinor) > 0 ? ` worth ${rupees(e.payload.valueMinor)}` : ''}`, related: true, meta: { leadId: e.payload?.leadId ?? null } }),
  'deal.stage_changed': async (e) => ({ subject: `Moved from ${e.payload?.fromStageName ?? 'a stage'} to ${e.payload?.toStageName ?? 'a stage'}`, related: true, meta: { changes: e.payload?.changes } }),
  'deal.won': async (e) => ({ subject: `Deal won${Number(e.payload?.valueMinor) > 0 ? ` — ${rupees(e.payload.valueMinor)}` : ''} 🎉`, related: true, meta: {} }),
  'deal.lost': async (e) => {
    const reason = e.payload?.lostReasonId ? (await prisma.lostReason.findUnique({ where: { id: e.payload.lostReasonId }, select: { name: true } }))?.name : null
    return { subject: `Deal lost${reason ? ` — ${reason}` : ''}`, related: true, meta: { lostReasonId: e.payload?.lostReasonId ?? null } }
  },
  'deal.reopened': async () => ({ subject: 'Deal reopened', related: true, meta: {} }),
  'deal.assigned': async (e) => ({ subject: await ownerChange(e, 'deal'), meta: { changes: e.payload?.changes } }),
  'task.completed': async (e) =>
    e.payload?.recordType && e.payload?.recordId
      ? { primary: { entityType: e.payload.recordType, entityId: e.payload.recordId }, subject: `Task completed: ${e.payload.title ?? 'task'}`, related: true, meta: { taskId: e.entityId } }
      : null,
}

subscribe('timeline', Object.keys(HANDLERS), async (event) => {
  const result = await HANDLERS[event.type](event)
  if (!result) return
  const primary = result.primary ?? { entityType: event.entityType, entityId: event.entityId }
  const related = result.related ? await relatedRefs(event.organizationId, primary.entityType, primary.entityId) : []
  await createSystemActivity(event, { refs: [primary, ...related, ...(result.extraRefs ?? [])], subject: result.subject, meta: result.meta })
})
