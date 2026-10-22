import crypto from 'node:crypto'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/config/env.js', () => ({ env: {
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused', DB_POOL_MAX: 10,
  JWT_ACCESS_SECRET: 'qualification-fixture-only-key-01234567890123456789', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test', JWT_ACCESS_EXPIRES_IN: '15m',
  DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', FRONTEND_URL: 'https://example.test',
} }))
vi.mock('../../src/email/mailer.js', () => ({ sendEmail: vi.fn(), queueEmail: vi.fn() }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue: vi.fn() }))
import { prisma } from '../../src/db/prisma.js'
import { leadRoutes } from '../../src/routes/lead.routes.js'
import { errorHandler } from '../../src/middlewares/errorHandler.js'
import { signAccessToken } from '../../src/services/token.service.js'

let org, other, users, lead, server, base
const request = async ({ method = 'GET', values, role = 0, tenant = org.id, ifMatch } = {}) => {
  const response = await fetch(`${base}/${lead.id}`, { method, headers: {
    authorization: `Bearer ${signAccessToken(users[role], tenant).accessToken}`, 'content-type': 'application/json', ...(ifMatch && { 'if-match': ifMatch }),
  }, ...(values && { body: JSON.stringify(values) }) })
  return { status: response.status, body: await response.json() }
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('real lead qualification persistence and access', () => {
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && process.env.TEST_DATABASE_DISPOSABLE !== 'true') throw new Error('Disposable test database required')
    users = await Promise.all(['owner', 'viewer', 'sales_rep'].map((name) => prisma.user.create({ data: { fullName: name, email: `${name}-${crypto.randomUUID()}@example.test`, passwordHash: 'cannot-login', emailVerifiedAt: new Date() } })))
    org = await prisma.organization.create({ data: { name: 'Qualification tests', slug: `qual-${crypto.randomUUID()}`, plan: 'business', createdById: users[0].id } })
    other = await prisma.organization.create({ data: { name: 'Other tenant', slug: `qual-${crypto.randomUUID()}`, createdById: users[0].id } })
    await prisma.membership.createMany({ data: users.map((user, i) => ({ organizationId: org.id, userId: user.id, role: ['owner', 'viewer', 'sales_rep'][i] })) })
    await prisma.membership.create({ data: { organizationId: other.id, userId: users[0].id, role: 'owner' } })
    lead = await prisma.lead.create({ data: { organizationId: org.id, firstName: 'Fixture', displayName: 'Fixture', ownerId: users[0].id } })
    const app = express(); app.use(express.json()); app.use('/leads', leadRoutes); app.use(errorHandler)
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) }); base = `http://127.0.0.1:${server.address().port}/leads`
  })
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (org) await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } })
    if (users) await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } })
    await prisma.$disconnect()
  })
  it('persists qualification on the actual lead, merges partial writes and emits audited changes', async () => {
    expect((await request()).body.data.lead.qualification).toEqual({})
    const person = { id: crypto.randomUUID(), name: 'Decision maker', role: 'decision_maker' }
    const first = await request({ method: 'PATCH', ifMatch: lead.updatedAt.toISOString(), values: { qualification: { priority: 'hot', timeline: '1_month', decisionMakers: [person] } } })
    expect(first.status).toBe(200)
    expect(first.body.data.lead.qualification).toMatchObject({ priority: 'hot', timeline: '1_month', decisionMakers: [person], updatedAt: expect.any(String) })
    const second = await request({ method: 'PATCH', ifMatch: first.body.data.lead.updatedAt, values: { qualification: { dealValueMinor: 0, objections: ['Price'], preferences: 'Morning consultation' } } })
    expect(second.status).toBe(200)
    expect((await request()).body.data.lead.qualification).toMatchObject({ priority: 'hot', dealValueMinor: 0, objections: ['Price'], timeline: '1_month' })
    const row = await prisma.lead.findUnique({ where: { id: lead.id } })
    expect(row.qualification.decisionMakers).toEqual([person])
    expect(await prisma.domainEvent.count({ where: { organizationId: org.id, entityId: lead.id, type: 'lead.updated' } })).toBe(2)
  })
  it('rejects stale writes, invalid payloads, viewers and foreign tenants without changing saved facts', async () => {
    expect((await request({ method: 'PATCH', ifMatch: lead.updatedAt.toISOString(), values: { qualification: { priority: 'cold' } } })).status).toBe(409)
    expect((await request({ method: 'PATCH', values: { qualification: { updatedAt: 'client-controlled' } } })).status).toBe(400)
    expect((await request({ method: 'PATCH', role: 1, values: { qualification: { priority: 'cold' } } })).status).toBe(403)
    // Own-scoped readers must not learn that another rep's lead exists.
    expect((await request({ method: 'PATCH', role: 2, values: { qualification: { priority: 'cold' } } })).status).toBe(404)
    expect((await request({ tenant: other.id })).status).toBe(404)
    expect((await request({ method: 'PATCH', tenant: other.id, values: { qualification: { priority: 'cold' } } })).status).toBe(404)
    expect((await request()).body.data.lead.qualification.priority).toBe('hot')
  })
  it('allows clearing details and preserves converted-lead protection', async () => {
    expect((await request({ method: 'PATCH', values: { qualification: { objections: [], priority: null } } })).status).toBe(200)
    expect((await request()).body.data.lead.qualification).toMatchObject({ priority: null, objections: [], timeline: '1_month' })
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'converted' } })
    expect((await request({ method: 'PATCH', values: { qualification: { priority: 'cold' } } })).status).toBe(409)
  })
})
