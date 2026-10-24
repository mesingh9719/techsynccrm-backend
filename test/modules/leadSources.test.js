import { beforeEach, describe, expect, it, vi } from 'vitest'

const { db, audit } = vi.hoisted(() => ({
  db: {
    leadSource: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), aggregate: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    leadSourceCatalog: { findMany: vi.fn(), findFirst: vi.fn() },
    lead: { count: vi.fn() },
    deal: { count: vi.fn() },
    campaign: { count: vi.fn() },
    webForm: { count: vi.fn() },
    $transaction: vi.fn(async (ops) => Promise.all(ops)),
  },
  audit: vi.fn(),
}))
vi.mock('../../src/db/prisma.js', () => ({ prisma: db, UNIQUE_VIOLATION: 'P2002' }))
vi.mock('../../src/lib/audit.js', () => ({ recordAudit: audit }))
vi.mock('../../src/events/outbox.js', () => ({ emit: vi.fn() }))
vi.mock('../../src/services/lead.service.js', () => ({ OPEN_STATUSES: ['new'] }))
vi.mock('../../src/services/entitlements.service.js', () => ({ assertFeature: vi.fn() }))

import { createSource, deleteSource, listSourceSuggestions, orderSources, updateSource } from '../../src/services/leadSetup.service.js'
import { assertActiveSources } from '../../src/services/assignment.service.js'
import { sourceOrderSchema, sourceSchema } from '../../src/validators/lead.validators.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  S2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ctx = { orgId: ORG, userId: 'u1' }
const row = (patch = {}) => ({ id: S1, name: 'Trade fair', key: null, isSystem: false, scoreWeight: 5, position: 0, archivedAt: null, ...patch })

beforeEach(() => {
  vi.clearAllMocks()
  db.leadSource.aggregate.mockResolvedValue({ _max: { position: 13 } })
  db.leadSource.create.mockImplementation(async ({ data }) => row({ ...data, id: S2 }))
  for (const m of [db.lead, db.deal, db.campaign, db.webForm]) m.count.mockResolvedValue(0)
})

describe('common source suggestions', () => {
  it('leaves out sources the workspace already has, by key or by name', async () => {
    db.leadSourceCatalog.findMany.mockResolvedValue([
      { key: 'website', name: 'Website', category: 'web', description: '', defaultScoreWeight: 15 },
      { key: 'trade_show', name: 'Trade Show', category: 'offline', description: 'Exhibitions', defaultScoreWeight: 10 },
      { key: 'linkedin', name: 'LinkedIn', category: 'social', description: '', defaultScoreWeight: 5 },
    ])
    db.leadSource.findMany.mockResolvedValue([{ key: 'website', name: 'Our site' }, { key: null, name: 'linkedin' }])
    expect(await listSourceSuggestions(ctx)).toEqual([{ key: 'trade_show', name: 'Trade Show', category: 'offline', description: 'Exhibitions', scoreWeight: 10 }])
  })

  it('returns nothing when the catalog table does not exist yet', async () => {
    db.leadSourceCatalog.findMany.mockRejectedValue(Object.assign(new Error('missing'), { code: 'P2021' }))
    db.leadSource.findMany.mockResolvedValue([])
    expect(await listSourceSuggestions(ctx)).toEqual([])
  })
})

describe('creating a source', () => {
  it('adds a custom source at the end of the list and audits it', async () => {
    const source = await createSource(ctx, { name: 'Trade fair', scoreWeight: 12 })
    expect(db.leadSource.create).toHaveBeenCalledWith(expect.objectContaining({ data: { organizationId: ORG, name: 'Trade fair', key: null, scoreWeight: 12, position: 14 } }))
    expect(source).toMatchObject({ name: 'Trade fair', archived: false })
    expect(audit).toHaveBeenCalledWith(db, ctx, expect.objectContaining({ action: 'lead_source.create', changes: { name: [null, 'Trade fair'] } }))
  })

  it('takes name, key and weight from a catalog suggestion', async () => {
    db.leadSourceCatalog.findFirst.mockResolvedValue({ key: 'trade_show', name: 'Trade Show', defaultScoreWeight: 10 })
    db.leadSource.count.mockResolvedValue(0)
    await createSource(ctx, { catalogKey: 'trade_show' })
    expect(db.leadSource.create.mock.calls[0][0].data).toMatchObject({ name: 'Trade Show', key: 'trade_show', scoreWeight: 10 })
  })

  it('refuses a suggestion that is gone or already added', async () => {
    db.leadSourceCatalog.findFirst.mockResolvedValue(null)
    await expect(createSource(ctx, { catalogKey: 'gone' })).rejects.toMatchObject({ statusCode: 400 })
    db.leadSourceCatalog.findFirst.mockResolvedValue({ key: 'website', name: 'Website', defaultScoreWeight: 15 })
    db.leadSource.count.mockResolvedValue(1)
    await expect(createSource(ctx, { catalogKey: 'website' })).rejects.toMatchObject({ statusCode: 400 })
    expect(db.leadSource.create).not.toHaveBeenCalled()
  })

  it('reports a duplicate name as a field error', async () => {
    db.leadSource.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))
    await expect(createSource(ctx, { name: 'Website' })).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('updating a source', () => {
  it('turns a built-in source off without touching its key, and audits only what changed', async () => {
    db.leadSource.findFirst.mockResolvedValue(row({ name: 'Website', key: 'website', isSystem: true }))
    db.leadSource.update.mockImplementation(async ({ data }) => row({ name: 'Website', key: 'website', isSystem: true, ...data }))
    const source = await updateSource(ctx, S1, { archived: true, name: 'Website' })
    const { data } = db.leadSource.update.mock.calls[0][0]
    expect(data).not.toHaveProperty('key')
    expect(data.archivedAt).toBeInstanceOf(Date)
    expect(source).toMatchObject({ key: 'website', archived: true })
    expect(audit).toHaveBeenCalledWith(db, ctx, expect.objectContaining({ action: 'lead_source.update', changes: { archived: [false, true] } }))
  })

  it('turns a source back on', async () => {
    db.leadSource.findFirst.mockResolvedValue(row({ archivedAt: new Date() }))
    db.leadSource.update.mockImplementation(async ({ data }) => row(data))
    expect((await updateSource(ctx, S1, { archived: false })).archived).toBe(false)
    expect(db.leadSource.update.mock.calls[0][0].data).toEqual({ archivedAt: null })
  })

  it('404s for another workspace’s source', async () => {
    db.leadSource.findFirst.mockResolvedValue(null)
    await expect(updateSource(ctx, S1, { name: 'X' })).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('reordering sources', () => {
  it('saves every position in the given order', async () => {
    db.leadSource.findMany.mockResolvedValueOnce([{ id: S1 }, { id: S2 }]).mockResolvedValueOnce([])
    await orderSources(ctx, [S2, S1])
    expect(db.leadSource.update).toHaveBeenCalledWith({ where: { id: S2 }, data: { position: 0 } })
    expect(db.leadSource.update).toHaveBeenCalledWith({ where: { id: S1 }, data: { position: 1 } })
  })

  it('refuses a stale list', async () => {
    db.leadSource.findMany.mockResolvedValue([{ id: S1 }, { id: S2 }])
    await expect(orderSources(ctx, [S1])).rejects.toMatchObject({ statusCode: 409 })
    expect(db.leadSource.update).not.toHaveBeenCalled()
  })
})

describe('deleting a source', () => {
  it('never deletes a built-in source', async () => {
    db.leadSource.findFirst.mockResolvedValue(row({ isSystem: true, key: 'website' }))
    await expect(deleteSource(ctx, S1)).rejects.toMatchObject({ statusCode: 409 })
    expect(db.leadSource.delete).not.toHaveBeenCalled()
  })

  it('refuses while a deal or web form still uses it', async () => {
    db.leadSource.findFirst.mockResolvedValue(row())
    db.webForm.count.mockResolvedValue(1)
    await expect(deleteSource(ctx, S1)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('deletes an unused custom source and audits it', async () => {
    db.leadSource.findFirst.mockResolvedValue(row())
    await deleteSource(ctx, S1)
    expect(db.lead.count).toHaveBeenCalledWith({ where: { organizationId: ORG, OR: [{ sourceId: S1 }, { latestSourceId: S1 }] } })
    expect(db.leadSource.delete).toHaveBeenCalledWith({ where: { id: S1 } })
    expect(audit).toHaveBeenCalledWith(db, ctx, expect.objectContaining({ action: 'lead_source.delete' }))
  })
})

describe('assignment rule source conditions', () => {
  const cond = (value) => ({ field: 'sourceId', operator: 'equals', value })

  it('rejects a newly chosen source that is turned off', async () => {
    db.leadSource.count.mockResolvedValue(0)
    await expect(assertActiveSources(ctx, [cond(S1)])).rejects.toMatchObject({ statusCode: 400 })
    expect(db.leadSource.count).toHaveBeenCalledWith({ where: { organizationId: ORG, id: { in: [S1] }, archivedAt: null } })
  })

  it('keeps a source the rule already had, even if it was turned off since', async () => {
    await assertActiveSources(ctx, [cond(S1), { field: 'city', operator: 'equals', value: 'Pune' }], [cond(S1)])
    expect(db.leadSource.count).not.toHaveBeenCalled()
  })

  it('treats a value that is not an id as unknown without querying', async () => {
    await expect(assertActiveSources(ctx, [cond('website')])).rejects.toMatchObject({ statusCode: 400 })
    expect(db.leadSource.count).not.toHaveBeenCalled()
  })
})

describe('source validators', () => {
  it('needs a name unless a suggestion is picked', () => {
    expect(sourceSchema.safeParse({}).success).toBe(false)
    expect(sourceSchema.safeParse({ catalogKey: 'trade_show' }).success).toBe(true)
    expect(sourceSchema.safeParse({ name: 'Expo', scoreWeight: 21 }).success).toBe(false)
  })

  it('rejects repeated ids when reordering', () => {
    expect(sourceOrderSchema.safeParse({ ids: [S1, S1] }).success).toBe(false)
    expect(sourceOrderSchema.safeParse({ ids: [S1, S2] }).success).toBe(true)
  })
})
