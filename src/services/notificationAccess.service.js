import { permissionsFor } from '../config/permissions.js'
import { planHasFeature } from '../config/plans.js'
import { prisma } from '../db/prisma.js'
import { taskVisibilityWhere } from '../lib/visibility.js'
import { loadRecord, RECORD_TYPES } from './recordRef.service.js'

/** Build the recipient's current context, never the actor's permissions. */
export async function notificationContext(orgId, userId, db = prisma) {
  const membership = await db.membership.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
    select: {
      role: true, status: true,
      user: { select: { id: true, fullName: true, email: true, emailVerifiedAt: true, deletedAt: true, twoFactorEnabledAt: true, timezone: true, quietHours: true, digestEnabled: true } },
      organization: { select: { id: true, name: true, timezone: true, plan: true, require2fa: true, deletedAt: true, seatSelectionRequiredAt: true, trialEndsAt: true } },
    },
  })
  if (!membership || membership.status !== 'active') return null
  const { user, organization: org, role } = membership
  if (user.deletedAt || !user.emailVerifiedAt || org.deletedAt) return null
  if (org.require2fa && planHasFeature(org.plan, 'require2fa') && !user.twoFactorEnabledAt) return null
  if (org.seatSelectionRequiredAt && role !== 'owner') {
    if (role !== 'admin') return null
    const senior = await db.membership.findFirst({ where: { organizationId: orgId, role: 'admin', status: 'active' }, orderBy: [{ joinedAt: 'asc' }, { createdAt: 'asc' }], select: { userId: true } })
    if (senior?.userId !== userId) return null
  }
  const team = role === 'manager' ? await db.teamMember.findMany({ where: { team: { organizationId: orgId, members: { some: { userId, isManager: true } } } }, select: { userId: true } }) : []
  return { orgId, userId, role, permissions: permissionsFor(role), managedUserIds: team.map((m) => m.userId), timezone: user.timezone || org.timezone, user, organization: org }
}

/** Recheck both scope and event-specific state before exposing or emailing record data. */
export async function notificationRecord(ctx, notification, db = prisma, now = new Date(), knownRecord) {
  const { entityType, entityId, type, context = {} } = notification
  let record = null
  try {
    if (RECORD_TYPES[entityType]) {
      record = knownRecord === undefined ? await loadRecord(ctx, entityType, entityId, 'read', db) : knownRecord
      if (!record) return null
      if (['lead_assigned', 'lead_repeat_enquiry', 'deal_assigned', 'deal_rotting'].includes(type) && record.ownerId !== ctx.userId) return null
      if (type === 'new_unassigned_lead' && record.ownerId !== null) return null
      if (type === 'deal_rotting') {
        const d = await db.deal.findFirst({ where: { id: entityId, organizationId: ctx.orgId, deletedAt: null }, include: { stage: true } })
        if (!d || d.status !== 'open' || d.stage.rottingDays == null || now - new Date(Math.max(d.lastActivityAt?.getTime() ?? 0, d.stageEnteredAt.getTime())) <= d.stage.rottingDays * 86400000) return null
      }
    } else if (entityType === 'task') {
      const task = await db.task.findFirst({ where: { AND: [{ id: entityId, organizationId: ctx.orgId, deletedAt: null }, taskVisibilityWhere(ctx)] } })
      if (!task) return null
      if (task.entityType) await loadRecord(ctx, task.entityType, task.entityId, 'read', db)
      if (type.startsWith('task_') && task.assigneeId !== ctx.userId) return null
      if (['task_reminder', 'task_overdue'].includes(type) && task.status !== 'open') return null
      if (type === 'task_reminder' && context.dueAt && task.dueAt?.getTime() !== new Date(context.dueAt).getTime()) return null
      if (type === 'task_reminder' && context.remindAt && task.remindAt?.getTime() !== new Date(context.remindAt).getTime()) return null
      if (type === 'task_overdue' && (!task.dueAt || task.dueAt >= now)) return null
      record = { ...task, name: task.title }
    } else if (entityType === 'organization' && entityId === ctx.orgId) {
      if (type === 'trial_ending' && (!['owner', 'admin'].includes(ctx.role) || !ctx.organization.trialEndsAt || ctx.organization.trialEndsAt <= now || (context.trialEndsAt && new Date(context.trialEndsAt).getTime() !== ctx.organization.trialEndsAt.getTime()))) return null
      record = { name: ctx.organization.name }
    } else if (!entityType) record = { name: null }
    if (!record) return null
    if (type === 'mention' && context.activityId) {
      const mention = await db.mention.findFirst({ where: { organizationId: ctx.orgId, activityId: context.activityId, userId: ctx.userId, activity: { deletedAt: null } }, select: { id: true } })
      if (!mention) return null
    }
    return record
  } catch (err) {
    if ([403, 404].includes(err.statusCode)) return null
    throw err
  }
}
