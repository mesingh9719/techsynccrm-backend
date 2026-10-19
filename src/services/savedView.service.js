import { prisma } from '../db/prisma.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * Saved list views (M08, shared by later list screens): a name plus the list's query params.
 * Personal views are visible to their creator; shared views to everyone in the workspace.
 * Only admins (settings.workspace.manage) can share; creators and admins can edit or delete.
 */

const MAX_VIEWS_PER_USER = 50
const viewSelect = { id: true, entityType: true, name: true, filters: true, columns: true, isShared: true, userId: true, createdAt: true, updatedAt: true }
const canShare = (ctx) => ctx.permissions.includes('settings.workspace.manage')
const forbidden = (message) => new ApiError(403, message, { code: 'FORBIDDEN' })

const present = (ctx) => (v) => ({ ...v, mine: v.userId === ctx.userId, canEdit: v.userId === ctx.userId || canShare(ctx) })

export async function listViews(ctx, entityType) {
  const rows = await prisma.savedView.findMany({
    where: { organizationId: ctx.orgId, entityType, OR: [{ userId: ctx.userId }, { isShared: true }] },
    orderBy: [{ isShared: 'desc' }, { name: 'asc' }],
    select: viewSelect,
  })
  return rows.map(present(ctx))
}

export async function createView(ctx, { entityType, name, filters, columns, isShared }) {
  if (isShared && !canShare(ctx)) throw forbidden('Only admins can share views with the workspace.')
  const mine = await prisma.savedView.count({ where: { organizationId: ctx.orgId, userId: ctx.userId } })
  if (mine >= MAX_VIEWS_PER_USER) throw new ApiError(400, `You can save up to ${MAX_VIEWS_PER_USER} views.`, { code: 'VIEW_LIMIT' })
  const row = await prisma.savedView.create({
    data: { organizationId: ctx.orgId, userId: ctx.userId, entityType, name, filters: filters ?? {}, columns: columns ?? [], isShared: Boolean(isShared) },
    select: viewSelect,
  })
  return present(ctx)(row)
}

async function getEditable(ctx, id) {
  const view = await prisma.savedView.findFirst({ where: { id, organizationId: ctx.orgId, OR: [{ userId: ctx.userId }, { isShared: true }] }, select: viewSelect })
  if (!view) throw ApiError.notFound('View not found')
  if (view.userId !== ctx.userId && !canShare(ctx)) throw forbidden('Only the person who created this view, or an admin, can change it.')
  return view
}

export async function updateView(ctx, id, input) {
  await getEditable(ctx, id)
  if (input.isShared !== undefined && !canShare(ctx)) throw forbidden('Only admins can share views with the workspace.')
  const row = await prisma.savedView.update({ where: { id }, data: input, select: viewSelect })
  return present(ctx)(row)
}

export async function deleteView(ctx, id) {
  await getEditable(ctx, id)
  await prisma.savedView.delete({ where: { id } })
}
