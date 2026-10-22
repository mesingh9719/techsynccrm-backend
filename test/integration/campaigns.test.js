import crypto from 'node:crypto'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('../../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    isProduction: false,
    DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused',
    DATABASE_URL_UNPOOLED: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused',
    DB_POOL_MAX: 10,
    FRONTEND_URL: 'https://crm.example.test',
    JWT_ACCESS_SECRET: 'campaign-tests-only-not-a-real-key-01234567890',
    JWT_ISSUER: 'test',
    JWT_AUDIENCE: 'test',
    JWT_ACCESS_EXPIRES_IN: '15m',
    DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  },
}))
vi.mock('../../src/email/mailer.js', () => ({ sendEmail: vi.fn(), queueEmail: vi.fn() }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue: vi.fn() }))
import { prisma } from '../../src/db/prisma.js'
import { campaignRoutes } from '../../src/routes/campaign.routes.js'
import { leadRoutes } from '../../src/routes/lead.routes.js'
import { errorHandler } from '../../src/middlewares/errorHandler.js'
import { signAccessToken } from '../../src/services/token.service.js'
import { ensureDefaultPipeline } from '../../src/services/pipeline.service.js'
import { createLeadFromCapture } from '../../src/services/lead.service.js'
import { permissionsFor } from '../../src/config/permissions.js'

const uuid = () => crypto.randomUUID()
let users, org, other, server, base, ownerToken, repToken, viewerToken, foreignToken, campaign
const request = async (path, { token = ownerToken, body, method = 'GET', ifMatch } = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body && { 'Content-Type': 'application/json' }),
      ...(ifMatch && { 'If-Match': ifMatch }),
    },
    ...(body && { body: JSON.stringify(body) }),
  })
  const json = response.status === 204 ? null : await response.json()
  return { status: response.status, json, data: json?.data }
}
const input = (changes = {}) => ({
  name: 'Campaign integration',
  code: 'campaign-integration',
  type: 'website',
  objective: 'lead_generation',
  status: 'active',
  startDate: '2026-10-01',
  endDate: null,
  actualSpendMinor: 10050,
  landingUrl: 'https://example.test/landing',
  ...changes,
})

describe.skipIf(!process.env.TEST_DATABASE_URL)('campaign API on disposable Postgres', () => {
  beforeAll(async () => {
    const host = new URL(process.env.TEST_DATABASE_URL).hostname
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && process.env.TEST_DATABASE_DISPOSABLE !== 'true')
      throw new Error('Use a disposable database')
    users = await Promise.all(
      ['owner', 'rep', 'viewer'].map((name) =>
        prisma.user.create({
          data: {
            fullName: name,
            email: `campaign-${name}-${uuid()}@example.test`,
            passwordHash: 'cannot-login',
            emailVerifiedAt: new Date(),
          },
        }),
      ),
    )
    org = await prisma.organization.create({
      data: { name: 'Campaign API tests', slug: `campaign-${uuid()}`, createdById: users[0].id, plan: 'business' },
    })
    other = await prisma.organization.create({
      data: { name: 'Other campaign tests', slug: `campaign-${uuid()}`, createdById: users[0].id, plan: 'business' },
    })
    await prisma.membership.createMany({
      data: users.map((user, index) => ({
        organizationId: org.id,
        userId: user.id,
        role: ['owner', 'sales_rep', 'viewer'][index],
        joinedAt: new Date(),
      })),
    })
    await prisma.membership.create({ data: { organizationId: other.id, userId: users[0].id, role: 'owner' } })
    ;[ownerToken, repToken, viewerToken] = users.map((user) => signAccessToken(user, org.id).accessToken)
    foreignToken = signAccessToken(users[0], other.id).accessToken
    const app = express()
    app.use(express.json())
    app.use('/campaigns', campaignRoutes)
    app.use('/leads', leadRoutes)
    app.use(errorHandler)
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
    })
    base = `http://127.0.0.1:${server.address().port}`
  }, 30000)
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (org) await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } })
    if (users) await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } })
    await prisma.$disconnect()
  }, 30000)

  it('creates persistent campaigns, keeps minor-unit precision and reports genuine zeros', async () => {
    const result = await request('/campaigns', { method: 'POST', body: input() })
    expect(result.status).toBe(201)
    campaign = result.data.campaign
    expect(campaign.actualSpendMinor).toBe(10050)
    expect(campaign.metrics.leadsCount).toBe(0)
    expect(campaign.metrics.revenueWonMinor).toBe(0)
    expect((await request(`/campaigns/${campaign.id}`)).data.campaign.code).toBe(campaign.code)
  }, 30000)
  it('rejects duplicate codes, invalid dates/URLs, foreign owners and viewer writes', async () => {
    expect((await request('/campaigns', { method: 'POST', body: input() })).status).toBe(409)
    expect(
      (await request('/campaigns', { method: 'POST', body: input({ code: 'bad-dates', endDate: '2026-09-01' }) }))
        .status,
    ).toBe(400)
    expect(
      (
        await request('/campaigns', {
          method: 'POST',
          body: input({ code: 'bad-url', landingUrl: 'javascript:alert(1)' }),
        })
      ).status,
    ).toBe(400)
    expect(
      (await request('/campaigns', { method: 'POST', body: input({ code: 'foreign-owner', ownerId: uuid() }) })).status,
    ).toBe(400)
    expect(
      (await request('/campaigns', { token: viewerToken, method: 'POST', body: input({ code: 'viewer-write' }) }))
        .status,
    ).toBe(403)
  }, 30000)
  it('scopes campaigns by organization/owner and prevents cross-workspace lead links in the database', async () => {
    expect((await request(`/campaigns/${campaign.id}`, { token: foreignToken })).status).toBe(404)
    expect((await request(`/campaigns/${campaign.id}`, { token: repToken })).status).toBe(404)
    expect((await request('/campaigns', { token: repToken })).data.items).toEqual([])
    await expect(
      prisma.lead.create({
        data: { organizationId: other.id, displayName: 'Wrong workspace', campaignId: campaign.id },
      }),
    ).rejects.toMatchObject({ code: 'P2003' })
  }, 30000)
  it('attributes manual/captured UTM leads and uses exact codes rather than substrings', async () => {
    const lead = await request('/leads', {
      method: 'POST',
      body: { firstName: 'Tracked lead', utm: { utm_campaign: campaign.code.toUpperCase() } },
    })
    expect(lead.status).toBe(201)
    expect(lead.data.lead.campaignId).toBe(campaign.id)
    const unrelated = await request('/leads', {
      method: 'POST',
      body: { firstName: 'Unrelated lead', sourceDetail: `prefix-${campaign.code}-suffix` },
    })
    expect(unrelated.data.lead.campaignId).toBeNull()
    const metrics = (await request(`/campaigns/${campaign.id}`)).data.campaign.metrics
    expect(metrics.leadsCount).toBe(1)
    expect(metrics.costPerLeadMinor).toBe(10050)
    const cleared = await request(`/leads/${lead.data.lead.id}`, {
      method: 'PATCH',
      body: { utm: null, sourceDetail: null },
    })
    expect(cleared.status).toBe(200)
    expect(cleared.data.lead.campaignId).toBeNull()
    expect(cleared.data.lead.utm).toBeNull()
    expect((await request(`/campaigns/${campaign.id}`)).data.campaign.metrics.leadsCount).toBe(0)
    await request(`/leads/${lead.data.lead.id}`, { method: 'PATCH', body: { utm: { utm_campaign: campaign.code } } })
    const captured = await createLeadFromCapture(
      {
        orgId: org.id,
        userId: users[0].id,
        role: 'owner',
        permissions: permissionsFor('owner'),
        actorType: 'system',
        plan: 'business',
        country: 'IN',
        timezone: 'Asia/Kolkata',
      },
      { firstName: 'Captured campaign lead', utm: { utm_campaign: campaign.code } },
      { dedupe: false },
    )
    expect(captured.lead.campaignId).toBe(campaign.id)
  }, 30000)
  it('aggregates beyond the visible lead page, paginates leads and excludes deleted/foreign-currency deals', async () => {
    await prisma.lead.createMany({
      data: Array.from({ length: 105 }, (_, index) => ({
        organizationId: org.id,
        displayName: `Bulk lead ${index}`,
        ownerId: users[0].id,
        campaignId: campaign.id,
        status: index === 0 ? 'converted' : 'new',
      })),
    })
    const first = await request(`/campaigns/${campaign.id}/leads?limit=25`)
    const second = await request(
      `/campaigns/${campaign.id}/leads?limit=25&cursor=${encodeURIComponent(first.data.nextCursor)}`,
    )
    expect(first.data.items).toHaveLength(25)
    expect(second.data.items).toHaveLength(25)
    expect(new Set([...first.data.items, ...second.data.items].map((lead) => lead.id)).size).toBe(50)
    await prisma.$transaction((tx) => ensureDefaultPipeline(tx, org.id))
    const pipeline = await prisma.pipeline.findFirst({ where: { organizationId: org.id }, include: { stages: true } })
    const lead = first.data.items[0]
    await prisma.deal.createMany({
      data: [
        {
          title: 'Won',
          organizationId: org.id,
          pipelineId: pipeline.id,
          stageId: pipeline.stages.find((stage) => stage.type === 'won').id,
          status: 'won',
          valueMinor: 100000n,
          currency: 'INR',
          leadId: lead.id,
          ownerId: users[0].id,
        },
        {
          title: 'Other currency',
          organizationId: org.id,
          pipelineId: pipeline.id,
          stageId: pipeline.stages[0].id,
          status: 'won',
          valueMinor: 500000n,
          currency: 'USD',
          leadId: lead.id,
          ownerId: users[0].id,
        },
      ],
    })
    const metrics = (await request(`/campaigns/${campaign.id}`)).data.campaign.metrics
    expect(metrics.leadsCount).toBe(107)
    expect(metrics.convertedCount).toBe(1)
    expect(metrics.revenueWonMinor).toBe(100000)
    expect(metrics.dealsWonCount).toBe(1)
    expect((await request(`/campaigns/${campaign.id}`, { token: viewerToken })).data.campaign.metrics).toEqual(metrics)
  }, 30000)
  it('updates status with optimistic concurrency, preserves tracking codes, and soft-deletes without deleting leads', async () => {
    const result = await request(`/campaigns/${campaign.id}/status`, {
      method: 'POST',
      body: { status: 'paused' },
      ifMatch: campaign.updatedAt,
    })
    expect(result.status).toBe(200)
    expect(result.data.campaign.status).toBe('paused')
    expect(
      (
        await request(`/campaigns/${campaign.id}`, {
          method: 'PATCH',
          body: { name: 'Stale edit' },
          ifMatch: campaign.updatedAt,
        })
      ).status,
    ).toBe(409)
    expect(
      (await request(`/campaigns/${campaign.id}`, { method: 'PATCH', body: { code: 'new-tracking-code' } })).status,
    ).toBe(400)
    expect((await request(`/campaigns/${campaign.id}`, { method: 'DELETE', token: viewerToken })).status).toBe(403)
    expect(
      (await request(`/campaigns/${campaign.id}`, { method: 'DELETE', ifMatch: result.data.campaign.updatedAt }))
        .status,
    ).toBe(204)
    expect((await request(`/campaigns/${campaign.id}`)).status).toBe(404)
    expect(await prisma.lead.count({ where: { campaignId: campaign.id, deletedAt: null } })).toBe(107)
  }, 30000)
})
