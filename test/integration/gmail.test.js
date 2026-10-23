import crypto from 'node:crypto'
import express from 'express'
import cookieParser from 'cookie-parser'
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ provider: { wrapKey: vi.fn(), unwrapKey: vi.fn(), exchange: vi.fn(), identity: vi.fn(), refresh: vi.fn(), revoke: vi.fn(), verifyPush: vi.fn(), api: vi.fn() }, queue: vi.fn() }))
vi.mock('../../src/config/env.js', () => ({ env: {
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused', DB_POOL_MAX: 10,
  JWT_ACCESS_SECRET: 'gmail-fixture-only-012345678901234567890123456789', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test', JWT_ACCESS_EXPIRES_IN: '15m',
  DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', FRONTEND_URL: 'https://example.test',
  GMAIL_ENABLED: true, GMAIL_SYNC_ENABLED: true, GOOGLE_GMAIL_CLIENT_ID: 'fixture-client', GOOGLE_GMAIL_CLIENT_SECRET: 'fixture-secret', GOOGLE_GMAIL_REDIRECT_URI: 'https://example.test/api/integrations/gmail/callback', GMAIL_KMS_KEY_NAME: 'fixture-key',
} }))
vi.mock('../../src/integrations/gmail/provider.js', () => ({ provider: fixture.provider, oauthClient: () => ({
  generateCodeVerifierAsync: async () => ({ codeVerifier: 'fixture-verifier', codeChallenge: 'fixture-challenge' }),
  generateAuthUrl: (values) => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ ...values, scope: values.scope.join(' ') })}`,
}) }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue: fixture.queue }))
vi.mock('../../src/email/mailer.js', () => ({ sendEmail: vi.fn(), queueEmail: vi.fn() }))
vi.mock('../../src/storage/objectStore.js', () => ({ objectStore: { bytes: vi.fn() } }))

import { prisma } from '../../src/db/prisma.js'
import { gmailRoutes, emailRoutes, emailTemplateRoutes } from '../../src/routes/gmail.routes.js'
import { activityRoutes } from '../../src/routes/activity.routes.js'
import { errorHandler } from '../../src/middlewares/errorHandler.js'
import { signAccessToken } from '../../src/services/token.service.js'
import { notificationContext } from '../../src/services/notificationAccess.service.js'
import { sendQueued, syncMailbox, ingestCandidate, reconcileUnknown, accessToken } from '../../src/integrations/gmail/jobs.js'
import { acceptPush, purgeMessages } from '../../src/integrations/gmail/maintenance.js'
import { disableMemberMailboxes } from '../../src/integrations/gmail/hooks.js'
import { newEnvelope, seal } from '../../src/integrations/gmail/vault.js'

let org, other, users, sessions, lead, account, server, base, sends = 0
const inbox = new Map(), fullReads = []
const request = async (path, { method = 'GET', values, user = 0, tenant = org.id, headers = {}, redirect = 'follow' } = {}) => {
  const response = await fetch(base + path, { method, redirect, headers: { authorization: `Bearer ${signAccessToken(users[user], tenant, sessions[user]).accessToken}`, 'content-type': 'application/json', ...headers }, ...(values && { body: JSON.stringify(values) }) })
  return { status: response.status, headers: response.headers, data: response.status === 303 ? null : await response.json() }
}
const draft = () => ({ entityType: 'lead', entityId: lead.id, to: 'customer@example.test', subject: 'Hello {{firstName}}', bodyHtml: '<p>Hello <strong>{{name}}</strong></p>', attachmentFileIds: [] })
function apiResponse(_token, path, options = {}) {
  if (path === 'profile') return { historyId: '10000000000000000001' }
  if (path === 'history') return { historyId: '10000000000000000002', history: [] }
  if (path === 'messages/send') { sends++; return { id: `sent-${sends}`, threadId: `gm-thread-${sends}` } }
  if (path === 'messages') return { messages: options.query?.q?.includes('rfc822msgid:') ? [{ id: 'resolved-send', threadId: 'resolved-thread' }] : [...inbox.keys()].map((id) => ({ id })) }
  const id = decodeURIComponent(path.slice('messages/'.length)), item = inbox.get(id)
  if (item) { if (options.query?.format === 'full') fullReads.push(id); return item }
  throw new Error('Unexpected synthetic provider route')
}
async function connect() {
  const started = await request('/integrations/gmail/oauth/start', { method: 'POST', values: { shareWithTeam: true, consentVersion: '2026-10-23-team-history-v1', returnTo: `/app/leads/${lead.id}`, backfillDays: 0 } })
  expect(started.status).toBe(200)
  const state = new URL(started.data.data.url).searchParams.get('state'), cookie = started.headers.get('set-cookie').split(';')[0]
  const result = await request(`/integrations/gmail/callback?state=${state}&code=fixture-code`, { headers: { cookie }, redirect: 'manual' })
  expect(result.status).toBe(303); expect(result.headers.get('location')).toContain('gmail=connected')
  return { state, cookie }
}
function incoming(id, { from = 'customer@example.test', to = 'rep@example.test', references = '', messageId = `<${id}@example.test>` } = {}) {
  const at = new Date(Date.now() + 1000)
  return { id, threadId: 'incoming-thread', labelIds: ['INBOX'], internalDate: String(at.getTime()), sizeEstimate: 200,
    payload: { mimeType: 'text/html', headers: [{ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: 'Reply' }, { name: 'Message-ID', value: messageId }, { name: 'Date', value: at.toUTCString() }, { name: 'In-Reply-To', value: references }], body: { data: Buffer.from('<p>Interested<img src="https://pixel.invalid"><script>bad()</script></p>').toString('base64url') } } }
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('Gmail HTTP, queue and real database integration', () => {
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && process.env.TEST_DATABASE_DISPOSABLE !== 'true') throw new Error('Disposable test database required')
    users = await Promise.all(['owner', 'viewer', 'sales_rep'].map((role) => prisma.user.create({ data: { fullName: role === 'owner' ? 'Rep' : role, email: `${role}-${crypto.randomUUID()}@example.test`, passwordHash: 'cannot-login', emailVerifiedAt: new Date() } })))
    sessions = users.map(() => crypto.randomUUID())
    await prisma.refreshToken.createMany({ data: users.map((u, i) => ({ userId: u.id, sessionId: sessions[i], tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + 86400000) })) })
    org = await prisma.organization.create({ data: { name: 'Gmail fixture', slug: `gmail-${crypto.randomUUID()}`, plan: 'growth', createdById: users[0].id } })
    other = await prisma.organization.create({ data: { name: 'Other tenant', slug: `gmail-${crypto.randomUUID()}`, plan: 'growth', createdById: users[0].id } })
    await prisma.membership.createMany({ data: users.map((u, i) => ({ organizationId: org.id, userId: u.id, role: ['owner', 'viewer', 'sales_rep'][i] })) })
    await prisma.membership.create({ data: { organizationId: other.id, userId: users[0].id, role: 'owner' } })
    lead = await prisma.lead.create({ data: { organizationId: org.id, firstName: 'Customer', displayName: 'Customer', ownerId: users[0].id, emails: [{ value: 'customer@example.test', primary: true }], primaryEmail: 'customer@example.test' } })
    await prisma.leadEmail.create({ data: { organizationId: org.id, leadId: lead.id, email: 'customer@example.test' } })
    const app = express(); app.use(express.json()); app.use(cookieParser()); app.use('/integrations/gmail', gmailRoutes); app.use('/emails', emailRoutes); app.use('/email-templates', emailTemplateRoutes); app.use('/activities', activityRoutes); app.use(errorHandler)
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) }); base = `http://127.0.0.1:${server.address().port}`
  })
  beforeEach(() => {
    vi.clearAllMocks(); inbox.clear(); fullReads.length = 0
    fixture.queue.mockResolvedValue('queued')
    fixture.provider.wrapKey.mockImplementation(async (key) => ({ wrappedKey: key.toString('base64'), keyVersion: 'fixture-only' }))
    fixture.provider.unwrapKey.mockImplementation(async (row) => Buffer.from(row.wrappedKey, 'base64'))
    fixture.provider.exchange.mockResolvedValue({ refresh_token: 'fixture-refresh-token', id_token: 'fixture-id-token', scope: 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly' })
    fixture.provider.identity.mockResolvedValue({ subject: 'fixture-google-subject', email: 'rep@example.test' })
    fixture.provider.refresh.mockResolvedValue({ access_token: 'fixture-access-token', expiry_date: Date.now() + 3600000 })
    fixture.provider.api.mockImplementation(async (...args) => apiResponse(...args))
  })
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (org) {
      await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } })
    }
    if (users) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } })
    await prisma.$disconnect()
  })
  it('rejects absent consent, viewers, bad browser binding, replay and expired OAuth state', async () => {
    expect((await request('/integrations/gmail/oauth/start', { method: 'POST', values: {} })).status).toBe(400)
    expect((await request('/integrations/gmail/oauth/start', { method: 'POST', user: 1, values: { shareWithTeam: true, consentVersion: '2026-10-23-team-history-v1' } })).status).toBe(403)
    const started = await request('/integrations/gmail/oauth/start', { method: 'POST', values: { shareWithTeam: true, consentVersion: '2026-10-23-team-history-v1' } })
    const state = new URL(started.data.data.url).searchParams.get('state')
    const bad = await request(`/integrations/gmail/callback?state=${state}&code=fixture`, { headers: { cookie: 'techsync_gmail_oauth=wrong' }, redirect: 'manual' })
    expect(bad.headers.get('location')).toContain('GMAIL_OAUTH_INVALID'); expect(fixture.provider.exchange).not.toHaveBeenCalled()
    const cookie = started.headers.get('set-cookie').split(';')[0]
    await prisma.gmailOAuthState.updateMany({ where: { organizationId: org.id }, data: { expiresAt: new Date(0) } })
    const expired = await request(`/integrations/gmail/callback?state=${state}&code=fixture`, { headers: { cookie }, redirect: 'manual' })
    expect(expired.headers.get('location')).toContain('GMAIL_OAUTH_EXPIRED')
    const connected = await connect()
    const replay = await request(`/integrations/gmail/callback?state=${connected.state}&code=fixture`, { headers: { cookie: connected.cookie }, redirect: 'manual' })
    expect(replay.headers.get('location')).toContain('GMAIL_OAUTH_EXPIRED')
    account = await prisma.gmailAccount.findFirst({ where: { organizationId: org.id } })
    expect(account.credentialEnc).not.toContain('fixture-refresh-token')
    expect(JSON.stringify((await request('/integrations/gmail/me')).data)).not.toMatch(/credentialEnc|wrappedKey|refresh.token/i)
  })
  it('handles Google denial, missing scopes and cross-workspace identity binding without disclosing credentials', async () => {
    async function attempt({ tenant, error } = {}) {
      const started = await request('/integrations/gmail/oauth/start', { method: 'POST', ...(tenant && { tenant }), values: { shareWithTeam: true, consentVersion: '2026-10-23-team-history-v1' } })
      const state = new URL(started.data.data.url).searchParams.get('state'), cookie = started.headers.get('set-cookie').split(';')[0]
      return request(`/integrations/gmail/callback?state=${state}&${error ? 'error=access_denied' : 'code=fixture-code'}`, { headers: { cookie }, redirect: 'manual' })
    }
    const denied = await attempt({ error: true }); expect(denied.headers.get('location')).toContain('GMAIL_OAUTH_CANCELLED'); expect(fixture.provider.exchange).not.toHaveBeenCalled()
    fixture.provider.exchange.mockResolvedValueOnce({ refresh_token: 'fixture', id_token: 'fixture', scope: 'https://www.googleapis.com/auth/gmail.send' })
    expect((await attempt()).headers.get('location')).toContain('GMAIL_SCOPES_MISSING')
    const crossWorkspace = await attempt({ tenant: other.id })
    expect(crossWorkspace.headers.get('location')).toContain('GMAIL_ACCOUNT_UNAVAILABLE')
    expect(await prisma.gmailAccount.count({ where: { organizationId: other.id } })).toBe(0)
  })
  it('queues an immutable idempotent composition and logs only accepted Gmail sends', async () => {
    const key = crypto.randomUUID()
    const first = await request('/emails/send', { method: 'POST', values: draft(), headers: { 'idempotency-key': key } })
    expect(first.status).toBe(202); expect(first.data.data.message.status).toBe('queued')
    expect(await prisma.activity.count({ where: { organizationId: org.id, type: 'email' } })).toBe(0)
    expect((await request('/emails/send', { method: 'POST', values: draft(), headers: { 'idempotency-key': key } })).data.data.message.id).toBe(first.data.data.message.id)
    expect((await request('/emails/send', { method: 'POST', values: { ...draft(), subject: 'Changed' }, headers: { 'idempotency-key': key } })).status).toBe(409)
    const data = { organizationId: org.id, messageId: first.data.data.message.id }
    await sendQueued(data); await sendQueued(data)
    expect(fixture.provider.api.mock.calls.filter((c) => c[1] === 'messages/send')).toHaveLength(1)
    const message = await prisma.emailMessage.findUnique({ where: { id: data.messageId } })
    expect(message.status).toBe('provider_accepted')
    expect((await prisma.lead.findUnique({ where: { id: lead.id } })).status).toBe('contacted')
    const activity = await prisma.activity.findUnique({ where: { id: message.activityId } })
    expect(activity.body).toBeNull(); expect(activity.meta.emailMessageId).toBe(message.id)
    expect((await request(`/activities/${activity.id}`, { method: 'PATCH', values: { body: 'Tampered' } })).status).toBe(403)
    const received = await request(`/emails/${message.id}`)
    expect(received.data.data.message.content.subject).toBe('Hello Customer')
    expect(JSON.stringify(fixture.queue.mock.calls)).not.toContain('bodyHtml')
  })
  it('enforces tenant, record ownership, viewer and recipient restrictions', async () => {
    const message = await prisma.emailMessage.findFirst({ where: { organizationId: org.id } })
    expect((await request(`/emails/${message.id}`, { tenant: other.id })).status).toBe(404)
    expect((await request(`/emails/${message.id}`, { user: 2 })).status).toBe(404)
    expect((await request(`/emails/${message.id}`, { user: 1 })).status).toBe(200)
    expect((await request('/emails/send', { method: 'POST', user: 1, values: draft(), headers: { 'idempotency-key': crypto.randomUUID() } })).status).toBe(403)
    expect((await request('/emails/send', { method: 'POST', values: { ...draft(), to: 'unrelated@example.test' }, headers: { 'idempotency-key': crypto.randomUUID() } })).status).toBe(422)
  })
  it('ingests matched replies once, skips unrelated bodies and preserves a thread', async () => {
    const sent = await prisma.emailMessage.findFirst({ where: { organizationId: org.id, direction: 'outbound' } })
    inbox.set('reply-1', incoming('reply-1', { references: sent.rfcMessageId }))
    inbox.set('unrelated', incoming('unrelated', { from: 'unknown@example.test', references: '' }))
    const stateWhere = { organizationId: org.id, accountId: account.id }
    await prisma.gmailSyncState.updateMany({ where: stateWhere, data: { nextAttemptAt: new Date(), searchFrom: new Date(Date.now() - 60000) } })
    await syncMailbox(stateWhere); await syncMailbox(stateWhere)
    const replies = await prisma.emailMessage.findMany({ where: { organizationId: org.id, direction: 'inbound' } })
    expect(replies).toHaveLength(1); expect(replies[0].threadId).toBe(sent.threadId)
    expect(fullReads).toEqual(['reply-1'])
    expect((await request(`/emails/${replies[0].id}`)).data.data.message.content.html).toBe('<p>Interested</p>')
    expect((await prisma.gmailSyncState.findFirst({ where: stateWhere })).historyId).toBe('10000000000000000002')
  })
  it('does not import a body when an unbound email matches duplicate leads', async () => {
    const duplicate = await prisma.lead.create({ data: { organizationId: org.id, displayName: 'Duplicate', ownerId: users[2].id } })
    await prisma.leadEmail.create({ data: { organizationId: org.id, leadId: duplicate.id, email: 'customer@example.test' } })
    inbox.set('ambiguous', incoming('ambiguous'))
    const ctx = await notificationContext(org.id, users[0].id), row = await prisma.gmailAccount.findUnique({ where: { id: account.id } })
    expect(await ingestCandidate(row, ctx, 'fixture-token', 'ambiguous')).toBe(false); expect(fullReads).toEqual([])
    await prisma.lead.delete({ where: { id: duplicate.id } })
  })
  it('preserves uncertain send state and reconciles without sending a duplicate', async () => {
    const queued = await request('/emails/send', { method: 'POST', values: draft(), headers: { 'idempotency-key': crypto.randomUUID() } })
    const id = queued.data.data.message.id
    fixture.provider.api.mockImplementation(async (token, path, options) => { if (path === 'messages/send') throw Object.assign(new Error('synthetic timeout'), { code: 'EMAIL_SEND_UNKNOWN', uncertain: true }); return apiResponse(token, path, options) })
    await sendQueued({ organizationId: org.id, messageId: id }); await sendQueued({ organizationId: org.id, messageId: id })
    let row = await prisma.emailMessage.findUnique({ where: { id } }); expect(row.status).toBe('unknown')
    await reconcileUnknown(row)
    row = await prisma.emailMessage.findUnique({ where: { id } }); expect(row.status).toBe('provider_accepted')
    expect(fixture.provider.api.mock.calls.filter((c) => c[1] === 'messages/send')).toHaveLength(1)
  })
  it('requires reconnect on rejected refresh and never queues a viewer connection', async () => {
    account = await prisma.gmailAccount.update({ where: { id: account.id }, data: { generation: { increment: 1 } } })
    fixture.provider.refresh.mockRejectedValueOnce(Object.assign(new Error('synthetic revoked token'), { code: 'GMAIL_RECONNECT_REQUIRED' }))
    await expect(accessToken(account)).rejects.toMatchObject({ code: 'GMAIL_RECONNECT_REQUIRED' })
    expect((await prisma.gmailAccount.findUnique({ where: { id: account.id } })).status).toBe('reconnect_required')
    await prisma.gmailAccount.update({ where: { id: account.id }, data: { status: 'connected' } })
  })
  it('supports personal/shared templates without leaking another tenant templates', async () => {
    const saved = await request('/email-templates', { method: 'POST', values: { name: 'Intro', subject: 'Hello {{name}}', bodyHtml: '<p>Hello</p><script>bad()</script>', shared: true } })
    expect(saved.status).toBe(201); expect(saved.data.data.template.bodyHtml).toBe('<p>Hello</p>')
    expect((await request('/email-templates', { user: 1 })).data.data.items).toHaveLength(1)
    expect((await request('/email-templates', { tenant: other.id })).data.data.items).toEqual([])
    expect((await request(`/email-templates/${saved.data.data.template.id}`, { method: 'DELETE', user: 2 })).status).toBe(404)
  })
  it('keeps stored refresh credentials when Google omits a new refresh token on reconnect', async () => {
    const before = await prisma.gmailAccount.findUnique({ where: { id: account.id } })
    const checkpoint = new Date(Date.now() - 3600000)
    await prisma.gmailSyncState.updateMany({ where: { accountId: account.id }, data: { searchFrom: checkpoint } })
    fixture.provider.exchange.mockResolvedValueOnce({ id_token: 'fixture-id-token', scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly' })
    await connect()
    account = await prisma.gmailAccount.findUnique({ where: { id: account.id } })
    expect(account.id).toBe(before.id); expect(account.credentialEnc).not.toBeNull()
    expect(account.syncFrom).toEqual(before.syncFrom)
    expect((await prisma.gmailSyncState.findFirst({ where: { accountId: account.id } })).searchFrom.getTime()).toBe(checkpoint.getTime())
    const { open } = await import('../../src/integrations/gmail/vault.js')
    expect(open(Buffer.from(account.wrappedKey, 'base64'), account, 'credentials', account.credentialEnc).refreshToken).toBe('fixture-refresh-token')
  })
  it('persists authenticated push work even when the queue is unavailable', async () => {
    const { acceptPush } = await import('../../src/integrations/gmail/maintenance.js')
    fixture.provider.verifyPush.mockRejectedValueOnce(Object.assign(new Error('fixture invalid JWT'), { code: 'GMAIL_PUSH_INVALID' }))
    const body = { message: { data: Buffer.from(JSON.stringify({ emailAddress: account.email, historyId: '99999999999999999999' })).toString('base64') } }
    await expect(acceptPush('Bearer wrong', body)).rejects.toMatchObject({ code: 'GMAIL_PUSH_INVALID' })
    fixture.queue.mockRejectedValueOnce(new Error('fixture queue unavailable'))
    await acceptPush('Bearer valid-fixture', body)
    expect((await prisma.gmailSyncState.findFirst({ where: { accountId: account.id } })).pendingHistoryId).toBe('99999999999999999999')
  })
  it('marks history expiry as a coverage gap and backs off quota failures without blind sends', async () => {
    await prisma.gmailSyncState.updateMany({ where: { accountId: account.id }, data: { historyId: 'expired-fixture', lastSyncedAt: new Date(), scanState: (await import('../../src/db/prisma.js')).DB_NULL } })
    fixture.provider.api.mockImplementation(async (token, path, options) => { if (path === 'history') throw Object.assign(new Error('fixture history expired'), { code: 'GMAIL_HISTORY_EXPIRED' }); return apiResponse(token, path, options) })
    await syncMailbox({ organizationId: org.id, accountId: account.id })
    expect((await prisma.gmailSyncState.findFirst({ where: { accountId: account.id } })).coverageGap).toBe(true)
    const queued = await request('/emails/send', { method: 'POST', values: draft(), headers: { 'idempotency-key': crypto.randomUUID() } })
    fixture.provider.api.mockImplementation(async (token, path, options) => { if (path === 'messages/send') throw Object.assign(new Error('fixture quota'), { code: 'GMAIL_RATE_LIMITED', providerStatus: 429, retryAfter: 120 }); return apiResponse(token, path, options) })
    await sendQueued({ organizationId: org.id, messageId: queued.data.data.message.id })
    const row = await prisma.emailMessage.findUnique({ where: { id: queued.data.data.message.id } })
    expect(row.status).toBe('queued'); expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 100000)
  })
  it('paginates message history and relinks converted conversations without duplicating email activity', async () => {
    const row = await prisma.emailMessage.findFirst({ where: { organizationId: org.id, direction: 'inbound' } })
    const page = await request(`/emails/threads/${row.threadId}/messages?limit=1`)
    expect(page.data.data.items).toHaveLength(1); expect(page.data.data.nextCursor).toBeTruthy()
    const next = await request(`/emails/threads/${row.threadId}/messages?limit=1&cursor=${encodeURIComponent(page.data.data.nextCursor)}`)
    expect(next.data.data.items[0].id).not.toBe(page.data.data.items[0].id)
    const contact = await prisma.contact.create({ data: { organizationId: org.id, displayName: 'Converted fixture', ownerId: users[0].id, emails: [{ value: 'customer@example.test' }] } })
    const { runConversionHooks } = await import('../../src/lib/merge.js')
    await prisma.$transaction((tx) => runConversionHooks(tx, { orgId: org.id }, { leadId: lead.id, contactId: contact.id }))
    expect(await prisma.emailRecordLink.count({ where: { organizationId: org.id, threadId: row.threadId, contactId: contact.id } })).toBe(1)
    const before = await prisma.activity.count({ where: { organizationId: org.id } })
    await prisma.$transaction((tx) => runConversionHooks(tx, { orgId: org.id }, { leadId: lead.id, contactId: contact.id }))
    expect(await prisma.activity.count({ where: { organizationId: org.id } })).toBe(before)
  })
  it('deduplicates one canonical message across two permitted employee mailboxes', async () => {
    await prisma.membership.update({ where: { organizationId_userId: { organizationId: org.id, userId: users[2].id } }, data: { role: 'admin' } })
    const { seal } = await import('../../src/integrations/gmail/vault.js')
    const id = crypto.randomUUID(), key = Buffer.from(account.wrappedKey, 'base64'), identity = { id, organizationId: org.id }
    const second = await prisma.gmailAccount.create({ data: { ...identity, userId: users[2].id, googleSubject: 'second-fixture-subject', email: 'second-rep@example.test', scopes: account.scopes, status: 'connected', credentialEnc: seal(key, identity, 'credentials', { refreshToken: 'second-fixture-refresh' }), wrappedKey: account.wrappedKey, keyVersion: account.keyVersion, consentVersion: account.consentVersion, consentAt: new Date(), syncFrom: new Date(Date.now() - 60000) } })
    await prisma.gmailSyncState.create({ data: { organizationId: org.id, accountId: id, searchFrom: second.syncFrom } })
    inbox.set('shared-copy', incoming('shared-copy', { to: 'rep@example.test, second-rep@example.test' }))
    const firstCtx = await notificationContext(org.id, users[0].id), secondCtx = await notificationContext(org.id, users[2].id)
    const before = await prisma.activity.count({ where: { organizationId: org.id, type: 'email' } })
    await ingestCandidate(account, firstCtx, 'fixture', 'shared-copy'); await ingestCandidate(second, secondCtx, 'fixture', 'shared-copy')
    const copies = await prisma.emailMailboxCopy.findMany({ where: { organizationId: org.id, gmailMessageId: 'shared-copy' } })
    expect(copies).toHaveLength(2); expect(copies[0].messageId).toBe(copies[1].messageId)
    expect(await prisma.activity.count({ where: { organizationId: org.id, type: 'email' } })).toBe(before + 1)
    await prisma.membership.update({ where: { organizationId_userId: { organizationId: org.id, userId: users[2].id } }, data: { role: 'sales_rep' } })
  })
  it('keeps the initial import cap after a page was committed before a worker restart', async () => {
    const canonical = await prisma.emailMessage.findFirst({ where: { organizationId: org.id } })
    await prisma.emailMailboxCopy.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ organizationId: org.id, accountId: account.id, messageId: canonical.id, gmailMessageId: `cap-fixture-${i}`, gmailThreadId: 'cap-fixture' })) })
    await prisma.gmailSyncState.updateMany({ where: { organizationId: org.id, accountId: account.id }, data: { scanState: { initial: true, imported: 0, started: Date.now() - 60000, from: Date.now() - 60000, upper: Date.now() + 1000, baselineId: '10000000000000000002', cursor: null, pageToken: null } } })
    await syncMailbox({ organizationId: org.id, accountId: account.id })
    expect(fixture.provider.api.mock.calls.filter((call) => call[1] === 'messages')).toHaveLength(0)
    expect(fullReads).toEqual([])
    expect((await prisma.gmailSyncState.findFirst({ where: { accountId: account.id } })).scanState).toBeNull()
    await prisma.emailMailboxCopy.deleteMany({ where: { organizationId: org.id, accountId: account.id, gmailMessageId: { startsWith: 'cap-fixture-' } } })
  })
  it('marks only an authenticated, correlated structured Google hard bounce and suppresses its recipient', async () => {
    const queued = await request('/emails/send', { method: 'POST', values: draft(), headers: { 'idempotency-key': crypto.randomUUID() } })
    await sendQueued({ organizationId: org.id, messageId: queued.data.data.message.id })
    const message = await prisma.emailMessage.findUnique({ where: { id: queued.data.data.message.id } })
    const report = { payload: { mimeType: 'multipart/report', headers: [{ name: 'From', value: 'mailer-daemon@googlemail.com' }, { name: 'To', value: account.email }, { name: 'In-Reply-To', value: message.rfcMessageId }, { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@googlemail.com;' }], parts: [{ mimeType: 'message/delivery-status', body: { data: Buffer.from('Final-Recipient: rfc822; customer@example.test\nAction: failed\nStatus: 5.1.1').toString('base64url') } }] }, sizeEstimate: 500, labelIds: ['INBOX'] }
    fixture.provider.api.mockImplementation(async (_token, path) => path === 'messages' ? { messages: [{ id: 'known-dsn' }] } : report)
    const { checkDeliveryReports } = await import('../../src/integrations/gmail/bounces.js')
    await checkDeliveryReports(message); await checkDeliveryReports(message)
    expect((await prisma.emailMessage.findUnique({ where: { id: message.id } })).status).toBe('bounced')
    expect(await prisma.emailSuppression.count({ where: { organizationId: org.id, recipientKey: 'customer@example.test' } })).toBe(1)
    expect((await request('/emails/send', { method: 'POST', values: draft(), headers: { 'idempotency-key': crypto.randomUUID() } })).data.error.code).toBe('EMAIL_SUPPRESSED')
    await prisma.emailSuppression.deleteMany({ where: { organizationId: org.id } })
  })
  it('makes departure revoke credentials atomically and purges expired provider activity content', async () => {
    await prisma.$transaction(async (tx) => { await disableMemberMailboxes(tx, users[0].id, org.id) })
    expect((await prisma.gmailAccount.findUnique({ where: { id: account.id } })).credentialEnc).toBeNull()
    const message = await prisma.emailMessage.findFirst({ where: { organizationId: org.id, contentEnc: { not: null } } })
    await prisma.emailMessage.update({ where: { id: message.id }, data: { expiresAt: new Date(0) } })
    expect(await purgeMessages({ organizationId: org.id, expiresAt: { lte: new Date() } })).toBe(1)
    expect((await prisma.emailMessage.findUnique({ where: { id: message.id } })).contentEnc).toBeNull()
    expect(await prisma.activity.count({ where: { organizationId: org.id, id: message.activityId } })).toBe(0)
  })
})
