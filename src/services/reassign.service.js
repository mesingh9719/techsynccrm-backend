import { prisma } from '../db/prisma.js'
import { emit } from '../events/outbox.js'
import { enqueue } from '../jobs/queue.js'
import { recordAudit } from '../lib/audit.js'
import { logger } from '../lib/logger.js'
import { listReassignables } from '../lib/visibility.js'

const log = logger.child({ component: 'reassign' })

/**
 * Moves a departing member's open records (every table registered with registerReassignable in
 * lib/visibility.js) to another member of the same workspace. Idempotent: running it twice is safe.
 *
 * @param {{ organizationId: string, fromUserId: string, toUserId: string, actorId?: string | null }} data
 */
export async function reassignRecords({ organizationId, fromUserId, toUserId, actorId = null }) {
  const moved = {}
  for (const { entity, model, ownerField, openWhere } of listReassignables()) {
    const { count } = await prisma[model].updateMany({
      where: { organizationId, [ownerField]: fromUserId, ...openWhere },
      data: { [ownerField]: toUserId },
    })
    if (count) moved[entity] = count
  }
  const ctx = { orgId: organizationId, userId: actorId, actorType: actorId ? 'user' : 'system' }
  await prisma.$transaction(async (tx) => {
    await emit(tx, ctx, 'member.records_reassigned', { entityType: 'user', entityId: fromUserId }, { toUserId, moved })
    await recordAudit(tx, ctx, { action: 'member.reassign', entityType: 'user', entityId: fromUserId, changes: { ownerId: [fromUserId, toUserId], moved } })
  })
  return moved
}

/** Queues the reassignment for the worker; runs it inline if the queue isn't available. */
export async function scheduleReassignment(data) {
  try {
    await enqueue('members.reassign', data, { singletonKey: `${data.organizationId}:${data.fromUserId}` })
  } catch (err) {
    log.warn({ err }, 'queue unavailable, reassigning inline')
    await reassignRecords(data)
  }
}
