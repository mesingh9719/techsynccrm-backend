import crypto from 'node:crypto'
import express from 'express'
import cookieParser from 'cookie-parser'
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ provider: { wrapKey: vi.fn(), unwrapKey: vi.fn(), exchange: vi.fn(), identity: vi.fn(), refresh: vi.fn(), revoke: vi.fn(), api: vi.fn() }, queue: vi.fn() }))
vi.mock('../../src/config/env.js', () => ({ env: {
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused', DB_POOL_MAX: 5,
  JWT_ACCESS_SECRET: 'email-foundation-fixture-only-01234567890123456789', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test', JWT_ACCESS_EXPIRES_IN: '15m',
  DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', FRONTEND_URL: 'https://example.test',
  GMAIL_ENABLED: true, GMAIL_SYNC_ENABLED: true, GOOGLE_GMAIL_CLIENT_ID: 'fixture-client', GOOGLE_GMAIL_CLIENT_SECRET: 'fixture-secret', GOOGLE_GMAIL_REDIRECT_URI: 'https://example.test/api/email/connect/google/callback', GMAIL_KMS_KEY_NAME: 'fixture-key',
} }))
vi.mock('../../src/integrations/gmail/provider.js', () => ({ provider: fixture.provider, oauthClient: () => ({
  generateCodeVerifierAsync: async () => ({ codeVerifier: 'fixture-verifier', codeChallenge: 'fixture-challenge' }),
  generateAuthUrl: (options) => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ ...options, scope: options.scope.join(' ') })}`,
}) }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue: fixture.queue }))
vi.mock('../../src/email/mailer.js', () => ({ queueEmail: vi.fn() }))
vi.mock('../../src/storage/objectStore.js', () => ({ objectStore: { bytes: vi.fn() } }))

import { prisma } from '../../src/db/prisma.js'
import { emailFoundationRoutes } from '../../src/email-integration/routes.js'
import { errorHandler } from '../../src/middlewares/errorHandler.js'
import { signAccessToken } from '../../src/services/token.service.js'
import { accessToken, syncMailbox } from '../../src/integrations/gmail/jobs.js'
import { disableMemberMailboxes } from '../../src/integrations/gmail/hooks.js'
import { checkEmailConnections } from '../../src/email-integration/connectionHealth.js'
import { gmailMe, updateSettings } from '../../src/integrations/gmail/connection.js'
import { notificationContext } from '../../src/services/notificationAccess.service.js'
import { processRevocations } from '../../src/email-integration/revocation.js'

let server, base, org, other, users, sessions, testIp = 0
const request = async (path, { user = 0, tenant, method = 'GET', body, cookie } = {}) => {
  const response = await fetch(`${base}/api/email${path}`, { method, redirect: 'manual', headers: {
    authorization: `Bearer ${signAccessToken(users[user], tenant || org.id, sessions[user]).accessToken}`,
    'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${testIp}`, ...(cookie && { cookie }),
  }, ...(body && { body: JSON.stringify(body) }) })
  return { status: response.status, headers: response.headers, data: response.status === 303 ? null : await response.json() }
}
async function start(user = 0, tenant = org.id, returnTo = '/app/settings/email') {
  const result = await request(`/connect/google/start?returnTo=${encodeURIComponent(returnTo)}`, { user, tenant })
  expect(result.status).toBe(200)
  const url = new URL(result.data.data.url)
  return { url, state: url.searchParams.get('state'), cookie: result.headers.get('set-cookie').split(';')[0] }
}
async function finish(started, suffix = 'code=fixture') {
  return request(`/connect/google/callback?state=${started.state}&${suffix}`, { cookie: started.cookie })
}
async function connect(user = 0, tenant = org.id) {
  const started = await start(user, tenant), result = await finish(started)
  expect(result.headers.get('location')).toContain('gmail=connected')
  return prisma.gmailAccount.findFirst({ where: { organizationId: tenant, userId: users[user].id }, orderBy: { consentAt: 'desc' } })
}
describe.skipIf(!process.env.TEST_DATABASE_URL)('email foundation with real Postgres and mocked Google', () => {
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && process.env.TEST_DATABASE_DISPOSABLE !== 'true') throw new Error('Disposable test database required')
    users = await Promise.all(['Owner', 'Employee', 'Other owner', 'Admin'].map((fullName) => prisma.user.create({ data: { fullName, email: `${crypto.randomUUID()}@example.test`, emailVerifiedAt: new Date() } })))
    sessions = users.map(() => crypto.randomUUID())
    await prisma.refreshToken.createMany({ data: users.map((user, index) => ({ userId: user.id, sessionId: sessions[index], tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + 86400000) })) })
    org = await prisma.organization.create({ data: { name: 'Email foundation', slug: `ef-${crypto.randomUUID()}`, plan: 'growth', createdById: users[0].id } })
    other = await prisma.organization.create({ data: { name: 'Other customer', slug: `ef-${crypto.randomUUID()}`, plan: 'growth', createdById: users[2].id } })
    await prisma.membership.createMany({ data: [
      { organizationId: org.id, userId: users[0].id, role: 'owner' }, { organizationId: org.id, userId: users[1].id, role: 'sales_rep' }, { organizationId: org.id, userId: users[3].id, role: 'admin' },
      { organizationId: other.id, userId: users[2].id, role: 'owner' },
    ] })
    const app = express(); app.set('trust proxy', 1); app.use(express.json(), cookieParser()); app.use('/api/email', emailFoundationRoutes); app.use(errorHandler)
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  beforeEach(async () => {
    vi.clearAllMocks(); testIp++
    await prisma.gmailAccount.deleteMany({ where: { organizationId: { in: [org.id, other.id] } } })
    await prisma.emailTokenRevocation.deleteMany({ where: { organizationId: { in: [org.id, other.id] } } })
    await prisma.emailAuditLog.deleteMany({ where: { organizationId: { in: [org.id, other.id] } } })
    await prisma.tenantEmailSettings.deleteMany({ where: { organizationId: org.id } })
    fixture.provider.wrapKey.mockImplementation(async (key) => ({ wrappedKey: key.toString('base64'), keyVersion: 'fixture' }))
    fixture.provider.unwrapKey.mockImplementation(async (row) => Buffer.from(row.wrappedKey, 'base64'))
    fixture.provider.exchange.mockResolvedValue({ refresh_token: 'fixture-refresh-secret', id_token: 'fixture-identity', scope: 'openid email profile https://www.googleapis.com/auth/gmail.send' })
    fixture.provider.identity.mockResolvedValue({ subject: 'shared-google-subject', email: 'different-login@example.test', displayName: 'Work mailbox' })
    fixture.provider.refresh.mockResolvedValue({ access_token: 'fixture-access-secret', expiry_date: Date.now() + 3600000 })
    fixture.provider.revoke.mockResolvedValue(undefined)
    fixture.queue.mockResolvedValue('queued')
  })
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (org) await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } })
    if (users) await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } })
    await prisma.$disconnect()
  })
  it('connects with PKCE, offline access, login hint, incremental authorization and send-only permission', async () => {
    const started = await start(1)
    expect(started.url.searchParams.get('scope').split(' ')).toEqual(['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.send'])
    expect(started.url.searchParams.get('include_granted_scopes')).toBe('true')
    expect(started.url.searchParams.get('access_type')).toBe('offline'); expect(started.url.searchParams.get('prompt')).toBe('consent')
    expect(started.url.searchParams.get('login_hint')).toBe(users[1].email)
    expect(started.url.searchParams.get('code_challenge_method')).toBe('S256')
    const stored = await prisma.gmailOAuthState.findUnique({ where: { stateHash: crypto.createHash('sha256').update(started.state).digest('hex') } })
    expect(stored.verifierEnc).not.toContain('fixture-verifier'); expect(stored.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(600000)
    expect((await finish(started)).headers.get('location')).toContain('gmail=connected')
    const status = (await request('/accounts/me', { user: 1 })).data.data
    expect(status.account).toMatchObject({ status: 'CONNECTED', emailAddress: 'different-login@example.test' })
    expect(JSON.stringify(status)).not.toMatch(/secret|credentialEnc|wrappedKey|refreshToken|verifierEnc/)
    expect(fixture.queue).not.toHaveBeenCalledWith('gmail.sync', expect.anything())
    await syncMailbox({ organizationId: org.id, accountId: status.account.id })
    expect(fixture.provider.api).not.toHaveBeenCalled()
    expect((await finish(started)).headers.get('location')).toContain('GMAIL_OAUTH_EXPIRED')
  })
  it('does not start inbox sync when Google includes a previously granted read scope', async () => {
    fixture.provider.exchange.mockResolvedValueOnce({ refresh_token: 'fixture-refresh', id_token: 'fixture-identity', scope: 'openid email profile https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly' })
    const account = await connect(1)
    await syncMailbox({ organizationId: org.id, accountId: account.id })
    expect(fixture.provider.api).not.toHaveBeenCalled()
    expect(fixture.queue).not.toHaveBeenCalledWith('gmail.sync', expect.anything())
  })
  it('does not overwrite an administrator disconnect while OAuth exchange is in flight', async () => {
    const account = await connect(1), started = await start(1)
    let release, ready
    const gate = new Promise((resolve) => { release = resolve })
    const waiting = new Promise((resolve) => { ready = resolve })
    fixture.provider.unwrapKey.mockImplementationOnce(async (row) => { ready(); await gate; return Buffer.from(row.wrappedKey, 'base64') })
    const pending = finish(started)
    await waiting
    await request(`/admin/accounts/${account.id}/disconnect`, { method: 'POST' })
    release()
    expect((await pending).headers.get('location')).toContain('GMAIL_ACCOUNT_CHANGED')
    expect((await request('/accounts/me', { user: 1 })).data.data.account.status).toBe('DISCONNECTED')
  })
  it('handles denied consent, unchecked send scope and absent refresh token without creating a connection', async () => {
    expect((await finish(await start(), 'error=access_denied')).headers.get('location')).toContain('GMAIL_OAUTH_CANCELLED')
    expect(fixture.provider.exchange).not.toHaveBeenCalled()
    fixture.provider.exchange.mockResolvedValueOnce({ refresh_token: 'fixture', scope: 'openid email profile' })
    expect((await finish(await start())).headers.get('location')).toContain('GMAIL_SCOPES_MISSING')
    fixture.provider.exchange.mockResolvedValueOnce({ scope: 'https://www.googleapis.com/auth/gmail.send' })
    expect((await finish(await start())).headers.get('location')).toContain('GMAIL_RECONNECT_REQUIRED')
    expect(await prisma.gmailAccount.count({ where: { organizationId: org.id } })).toBe(0)
  })
  it('rejects expired, tampered and wrong-browser state and revoked originating sessions', async () => {
    const started = await start()
    expect((await finish({ ...started, state: `${started.state}tampered` })).headers.get('location')).toContain('GMAIL_OAUTH_EXPIRED')
    expect((await finish({ ...started, cookie: 'techsync_gmail_oauth=other-browser' })).headers.get('location')).toContain('GMAIL_OAUTH_INVALID')
    await prisma.gmailOAuthState.updateMany({ where: { organizationId: org.id, usedAt: null }, data: { expiresAt: new Date(0) } })
    expect((await finish(started)).headers.get('location')).toContain('GMAIL_OAUTH_EXPIRED')
    const fresh = await start()
    await prisma.refreshToken.updateMany({ where: { userId: users[0].id }, data: { revokedAt: new Date() } })
    expect((await finish(fresh)).headers.get('location')).toContain('GMAIL_OAUTH_EXPIRED')
    await prisma.refreshToken.updateMany({ where: { userId: users[0].id }, data: { revokedAt: null } })
    expect(fixture.provider.exchange).not.toHaveBeenCalled()
  })
  it('blocks duplicate teammates but allows the same Google identity in another tenant', async () => {
    await connect()
    expect((await finish(await start(1))).headers.get('location')).toContain('GMAIL_ACCOUNT_UNAVAILABLE')
    await connect(2, other.id)
    const team = (await request('/admin/team')).data.data
    expect(team.total).toBe(3); expect(team.items.map((row) => row.userId)).not.toContain(users[2].id)
    expect(team.summary.CONNECTED).toBe(1)
    expect((await request('/admin/team?status=DISCONNECTED')).data.data.total).toBe(2)
    expect((await request('/admin/team?q=Employee&pageSize=1')).data.data.items[0].fullName).toBe('Employee')
  })
  it('denies employee admin APIs and cross-tenant disconnect and rejects tenant overrides', async () => {
    const foreign = await connect(2, other.id), own = await connect(1)
    for (const path of ['/admin/team', '/admin/settings']) expect((await request(path, { user: 1 })).status).toBe(403)
    expect((await request('/admin/remind', { user: 1, method: 'POST', body: {} })).status).toBe(403)
    expect((await request('/admin/settings', { user: 1, method: 'PUT', body: { emailEnabled: false } })).status).toBe(403)
    expect((await request(`/admin/accounts/${foreign.id}/disconnect`, { method: 'POST' })).status).toBe(404)
    expect((await request(`/accounts/${foreign.id}/disconnect`, { user: 1, method: 'POST' })).status).toBe(404)
    expect((await request(`/accounts/${own.id}/disconnect`, { user: 0, tenant: other.id, method: 'POST' })).status).toBe(403)
    expect((await request(`/admin/team?tenantId=${other.id}`)).status).toBe(400)
    expect((await request('/admin/settings', { method: 'PUT', body: { organizationId: other.id, emailEnabled: false } })).status).toBe(400)
    expect(fixture.provider.revoke).not.toHaveBeenCalled()
  })
  it('disconnects self and admin targets, removes secrets, and audits the responsible actor', async () => {
    let account = await connect(1)
    expect((await request(`/accounts/${account.id}/disconnect`, { user: 1, method: 'POST' })).status).toBe(200)
    expect(fixture.provider.revoke).toHaveBeenCalledWith('fixture-refresh-secret')
    expect((await prisma.gmailAccount.findUnique({ where: { id: account.id } })).credentialEnc).toBeNull()
    expect((await request('/accounts/me', { user: 1 })).data.data.account.status).toBe('DISCONNECTED')
    account = await connect(1)
    expect((await request(`/admin/accounts/${account.id}/disconnect`, { user: 3, method: 'POST' })).status).toBe(200)
    expect(await prisma.emailAuditLog.count({ where: { organizationId: org.id, actorUserId: users[3].id, targetUserId: users[1].id, action: 'DISCONNECTED_BY_ADMIN' } })).toBe(1)
    await expect(accessToken(account)).rejects.toMatchObject({ code: 'GMAIL_NOT_CONNECTED' })
  })
  it('shares concurrent token refresh and marks invalid_grant once without retry loops', async () => {
    let account = await connect(1)
    const tokens = await Promise.all(Array.from({ length: 5 }, () => accessToken(account)))
    expect(new Set(tokens)).toEqual(new Set(['fixture-access-secret'])); expect(fixture.provider.refresh).toHaveBeenCalledTimes(1)
    account = await prisma.gmailAccount.update({ where: { id: account.id }, data: { generation: { increment: 1 } } })
    fixture.provider.refresh.mockRejectedValueOnce(Object.assign(new Error('safe-provider-error'), { code: 'GMAIL_RECONNECT_REQUIRED' }))
    await expect(accessToken(account)).rejects.toMatchObject({ code: 'GMAIL_RECONNECT_REQUIRED' })
    expect((await request('/accounts/me', { user: 1 })).data.data.account.status).toBe('NEEDS_RECONNECT')
    await expect(accessToken(account)).rejects.toMatchObject({ code: 'GMAIL_NOT_CONNECTED' })
    expect(fixture.provider.refresh).toHaveBeenCalledTimes(2)
    expect(await prisma.emailAuditLog.count({ where: { organizationId: org.id, action: 'NEEDS_RECONNECT' } })).toBe(1)
  })
  it('detects revoked send-only grants through worker health checks without reading mail', async () => {
    await connect(1)
    fixture.provider.refresh.mockRejectedValueOnce(Object.assign(new Error('revoked'), { code: 'GMAIL_RECONNECT_REQUIRED' }))
    await checkEmailConnections(new Date(), org.id)
    expect((await request('/accounts/me', { user: 1 })).data.data.account.status).toBe('NEEDS_RECONNECT')
    await checkEmailConnections(new Date(Date.now() + 86400000), org.id)
    expect(fixture.provider.refresh).toHaveBeenCalledTimes(1)
    expect(fixture.provider.api).not.toHaveBeenCalled()
  })
  it('rate limits reminders per member across concurrent requests and stays tenant-scoped', async () => {
    const calls = await Promise.all([request('/admin/remind', { method: 'POST', body: { userIds: [users[1].id, users[2].id] } }), request('/admin/remind', { method: 'POST', body: { userIds: [users[1].id] } })])
    expect(calls.reduce((sum, result) => sum + result.data.data.sent, 0)).toBe(1)
    expect(await prisma.emailAuditLog.count({ where: { organizationId: org.id, action: 'REMINDER_SENT', targetUserId: users[2].id } })).toBe(0)
    expect(await prisma.notification.count({ where: { organizationId: org.id, userId: users[1].id, title: 'Connect your Gmail' } })).toBe(1)
    expect((await request('/admin/remind', { method: 'POST', body: { userIds: [users[1].id] } })).data.data.sent).toBe(0)
  })
  it('saves sanitized settings, audits changes and blocks new connects when email is disabled', async () => {
    const result = await request('/admin/settings', { method: 'PUT', body: { emailEnabled: false, emailVisibility: 'OWNER_ONLY', defaultSignatureHtml: '<b>Team</b><script>steal()</script>', allowEmployeeCustomSignature: false } })
    expect(result.data.data.defaultSignatureHtml).toBe('<b>Team</b>')
    expect((await request('/connect/google/start', { user: 1 })).data.error.code).toBe('EMAIL_DISABLED')
    expect((await request('/accounts/me', { user: 1 })).data.data.settings.emailEnabled).toBe(false)
    expect(await prisma.emailAuditLog.count({ where: { organizationId: org.id, action: 'SETTINGS_UPDATED' } })).toBe(1)
    expect((await request('/admin/settings', { user: 2, tenant: other.id })).data.data.emailEnabled).toBe(true)
  })
  it('saves signature-only changes without resetting exclusions and enforces the workspace signature policy', async () => {
    await connect(1)
    const employee = await notificationContext(org.id, users[1].id)
    await updateSettings(employee, { excludedAddresses: ['private@example.test'], excludedDomains: ['internal.example.test'] })
    const result = await updateSettings(employee, { signatureHtml: '<p>Regards, Employee</p><script>steal()</script>' })
    expect(result.account.signatureHtml).toBe('<p>Regards, Employee</p>')
    expect(result.account.excludedAddresses).toEqual(['private@example.test'])
    expect(result.account.excludedDomains).toEqual(['internal.example.test'])
    await request('/admin/settings', { method: 'PUT', body: { allowEmployeeCustomSignature: false } })
    expect((await gmailMe(employee)).canCustomizeSignature).toBe(false)
    await expect(updateSettings(employee, { signatureHtml: '<p>Blocked</p>' })).rejects.toMatchObject({ code: 'EMAIL_SIGNATURE_MANAGED', statusCode: 403 })
    expect((await gmailMe(employee)).account.signatureHtml).toBe('<p>Regards, Employee</p>')
    // Privacy exclusions remain editable when personal signatures are managed.
    await updateSettings(employee, { excludedDomains: ['another.example.test'] })
    fixture.provider.identity.mockResolvedValue({ subject: 'owner-subject', email: 'owner-mailbox@example.test' })
    await connect(0)
    const owner = await notificationContext(org.id, users[0].id)
    expect((await gmailMe(owner)).canCustomizeSignature).toBe(true)
    expect((await updateSettings(owner, { signatureHtml: '<p>Owner</p>' })).account.signatureHtml).toBe('<p>Owner</p>')
  })
  it('atomically disables departed members, retries encrypted revocations and prevents reconnect until revocation finishes', async () => {
    const account = await connect(1)
    await prisma.$transaction((tx) => disableMemberMailboxes(tx, users[1].id, org.id))
    expect((await prisma.gmailAccount.findUnique({ where: { id: account.id } })).credentialEnc).toBeNull()
    const job = await prisma.emailTokenRevocation.findFirst({ where: { organizationId: org.id } })
    expect(job.credentialEnc).not.toContain('fixture-refresh-secret')
    expect((await finish(await start(1))).headers.get('location')).toContain('GMAIL_REVOCATION_PENDING')
    fixture.provider.revoke.mockRejectedValueOnce(new Error('fixture network failure'))
    await processRevocations(new Date(), { organizationId: org.id })
    expect(await prisma.emailTokenRevocation.count({ where: { organizationId: org.id } })).toBe(1)
    await processRevocations(new Date(Date.now() + 86400000), { organizationId: org.id })
    expect(await prisma.emailTokenRevocation.count({ where: { organizationId: org.id } })).toBe(0)
  })
})
