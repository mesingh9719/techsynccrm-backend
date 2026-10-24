import { toJsonValue } from '../lib/json.js'

/**
 * Transactional outbox. Call `emit` with the transaction client inside the same
 * `prisma.$transaction` as the change, so an event exists if and only if the change committed:
 *
 *   await prisma.$transaction(async (tx) => {
 *     const lead = await tx.lead.create({ data })
 *     await emit(tx, ctx, 'lead.created', { entityType: 'lead', entityId: lead.id })
 *   })
 *
 * The worker's dispatcher (events/dispatcher.js) delivers events to subscribers at least once.
 */

/**
 * @param {object} tx Prisma transaction client (or the root client for non-transactional writes)
 * @param {{ orgId?: string|null, userId?: string|null }} ctx
 * @param {string} type "<entity>.<past-tense verb>", e.g. "lead.created"
 * @param {{ entityType: string, entityId: string }} entity
 * @param {object} [payload] ids and a `changes` diff — not whole records
 */
export async function emit(tx, ctx, type, { entityType, entityId }, payload = {}) {
  if (!/^[a-z_]+\.[a-z_]+$/.test(type)) throw new Error(`Invalid event type "${type}"`)
  return tx.domainEvent.create({
    data: {
      organizationId: ctx?.orgId ?? null,
      actorId: ctx?.userId ?? null,
      type,
      entityType,
      entityId,
      payload: toJsonValue(ctx?.importId ? { ...payload, meta: { ...payload.meta, importId: ctx.importId } } : payload) ?? {},
    },
    select: { id: true },
  })
}

/**
 * `emit` for many records of one type in a single insert (bulk actions): one round trip inside the
 * transaction instead of one per record. `payloadFor(entityId)` builds each event's payload.
 */
export async function emitMany(tx, ctx, type, entityType, entityIds, payloadFor = () => ({})) {
  if (!/^[a-z_]+\.[a-z_]+$/.test(type)) throw new Error(`Invalid event type "${type}"`)
  if (!entityIds.length) return { count: 0 }
  return tx.domainEvent.createMany({
    data: entityIds.map((entityId) => {
      const payload = payloadFor(entityId)
      return {
        organizationId: ctx?.orgId ?? null,
        actorId: ctx?.userId ?? null,
        type,
        entityType,
        entityId,
        payload: toJsonValue(ctx?.importId ? { ...payload, meta: { ...payload.meta, importId: ctx.importId } } : payload) ?? {},
      }
    }),
  })
}

// Money columns are BigInt, which JSON.stringify rejects; compare them as strings.
const stable = (value) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))
const isEqual = (a, b) => {
  if (a instanceof Date || b instanceof Date) return a?.valueOf?.() === b?.valueOf?.()
  if (typeof a === 'bigint' || typeof b === 'bigint') return a !== null && b !== null && BigInt(a) === BigInt(b)
  if (typeof a === 'object' || typeof b === 'object') return stable(a) === stable(b)
  return a === b
}

/**
 * Field-level diff for event payloads and audit entries: `{ field: [old, new] }` for each listed
 * field that changed. Returns null when nothing changed.
 */
export function diff(before, after, fields) {
  const changes = {}
  for (const field of fields) {
    const from = before?.[field] ?? null
    const to = after?.[field] ?? null
    if (!isEqual(from, to)) changes[field] = [from, to]
  }
  return Object.keys(changes).length ? changes : null
}
