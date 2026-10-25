import crypto from 'node:crypto'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('../../src/config/env.js', () => ({ env: {
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused', DB_POOL_MAX: 5,
  JWT_ACCESS_SECRET: 'product-review-fixture-01234567890123456789012345', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test', JWT_ACCESS_EXPIRES_IN: '15m',
  DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', FRONTEND_URL: 'https://example.test',
} }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue: vi.fn() }))
vi.mock('../../src/email/mailer.js', () => ({ queueEmail: vi.fn(), sendEmail: vi.fn() }))
import { prisma } from '../../src/db/prisma.js'
import { reportRoutes } from '../../src/routes/report.routes.js'
import { leadRoutes } from '../../src/routes/lead.routes.js'
import { companyRoutes, contactRoutes } from '../../src/routes/crm.routes.js'
import { signAccessToken } from '../../src/services/token.service.js'
import { errorHandler } from '../../src/middlewares/errorHandler.js'
import { ensureDefaultPipeline } from '../../src/services/pipeline.service.js'
import { permissionsFor } from '../../src/config/permissions.js'
import { exportReport, kpis } from '../../src/services/report.service.js'
const uuid = () => crypto.randomUUID(), roles = ['owner', 'admin', 'manager', 'sales_rep', 'viewer']
let users, orgs, source, foreignSource, pipeline, server, base, lead, unowned, restricted, contact, company
const query = 'from=2026-10-01&to=2026-10-02'
async function request(path, role = 0, org = 0) {
  const response = await fetch(base + path, { headers: { authorization: `Bearer ${signAccessToken(users[role], orgs[org].id).accessToken}` } })
  return { status: response.status, data: (await response.json()).data }
}
const ctx = (role = 0) => ({ orgId: orgs[0].id, userId: users[role].id, permissions: permissionsFor(roles[role]), role: roles[role], managedUserIds: [users[3].id], timezone: 'Asia/Kolkata', currency: 'INR' })
describe.skipIf(!process.env.TEST_DATABASE_URL)('market review: real reports and related-record visibility', () => {
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local disposable DB required')
    users = await Promise.all(roles.map(role => prisma.user.create({ data: { email: `review-${role}-${uuid()}@example.test`, fullName: role, emailVerifiedAt: new Date() } })))
    orgs = await Promise.all([0, 1].map(i => prisma.organization.create({ data: { name: `Review ${i}`, slug: `review-${uuid()}`, createdById: users[0].id, plan: 'business' } })))
    await prisma.membership.createMany({ data: orgs.flatMap(o => users.map((u, i) => ({ organizationId: o.id, userId: u.id, role: roles[i] }))) })
    const team = await prisma.team.create({ data: { organizationId: orgs[0].id, name: 'Review team' } })
    await prisma.teamMember.createMany({ data: [{ teamId: team.id, userId: users[2].id, isManager: true }, { teamId: team.id, userId: users[3].id }] })
    source = await prisma.leadSource.create({ data: { organizationId: orgs[0].id, name: '=Formula source', key: `review-${uuid()}` } })
    foreignSource = await prisma.leadSource.create({ data: { organizationId: orgs[1].id, name: 'Foreign source', key: `review-${uuid()}` } })
    await prisma.$transaction(tx => ensureDefaultPipeline(tx, orgs[0].id))
    pipeline = await prisma.pipeline.findFirst({ where: { organizationId: orgs[0].id }, include: { stages: true } })
    const input = { organizationId: orgs[0].id, displayName: 'Reached qualification then lost', ownerId: users[3].id, sourceId: source.id, createdAt: new Date('2026-09-30T18:30:00Z') }
    lead = await prisma.lead.create({ data: { ...input, status: 'lost' } })
    // Even if an event's current endpoint is new/lost, the previous side is durable evidence.
    await prisma.domainEvent.create({ data: { organizationId: orgs[0].id, type: 'lead.status_changed', entityType: 'lead', entityId: lead.id, payload: { changes: { status: ['qualified', 'lost'] } } } })
    unowned = await prisma.lead.create({ data: { ...input, displayName: 'Unassigned enquiry', ownerId: null, sourceId: null } })
    restricted = await prisma.lead.create({ data: { ...input, displayName: 'Owner enquiry', ownerId: users[0].id } })
    await prisma.lead.createMany({ data: [
      { ...input, displayName: 'Junk', status: 'junk' }, { ...input, displayName: 'Deleted', deletedAt: new Date() },
      { ...input, displayName: 'Before IST midnight', createdAt: new Date('2026-09-30T18:29:59.999Z') },
      { ...input, displayName: 'After end IST', createdAt: new Date('2026-10-02T18:30:00Z') },
      { ...input, displayName: 'Foreign enquiry', organizationId: orgs[1].id, sourceId: foreignSource.id },
    ] })
    const wonStage = pipeline.stages.find(s => s.type === 'won'), lostStage = pipeline.stages.find(s => s.type === 'lost')
    const deal = { organizationId: orgs[0].id, title: 'Revenue fixture', pipelineId: pipeline.id, stageId: wonStage.id, status: 'won', ownerId: users[3].id, currency: 'INR', sourceId: source.id, valueMinor: 10001n, wonAt: new Date('2026-10-01T18:29:59.999Z'), closedAt: new Date('2026-10-01T18:29:59.999Z') }
    const convertedDeal = await prisma.deal.create({ data: { ...deal, leadId: lead.id } })
    await prisma.deal.createMany({ data: [
      { ...deal, title: 'Other currency', currency: 'USD', valueMinor: 999999999n },
      { ...deal, title: 'Out of range', wonAt: new Date('2026-10-02T18:30:00Z'), closedAt: new Date('2026-10-02T18:30:00Z') },
      { ...deal, title: 'Lost', stageId: lostStage.id, status: 'lost', wonAt: null, lostAt: new Date('2026-10-01'), closedAt: new Date('2026-10-01') },
    ] })
    await prisma.lead.update({ where: { id: restricted.id }, data: { status: 'converted', convertedAt: new Date(), convertedDealId: convertedDeal.id } })
    contact = await prisma.contact.create({ data: { organizationId: orgs[0].id, displayName: 'Visible contact', ownerId: users[3].id } })
    company = await prisma.company.create({ data: { organizationId: orgs[0].id, name: 'Restricted company', ownerId: users[0].id } })
    await prisma.contactCompany.create({ data: { organizationId: orgs[0].id, contactId: contact.id, companyId: company.id, isPrimary: true } })
    const hidden = await prisma.contact.create({ data: { organizationId: orgs[0].id, displayName: 'Hidden contact', ownerId: users[0].id } })
    const visibleCompany = await prisma.company.create({ data: { organizationId: orgs[0].id, name: 'Visible company', ownerId: users[3].id } })
    await prisma.contactCompany.create({ data: { organizationId: orgs[0].id, contactId: hidden.id, companyId: visibleCompany.id } })
    company.visible = visibleCompany.id
    const app = express(); app.use(express.json()); app.use('/reports', reportRoutes); app.use('/leads', leadRoutes); app.use('/contacts', contactRoutes); app.use('/companies', companyRoutes); app.use(errorHandler)
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); base = `http://127.0.0.1:${server.address().port}`
  }, 20000)
  afterAll(async () => {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    if (orgs) { await prisma.domainEvent.deleteMany({ where: { organizationId: { in: orgs.map(o => o.id) } } }); await prisma.organization.deleteMany({ where: { id: { in: orgs.map(o => o.id) } } }) }
    if (users) await prisma.user.deleteMany({ where: { id: { in: users.map(u => u.id) } } })
    await prisma.$disconnect()
  })
  it.each(['kpis', 'revenue-series', 'leads-by-source', 'funnel', 'leaderboard'])('enforces real tenant/role scope on %s', async endpoint => {
    for (let role = 0; role < roles.length; role++) {
      const r = await request(`/reports/${endpoint}?${query}`, role)
      expect(r.status, roles[role]).toBe(200)
      expect(JSON.stringify(r.data)).not.toContain('Foreign')
    }
    expect((await request(`/reports/${endpoint}?${query}&ownerId=${users[0].id}`, 3)).status).toBe(403)
    expect((await request(`/reports/${endpoint}?${query}&sourceId=${foreignSource.id}`)).data).toEqual(endpoint === 'funnel' ? [
      { stage: 'New enquiries', count: 0 }, { stage: 'Contacted', count: 0 }, { stage: 'Qualified', count: 0 }, { stage: 'Converted', count: 0 }, { stage: 'Deal won', count: 0 },
    ] : expect.any(Array))
  })
  it('matches KPI, sources, series and lead-list counts at IST boundaries, without junk/deleted/FX pollution', async () => {
    const metrics = (await request(`/reports/kpis?${query}`)).data
    expect(metrics.find(k => k.key === 'leads').value).toBe('3')
    expect(metrics.find(k => k.key === 'revenue').valueMinor).toBe(10001)
    expect(metrics.find(k => k.key === 'winRate').value).toBe('50%')
    const sources = (await request(`/reports/leads-by-source?${query}`)).data
    expect(sources.reduce((n, s) => n + s.leads, 0)).toBe(3)
    expect(sources.reduce((n, s) => n + s.revenueMinor, 0)).toBe(10001)
    const series = (await request(`/reports/revenue-series?${query}`)).data
    expect(series).toHaveLength(12); expect(series.reduce((n, r) => n + r.valueMinor, 0)).toBe(10001)
    const noSource = (await request(`/leads?sourceId=none&createdFrom=2026-10-01&createdTo=2026-10-02&count=true`)).data
    expect(noSource.total).toBe(1); expect(noSource.items[0].id).toBe(unowned.id)
    expect((await request(`/reports/kpis?${query}`, 3)).data.find(k => k.key === 'leads').value).toBe('2')
  })
  it('retains reached qualification after loss and counts one converted/won lead once', async () => {
    const all = (await request(`/reports/funnel?${query}`)).data
    expect(all.map(r => r.count)).toEqual([3, 2, 2, 1, 1])
    expect((await request(`/reports/funnel?${query}`, 3)).data.map(r => r.count)).toEqual([2, 1, 1, 0, 0])
  })
  it('validates dates and comparisons, denies direct exports, and audits authorized exports', async () => {
    for (const bad of ['from=2026-02-30&to=2026-03-01', 'from=2026-10-03&to=2026-10-02', 'from=2026-10-01', `${query}&compare=anything`, `${query}&months=25`]) expect((await request(`/reports/kpis?${bad}`)).status).toBe(400)
    for (const role of [3, 4]) expect((await request(`/reports/sources/export?${query}`, role)).status).toBe(403)
    await expect(exportReport(ctx(4), 'sources', { from: '2026-10-01', to: '2026-10-02' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const exported = await request(`/reports/sources/export?${query}`)
    expect(exported.status).toBe(200); expect(exported.data.rows).toHaveLength(2)
    expect(await prisma.auditLog.count({ where: { organizationId: orgs[0].id, action: 'report.export' } })).toBe(1)
    expect((await request(`/reports/unknown/export?${query}`)).status).toBe(404)
    const manager = (await request(`/reports/sources/export?${query}`, 2)).data
    expect(manager.rows.reduce((n, row) => n + row[1], 0)).toBe(1) // no unassigned rows on exports
    await expect(kpis({ ...ctx(), permissions: [] }, { from: '2026-10-01', to: '2026-10-02' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('hides restricted company references and contact counts in both list and detail', async () => {
    const visible = await request(`/contacts/${contact.id}`, 3)
    expect(visible.status).toBe(200); expect(visible.data.contact.companies).toEqual([])
    expect((await request(`/contacts/${contact.id}`)).data.contact.companies[0].name).toBe('Restricted company')
    expect((await request(`/companies/${company.visible}`, 3)).data.company.contactCount).toBe(0)
    expect((await request(`/companies/${company.visible}`)).data.company.contactCount).toBe(1)
    expect((await request(`/contacts/${contact.id}`, 0, 1)).status).toBe(404)
    expect((await request(`/companies/${company.visible}`, 0, 1)).status).toBe(404)
  })
  it('reports measured first response and due-cohort compliance with role/source isolation', async () => {
    await prisma.lead.update({ where: { id: lead.id }, data: { firstRespondedAt: new Date(lead.createdAt.getTime() + 5 * 60000) } })
    const due = new Date('2026-10-01T09:00:00Z')
    const task = { organizationId: orgs[0].id, assigneeId: users[3].id, title: 'Compliance', entityType: 'lead', entityId: lead.id, dueAt: due }
    await prisma.task.createMany({ data: [
      { ...task, status: 'completed', completedAt: new Date(due.getTime() - 60000) },
      { ...task, status: 'completed', completedAt: new Date(due.getTime() + 60000) },
      { ...task, status: 'open' }, { ...task, status: 'cancelled' },
      { ...task, organizationId: orgs[1].id, entityId: uuid(), status: 'open' },
    ] })
    for (const role of [0, 1, 2, 3, 4]) {
      const r = await request(`/reports/first-response?${query}&sourceId=${source.id}`, role)
      expect(r.status).toBe(200); expect(r.data.medianMinutes).toBe(5)
      const t = await request(`/reports/follow-ups?${query}&sourceId=${source.id}`, role)
      expect(t.status).toBe(200); expect(t.data).toMatchObject({ due: 3, completed: 2, onTime: 1, compliancePercent: 33.3, overdueNow: 1 })
    }
    expect((await request(`/reports/first-response?${query}&sourceId=${foreignSource.id}`)).data).toMatchObject({ total: 0, medianMinutes: null })
    expect((await request(`/reports/follow-ups?${query}&sourceId=${foreignSource.id}`)).data).toMatchObject({ due: 0, compliancePercent: null, overdueNow: 0 })
    expect((await request(`/reports/first-response?${query}&ownerId=${users[0].id}`, 3)).status).toBe(403)
  })
  it('uses the seven-day idle threshold with deterministic dates in notification digests', async () => {
    const { digestSections } = await import('../../src/services/notificationDelivery.service.js')
    const now = new Date('2026-10-19T03:00:00Z'), stage = pipeline.stages.find(s => s.type === 'open')
    await prisma.pipelineStage.update({ where: { id: stage.id }, data: { rottingDays: 7 } })
    const idle = await prisma.deal.create({ data: { organizationId: orgs[0].id, title: 'Deterministic idle', pipelineId: pipeline.id, stageId: stage.id, status: 'open', ownerId: users[3].id, currency: 'INR', stageEnteredAt: new Date('2026-10-08T03:00:00Z'), lastActivityAt: new Date('2026-10-08T03:00:00Z') } })
    let sections = await digestSections(ctx(3), now)
    expect(sections.find(s => s.label === 'Idle deals').items.some(i => i.title === idle.title)).toBe(true)
    await prisma.deal.update({ where: { id: idle.id }, data: { lastActivityAt: new Date('2026-10-17T03:00:00Z') } })
    sections = await digestSections(ctx(3), now)
    expect(sections.find(s => s.label === 'Idle deals')?.items.some(i => i.title === idle.title) ?? false).toBe(false)
  })

})
