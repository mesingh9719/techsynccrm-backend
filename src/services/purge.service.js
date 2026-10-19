import { prisma } from '../db/prisma.js'
import { logger } from '../lib/logger.js'
import { RESTORE_WINDOW_DAYS } from '../lib/records.js'
import { deleteTagsOf } from './tag.service.js'

/**
 * `records.purge` (nightly): permanently deletes CRM records soft-deleted more than 30 days ago
 * (they can no longer be restored). Lookup rows and company links cascade; polymorphic tag rows
 * are removed here. Merged duplicates are purged too — their history already lives on the survivor
 * and in the audit log.
 */

const log = logger.child({ component: 'purge' })
const BATCH = 500
const MODELS = [
  { model: 'task', entityType: 'task' },
  { model: 'activity', entityType: 'activity' },
  { model: 'deal', entityType: 'deal' },
  { model: 'lead', entityType: 'lead' },
  { model: 'contact', entityType: 'contact' },
  { model: 'company', entityType: 'company' },
]

export async function purgeDeletedRecords(now = new Date()) {
  const cutoff = new Date(now.getTime() - RESTORE_WINDOW_DAYS * 86_400_000)
  const purged = {}
  for (const { model, entityType } of MODELS) {
    let total = 0
    for (;;) {
      const rows = await prisma[model].findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true, organizationId: true }, take: BATCH })
      if (!rows.length) break
      await prisma.$transaction(async (tx) => {
        const byOrg = Map.groupBy(rows, (r) => r.organizationId)
        for (const [orgId, list] of byOrg) await deleteTagsOf(tx, orgId, entityType, list.map((r) => r.id))
        if (model === 'contact') await tx.lead.updateMany({ where: { contactId: { in: rows.map((r) => r.id) } }, data: { contactId: null } })
        await tx[model].deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })
      })
      total += rows.length
      if (rows.length < BATCH) break
    }
    purged[model] = total
  }
  if (Object.values(purged).some(Boolean)) log.info({ purged }, 'purged deleted records')
  return purged
}
