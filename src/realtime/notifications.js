import { Client } from 'pg'
import { env } from '../config/env.js'
import { NOTIFICATION_CHANNEL } from '../config/notifications.js'
import { prisma } from '../db/prisma.js'
import { withStrictSsl } from '../db/connectionString.js'
import { logger } from '../lib/logger.js'
import { ApiError } from '../utils/ApiError.js'
import { notificationContext } from '../services/notificationAccess.service.js'
import { unreadCount } from '../services/notification.service.js'

const log = logger.child({ component: 'notification-stream' })
const subscriptions = new Map()
const pending = new Map()
let client = null
let retry = null
let stopped = true
let connecting = false
const keyOf = (orgId, userId) => `${orgId}:${userId}`

export function subscribeNotifications(orgId, userId, callback) {
  const key = keyOf(orgId, userId)
  const set = subscriptions.get(key) ?? new Set()
  subscriptions.set(key, set)
  set.add(callback)
  return () => { set.delete(callback); if (!set.size) subscriptions.delete(key) }
}

async function broadcast(orgId, userId) {
  const callbacks = subscriptions.get(keyOf(orgId, userId))
  if (!callbacks?.size) return
  const ctx = await notificationContext(orgId, userId)
  const payload = ctx ? { type: 'notification', unreadCount: await unreadCount(ctx) } : null
  for (const callback of callbacks) callback(payload)
}

/** Coalesce bulk changes and allow at most one unread-count query per recipient at a time. */
function scheduleBroadcast(orgId, userId) {
  const key = keyOf(orgId, userId)
  if (!subscriptions.has(key)) return
  const existing = pending.get(key)
  if (existing) { existing.again = true; return }
  const state = { again: false, timer: null }
  pending.set(key, state)
  state.timer = setTimeout(async () => {
    try { await broadcast(orgId, userId) } catch (err) { log.warn({ err }, 'notification broadcast failed') }
    finally { pending.delete(key); if (state.again && !stopped) scheduleBroadcast(orgId, userId) }
  }, 75)
}

async function connect() {
  if (stopped || connecting || client) return
  connecting = true
  const next = new Client({ connectionString: withStrictSsl(env.DATABASE_URL_UNPOOLED), application_name: 'techsync-notifications-listen', connectionTimeoutMillis: 5000, keepAlive: true })
  const disconnected = () => {
    if (client === next) client = null
    if (!stopped && !retry) retry = setTimeout(() => { retry = null; void connect() }, 5000)
  }
  next.on('error', (err) => { log.warn({ message: err.message }, 'notification listener disconnected'); void next.end().catch(() => {}); disconnected() })
  next.on('end', disconnected)
  next.on('notification', (message) => {
    try {
      const { orgId, userId } = JSON.parse(message.payload)
      if (typeof orgId === 'string' && typeof userId === 'string') scheduleBroadcast(orgId, userId)
    } catch { /* Ignore malformed messages; never forward arbitrary database payloads. */ }
  })
  try {
    await next.connect()
    if (stopped) { await next.end(); return }
    await next.query(`LISTEN ${NOTIFICATION_CHANNEL}`)
    client = next
    // Recover updates missed while the LISTEN connection was down.
    for (const key of subscriptions.keys()) {
      const [orgId, userId] = key.split(':')
      scheduleBroadcast(orgId, userId)
    }
  } catch (err) {
    log.warn({ message: err.message }, 'notification listener unavailable; clients can poll')
    await next.end().catch(() => {})
    disconnected()
  } finally { connecting = false }
}

export function startNotificationListener() { stopped = false; return connect() }
export async function stopNotificationStreams() {
  stopped = true
  clearTimeout(retry); retry = null
  for (const state of pending.values()) clearTimeout(state.timer)
  pending.clear()
  for (const callbacks of subscriptions.values()) for (const callback of callbacks) callback(null)
  subscriptions.clear()
  const current = client; client = null
  await current?.end().catch(() => {})
}

/** Ticket authentication ran through the same workspace guard as ordinary requests. */
export async function openNotificationStream(req, res) {
  const ctx = req.ctx
  if (ctx.sessionId && !(await prisma.refreshToken.findFirst({ where: { userId: ctx.userId, sessionId: ctx.sessionId, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } }))) {
    throw ApiError.unauthorized('Your session has ended. Sign in again.', 'AUTH_REQUIRED')
  }
  const expiresAt = Date.now() + 5 * 60_000
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  let closed = false
  let busy = false
  const push = (payload) => {
    if (closed) return
    if (!payload) { close(); return }
    // Disconnect slow readers rather than allowing an unbounded response buffer.
    if (!res.write(`data: ${JSON.stringify(payload)}\n\n`)) close()
    res.flush?.()
  }
  const unsubscribe = subscribeNotifications(ctx.orgId, ctx.userId, push)
  const heartbeat = setInterval(async () => {
    if (closed || busy) return
    busy = true
    try {
      if (Date.now() >= expiresAt) return close()
      if (!(await notificationContext(ctx.orgId, ctx.userId))) return close()
      if (ctx.sessionId && !(await prisma.refreshToken.findFirst({ where: { userId: ctx.userId, sessionId: ctx.sessionId, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } }))) return close()
      res.write(': keep-alive\n\n'); res.flush?.()
    } catch { close() } finally { busy = false }
  }, 20_000)
  function close() {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    res.end()
  }
  res.on('close', close)
  try { push({ type: 'notification', unreadCount: await unreadCount(ctx) }) } catch { close() }
}
