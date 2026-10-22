import crypto from 'node:crypto'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/config/env.js', () => ({ env: {
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused',
  DB_POOL_MAX: 10, PERFORMANCE_METRICS: true, SLOW_QUERY_MS: 10000,
  JWT_ACCESS_SECRET: 'performance-tests-only-key-012345678901234567890', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test', JWT_ACCESS_EXPIRES_IN: '15m',
  FRONTEND_URL: 'https://example.test', DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
} }))
vi.mock('../../src/email/mailer.js', () => ({ sendEmail: vi.fn(), queueEmail: vi.fn() }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue: vi.fn() }))
import { prisma } from '../../src/db/prisma.js'
import { leadRoutes } from '../../src/routes/lead.routes.js'
import { dealRoutes } from '../../src/routes/deal.routes.js'
import { errorHandler } from '../../src/middlewares/errorHandler.js'
import { requestPerformance } from '../../src/lib/performance.js'
import { signAccessToken } from '../../src/services/token.service.js'
import { ensureDefaultPipeline } from '../../src/services/pipeline.service.js'

let org, other, users, stages, server, base, tag, pipeline, leads
const roles = ['owner', 'admin', 'manager', 'sales_rep', 'viewer']
const uuid = () => crypto.randomUUID()
const request = async (path, index = 0, orgId = org.id) => {
  const token = signAccessToken(users[index], orgId).accessToken
  const response = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } })
  return { status: response.status, timing: response.headers.get('server-timing'), body: await response.json() }
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('performance endpoint regressions on disposable Postgres', () => {
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && process.env.TEST_DATABASE_DISPOSABLE !== 'true') throw new Error('Disposable database required')
    users = await Promise.all(roles.map((role) => prisma.user.create({ data: { fullName: role, email: `${role}-${uuid()}@example.test`, passwordHash: 'cannot-login', emailVerifiedAt: new Date() } })))
    org = await prisma.organization.create({ data: { name: 'Performance regression', slug: `perf-${uuid()}`, plan: 'business', createdById: users[0].id } })
    other = await prisma.organization.create({ data: { name: 'Other tenant', slug: `perf-${uuid()}`, plan: 'business', createdById: users[0].id } })
    await prisma.membership.createMany({ data: users.map((u, i) => ({ organizationId: org.id, userId: u.id, role: roles[i] })) })
    await prisma.membership.create({ data: { organizationId: other.id, userId: users[0].id, role: 'owner' } })
    const team = await prisma.team.create({ data: { organizationId: org.id, name: 'Managed team' } })
    await prisma.teamMember.createMany({ data: [{ teamId: team.id, userId: users[2].id, isManager: true }, { teamId: team.id, userId: users[3].id }] })
    await prisma.$transaction((tx) => ensureDefaultPipeline(tx, org.id))
    pipeline = await prisma.pipeline.findFirst({ where: { organizationId: org.id } })
    stages = await prisma.pipelineStage.findMany({ where: { pipelineId: pipeline.id }, orderBy: { position: 'asc' } })
    for (const stage of stages) await prisma.deal.createMany({ data: Array.from({ length: 61 }, (_, n) => ({
      organizationId: org.id, title: `Card ${n}`, pipelineId: pipeline.id, stageId: stage.id,
      status: stage.type === 'open' ? 'open' : stage.type, valueMinor: BigInt(n * 101 + 1), currency: 'INR',
      ownerId: users[n % 2 ? 0 : 3].id, position: n, probabilityOverride: n % 3 ? null : 50,
      closedAt: stage.type === 'open' ? null : new Date(Date.now() - (n === 60 ? 40 : 1) * 86400000),
    })) })
    tag = await prisma.tag.create({ data: { organizationId: org.id, name: 'Tagged' } })
    await prisma.customFieldDefinition.create({ data: { organizationId: org.id, entityType: 'lead', key: 'segment', label: 'Segment', type: 'text' } })
    leads = await Promise.all(Array.from({ length: 16 }, (_, n) => prisma.lead.create({ data: {
      organizationId: org.id, displayName: `Lead ${n}`, status: ['new', 'qualified'][n%2], ownerId: users[n%3 ? 3 : 0].id,
      customFields: { segment: n%2 ? 'retail' : 'wholesale' }, deletedAt: n === 15 ? new Date() : null,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)),
    } })))
    await prisma.recordTag.createMany({ data: leads.map((l) => ({ organizationId: org.id, entityType: 'lead', entityId: l.id, tagId: tag.id })) })
    const app = express(); app.use(express.json()); app.use(requestPerformance)
    app.use('/leads', leadRoutes); app.use('/deals', dealRoutes); app.use(errorHandler)
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) }); base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (org) await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } })
    if (users) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } })
    await prisma.$disconnect()
  })

  it('keeps exact board totals, rounding, card ordering and stage limits while bounding queries', async () => {
    const { status, body, timing } = await request('/deals/board')
    expect(status).toBe(200)
    expect(Number(/queries;desc="(\d+)"/.exec(timing)[1])).toBeLessThanOrEqual(37)
    for (const stage of body.data.stages) {
      const closed = stage.type !== 'open'
      expect(stage.count).toBe(closed ? 60 : 61)
      expect(stage.deals).toHaveLength(50)
      expect(stage.hasMore).toBe(true)
      expect(stage.deals.map((d) => d.position)).toEqual(Array.from({ length: 50 }, (_, n) => n))
      let total = 0, weighted = 0
      for (let n = 0; n < (closed ? 60 : 61); n++) {
        const value = n*101+1, probability = n%3 ? stage.probability : 50, scaled = value*probability/100
        const floor = Math.floor(scaled), fraction = scaled-floor
        total += value
        weighted += fraction === 0.5 ? floor + floor%2 : Math.round(scaled)
      }
      expect(stage.totalMinor).toBe(total)
      expect(stage.weightedMinor).toBe(closed ? 0 : weighted)
    }
  })

  it('preserves own/team/all visibility for every role and isolates tenant reads', async () => {
    for (let role = 0; role < roles.length; role++) {
      const response = await request('/deals/board', role)
      expect(response.status).toBe(200)
      const expected = role === 2 || role === 3 ? users[3].id : null
      if (expected) expect(response.body.data.stages.flatMap((s) => s.deals).every((d) => d.ownerId === expected)).toBe(true)
    }
    expect((await request(`/leads/${leads[0].id}`, 0, other.id)).status).toBe(404)
    expect((await request('/deals/board', 0, other.id)).status).toBe(404)
  })

  it('retains tag/custom-field filters and count contracts including repeated status values', async () => {
    const query = `tag=${tag.id}&cf.segment=retail&status=qualified,qualified&count=true&counts=true&limit=3`
    const result = (await request(`/leads?${query}`)).body.data
    expect(result.total).toBe(7)
    expect(result.counts).toEqual({ new: 0, contacted: 0, qualified: 7, lost: 0, junk: 0, converted: 0, all: 7 })
    expect(result.items).toHaveLength(3)
    expect(result.items.every((l) => l.status === 'qualified' && l.tags[0].id === tag.id)).toBe(true)
    const withoutTabs = (await request(`/leads?${query.replace('counts=true', 'counts=false')}`)).body.data
    expect(withoutTabs.total).toBe(result.total)
    expect(withoutTabs).not.toHaveProperty('counts')
    const withoutTotal = (await request('/leads?counts=true')).body.data
    expect(withoutTotal).not.toHaveProperty('total')
  })

  it('keeps pagination stable through the last/empty page and both sort directions', async () => {
    for (const sort of ['createdAt', '-createdAt', 'displayName', '-displayName']) {
      const ids = []; let cursor
      do {
        const result = (await request(`/leads?limit=4&count=true&counts=true&sort=${sort}${cursor ? `&cursor=${cursor}` : ''}`)).body.data
        expect(result.total).toBe(15); expect(result.counts.all).toBe(15)
        ids.push(...result.items.map((l) => l.id)); cursor = result.nextCursor
      } while (cursor)
      expect(new Set(ids).size).toBe(15)
      const rows = await prisma.lead.findMany({ where: { organizationId: org.id, deletedAt: null }, orderBy: [{ [sort.replace('-', '')]: sort.startsWith('-') ? 'desc' : 'asc' }, { id: sort.startsWith('-') ? 'desc' : 'asc' }], select: { id: true } })
      expect(ids).toEqual(rows.map((r) => r.id))
    }
    const empty = (await request('/leads?q=no-such-lead&count=true&counts=true')).body.data
    expect(empty).toMatchObject({ items: [], nextCursor: null, total: 0, counts: { all: 0 } })
    expect((await request('/leads?deleted=true&count=true&counts=true')).body.data.total).toBe(1)
  })

  it('applies membership changes immediately without cross-request permission caching', async () => {
    const where = { organizationId_userId: { organizationId: org.id, userId: users[3].id } }
    await prisma.membership.update({ where, data: { status: 'deactivated' } })
    try { expect((await request('/leads', 3)).status).toBe(403) }
    finally { await prisma.membership.update({ where, data: { status: 'active' } }) }
    await prisma.membership.update({ where, data: { role: 'viewer' } })
    try { expect((await request('/leads?count=true', 3)).body.data.total).toBe(15) }
    finally { await prisma.membership.update({ where, data: { role: 'sales_rep' } }) }
    const responses = await Promise.all(Array.from({ length: 8 }, (_, n) => request('/deals/board', n%5)))
    expect(responses.every((r) => r.status === 200 && r.timing.includes('queries;desc='))).toBe(true)
  })
})
