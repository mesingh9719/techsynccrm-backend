import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/config/env.js', () => ({ env: {
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused',
  DB_POOL_MAX: 10, PERFORMANCE_METRICS: true, SLOW_QUERY_MS: 10000,
  JWT_ACCESS_SECRET: 'latency-tests-only-key-012345678901234567890', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test', JWT_ACCESS_EXPIRES_IN: '15m',
  FRONTEND_URL: 'https://example.test', DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
} }))
vi.mock('../../src/email/mailer.js', () => ({ sendEmail: vi.fn(), queueEmail: vi.fn() }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue: vi.fn() }))
import { prisma } from '../../src/db/prisma.js'
import { leadEngagement } from '../../src/services/lead.service.js'

let user, orgs, leads
const uuid = () => crypto.randomUUID()
describe.skipIf(!process.env.TEST_DATABASE_URL)('lead scoring index regression', () => {
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && process.env.TEST_DATABASE_DISPOSABLE !== 'true') throw new Error('Disposable database required')
    user = await prisma.user.create({ data: { fullName: 'Scoring fixture', email: `${uuid()}@example.test` } })
    orgs = await Promise.all([0,1].map(n => prisma.organization.create({ data: { name: `Scoring ${n}`, slug: `scoring-${uuid()}`, createdById: user.id } })))
    leads = await Promise.all(orgs.map(o => prisma.lead.create({ data: { organizationId: o.id, displayName: 'Scoring lead' } })))
  })
  afterAll(async () => {
    if (orgs) await prisma.organization.deleteMany({ where: { id: { in: orgs.map(o=>o.id) } } })
    if (user) await prisma.user.delete({ where: { id: user.id } })
    await prisma.$disconnect()
  })
  it('preserves linked-record, inbound, outcome, deletion and date rules across tenants', async () => {
    const now = new Date('2026-10-24T12:00:00Z')
    const hour = 3600000
    for (const [tenant, type, direction, outcome, ageHours, deleted] of [
      [0, 'call', 'inbound', 'connected', 2, false],
      [0, 'meeting', null, null, 24, false],
      [0, 'call', 'outbound', 'no_answer', 1, false],
      [0, 'call', 'inbound', 'connected', 1, true],
      [0, 'site_visit', null, null, 24*15, false],
      [0, 'meeting', null, null, -1, false],
      [1, 'call', 'inbound', 'connected', 0, false],
    ]) {
      const activity = await prisma.activity.create({ data: {
        organizationId: orgs[tenant].id, type, direction, outcome, occurredAt: new Date(now-ageHours*hour),
        // An activity's primary record can differ: scoring must use its links.
        entityType: 'company', entityId: uuid(), deletedAt: deleted ? now : null,
      } })
      await prisma.activityLink.create({ data: { activityId: activity.id, organizationId: orgs[tenant].id, entityType: 'lead', entityId: leads[0].id, occurredAt: activity.occurredAt } })
    }
    expect(await leadEngagement(prisma, orgs[0].id, leads[0].id, now)).toEqual({ lastInboundAt: new Date(now-2*hour), completedTouches14d: 2 })
    expect(await leadEngagement(prisma, orgs[1].id, leads[1].id, now)).toEqual({ lastInboundAt: null, completedTouches14d: 0 })
    expect(await leadEngagement(prisma, orgs[0].id, uuid(), now)).toEqual({ lastInboundAt: null, completedTouches14d: 0 })
  })
})
