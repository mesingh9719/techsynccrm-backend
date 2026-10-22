import { describe, expect, it, vi } from 'vitest'
vi.mock('../../src/db/prisma.js', () => ({ prisma: {}, DB_NULL: 'DB_NULL' }))
vi.mock('../../src/config/env.js', () => ({ env: { NODE_ENV: 'test', FRONTEND_URL: 'https://example.test' } }))
import {
  createCampaignSchema,
  updateCampaignSchema,
  campaignSyncSchema,
} from '../../src/validators/campaign.validators.js'
import { resolveCampaignId } from '../../src/lib/campaignAttribution.js'
import { permissionsFor } from '../../src/config/permissions.js'

const campaign = {
  name: 'Campaign',
  code: 'spring-campaign',
  type: 'website',
  objective: 'lead_generation',
  status: 'active',
  startDate: '2026-10-01',
}
describe('campaign validation and attribution', () => {
  it('accepts exact minor units and zero spend, and rejects invalid amounts/URLs/dates', () => {
    expect(createCampaignSchema.parse({ ...campaign, actualSpendMinor: 0 }).actualSpendMinor).toBe(0)
    expect(createCampaignSchema.parse({ ...campaign, actualSpendMinor: 1051 }).actualSpendMinor).toBe(1051)
    for (const input of [
      { actualSpendMinor: -1 },
      { actualSpendMinor: 1.2 },
      { actualSpendMinor: Number.MAX_SAFE_INTEGER + 1 },
      { startDate: '2026-02-30' },
      { endDate: '2026-09-30' },
      { landingUrl: 'javascript:alert(1)' },
      { organizationId: 'other-workspace' },
    ])
      expect(createCampaignSchema.safeParse({ ...campaign, ...input }).success).toBe(false)
    expect(updateCampaignSchema.safeParse({}).success).toBe(false)
    expect(updateCampaignSchema.safeParse({ endDate: null }).success).toBe(true)
  })
  it('validates provider identifiers instead of accepting arbitrary graph paths', () => {
    expect(campaignSyncSchema.safeParse({ adAccountId: 'act_12345' }).success).toBe(true)
    expect(campaignSyncSchema.safeParse({ adAccountId: 'https://attacker.test' }).success).toBe(false)
    expect(campaignSyncSchema.safeParse({ adAccountId: 'act_123/campaigns' }).success).toBe(false)
  })
  it('normalizes UTM codes and resolves only inside the provided organization', async () => {
    const db = { campaign: { findMany: vi.fn().mockResolvedValue([{ id: 'campaign-id', code: 'spring-campaign' }]) } }
    expect(await resolveCampaignId(db, 'workspace-a', { utm: { utm_campaign: ' SPRING-CAMPAIGN ' } })).toBe(
      'campaign-id',
    )
    expect(db.campaign.findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: 'workspace-a',
      deletedAt: null,
      OR: [{ code: 'spring-campaign' }],
    })
    db.campaign.findMany.mockResolvedValue([])
    expect(await resolveCampaignId(db, 'workspace-b', { sourceDetail: 'prefix-spring-campaign-suffix' })).toBeNull()
  })
  it('supports the Facebook connector metadata and rejects conflicting explicit UTM codes', async () => {
    const db = { campaign: { findMany: vi.fn().mockResolvedValue([{ id: 'campaign-id', code: 'meta-123' }]) } }
    expect(await resolveCampaignId(db, 'workspace', { utm: { campaign: '123', source: 'facebook' } })).toBe(
      'campaign-id',
    )
    expect(
      await resolveCampaignId(db, 'workspace', { utm: { campaign_id: '123', utm_campaign: 'different-code' } }),
    ).toBeNull()
    db.campaign.findMany.mockClear()
    expect(await resolveCampaignId(db, 'workspace', {})).toBeNull()
    expect(db.campaign.findMany).not.toHaveBeenCalled()
  })
  it('gives viewers read-only campaigns and sales representatives only their own records', () => {
    expect(permissionsFor('viewer')).toContain('campaigns.read.all')
    expect(permissionsFor('viewer')).not.toContain('campaigns.create')
    expect(permissionsFor('sales_rep')).toContain('campaigns.read.own')
    expect(permissionsFor('sales_rep')).not.toContain('campaigns.delete.all')
    expect(permissionsFor('manager')).toContain('campaigns.update.team')
  })
})
