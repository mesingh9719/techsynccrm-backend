import { prisma } from '../../db/prisma.js'
import { subscribe } from '../registry.js'

// Use current record state so a delayed deletion event cannot hide links after a restore.
subscribe('file-links', ['lead.deleted', 'lead.restored', 'contact.deleted', 'contact.restored', 'company.deleted', 'company.restored', 'deal.deleted', 'deal.restored', 'activity.deleted'], async (event) => {
  if (!event.organizationId || !['lead', 'contact', 'company', 'deal', 'activity'].includes(event.entityType)) return
  const record = await prisma[event.entityType].findFirst({ where: { id: event.entityId, organizationId: event.organizationId }, select: { deletedAt: true } })
  await prisma.fileLink.updateMany({ where: { organizationId: event.organizationId, entityType: event.entityType, entityId: event.entityId }, data: { deletedAt: record ? record.deletedAt : event.createdAt } })
})
