import { ApiError } from '../utils/ApiError.js'

/** Compare-and-set in the write itself, including tag/link-only edits. Caller owns the transaction. */
export async function versionedUpdate(tx, model, ctx, before, data, select) {
  try {
    return await tx[model].update({
      where: { id: before.id, organizationId: ctx.orgId, updatedAt: before.updatedAt, deletedAt: before.deletedAt ?? null },
      data: { ...data, updatedAt: new Date(Math.max(Date.now(), new Date(before.updatedAt).getTime() + 1)) },
      ...(select && { select }),
    })
  } catch (err) {
    if (err.code !== 'P2025') throw err
    throw new ApiError(409, 'This record changed. Refresh and try again.', { code: 'STALE_UPDATE' })
  }
}
