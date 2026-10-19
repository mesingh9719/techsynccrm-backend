/**
 * Registries that let later modules plug their child tables into record merges and lead
 * conversion without the contact/lead services knowing about them.
 *
 *   registerMergeable('company', { model: 'deal', field: 'companyId' })        // simple FK re-point
 *   registerMergeHook('contact', async (tx, ctx, { primaryId, ids }) => { … }) // composite keys, dedupe
 *   registerConversionHook(async (tx, ctx, { leadId, contactId, companyId, dealId }) => { … })
 */

const mergeables = { contact: [], company: [] }
const mergeHooks = { contact: [], company: [] }

/**
 * A table whose `field` points at a contact/company. On merge, rows pointing at a duplicate are
 * re-pointed to the surviving record (`updateMany`, inside the merge transaction).
 * @param {'contact' | 'company'} entity
 * @param {{ model: string, field: string }} definition `model` = Prisma delegate name
 */
export function registerMergeable(entity, { model, field }) {
  const list = mergeables[entity]
  if (!list) throw new Error(`Unknown mergeable entity "${entity}"`)
  if (!list.some((m) => m.model === model && m.field === field)) list.push({ model, field })
}

export function listMergeables(entity) {
  return [...(mergeables[entity] ?? [])]
}

/**
 * Custom merge step for tables a plain re-point would break (composite primary keys such as
 * deal_contacts or activity_links, where the survivor may already have a row).
 * @param {'contact' | 'company'} entity
 * @param {(tx: any, ctx: object, args: { primaryId: string, ids: string[] }) => Promise<void>} hook
 */
export function registerMergeHook(entity, hook) {
  if (!mergeHooks[entity].includes(hook)) mergeHooks[entity].push(hook)
}

/** Runs every simple re-point and custom hook for a merge (inside its transaction). */
export async function runMergeSteps(tx, ctx, entity, primaryId, ids) {
  for (const { model, field } of mergeables[entity]) {
    await tx[model].updateMany({ where: { organizationId: ctx.orgId, [field]: { in: ids } }, data: { [field]: primaryId } })
  }
  for (const hook of mergeHooks[entity]) await hook(tx, ctx, { primaryId, ids })
}

const conversionHooks = []

/**
 * Runs inside the lead-conversion transaction, after the contact (and company/deal) exist — e.g.
 * to link the lead's activities to the contact and move its open tasks.
 * @param {(tx: any, ctx: object, args: { leadId: string, contactId: string, companyId: string|null, dealId: string|null }) => Promise<void>} hook
 */
export function registerConversionHook(hook) {
  if (!conversionHooks.includes(hook)) conversionHooks.push(hook)
}

export async function runConversionHooks(tx, ctx, args) {
  for (const hook of conversionHooks) await hook(tx, ctx, args)
}
