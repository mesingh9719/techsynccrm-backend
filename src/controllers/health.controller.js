import { prisma, pingDatabase } from '../db/prisma.js'

/** A worker that hasn't checked in for this long is reported as stale (it beats every 30 s). */
const WORKER_STALE_MS = 2 * 60 * 1000

async function workerStatus() {
  try {
    const latest = await prisma.workerHeartbeat.findFirst({ orderBy: { lastBeatAt: 'desc' }, select: { lastBeatAt: true } })
    if (!latest) return 'stale'
    return Date.now() - latest.lastBeatAt.getTime() < WORKER_STALE_MS ? 'ok' : 'stale'
  } catch {
    return 'unknown'
  }
}

/**
 * Liveness + database readiness. Returns 503 if Postgres is unreachable. A stale worker is
 * reported but doesn't fail the check — the API itself can still serve requests.
 */
export async function getHealth(_req, res) {
  let database = 'ok'
  try {
    await pingDatabase()
  } catch {
    database = 'unavailable'
  }
  const worker = database === 'ok' ? await workerStatus() : 'unknown'
  res.status(database === 'ok' ? 200 : 503).json({
    success: database === 'ok',
    data: {
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      worker,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  })
}
