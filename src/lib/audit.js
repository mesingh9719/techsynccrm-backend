import { prisma } from '../db/prisma.js'
import { toJsonValue } from './json.js'
import { logger } from './logger.js'

/**
 * Who did something, taken from the request. Services receive this (or the full `req.ctx` once
 * organizations exist) rather than `req` itself.
 */
export function auditContext(req, extra = {}) {
  return {
    orgId: req.ctx?.orgId ?? null,
    userId: req.user?.id ?? null,
    actorType: 'user',
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
    ...extra,
  }
}

/**
 * Appends an audit entry. Pass the transaction client when the action happens in a transaction so
 * the entry commits (or rolls back) with it.
 *
 * @param {object} db prisma client or transaction client
 * @param {{ orgId?: string|null, userId?: string|null, actorType?: string, ip?: string|null, userAgent?: string|null }} ctx
 * @param {{ action: string, entityType?: string, entityId?: string, changes?: object }} entry
 */
export async function recordAudit(db, ctx, { action, entityType, entityId, changes }) {
  await (db ?? prisma).auditLog.create({
    data: {
      organizationId: ctx?.orgId ?? null,
      actorUserId: ctx?.userId ?? null,
      actorType: ctx?.actorType ?? (ctx?.userId ? 'user' : 'system'),
      action,
      entityType: entityType ?? null,
      entityId: entityId ?? null,
      changes: changes ? toJsonValue(changes) : undefined,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
    },
  })
}

/** For audit entries outside a transaction where a failure must not break the user's action. */
export async function tryRecordAudit(ctx, entry) {
  try {
    await recordAudit(prisma, ctx, entry)
  } catch (err) {
    logger.error({ err, action: entry.action }, '[audit] failed to record entry')
  }
}
