import crypto from 'node:crypto'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/config/env.js', () => ({ env: {
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused', DB_POOL_MAX: 5,
  JWT_ACCESS_SECRET: 'template-fixture-only-012345678901234567890123456789', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test', JWT_ACCESS_EXPIRES_IN: '15m',
  DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', FRONTEND_URL: 'https://example.test',
} }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue: vi.fn() }))
import { prisma } from '../../src/db/prisma.js'
import { customFieldRoutes } from '../../src/routes/crm.routes.js'
import { templateRoutes } from '../../src/routes/template.routes.js'
import { emailTemplateRoutes } from '../../src/routes/gmail.routes.js'
import { errorHandler } from '../../src/middlewares/errorHandler.js'
import { signAccessToken } from '../../src/services/token.service.js'
import { validateTemplateContent } from '../../src/services/template.service.js'
import { templateCreate, templateUpdate } from '../../src/validators/template.validators.js'
import { permissionsFor } from '../../src/config/permissions.js'

const input = (values = {}) => ({ name: 'First response', channel: 'email', category: 'introduction', subject: 'Hello {{firstName}}', bodyHtml: '<p>Hi {{firstName}}, from {{workspace}}</p>', shared: false, ...values })
describe('template content validation', () => {
  it('rejects blank sanitized content, invalid fields, header injection and unsupported channels', () => {
    expect(() => validateTemplateContent(input({ bodyHtml: '<script>bad()</script><p><br></p>' }))).toThrow('Write a message')
    expect(() => validateTemplateContent(input({ bodyHtml: '<p>{{unknown}}</p>' }))).toThrow('Unknown field')
    expect(() => validateTemplateContent(input({ subject: '{{ firstName }' }))).toThrow('Check your personalization')
    expect(() => validateTemplateContent(input({ subject: '   ' }))).toThrow('Add an email subject')
    expect(templateCreate.safeParse(input({ subject: 'Subject\r\nBcc: injected' })).success).toBe(false)
    expect(templateCreate.safeParse(input({ channel: 'fax' })).success).toBe(false)
    expect(templateCreate.safeParse(input({ name: '   ' })).success).toBe(false)
    expect(templateUpdate.safeParse({ name: 'Changed' }).success).toBe(false)
    expect(templateUpdate.safeParse({ expectedVersion: 1, channel: 'sms' }).success).toBe(false)
  })
  it('sanitizes HTML and enforces useful channel-specific limits', () => {
    const value = validateTemplateContent(input({ bodyHtml: '<p onclick="bad()">Hi <strong>{{name}}</strong><img src="https://pixel.invalid"><script>bad()</script></p>' }))
    expect(value.bodyHtml).toBe('<p>Hi <strong>{{name}}</strong></p>')
    expect(() => validateTemplateContent(input({ channel: 'sms', bodyHtml: 'a'.repeat(1601) }))).toThrow('1,600')
    expect(() => validateTemplateContent(input({ channel: 'whatsapp', bodyHtml: 'a'.repeat(4097) }))).toThrow('4,096')
    expect(validateTemplateContent(input({ channel: 'sms', subject: '', bodyHtml: 'Hi {{name}}' })).subject).toBe('')
  })
})

describe.skipIf(!process.env.TEST_DATABASE_URL)('template library HTTP and database boundaries', () => {
  let org, other, users = [], sessions, server, base, personal, shared, whatsapp
  const request = async (path = '/templates', { method = 'GET', values, user = 0, tenant, headers = {} } = {}) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${signAccessToken(users[user], tenant || org.id, sessions[user]).accessToken}`, 'content-type': 'application/json', ...headers }, ...(values && { body: JSON.stringify(values) }) })
    return { status: res.status, body: res.status === 204 ? null : await res.json() }
  }
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && process.env.TEST_DATABASE_DISPOSABLE !== 'true') throw new Error('Disposable test database required')
    users = await Promise.all(['owner', 'admin', 'sales_rep', 'viewer'].map((role) => prisma.user.create({ data: { fullName: role, email: `${crypto.randomUUID()}@example.test`, passwordHash: 'cannot-login', emailVerifiedAt: new Date() } })))
    sessions = users.map(() => crypto.randomUUID())
    await prisma.refreshToken.createMany({ data: users.map((user, i) => ({ userId: user.id, sessionId: sessions[i], tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + 86400000) })) })
    org = await prisma.organization.create({ data: { name: 'Templates fixture', slug: `templates-${crypto.randomUUID()}`, plan: 'growth', createdById: users[0].id } })
    other = await prisma.organization.create({ data: { name: 'Other template tenant', slug: `templates-${crypto.randomUUID()}`, plan: 'growth', createdById: users[0].id } })
    await prisma.membership.createMany({ data: users.map((user, i) => ({ organizationId: org.id, userId: user.id, role: ['owner', 'admin', 'sales_rep', 'viewer'][i] })) })
    await prisma.membership.create({ data: { organizationId: other.id, userId: users[0].id, role: 'owner' } })
    const app = express(); app.use(express.json()); app.use('/templates', templateRoutes); app.use('/custom-fields', customFieldRoutes); app.use('/email-templates', emailTemplateRoutes); app.use(errorHandler)
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) }); base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (org) {
      await prisma.emailTemplate.deleteMany({ where: { organizationId: { in: [org.id, other.id] } } })
      await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } })
    }
    if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } })
    await prisma.$disconnect()
  })
  it('requires authentication and validates bodies and identifiers', async () => {
    expect((await fetch(`${base}/templates`)).status).toBe(401)
    expect((await request('/templates', { method: 'POST', values: input({ name: '' }) })).status).toBe(400)
    expect((await request('/templates/not-a-uuid', { method: 'PATCH', values: { expectedVersion: 1 } })).status).toBe(400)
    expect((await request('/templates?limit=101')).status).toBe(400)
    expect((await request('/templates?status=deleted')).status).toBe(400)
  })
  it('creates sanitized templates and records an audit entry in the same transaction', async () => {
    const result = await request('/templates', { method: 'POST', values: input({ bodyHtml: '<p>Hi {{firstName}}<script>bad()</script></p>' }) })
    expect(result.status).toBe(201); personal = result.body.data.template
    expect(personal.bodyHtml).toBe('<p>Hi {{firstName}}</p>'); expect(personal.channel).toBe('email'); expect(personal.version).toBe(1)
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityId: personal.id, action: 'template.created' } })).toBe(1)
    expect(await prisma.domainEvent.count({ where: { organizationId: org.id, entityId: personal.id, type: 'template.created' } })).toBe(1)
  })
  it('keeps private templates invisible even to another admin and across workspaces', async () => {
    expect((await request('/templates', { user: 1 })).body.data.items).toEqual([])
    expect((await request('/templates', { tenant: other.id })).body.data.items).toEqual([])
    for (const options of [{ user: 1 }, { tenant: other.id }]) {
      expect((await request(`/templates/${personal.id}`, { ...options, method: 'PATCH', values: { name: 'Stolen', expectedVersion: 1 } })).status).toBe(404)
      expect((await request(`/email-templates/${personal.id}`, { ...options, method: 'DELETE' })).status).toBe(404)
    }
  })
  it('enforces viewer and team-edit permissions while allowing personal copies', async () => {
    shared = (await request('/templates', { method: 'POST', values: input({ name: 'Team reply', shared: true }) })).body.data.template
    expect((await request('/templates', { user: 3 })).body.data.items.map((t) => t.id)).toEqual([shared.id])
    expect((await request('/templates', { method: 'POST', user: 3, values: input() })).status).toBe(403)
    expect((await request('/templates', { method: 'POST', user: 2, values: input({ shared: true }) })).status).toBe(403)
    expect((await request(`/templates/${shared.id}`, { method: 'PATCH', user: 2, values: { bodyHtml: '<p>Changed</p>', expectedVersion: 1 } })).status).toBe(403)
    const copy = await request('/templates', { method: 'POST', user: 2, values: input({ name: 'My copy', shared: false }) })
    expect(copy.status).toBe(201); expect(copy.body.data.template.ownerId).toBe(users[2].id)
  })
  it('detects stale edits and archive/edit races atomically', async () => {
    const requests = await Promise.all(['First edit', 'Second edit'].map((name) => request(`/templates/${personal.id}`, { method: 'PATCH', values: { name, expectedVersion: 1 } })))
    expect(requests.map((r) => r.status).sort()).toEqual([200, 409])
    personal = requests.find((r) => r.status === 200).body.data.template
    const stale = await request(`/templates/${personal.id}`, { method: 'PATCH', values: { archived: true, expectedVersion: 1 } })
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('STALE_UPDATE')
    expect((await request(`/templates/${personal.id}`, { method: 'PATCH', values: { archived: true } })).status).toBe(400)
  })
  it('makes a team template private to the admin who chooses Personal · only me', async () => {
    const created = (await request('/templates', { method: 'POST', values: input({ name: 'Take private', shared: true }) })).body.data.template
    const saved = await request(`/templates/${created.id}`, { method: 'PATCH', user: 1, values: { shared: false, expectedVersion: created.version } })
    expect(saved.status).toBe(200); expect(saved.body.data.template.ownerId).toBe(users[1].id)
    expect((await request('/templates?q=Take%20private')).body.data.items).toEqual([])
    expect((await request('/templates?q=Take%20private', { user: 1 })).body.data.items.map((t) => t.id)).toEqual([created.id])
  })
  it('archives and restores without losing content, and excludes archived entries from legacy pickers', async () => {
    const before = personal.bodyHtml
    personal = (await request(`/templates/${personal.id}`, { method: 'PATCH', values: { archived: true, expectedVersion: personal.version } })).body.data.template
    expect(personal.archivedAt).toBeTruthy()
    expect((await request('/email-templates')).body.data.items.some((t) => t.id === personal.id)).toBe(false)
    expect((await request('/templates?status=archived')).body.data.items.map((t) => t.id)).toEqual([personal.id])
    personal = (await request(`/templates/${personal.id}`, { method: 'PATCH', values: { archived: false, expectedVersion: personal.version } })).body.data.template
    expect(personal.bodyHtml).toBe(before); expect(personal.archivedAt).toBeNull()
    expect((await request('/email-templates')).body.data.items.some((t) => t.id === personal.id)).toBe(true)
  })
  it('supports channel/category/search filters and stable cursor pagination', async () => {
    whatsapp = (await request('/templates', { method: 'POST', values: input({ channel: 'whatsapp', name: 'Quick quotation', category: 'proposal', subject: '' }) })).body.data.template
    expect((await request('/templates?channel=whatsapp&category=proposal&q=quotation')).body.data.items.map((t) => t.id)).toEqual([whatsapp.id])
    expect((await request('/templates?scope=team')).body.data.items.every((t) => t.shared)).toBe(true)
    const first = (await request('/templates?limit=1&sort=name')).body.data
    const second = (await request(`/templates?limit=1&sort=name&cursor=${encodeURIComponent(first.nextCursor)}`)).body.data
    expect(first.nextCursor).toBeTruthy(); expect(second.items[0].id).not.toBe(first.items[0].id)
    expect((await request(`/templates?sort=-updatedAt&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(400)
    expect((await request('/email-templates')).body.data.items.some((t) => t.id === whatsapp.id)).toBe(false)
  })
  it('searches visible message content without matching HTML tags', async () => {
    const created = await request('/templates', { method: 'POST', values: input({ name: 'Search example', bodyHtml: '<p><strong>uniqueneedle</strong></p>' }) })
    expect(created.status).toBe(201)
    expect((await request('/templates?q=uniqueneedle')).body.data.items.map((t) => t.id)).toEqual([created.body.data.template.id])
    expect((await request('/templates?q=strong')).body.data.items).toEqual([])
  })
  it('retains the legacy email API but cannot mutate quick replies through it', async () => {
    const saved = await request(`/email-templates/${personal.id}`, { method: 'PATCH', values: { name: personal.name, subject: 'Updated legacy subject', bodyHtml: personal.bodyHtml, shared: false, expectedVersion: personal.version } })
    expect(saved.status).toBe(200)
    expect((await request(`/email-templates/${whatsapp.id}`, { method: 'PATCH', values: { name: 'Wrong channel', subject: 'Hi', bodyHtml: '<p>Hi</p>' } })).status).toBe(404)
    expect((await request(`/email-templates/${whatsapp.id}`, { method: 'DELETE' })).status).toBe(404)
  })
  it('keeps Growth gating on email editing while allowing SMS on Starter', async () => {
    await prisma.organization.update({ where: { id: org.id }, data: { plan: 'starter' } })
    try {
      const denied = await request('/templates', { method: 'POST', values: input() })
      expect(denied.status).toBe(403); expect(denied.body.error.code).toBe('FEATURE_NOT_IN_PLAN')
      expect((await request('/templates', { method: 'POST', values: input({ channel: 'sms', subject: '' }) })).status).toBe(201)
    } finally { await prisma.organization.update({ where: { id: org.id }, data: { plan: 'growth' } }) }
  })
  it('persists shared variable definitions, validates defaults, and protects referenced definitions', async () => {
    const values = input({ name: 'Dynamic proposal', recordType: 'lead', variables: [{ key: ' Project Name ', label: 'Project name', type: 'text', required: true, defaultValue: 'CRM rollout' }, { key: 'meeting_link', label: 'Meeting link', type: 'url', required: true, helpText: 'Booking link for this recipient' }, { key: 'discount_offer', label: 'Discount offer', type: 'text', required: false }], subject: 'Hello {{lead.first_name}}', bodyHtml: '<p>{{project_name}} {{discount_offer}}</p><a href="{{meeting_link}}">Book a meeting</a>' })
    const created = await request('/templates', { method: 'POST', values })
    expect(created.status).toBe(201)
    const t = created.body.data.template
    expect(t.variables[0].key).toBe('project_name')
    expect((await request('/templates?scope=team', { user: 2 })).body.data.items.some((row) => row.id === t.id)).toBe(false)
    expect((await request(`/templates/${t.id}`, { method: 'PATCH', values: { shared: true, expectedVersion: t.version } })).status).toBe(200)
    const shared = (await request('/templates?scope=team', { user: 2 })).body.data.items.find((row) => row.id === t.id)
    expect(shared.variables[1].helpText).toBe('Booking link for this recipient')
    expect((await request(`/templates/${t.id}`, { method: 'PATCH', user: 2, values: { variables: [], expectedVersion: shared.version } })).status).toBe(403)
    const rejected = await request(`/templates/${t.id}`, { method: 'PATCH', values: { variables: [], expectedVersion: shared.version } })
    expect(rejected.status).toBe(422)
    expect((await prisma.emailTemplate.findFirst({ where: { id: t.id, organizationId: org.id } })).variables).toHaveLength(3)
    expect((await request('/templates', { method: 'POST', values: { ...values, variables: [{ key: 'meeting_link', label: 'Meeting link', type: 'url', defaultValue: 'javascript:alert(1)' }] } })).status).toBe(400)
    expect((await request(`/templates/${t.id}`, { method: 'PATCH', values: { archived: true, expectedVersion: shared.version } })).body.data.template.variables).toHaveLength(3)
  })
  it('resolves system/custom fields against each recipient and sender, with no one-off values stored', async () => {
    const leads = await Promise.all(['Asha', 'Ravi'].map((firstName, i) => prisma.lead.create({ data: { organizationId: org.id, firstName, displayName: firstName, ownerId: users[2].id, primaryEmail: `recipient${i}@example.test`, emails: [{ value: `recipient${i}@example.test` }], customFields: { preferred_plan: i ? 'basic' : 'pro' } } })))
    await prisma.customFieldDefinition.create({ data: { organizationId: org.id, entityType: 'lead', key: 'preferred_plan', label: 'Preferred plan', type: 'select', options: [{ value: 'pro', label: 'Professional' }, { value: 'basic', label: 'Basic' }] } })
    const template = (await request('/templates', { method: 'POST', values: input({ shared: true, recordType: 'lead', subject: '{{lead.first_name}} · {{user.name}}', bodyHtml: '<p>{{lead.custom.preferred_plan}} {{project_name}} {{optional_note}}</p><a href="{{meeting_link}}">Meet</a>', variables: [{ key: 'meeting_link', label: 'Meeting link', type: 'url' }, { key: 'project_name', label: 'Project', type: 'text', defaultValue: 'CRM rollout' }, { key: 'optional_note', label: 'Optional note', type: 'text', required: false }] }) })).body.data.template
    const fields = (await request('/templates/variables?recordType=lead', { user: 2 })).body.data.fields
    expect(fields.some((d) => d.key === 'lead.custom.preferred_plan')).toBe(true)
    const render = (lead, values = {}, user = 2) => request(`/templates/${template.id}/render`, { method: 'POST', user, values: { entityType: 'lead', entityId: lead.id, ...(lead.primaryEmail && { to: lead.primaryEmail }), values, expectedVersion: template.version } })
    const missing = await render(leads[0])
    expect(missing.status).toBe(200); expect(missing.body.data.valid).toBe(false)
    expect(missing.body.data.fields.find((f) => f.key === 'meeting_link').error).toContain('required')
    const ready = await render(leads[0], { meeting_link: 'https://example.com/asha', project_name: '<script>inert</script>', 'lead.first_name': 'Wrong record' })
    expect(ready.body.data.valid).toBe(true); expect(ready.body.data.subject).toBe('Asha · sales_rep')
    expect(ready.body.data.bodyHtml).toContain('Professional &lt;script&gt;inert&lt;/script&gt;')
    expect(ready.body.data.bodyHtml).toContain('href="https://example.com/asha"')
    const second = await render(leads[1], { meeting_link: 'https://example.com/ravi' }, 0)
    expect(second.body.data.subject).toBe('Ravi · owner'); expect(second.body.data.bodyHtml).toContain('Basic CRM rollout')
    expect(second.body.data.bodyHtml).not.toContain('inert'); expect(second.body.data.bodyHtml).not.toContain('{{')
    expect((await prisma.emailTemplate.findFirst({ where: { id: template.id, organizationId: org.id } })).variables[1].defaultValue).toBe('CRM rollout')
    expect((await render(leads[0], { meeting_link: 'javascript:alert(1)' })).body.data.valid).toBe(false)
    expect((await request(`/templates/${template.id}/render`, { method: 'POST', tenant: other.id, values: { entityType: 'lead', entityId: leads[0].id } })).status).toBe(404)
    const privateLead = await prisma.lead.create({ data: { organizationId: org.id, displayName: 'Hidden recipient', ownerId: users[0].id } })
    expect((await render(privateLead)).status).toBe(404)
    expect((await request(`/templates/${template.id}/render`, { method: 'POST', values: { entityType: 'contact', entityId: leads[0].id } })).body.error.code).toBe('TEMPLATE_CONTEXT_MISMATCH')
  })
  it('resolves contact and primary-company custom fields without leaking an inaccessible company', async () => {
    const company = await prisma.company.create({ data: { organizationId: org.id, name: 'Hidden company', ownerId: users[0].id, customFields: { credit_amount: 123450 } } })
    const contact = await prisma.contact.create({ data: { organizationId: org.id, displayName: 'Contact', firstName: 'Contact', ownerId: users[2].id, customFields: { renewal_date: '2026-12-10' } } })
    await prisma.contactCompany.create({ data: { organizationId: org.id, companyId: company.id, contactId: contact.id, isPrimary: true } })
    await prisma.customFieldDefinition.createMany({ data: [{ organizationId: org.id, entityType: 'company', key: 'credit_amount', label: 'Credit amount', type: 'currency' }, { organizationId: org.id, entityType: 'contact', key: 'renewal_date', label: 'Renewal date', type: 'date' }] })
    const template = (await request('/templates', { method: 'POST', values: input({ shared: true, recordType: 'contact', subject: '{{contact.first_name}}', bodyHtml: '<p>{{contact.custom.renewal_date}} {{company.custom.credit_amount}}</p>' }) })).body.data.template
    const render = (user) => request(`/templates/${template.id}/render`, { method: 'POST', user, values: { entityType: 'contact', entityId: contact.id } })
    const owner = (await render(0)).body.data
    expect(owner.valid).toBe(true); expect(owner.bodyHtml).toContain('2026-12-10'); expect(owner.bodyHtml).toContain('1,234.50')
    const rep = (await render(2)).body.data
    expect(rep.valid).toBe(false); expect(rep.bodyHtml).not.toContain('1,234.50'); expect(JSON.stringify(rep)).not.toContain('123450')
  })
  it('uses the same renderer for example previews, rejects malformed references and ignores prototype traversal', async () => {
    const result = await request('/templates/preview', { method: 'POST', values: { channel: 'email', recordType: 'lead', subject: '{{lead.first_name}}', bodyHtml: '<p>{{project_name}}</p>', variables: [{ key: 'project_name', label: 'Project', type: 'text', required: false }], values: { 'lead.first_name': 'Example Asha' } } })
    expect(result.status).toBe(200); expect(result.body.data.subject).toBe('Example Asha'); expect(result.body.data.bodyHtml).toBe('<p></p>')
    expect((await request('/templates', { method: 'POST', values: input({ bodyHtml: '<p>{{user.password}}</p>' }) })).status).toBe(422)
    expect((await request('/templates', { method: 'POST', values: input({ recordType: 'lead', bodyHtml: '{{contact.first_name}}' }) })).status).toBe(422)
  })
  it('blocks CRM definition changes that would leave references in private or archived templates', async () => {
    const def = await prisma.customFieldDefinition.create({ data: { organizationId: org.id, entityType: 'lead', key: 'template_dependency', label: 'Dependency', type: 'text' } })
    const template = (await request('/templates', { method: 'POST', values: input({ name: 'Private dependency', bodyHtml: '{{lead.custom.template_dependency}}' }) })).body.data.template
    for (const values of [{ archived: true }, { type: 'number' }]) {
      const denied = await request(`/custom-fields/${def.id}`, { method: 'PATCH', user: 1, values })
      expect(denied.status).toBe(409); expect(denied.body.error.code).toBe('FIELD_IN_TEMPLATE')
      expect(JSON.stringify(denied.body)).not.toContain(template.name)
    }
    expect((await request(`/custom-fields/${def.id}`, { method: 'DELETE', user: 1 })).status).toBe(409)
    await request(`/templates/${template.id}`, { method: 'PATCH', values: { archived: true, expectedVersion: template.version } })
    expect((await request(`/custom-fields/${def.id}`, { method: 'DELETE' })).status).toBe(409)
    await request(`/templates/${template.id}`, { method: 'PATCH', values: { bodyHtml: '<p>Reference removed</p>', expectedVersion: template.version + 1 } })
    expect((await request(`/custom-fields/${def.id}`, { method: 'DELETE' })).status).toBe(204)
  })
  it.skipIf(!process.env.PLAYWRIGHT_MODULE)('verifies the library in Chrome through real HTTP and Postgres', async () => {
    const { verifyTemplateLibrary } = await import('../../../frontend/test/templates.browser.mjs')
    const summary = { id: org.id, name: org.name, slug: org.slug, plan: 'growth', role: 'owner', permissions: permissionsFor('owner') }
    const organization = { ...summary, timezone: 'Asia/Kolkata', country: 'IN', currency: 'INR', locale: 'en-IN', logoUrl: null, seatSelectionRequired: false, trialActive: false, trialEndsAt: null, unreadNotificationCount: 0, entitlements: { features: ['files', 'customFields', 'emailSync'], limits: { users: null, records: null, pipelines: null, customFields: null, webForms: null, storageGb: 10 }, upgrades: {} }, usage: { users: 4, records: 0, pipelines: 1, storageBytes: 0, updatedAt: new Date().toISOString() } }
    const browserUser = (index, role) => ({ id: users[index].id, fullName: users[index].fullName, email: users[index].email, emailVerified: true, onboardingCompleted: true, termsUpToDate: true, twoFactorEnabled: false, avatarUrl: null, organization: { ...summary, role, permissions: permissionsFor(role) }, createdAt: new Date().toISOString() })
    await verifyTemplateLibrary({ base, organization, user: browserUser(0, 'owner'), accessToken: signAccessToken(users[0], org.id, sessions[0]).accessToken,
      viewer: { user: browserUser(3, 'viewer'), accessToken: signAccessToken(users[3], org.id, sessions[3]).accessToken },
      seedPages: () => prisma.emailTemplate.createMany({ data: Array.from({ length: 26 }, (_, i) => ({ organizationId: org.id, ownerId: users[0].id, name: `Pagination fixture ${i}`, subject: 'Page fixture', bodyHtml: '<p>Fixture</p>', bodyText: 'Fixture' })) }),
    })
    const saved = await prisma.emailTemplate.findFirst({ where: { organizationId: org.id, name: 'Browser SMS reply' } })
    expect(saved?.channel).toBe('sms'); expect(saved?.category).toBe('follow_up')
  }, 120000)
})
