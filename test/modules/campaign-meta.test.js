import { beforeEach, describe, expect, it, vi } from 'vitest'

const { db, graph, connectionFor } = vi.hoisted(() => ({
  db: {
    campaign: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    lead: { groupBy: vi.fn() }, user: { findMany: vi.fn() }, leadSource: { findMany: vi.fn() },
    auditLog: { create: vi.fn() }, $queryRaw: vi.fn(), $transaction: vi.fn(),
  }, graph: vi.fn(), connectionFor: vi.fn(),
}))
vi.mock('../../src/db/prisma.js', () => ({ prisma: db }))
vi.mock('../../src/lib/crypto.js', () => ({ decrypt: () => 'test-token' }))
vi.mock('../../src/lib/visibility.js', () => ({ visibilityWhere: () => ({}), registerReassignable: vi.fn() }))
vi.mock('../../src/integrations/facebook/connection.js', () => ({ connectionFor }))
vi.mock('../../src/integrations/facebook/graph.js', () => ({ graph, graphPage: data => ({ items: data.data, nextCursor: null }) }))
vi.mock('../../src/config/env.js', () => ({ env: { NODE_ENV: 'test' } }))

import { ApiError } from '../../src/utils/ApiError.js'
import { permissionsFor } from '../../src/config/permissions.js'
import { setCampaignStatus, updateCampaign, syncMetaCampaigns, getMetaCampaignState } from '../../src/services/campaign.service.js'
import { metaConfiguredStatus } from '../../src/integrations/facebook/campaigns.js'

const ctx = { orgId: 'workspace', userId: 'owner', permissions: permissionsFor('owner'), timezone: 'Asia/Kolkata', currency: 'INR' }
let row, remote
beforeEach(() => {
  vi.clearAllMocks()
  row = { id: 'campaign', organizationId: ctx.orgId, name: 'Linked campaign', code: 'meta-456', type: 'meta_ads', status: 'paused', startDate: new Date('2026-01-01Z'), endDate: null, utm: {}, currency: 'INR', externalPlatform: 'facebook', externalCampaignId: '456', externalAccountId: 'act_123', updatedAt: new Date('2026-01-01Z'), deletedAt: null }
  remote = { id: '456', account_id: '123', name: row.name, status: 'PAUSED', effective_status: 'PAUSED', start_time: '2026-01-01T00:00:00Z', stop_time: null }
  connectionFor.mockResolvedValue({ tokenEnc: 'encrypted' })
  db.campaign.findFirst.mockImplementation(async () => ({ ...row }))
  db.campaign.findUnique.mockImplementation(async () => ({ ...row }))
  db.campaign.update.mockImplementation(async ({ where, data }) => {
    if (where.updatedAt.getTime() !== row.updatedAt.getTime()) throw Object.assign(new Error('stale'), { code: 'P2025' })
    row = { ...row, ...data }; return { ...row }
  })
  db.$transaction.mockImplementation(async fn => fn(db))
  db.lead.groupBy.mockResolvedValue([])
  db.$queryRaw.mockResolvedValue([])
  db.user.findMany.mockResolvedValue([])
  db.leadSource.findMany.mockResolvedValue([])
  graph.mockImplementation(async (path, _token, params, method = 'GET') => {
    if (path === 'act_123') return { id: 'act_123', currency: 'INR' }
    if (path === 'act_123/campaigns') return { data: [{ ...remote }] }
    if (method === 'POST') { remote = { ...remote, status: params.status, effective_status: params.status }; return { success: true } }
    return { ...remote }
  })
})
const posts = () => graph.mock.calls.filter(call => call[3] === 'POST')

describe('Meta campaign status changes', () => {
  it('changes Meta, verifies readback, and retains the status through the next sync', async () => {
    const result = await setCampaignStatus(ctx, row.id, 'active', { expectedUpdatedAt: row.updatedAt })
    expect(result.status).toBe('active')
    expect(remote.status).toBe('ACTIVE')
    expect(posts()).toEqual([['456', 'test-token', { status: 'ACTIVE' }, 'POST']])
    expect(graph.mock.calls.map(call => call[3] ?? 'GET')).toEqual(['GET', 'POST', 'GET'])
    await syncMetaCampaigns(ctx, { adAccountId: 'act_123' })
    expect(row.status).toBe('active')
    expect(posts()).toHaveLength(1)
  })

  it('keeps the local status unchanged when Meta rejects the write', async () => {
    graph.mockImplementation(async (_path, _token, _params, method) => {
      if (method === 'POST') throw new ApiError(502, 'Meta denied permission')
      return { ...remote }
    })
    await expect(setCampaignStatus(ctx, row.id, 'active')).rejects.toThrow('Meta denied permission')
    expect(row.status).toBe('paused')
    expect(db.campaign.update).not.toHaveBeenCalled()
  })

  it('does not claim success when Meta readback does not confirm the requested state', async () => {
    graph.mockImplementation(async (_path, _token, _params, method) => method === 'POST' ? { success: true } : { ...remote })
    await expect(setCampaignStatus(ctx, row.id, 'active')).rejects.toMatchObject({ code: 'META_STATUS_UNCONFIRMED' })
    expect(db.campaign.update).not.toHaveBeenCalled()
  })

  it('blocks enabling an expired schedule before sending any write to Meta', async () => {
    remote.stop_time = '2020-01-01T00:00:00Z'
    await expect(setCampaignStatus(ctx, row.id, 'active')).rejects.toThrow('schedule has ended')
    expect(posts()).toHaveLength(0)
    expect(db.campaign.update).not.toHaveBeenCalled()
  })

  it('can pause an enabled campaign even after its schedule has ended', async () => {
    remote.status = 'ACTIVE'; remote.stop_time = '2020-01-01T00:00:00Z'; row.status = 'active'
    await setCampaignStatus(ctx, row.id, 'paused')
    expect(remote.status).toBe('PAUSED')
    expect(row.status).toBe('paused')
  })

  it('requires current integration administration permission before contacting Meta', async () => {
    const restricted = { ...ctx, permissions: ctx.permissions.filter(p => p !== 'settings.workspace.manage') }
    await expect(setCampaignStatus(restricted, row.id, 'active')).rejects.toMatchObject({ statusCode: 403 })
    expect(graph).not.toHaveBeenCalled()
  })

  it('rejects another tenant or an invisible campaign before contacting Meta', async () => {
    db.campaign.findFirst.mockResolvedValue(null)
    await expect(setCampaignStatus(ctx, row.id, 'active')).rejects.toMatchObject({ statusCode: 404 })
    expect(db.campaign.findFirst.mock.calls[0][0].where.AND[0]).toMatchObject({ organizationId: ctx.orgId })
    expect(graph).not.toHaveBeenCalled()
  })

  it('rejects stale requests before changing Meta', async () => {
    await expect(setCampaignStatus(ctx, row.id, 'active', { expectedUpdatedAt: '2020-01-01Z' })).rejects.toMatchObject({ code: 'STALE_UPDATE' })
    expect(graph).not.toHaveBeenCalled()
  })

  it('validates the linked account and refuses an account mismatch', async () => {
    remote.account_id = '999'
    await expect(setCampaignStatus(ctx, row.id, 'active')).rejects.toMatchObject({ statusCode: 403 })
    expect(posts()).toHaveLength(0)
  })

  it('keeps archived/deleted campaigns and unsupported lifecycle operations out of the toggle', async () => {
    await expect(setCampaignStatus(ctx, row.id, 'archived')).rejects.toThrow('Enable and Pause')
    remote.status = 'ARCHIVED'
    await expect(setCampaignStatus(ctx, row.id, 'active')).rejects.toThrow('archived or deleted')
    expect(posts()).toHaveLength(0)
  })

  it('reports a local save conflict after Meta accepted the write, and sync reconciles it', async () => {
    db.campaign.update.mockRejectedValueOnce(Object.assign(new Error('stale'), { code: 'P2025' }))
    await expect(setCampaignStatus(ctx, row.id, 'active')).rejects.toMatchObject({ code: 'META_STATUS_RECONCILE_REQUIRED' })
    expect(remote.status).toBe('ACTIVE')
    expect(row.status).toBe('paused')
    await syncMetaCampaigns(ctx, { adAccountId: 'act_123' })
    expect(row.status).toBe('active')
    expect(posts()).toHaveLength(1)
  })

  it('rejects local PATCH status changes and changes to the provider identity/name/schedule', async () => {
    for (const input of [{ status: 'active' }, { name: 'Local rename' }, { externalCampaignId: '999' }, { externalPlatform: null }, { startDate: '2030-01-01' }])
      await expect(updateCampaign(ctx, row.id, input)).rejects.toMatchObject({ statusCode: 400 })
    expect(db.campaign.update).not.toHaveBeenCalled()
    expect(graph).not.toHaveBeenCalled()
  })

  it('continues to support local campaign status changes without any Meta calls', async () => {
    row.externalPlatform = null; row.externalCampaignId = null
    const result = await setCampaignStatus(ctx, row.id, 'active')
    expect(result.status).toBe('active')
    expect(graph).not.toHaveBeenCalled()
  })

  it('exposes actual configured and effective status separately', async () => {
    remote.status = 'ACTIVE'; remote.effective_status = 'WITH_ISSUES'
    expect(await getMetaCampaignState(ctx, row.id)).toMatchObject({ configuredStatus: 'ACTIVE', effectiveStatus: 'WITH_ISSUES' })
    expect(metaConfiguredStatus(remote)).toBe('active')
  })

  it('does not overwrite a newer status edit with an older in-flight sync response', async () => {
    graph.mockImplementation(async path => {
      if (path === 'act_123') return { currency: 'INR' }
      row.status = 'active'; row.updatedAt = new Date(Date.now() + 1000)
      return { data: [{ ...remote, status: 'PAUSED' }] }
    })
    await syncMetaCampaigns(ctx, { adAccountId: 'act_123' })
    expect(row.status).toBe('active')
    expect(db.campaign.update).not.toHaveBeenCalled()
  })
})
