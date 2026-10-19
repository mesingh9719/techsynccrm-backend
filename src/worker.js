import os from 'node:os'
import { prisma } from './db/prisma.js'
import { closeMailer, verifyMailer } from './email/mailer.js'
import { startDispatcher } from './events/dispatcher.js'
import './events/subscribers/index.js'
import { startQueue, stopQueue } from './jobs/queue.js'
import { registerJobs } from './jobs/schedules.js'
import { logger } from './lib/logger.js'

/**
 * Background worker: job handlers, cron schedules and the domain-event dispatcher.
 * Run alongside the API with `npm run worker`. Safe to run more than one instance.
 */

const log = logger.child({ component: 'worker' })
const HEARTBEAT_ID = process.env.WORKER_ID ?? 'worker'
const HEARTBEAT_MS = 30_000

async function beat(startedAt) {
  const now = new Date()
  await prisma.workerHeartbeat.upsert({
    where: { id: HEARTBEAT_ID },
    create: { id: HEARTBEAT_ID, startedAt, lastBeatAt: now, pid: process.pid, host: os.hostname() },
    update: { lastBeatAt: now, pid: process.pid, host: os.hostname() },
  })
}

async function main() {
  const startedAt = new Date()
  verifyMailer()
  await startQueue({ role: 'worker' })
  await registerJobs()
  const stopDispatcher = startDispatcher()

  await beat(startedAt)
  const heartbeat = setInterval(() => beat(startedAt).catch((err) => log.error({ err }, 'heartbeat failed')), HEARTBEAT_MS)
  log.info({ id: HEARTBEAT_ID }, 'worker running')

  let shuttingDown = false
  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`${signal} received, shutting down`)
    setTimeout(() => process.exit(1), 15_000).unref()
    clearInterval(heartbeat)
    await stopDispatcher()
    await stopQueue()
    closeMailer()
    await prisma.$disconnect().catch(() => {})
    process.exit(exitCode)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandled promise rejection')
    shutdown('unhandledRejection', 1)
  })
}

main().catch((err) => {
  log.fatal({ err }, 'worker failed to start')
  process.exit(1)
})
