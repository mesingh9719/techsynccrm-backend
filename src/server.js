import app from './app.js'
import { env } from './config/env.js'
import { prisma } from './db/prisma.js'
import { closeMailer, verifyMailer } from './email/mailer.js'
import { startQueue, stopQueue } from './jobs/queue.js'
import { startNotificationListener, stopNotificationStreams } from './realtime/notifications.js'
import { logger } from './lib/logger.js'

const log = logger.child({ component: 'server' })

const server = app.listen(env.PORT, () => {
  log.info(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`)
  verifyMailer()
  startNotificationListener()
  // Producer-only connection for sending jobs. If it can't start, queueEmail() falls back to sending inline.
  if (env.EMAIL_DELIVERY === 'queue') startQueue({ role: 'api' }).catch((err) => log.error({ err }, 'job queue unavailable'))
})

// e.g. EADDRINUSE — fail loudly instead of looking like a clean exit.
server.on('error', (err) => {
  log.fatal(`failed to start: ${err.message}`)
  process.exit(1)
})

/** Stop accepting new connections, let in-flight requests finish, then exit. */
function shutdown(signal, exitCode = 0) {
  log.info(`${signal} received, shutting down gracefully`)
  void stopNotificationStreams()
  server.close(async () => {
    closeMailer()
    await stopQueue()
    await prisma.$disconnect().catch(() => {})
    process.exit(exitCode)
  })
  // Force exit if connections don't close in time.
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'unhandled promise rejection')
  shutdown('unhandledRejection', 1)
})
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception')
  shutdown('uncaughtException', 1)
})
