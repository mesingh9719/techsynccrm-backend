import crypto from 'node:crypto'
import express from 'express'
import cookieParser from 'cookie-parser'
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ queue: vi.fn(), env: {
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused', DB_POOL_MAX: 5,
  JWT_ACCESS_SECRET: 'google-workspace-fixture-only-01234567890123456789', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test', JWT_ACCESS_EXPIRES_IN: '15m',
  DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', FRONTEND_URL: 'https://example.test',
  GOOGLE_WORKSPACE_ENABLED: true, GOOGLE_WORKSPACE_CALENDAR_ENABLED: true, GOOGLE_WORKSPACE_DRIVE_ENABLED: true, GOOGLE_WORKSPACE_SHEETS_ENABLED: true,
  GOOGLE_WORKSPACE_CLIENT_ID: '123456789-fixture.apps.googleusercontent.com', GOOGLE_WORKSPACE_CLIENT_SECRET: 'fixture-secret', GOOGLE_WORKSPACE_PROJECT_NUMBER: '123456789',
  GOOGLE_WORKSPACE_REDIRECT_URI: 'https://example.test/api/google/oauth/callback', GOOGLE_WORKSPACE_TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  GOOGLE_GMAIL_CLIENT_ID: '987654321-gmail.apps.googleusercontent.com', GOOGLE_AUTH_CLIENT_ID: '987654321-login.apps.googleusercontent.com',
} }))
vi.mock('../../src/config/env.js', () => ({ env: fixture.env }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue: fixture.queue }))
vi.mock('../../src/email/mailer.js', () => ({ queueEmail: vi.fn() }))
import { prisma } from '../../src/db/prisma.js'
import { googleWorkspaceRoutes } from '../../src/routes/googleWorkspace.routes.js'
import { errorHandler } from '../../src/middlewares/errorHandler.js'
import { signAccessToken } from '../../src/services/token.service.js'
import { googleProvider } from '../../src/integrations/google/provider.js'
import { CONSENT_VERSION, SERVICE_SCOPES } from '../../src/integrations/google/config.js'
import { workspaceAccessToken, maintainGoogleWorkspace } from '../../src/integrations/google/jobs.js'
import { processGoogleRevocations } from '../../src/integrations/google/revocation.js'
import { workspaceContext, openValue } from '../../src/integrations/google/envelope.js'
import { disableMemberMailboxes } from '../../src/integrations/gmail/hooks.js'

let server, base, org, other, users, sessions, testIp = 0
const request = async (path, { user = 0, tenant, method = 'GET', body, cookie, anonymous = false } = {}) => {
  const response = await fetch(`${base}/api/google${path}`, { method, redirect: 'manual', headers: {
    ...(!anonymous && { authorization: `Bearer ${signAccessToken(users[user], tenant || org.id, sessions[user]).accessToken}` }),
    'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${testIp}`, ...(cookie && { cookie }),
  }, ...(body && { body: JSON.stringify(body) }) })
  return { status: response.status, headers: response.headers, data: response.status === 303 ? null : await response.json() }
}
async function start(service = 'calendar', options = {}) {
  const result = await request('/oauth/start', { ...options, method: 'POST', body: { service, consentVersion: CONSENT_VERSION, returnTo: options.returnTo } })
  expect(result.status, JSON.stringify(result.data)).toBe(200)
  const url = new URL(result.data.data.url)
  return { url, state: url.searchParams.get('state'), cookie: result.headers.get('set-cookie').split(';')[0] }
}
const finish = (started, suffix = 'code=fixture') => request(`/oauth/callback?state=${started.state}&${suffix}`, { cookie: started.cookie, anonymous: true })
async function connect(service = 'calendar', options = {}) {
  const result = await finish(await start(service, options))
  expect(result.headers.get('location')).toContain('google=connected')
  return prisma.googleConnection.findUnique({ where: { organizationId_userId: { organizationId: options.tenant || org.id, userId: users[options.user || 0].id } } })
}
describe.skipIf(!process.env.TEST_DATABASE_URL)('Google Workspace with real Postgres and mocked Google network', () => {
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && process.env.TEST_DATABASE_DISPOSABLE !== 'true') throw new Error('Disposable test database required')
    users = await Promise.all(['Owner', 'Employee', 'Other owner', 'Admin', 'Viewer'].map((fullName) => prisma.user.create({ data: { fullName, email: `${crypto.randomUUID()}@example.test`, emailVerifiedAt: new Date() } })))
    sessions = users.map(() => crypto.randomUUID())
    await prisma.refreshToken.createMany({ data: users.map((user, i) => ({ userId: user.id, sessionId: sessions[i], tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + 86400000) })) })
    org = await prisma.organization.create({ data: { name: 'Workspace foundation', slug: `gw-${crypto.randomUUID()}`, plan: 'growth', createdById: users[0].id } })
    other = await prisma.organization.create({ data: { name: 'Other customer', slug: `gw-${crypto.randomUUID()}`, plan: 'growth', createdById: users[2].id } })
    await prisma.membership.createMany({ data: [0, 1, 3, 4].map((i) => ({ organizationId: org.id, userId: users[i].id, role: ({ 0: 'owner', 1: 'sales_rep', 3: 'admin', 4: 'viewer' })[i] })).concat([
      { organizationId: other.id, userId: users[2].id, role: 'owner' }, { organizationId: other.id, userId: users[0].id, role: 'sales_rep' },
    ]) })
    vi.spyOn(googleProvider, 'exchange'); vi.spyOn(googleProvider, 'identity'); vi.spyOn(googleProvider, 'refresh'); vi.spyOn(googleProvider, 'revoke')
    const app = express(); app.set('trust proxy', 1); app.use(express.json(), cookieParser()); app.use('/api/google', googleWorkspaceRoutes); app.use(errorHandler)
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) }); base = `http://127.0.0.1:${server.address().port}`
  })
  beforeEach(async () => {
    vi.clearAllMocks(); testIp++
    fixture.env.GOOGLE_WORKSPACE_ENABLED = true; fixture.env.GOOGLE_WORKSPACE_CALENDAR_ENABLED = true
    await prisma.googleConnection.deleteMany({ where: { organizationId: { in: [org.id, other.id] } } })
    await prisma.googleWorkspaceOAuthState.deleteMany({ where: { organizationId: { in: [org.id, other.id] } } })
    await prisma.googleRevocation.deleteMany({ where: { organizationId: { in: [org.id, other.id] } } })
    await prisma.googleSyncLog.deleteMany({ where: { organizationId: { in: [org.id, other.id] } } })
    for (const row of [org, other]) await prisma.googleWorkspaceSettings.upsert({ where: { organizationId: row.id }, create: { organizationId: row.id, calendarEnabled: true, driveEnabled: true, sheetsEnabled: true }, update: { calendarEnabled: true, driveEnabled: true, sheetsEnabled: true } })
    await prisma.membership.updateMany({ where: { userId: users[1].id }, data: { role: 'sales_rep', status: 'active' } })
    await prisma.refreshToken.updateMany({ where: { userId: { in: users.map((u) => u.id) } }, data: { revokedAt: null, createdAt: new Date(), expiresAt: new Date(Date.now() + 86400000) } })
    googleProvider.exchange.mockResolvedValue({ refresh_token: 'fixture-refresh-secret', id_token: 'fixture-identity', scope: `openid email profile ${SERVICE_SCOPES.calendar} ${SERVICE_SCOPES.drive}` })
    googleProvider.identity.mockResolvedValue({ subject: 'shared-google-subject', email: 'work@example.test' })
    googleProvider.refresh.mockResolvedValue({ access_token: 'fixture-access-secret', expiry_date: Date.now() + 3600000 })
    googleProvider.revoke.mockResolvedValue(undefined); fixture.queue.mockResolvedValue('queued')
  })
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (org) {
      await prisma.googleRevocation.deleteMany({ where: { organizationId: { in: [org.id, other.id] } } })
      await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } })
    }
    if (users) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } })
    await prisma.$disconnect()
  })
  it('uses PKCE, offline consent, nonce, narrow scopes, a safe return and encrypted storage', async () => {
    const started = await start('calendar', { returnTo: '//evil.test' })
    expect(started.url.searchParams.get('scope')).toBe(`openid email profile ${SERVICE_SCOPES.calendar}`)
    expect(started.url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(started.url.searchParams.get('access_type')).toBe('offline')
    expect(started.url.searchParams.get('include_granted_scopes')).toBe('true')
    expect(started.url.searchParams.get('nonce')).toBeTruthy()
    expect((await finish(started)).headers.get('location')).toBe('https://example.test/app/settings/google?google=connected')
    const row = await prisma.googleConnection.findFirst({ where: { organizationId: org.id } })
    expect(JSON.stringify(row)).not.toContain('fixture-refresh-secret')
    expect(openValue(await googleProvider.unwrapKey(row), workspaceContext(row), 'credentials', row.credentialEnc).refreshToken).toBe('fixture-refresh-secret')
    const dto = await request('/connections/me')
    expect(dto.headers.get('cache-control')).toBe('no-store')
    expect(JSON.stringify(dto.data)).not.toMatch(/credentialEnc|wrappedKey|grantHash|clientFingerprint|fixture-refresh-secret|googleSubject/)
    expect(dto.data.data.services.map((s) => s.enabled)).toEqual([true, false, false])
  })
  it('rejects wrong-browser state, allows a valid retry, then rejects replay', async () => {
    const started = await start()
    expect((await finish({ ...started, cookie: 'techsync_google_workspace=wrong' })).headers.get('location')).toContain('GOOGLE_OAUTH_INVALID')
    expect((await finish(started)).headers.get('location')).toContain('google=connected')
    expect((await finish(started)).headers.get('location')).toContain('GOOGLE_OAUTH_EXPIRED')
    expect(googleProvider.exchange).toHaveBeenCalledTimes(1)
  })
  it('rejects expired state and an expired CRM session before exchanging a code', async () => {
    const expired = await start()
    await prisma.googleWorkspaceOAuthState.updateMany({ where: { organizationId: org.id }, data: { expiresAt: new Date(0) } })
    expect((await finish(expired)).headers.get('location')).toContain('GOOGLE_OAUTH_EXPIRED')
    const session = await start()
    await prisma.refreshToken.updateMany({ where: { userId: users[0].id }, data: { revokedAt: new Date() } })
    expect((await finish(session)).headers.get('location')).toContain('GOOGLE_SESSION_REQUIRED')
    expect(googleProvider.exchange).not.toHaveBeenCalled()
  })
  it('handles cancellation, partial consent, unexpected broad scopes and missing refresh tokens', async () => {
    expect((await finish(await start(), 'error=access_denied')).headers.get('location')).toContain('GOOGLE_OAUTH_CANCELLED')
    googleProvider.exchange.mockResolvedValueOnce({ refresh_token: 'fixture', scope: 'openid email profile' })
    expect((await finish(await start())).headers.get('location')).toContain('GOOGLE_SCOPES_MISSING')
    googleProvider.exchange.mockResolvedValueOnce({ refresh_token: 'fixture', scope: `${SERVICE_SCOPES.calendar} https://www.googleapis.com/auth/drive` })
    expect((await finish(await start())).headers.get('location')).toContain('GOOGLE_UNEXPECTED_SCOPES')
    googleProvider.exchange.mockResolvedValueOnce({ scope: SERVICE_SCOPES.calendar })
    expect((await finish(await start())).headers.get('location')).toContain('GOOGLE_RECONNECT_REQUIRED')
    expect(await prisma.googleConnection.count({ where: { organizationId: org.id } })).toBe(0)
  })
  it('preserves a same-profile refresh token during incremental consent and enables only the chosen service', async () => {
    let row = await connect('drive')
    googleProvider.exchange.mockResolvedValueOnce({ id_token: 'fixture', scope: SERVICE_SCOPES.drive })
    row = await connect('sheets')
    expect(row.generation).toBe(2)
    const dto = (await request('/connections/me')).data.data
    expect(dto.services.map((s) => s.enabled)).toEqual([false, true, true])
    expect(openValue(await googleProvider.unwrapKey(row), workspaceContext(row), 'credentials', row.credentialEnc).refreshToken).toBe('fixture-refresh-secret')
  })
  it('rechecks role changes during OAuth and rejects viewer connects and employee administration', async () => {
    expect((await request('/oauth/start', { user: 4, method: 'POST', body: { service: 'calendar', consentVersion: CONSENT_VERSION } })).status).toBe(403)
    expect((await request('/admin/connections', { user: 1 })).status).toBe(403)
    const started = await start('calendar', { user: 1 })
    await prisma.membership.updateMany({ where: { userId: users[1].id }, data: { role: 'viewer' } })
    expect((await finish(started)).headers.get('location')).toContain('GOOGLE_ACCESS_DENIED')
    expect(googleProvider.exchange).not.toHaveBeenCalled()
  })
  it('enforces tenant and owner boundaries and sanitizes the team connection list', async () => {
    const row = await connect()
    expect((await request(`/connections/${row.id}/disconnect`, { user: 1, method: 'POST' })).status).toBe(404)
    expect((await request(`/admin/connections/${row.id}/disconnect`, { user: 2, tenant: other.id, method: 'POST' })).status).toBe(404)
    const team = await request('/admin/connections?pageSize=2', { user: 3 })
    expect(team.status).toBe(200); expect(team.data.data.total).toBe(4); expect(team.data.data.items).toHaveLength(2)
    expect(JSON.stringify(team.data)).not.toMatch(/credentialEnc|wrappedKey|grantHash|clientFingerprint|grantedScopes/)
    expect((await request('/connections/me', { anonymous: true })).status).toBe(401)
  })
  it('rejects stale OAuth completions after another consent or detach', async () => {
    const stale = await start()
    await connect()
    expect((await finish(stale)).headers.get('location')).toContain('GOOGLE_ACCOUNT_CHANGED')
  })
  it('requires an explicit current consent version and invalidates access after a service is disabled', async () => {
    const row = await connect()
    expect((await request(`/connections/${row.id}/services/calendar`, { method: 'PATCH', body: { enabled: true, consentVersion: 'old' } })).status).toBe(400)
    expect(await workspaceAccessToken(org.id, row.id, 'calendar')).toBe('fixture-access-secret')
    expect((await request(`/connections/${row.id}/services/calendar`, { method: 'PATCH', body: { enabled: false } })).status).toBe(200)
    await expect(workspaceAccessToken(org.id, row.id, 'calendar')).rejects.toMatchObject({ code: 'GOOGLE_CONSENT_REQUIRED' })
    expect(googleProvider.revoke).not.toHaveBeenCalled()
  })
  it('uses a database refresh lease and rechecks membership even on token cache hits', async () => {
    const row = await connect('calendar', { user: 1 })
    let release
    googleProvider.refresh.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const first = workspaceAccessToken(org.id, row.id, 'calendar')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await expect(workspaceAccessToken(org.id, row.id, 'calendar')).rejects.toMatchObject({ code: 'GOOGLE_REFRESH_BUSY' })
    release({ access_token: 'fixture-access-secret', expiry_date: Date.now() + 3600000 }); await first
    await prisma.membership.updateMany({ where: { userId: users[1].id }, data: { role: 'viewer' } })
    await expect(workspaceAccessToken(org.id, row.id, 'calendar')).rejects.toMatchObject({ code: 'GOOGLE_ACCESS_DENIED' })
    expect(googleProvider.refresh).toHaveBeenCalledTimes(1)
  })
  it('does not publish an access token if disconnect wins a refresh race', async () => {
    const row = await connect()
    let release
    googleProvider.refresh.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const pending = workspaceAccessToken(org.id, row.id, 'calendar')
    const assertion = expect(pending).rejects.toMatchObject({ code: 'GOOGLE_RECONNECT_REQUIRED' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await request(`/connections/${row.id}/disconnect`, { method: 'POST' })
    release({ access_token: 'must-not-escape' }); await assertion
  })
  it('marks invalid grants as reconnect required without leaking Google exception details', async () => {
    const row = await connect()
    googleProvider.refresh.mockRejectedValueOnce(Object.assign(new Error('safe message'), { code: 'GOOGLE_RECONNECT_REQUIRED' }))
    await expect(workspaceAccessToken(org.id, row.id, 'calendar')).rejects.toThrow()
    expect((await request('/connections/me')).data.data.connection.status).toBe('reconnect_required')
    const logs = (await request('/admin/sync-logs')).data.data.items
    expect(logs.some((r) => r.action === 'reconnect_required' && r.reason === 'GOOGLE_RECONNECT_REQUIRED')).toBe(true)
  })
  it('turns off capabilities through tenant settings without silently restoring personal consent', async () => {
    await connect()
    expect((await request('/admin/settings', { method: 'PATCH', body: { calendarEnabled: false } })).status).toBe(200)
    expect((await request('/connections/me')).data.data.services[0].enabled).toBe(false)
    await request('/admin/settings', { method: 'PATCH', body: { calendarEnabled: true } })
    expect((await request('/connections/me')).data.data.services[0].enabled).toBe(false)
    expect((await request('/admin/settings', { method: 'PATCH', body: { arbitrary: true } })).status).toBe(400)
  })
  it('detaches one binding without revoking another workspace using the same Google project grant', async () => {
    const one = await connect(), two = await connect('calendar', { tenant: other.id })
    await request(`/connections/${one.id}/disconnect`, { method: 'POST' })
    expect(await prisma.googleRevocation.count({ where: { grantHash: one.grantHash } })).toBe(0)
    expect((await prisma.googleConnection.findUnique({ where: { id: two.id } })).status).toBe('connected')
    await request(`/connections/${two.id}/disconnect`, { tenant: other.id, method: 'POST' })
    expect(await prisma.googleRevocation.count({ where: { grantHash: one.grantHash } })).toBe(1)
    await processGoogleRevocations()
    expect(googleProvider.revoke).toHaveBeenCalledWith('fixture-refresh-secret')
  })
  it('requires confirmation and recent login for project revocation and invalidates all grant bindings first', async () => {
    const one = await connect(), two = await connect('calendar', { tenant: other.id })
    const path = `/connections/${one.id}/revoke-project-grant`
    expect((await request(path, { method: 'POST', body: {} })).status).toBe(400)
    await prisma.refreshToken.updateMany({ where: { userId: users[0].id }, data: { createdAt: new Date(Date.now() - 3600000) } })
    expect((await request(path, { method: 'POST', body: { confirmProjectRevocation: true } })).status).toBe(401)
    await prisma.refreshToken.updateMany({ where: { userId: users[0].id }, data: { createdAt: new Date() } })
    expect((await request(path, { method: 'POST', body: { confirmProjectRevocation: true } })).status).toBe(200)
    for (const id of [one.id, two.id]) expect(await prisma.googleConnection.findUnique({ where: { id } })).toMatchObject({ status: 'disconnected', credentialEnc: null, wrappedKey: null })
    expect(googleProvider.revoke).not.toHaveBeenCalled()
    expect((await finish(await start())).headers.get('location')).toContain('GOOGLE_REVOCATION_PENDING')
  })
  it('retains encrypted cleanup after deletion and retries while rollout is off', async () => {
    const row = await connect()
    await prisma.$transaction((tx) => disableMemberMailboxes(tx, users[0].id, org.id))
    await prisma.googleConnection.delete({ where: { id: row.id } })
    fixture.env.GOOGLE_WORKSPACE_ENABLED = false
    googleProvider.revoke.mockRejectedValueOnce(new Error('provider outage secret'))
    await maintainGoogleWorkspace()
    const pending = await prisma.googleRevocation.findUnique({ where: { grantHash: row.grantHash } })
    expect(pending.attempts).toBe(1); expect(pending.leaseToken).toBeNull()
    expect(JSON.stringify(pending)).not.toContain('provider outage')
    await processGoogleRevocations(new Date(Date.now() + 120000))
    expect(await prisma.googleRevocation.count({ where: { grantHash: row.grantHash } })).toBe(0)
  })
  it('keeps an outbox record after a hard tenant delete and rejects cross-tenant consent references', async () => {
    const row = await connect()
    await expect(prisma.googleServiceConsent.create({ data: { organizationId: other.id, connectionId: row.id, service: 'sheets', consentVersion: CONSENT_VERSION } })).rejects.toMatchObject({ code: 'P2003' })
    const disposable = await prisma.organization.create({ data: { name: 'Delete fixture', slug: `gw-${crypto.randomUUID()}`, createdById: users[0].id } })
    await prisma.googleRevocation.create({ data: { organizationId: disposable.id, connectionId: row.id, grantHash: `delete-${row.grantHash}`, credentialEnc: row.credentialEnc, wrappedKey: row.wrappedKey, keyVersion: row.keyVersion, expiresAt: new Date(Date.now() + 3600000) } })
    await prisma.organization.delete({ where: { id: disposable.id } })
    expect(await prisma.googleRevocation.count({ where: { organizationId: disposable.id } })).toBe(1)
    await prisma.googleRevocation.deleteMany({ where: { organizationId: disposable.id } })
  })
  it('fails closed while rollout or a service is disabled', async () => {
    fixture.env.GOOGLE_WORKSPACE_ENABLED = false
    expect((await request('/connections/me')).data.data.setup.ready).toBe(false)
    expect((await request('/oauth/start', { method: 'POST', body: { service: 'calendar', consentVersion: CONSENT_VERSION } })).status).toBe(503)
    fixture.env.GOOGLE_WORKSPACE_ENABLED = true; fixture.env.GOOGLE_WORKSPACE_CALENDAR_ENABLED = false
    expect((await request('/oauth/start', { method: 'POST', body: { service: 'calendar', consentVersion: CONSENT_VERSION } })).status).toBe(403)
  })
  it('rejects another Google subject and a client change during consent without replacing credentials', async () => {
    const row = await connect()
    googleProvider.identity.mockResolvedValueOnce({ subject: 'different-subject', email: 'other@example.test' })
    expect((await finish(await start())).headers.get('location')).toContain('GOOGLE_ACCOUNT_CHANGED')
    expect((await prisma.googleConnection.findUnique({ where: { id: row.id } })).credentialEnc).toBe(row.credentialEnc)
    const started = await start(), clientId = fixture.env.GOOGLE_WORKSPACE_CLIENT_ID
    try {
      fixture.env.GOOGLE_WORKSPACE_CLIENT_ID = '123456789-changed.apps.googleusercontent.com'
      expect((await finish(started)).headers.get('location')).toContain('GOOGLE_OAUTH_EXPIRED')
      const state = (await request('/connections/me')).data.data
      expect(state.services.every((s) => !s.enabled && !s.permissionGranted)).toBe(true)
    } finally { fixture.env.GOOGLE_WORKSPACE_CLIENT_ID = clientId }
  })
  it('maintenance detaches a connection after membership loss before contacting Google', async () => {
    const row = await connect('calendar', { user: 1 })
    await prisma.membership.updateMany({ where: { userId: users[1].id }, data: { status: 'deactivated' } })
    await maintainGoogleWorkspace()
    expect((await prisma.googleConnection.findUnique({ where: { id: row.id } })).status).toBe('disconnected')
    expect(googleProvider.refresh).not.toHaveBeenCalled()
    expect(await prisma.googleRevocation.count({ where: { grantHash: row.grantHash } })).toBe(1)
  })
})
