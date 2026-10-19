import { prisma } from '../db/prisma.js'
import { logger } from '../lib/logger.js'
import { subscribersFor } from './registry.js'

const log = logger.child({ component: 'events' })

const BATCH_SIZE = 100
/** How long a claimed event is reserved for this dispatcher before another may take it. */
const LEASE_SECONDS = 300
/** Events that keep failing are parked after this many attempts (left unprocessed, logged at error). */
export const MAX_ATTEMPTS = 10
const IDLE_POLL_MS = 1000

/**
 * Claims up to BATCH_SIZE due events. SKIP LOCKED + the lease means concurrent dispatchers (several
 * worker processes) never receive the same event, without holding a transaction open while
 * subscribers run.
 */
async function claimBatch() {
  const rows = await prisma.$queryRaw`
    UPDATE domain_events
       SET claimed_until = now() + make_interval(secs => ${LEASE_SECONDS}),
           attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM domain_events
        WHERE processed_at IS NULL
          AND attempts < ${MAX_ATTEMPTS}
          AND (claimed_until IS NULL OR claimed_until < now())
        ORDER BY created_at
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING id, organization_id, type, entity_type, entity_id, actor_id, payload, created_at, attempts`
  return rows
    .map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      type: r.type,
      entityType: r.entity_type,
      entityId: r.entity_id,
      actorId: r.actor_id,
      payload: r.payload ?? {},
      createdAt: r.created_at,
      attempts: r.attempts,
    }))
    .sort((a, b) => a.createdAt - b.createdAt)
}

async function processEvent(event) {
  const failures = []
  for (const sub of subscribersFor(event.type)) {
    try {
      await sub.handler(event)
    } catch (err) {
      failures.push(`${sub.name}: ${err.message}`)
      log.warn({ err, eventId: event.id, type: event.type, subscriber: sub.name }, 'subscriber failed')
    }
  }

  if (!failures.length) {
    await prisma.domainEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), claimedUntil: null, lastError: null } })
    return
  }
  // Retry later with a growing delay: 30 s, 2 min, 4.5 min, 8 min … (attempts² × 30 s).
  const retryAfter = new Date(Date.now() + event.attempts ** 2 * 30_000)
  await prisma.domainEvent.update({
    where: { id: event.id },
    data: { claimedUntil: retryAfter, lastError: failures.join(' | ').slice(0, 2000) },
  })
  if (event.attempts >= MAX_ATTEMPTS) log.error({ eventId: event.id, type: event.type, failures }, 'event parked after max attempts')
}

/** Processes one batch. Returns the number of events claimed. Exported for tests and scripts. */
export async function dispatchOnce() {
  const batch = await claimBatch()
  for (const event of batch) await processEvent(event)
  return batch.length
}

/** Starts the polling loop. Returns a stop function that resolves once the current batch finishes. */
export function startDispatcher() {
  let stopped = false
  let timer = null
  let running = Promise.resolve()

  const tick = async () => {
    if (stopped) return
    let claimed = 0
    try {
      running = dispatchOnce()
      claimed = await running
    } catch (err) {
      log.error({ err }, 'dispatch failed')
    }
    // A full batch means there is probably more waiting — go again straight away.
    if (!stopped) timer = setTimeout(tick, claimed === BATCH_SIZE ? 0 : IDLE_POLL_MS)
  }

  timer = setTimeout(tick, 0)
  log.info('event dispatcher started')
  return async () => {
    stopped = true
    clearTimeout(timer)
    await running.catch(() => {})
  }
}
