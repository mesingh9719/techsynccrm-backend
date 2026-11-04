import { PIPELINE_TEMPLATES } from '../config/pipelineTemplates.js'
import { prisma } from '../db/prisma.js'
import { logger } from '../lib/logger.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * The industry master list (`industries` table). It changes rarely and is read on every onboarding,
 * workspace create and settings save, so each instance keeps it in memory for a few minutes.
 * After editing rows directly (SQL / Prisma Studio), changes show within CACHE_TTL_MS.
 */

const CACHE_TTL_MS = 5 * 60 * 1000
const log = logger.child({ component: 'industries' })

const select = { id: true, slug: true, name: true, icon: true, featured: true, sortOrder: true, keywords: true, pipelineTemplate: true, isActive: true }

let cache = null

async function load() {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache
  const rows = await prisma.industry.findMany({ select, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
  for (const row of rows) {
    if (row.pipelineTemplate && !PIPELINE_TEMPLATES[row.pipelineTemplate]) {
      log.warn({ slug: row.slug, pipelineTemplate: row.pipelineTemplate }, 'Industry points at an unknown pipeline template; the general one is used')
    }
  }
  cache = { loadedAt: Date.now(), rows, byId: new Map(rows.map((r) => [r.id, r])) }
  return cache
}

/** Forget the cached list (tests, or after an admin edit in this process). */
export function clearIndustryCache() {
  cache = null
}

/** GET /api/meta/industries — industries people can pick, in display order. */
export async function listIndustries() {
  const { rows } = await load()
  return rows
    .filter((r) => r.isActive)
    .map(({ id, slug, name, icon, featured, keywords, pipelineTemplate }) => ({ id, slug, name, icon, featured, keywords, pipelineTemplate }))
}

/**
 * The industry a workspace may be saved with: it must exist and be active. An inactive one is
 * still accepted when it's the workspace's current industry, so saving other settings never
 * forces a change. Throws a field error otherwise.
 */
export async function selectableIndustry(id, { field = 'industryId', currentId = null } = {}) {
  const row = (await load()).byId.get(id) ?? (await prisma.industry.findUnique({ where: { id }, select }))
  if (!row || (!row.isActive && row.id !== currentId)) {
    throw new ApiError(400, 'Validation failed', { code: 'VALIDATION_ERROR', details: { fields: { [field]: 'Choose your industry' } } })
  }
  return row
}
