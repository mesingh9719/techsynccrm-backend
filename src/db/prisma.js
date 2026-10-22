import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, Prisma } from '../generated/prisma/client.js'
import { env } from '../config/env.js'
import { withStrictSsl } from './connectionString.js'
import { observeQuery } from '../lib/performance.js'
import { logger } from '../lib/logger.js'

/**
 * Single Prisma client for the whole process.
 *
 * Express runs as a long-lived Node server, so Prisma uses the node-postgres driver adapter
 * with a reusable pool over Neon's pooled (PgBouncer) DATABASE_URL. Migrations use the
 * direct DATABASE_URL_UNPOOLED instead — see prisma.config.ts.
 */
const adapter = new PrismaPg({
  connectionString: withStrictSsl(env.DATABASE_URL),
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  // Neon computes can scale to zero; allow time for a cold start.
  connectionTimeoutMillis: 10_000,
})

export const prisma = new PrismaClient({
  adapter,
  // Hosted-database round trips can exceed Prisma's 5 s default across a multi-query
  // write. Keep a bounded budget; individual transactions can still override it.
  transactionOptions: {
    maxWait: env.DB_TRANSACTION_MAX_WAIT_MS ?? 10_000,
    timeout: env.DB_TRANSACTION_TIMEOUT_MS ?? 15_000,
  },
  log: [...(env.isProduction ? ['error'] : ['warn', 'error']), ...(env.PERFORMANCE_METRICS ? [{ emit: 'event', level: 'query' }] : [])],
})

if (env.PERFORMANCE_METRICS) prisma.$on('query', (event) => observeQuery(event, logger, env.SLOW_QUERY_MS))

export async function pingDatabase() {
  await prisma.$queryRaw`SELECT 1`
}

/** Prisma error code for a unique-constraint violation. */
export const UNIQUE_VIOLATION = 'P2002'

/** Writes SQL NULL to a nullable JSON column (Prisma rejects a plain `null` there). */
export const DB_NULL = Prisma.DbNull
