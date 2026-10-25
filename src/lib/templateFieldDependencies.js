import { references } from './templateVariables.js'
import { ApiError } from '../utils/ApiError.js'

/** Shares the existing advisory-lock pattern with definition edits to prevent dangling references. */
export async function lockTemplateFields(tx, orgId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`template-fields:${orgId}`}, 0))`
}

export async function assertFieldNotReferenced(tx, ctx, definition) {
  const key = `${definition.entityType}.custom.${definition.key}`
  const candidates = await tx.emailTemplate.findMany({ where: { organizationId: ctx.orgId, OR: [{ subject: { contains: key } }, { bodyHtml: { contains: key } }] }, select: { subject: true, bodyHtml: true } })
  if (candidates.some((t) => [...references(t.subject).keys, ...references(t.bodyHtml).keys].includes(key))) {
    // Do not expose names or content of another user's private templates.
    throw new ApiError(409, 'A template references this CRM field. Remove or replace its template references before archiving, deleting or changing its type.', { code: 'FIELD_IN_TEMPLATE' })
  }
}
