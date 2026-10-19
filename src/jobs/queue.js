import { PgBoss } from 'pg-boss'
import { env } from '../config/env.js'
import { withStrictSsl } from '../db/connectionString.js'
import { logger } from '../lib/logger.js'
import { QUEUES } from './queues.js'

/**
 * Postgres-backed job queue (pg-boss) — no extra infrastructure on Neon. It needs a direct
 * (unpooled) connection, so it uses DATABASE_URL_UNPOOLED.
 *
 * - The API process starts it in "producer" mode: it only sends jobs.
 * - The worker process (src/worker.js) also runs maintenance, cron schedules and job handlers.
 */

const log = logger.child({ component: 'jobs' })
let boss = null
let startPromise = null

/** @param {{ role: 'api' | 'worker' }} options */
export function startQueue({ role }) {
  startPromise ??= (async () => {
    const isWorker = role === 'worker'
    boss = new PgBoss({
      connectionString: withStrictSsl(env.DATABASE_URL_UNPOOLED),
      application_name: `techsync-${role}`,
      max: isWorker ? 5 : 2,
      supervise: isWorker,
      schedule: isWorker,
      instanceName: role,
    })
    boss.on('error', (err) => log.error({ err }, 'pg-boss error'))
    await boss.start()
    await ensureQueues()
    log.info({ role }, 'job queue started')
    return boss
  })().catch((err) => {
    startPromise = null
    boss = null
    throw err
  })
  return startPromise
}

async function ensureQueues() {
  for (const [name, options] of Object.entries(QUEUES)) {
    if (!(await boss.getQueue(name))) await boss.createQueue(name, options)
  }
}

function requireBoss() {
  if (!boss) throw new Error('Job queue is not started')
  return boss
}

/**
 * Sends a job. `options` are pg-boss SendOptions (startAfter, singletonKey, …).
 * @returns {Promise<string | null>} job id (null when deduplicated by a singleton key)
 */
export async function enqueue(name, data, options) {
  if (!QUEUES[name]) throw new Error(`Unknown queue "${name}" — add it to jobs/queues.js`)
  if (startPromise) await startPromise
  return requireBoss().send(name, data ?? {}, options)
}

/**
 * Registers a handler (worker only). The handler receives one job at a time; throwing fails the
 * job, which pg-boss retries according to the queue's policy.
 * @param {string} name
 * @param {(job: { id: string, data: any, retryCount: number }) => Promise<unknown>} handler
 */
export async function registerHandler(name, handler, { concurrency = 1 } = {}) {
  await requireBoss().work(name, { batchSize: 1, localConcurrency: concurrency }, async ([job]) => {
    const started = Date.now()
    try {
      const result = await handler(job)
      log.debug({ queue: name, jobId: job.id, ms: Date.now() - started }, 'job completed')
      return result
    } catch (err) {
      log.warn({ err, queue: name, jobId: job.id, retryCount: job.retryCount }, 'job failed')
      throw err
    }
  })
}

/** Registers a cron schedule (worker only). Times are evaluated in `tz`. */
export async function schedule(name, cron, data, { tz = 'Asia/Kolkata' } = {}) {
  await requireBoss().schedule(name, cron, data ?? null, { tz })
}

export async function stopQueue() {
  if (!boss) return
  await boss.stop({ graceful: true, timeout: 10_000 }).catch((err) => log.error({ err }, 'pg-boss stop failed'))
  boss = null
  startPromise = null
}
