import { beforeEach, describe, expect, it, vi } from 'vitest'

const { db } = vi.hoisted(() => ({ db: { industry: { findMany: vi.fn(), findUnique: vi.fn() } } }))
vi.mock('../../src/db/prisma.js', () => ({ prisma: db }))

import { templateKey } from '../../src/config/pipelineTemplates.js'
import { clearIndustryCache, listIndustries, selectableIndustry } from '../../src/services/industry.service.js'

const row = (slug, extra = {}) => ({ id: `id-${slug}`, slug, name: slug, icon: 'Shapes', featured: false, sortOrder: 0, keywords: [], pipelineTemplate: null, isActive: true, ...extra })

describe('industries', () => {
  beforeEach(() => {
    clearIndustryCache()
    db.industry.findMany.mockReset().mockResolvedValue([row('pharmaceuticals', { pipelineTemplate: 'manufacturing' }), row('retired', { isActive: false })])
    db.industry.findUnique.mockReset().mockResolvedValue(null)
  })

  it('lists only active industries, without admin fields', async () => {
    const list = await listIndustries()
    expect(list.map((i) => i.slug)).toEqual(['pharmaceuticals'])
    expect(list[0]).not.toHaveProperty('isActive')
    expect(list[0]).not.toHaveProperty('sortOrder')
  })

  it('caches the list between calls', async () => {
    await listIndustries()
    await selectableIndustry('id-pharmaceuticals')
    expect(db.industry.findMany).toHaveBeenCalledTimes(1)
  })

  it('accepts an active industry and rejects unknown or retired ones', async () => {
    await expect(selectableIndustry('id-pharmaceuticals')).resolves.toMatchObject({ pipelineTemplate: 'manufacturing' })
    await expect(selectableIndustry('missing')).rejects.toMatchObject({ details: { fields: { industryId: 'Choose your industry' } } })
    await expect(selectableIndustry('id-retired')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('keeps a retired industry the workspace already has', async () => {
    await expect(selectableIndustry('id-retired', { currentId: 'id-retired' })).resolves.toMatchObject({ slug: 'retired' })
  })

  it('finds an industry added after the list was cached', async () => {
    await listIndustries()
    db.industry.findUnique.mockResolvedValue(row('new-one'))
    await expect(selectableIndustry('id-new-one')).resolves.toMatchObject({ slug: 'new-one' })
  })

  it('falls back to the general pipeline template', () => {
    expect(templateKey('manufacturing')).toBe('manufacturing')
    expect(templateKey(null)).toBe('default')
    expect(templateKey('not-a-template')).toBe('default')
  })
})
