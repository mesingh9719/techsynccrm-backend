import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import express from 'express'
import cookieParser from 'cookie-parser'
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ exchange: vi.fn(), factor: vi.fn(), mail: vi.fn() }))
vi.mock('../../src/config/env.js', () => ({ env: {
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused', DB_POOL_MAX: 10,
  JWT_ACCESS_SECRET: 'google-signin-fixture-key-012345678901234567890', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test', JWT_ACCESS_EXPIRES_IN: '15m',
  DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', FRONTEND_URL: 'https://example.test', COOKIE_SAMESITE: 'lax', CORS_ORIGINS: ['https://example.test'],
  GOOGLE_AUTH_ENABLED: true, GOOGLE_AUTH_CLIENT_ID: 'fixture-client', GOOGLE_AUTH_CLIENT_SECRET: 'fixture-secret', GOOGLE_AUTH_REDIRECT_URI: 'https://example.test/api/auth/google/callback',
  REFRESH_TOKEN_TTL_DAYS: 7, REFRESH_TOKEN_REMEMBER_TTL_DAYS: 30, RATE_LIMIT_WINDOW_MS: 60000, AUTH_RATE_LIMIT_MAX: 1000,
  EMAIL_VERIFICATION_TTL_HOURS: 24, EMAIL_RESEND_COOLDOWN_SECONDS: 60, LOGIN_LOCKOUT_THRESHOLD: 10, LOGIN_LOCKOUT_MINUTES: 15,
} }))
vi.mock('../../src/services/googleIdentity.js', async (original) => ({ ...await original(), googleIdentity: { exchange: fixture.exchange } }))
vi.mock('../../src/services/twoFactor.service.js', async (original) => ({ ...await original(), verifySecondFactor: fixture.factor }))
vi.mock('../../src/email/mailer.js', () => ({ queueEmail: fixture.mail, sendEmail: vi.fn() }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue: vi.fn() }))
import authRoutes from '../../src/routes/auth.routes.js'
import { errorHandler } from '../../src/middlewares/errorHandler.js'
import { prisma } from '../../src/db/prisma.js'
import { encrypt, decrypt } from '../../src/lib/crypto.js'
import { verifyAccessToken } from '../../src/services/token.service.js'

let base, server, sequence = 0
const users = [], organizations = []
const identity = (overrides = {}) => ({ subject: crypto.randomUUID(), email: `google-${crypto.randomUUID()}@gmail.com`, fullName: 'Google fixture', authoritative: true, ...overrides })
const cookie = (response, name) => response.headers.getSetCookie().find((c) => c.startsWith(name + '='))?.split(';')[0]
async function request(path, { method = 'GET', values, cookies, origin } = {}) {
  const response = await fetch(base + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.${Math.floor(++sequence / 250)}.${sequence % 250 + 1}`, ...(cookies && { cookie: cookies }), ...(origin && { origin }) }, ...(values && { body: JSON.stringify(values) }) })
  const text = await response.text(); return { response, status: response.status, body: text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null }
}
async function begin(values = {}) {
  const start = await request('/google/start', { method: 'POST', values: { intent: 'signin', ...values } })
  expect(start.status).toBe(200)
  return { start, url: new URL(start.body.data.url), flowCookie: cookie(start.response, 'ts_google_flow') }
}
async function authorize(person, values = {}) {
  const start = await begin(values)
  fixture.exchange.mockResolvedValueOnce(person)
  const callback = await request(`/google/callback?state=${start.url.searchParams.get('state')}&code=fixture-${crypto.randomUUID()}`, { cookies: start.flowCookie })
  return { ...start, callback, resultCookie: cookie(callback.response, 'ts_google_result') }
}
async function localUser(overrides = {}) {
  const user = await prisma.user.create({ data: { email: `local-${crypto.randomUUID()}@gmail.com`, fullName: 'Existing fixture', passwordHash: await bcrypt.hash('Fixture123', 4), emailVerifiedAt: new Date(), ...overrides } })
  users.push(user.id); return user
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('Google sign-in and sign-up with real local database', () => {
  beforeAll(async () => {
    const target = new URL(process.env.TEST_DATABASE_URL)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && process.env.TEST_DATABASE_DISPOSABLE !== 'true') throw new Error('Disposable database required')
    const app = express(); app.set('trust proxy', 1); app.use(express.json(), cookieParser()); app.use('/api/auth', authRoutes); app.use(errorHandler)
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) }); base = `http://127.0.0.1:${server.address().port}/api/auth`
  })
  beforeEach(() => { vi.clearAllMocks(); fixture.mail.mockResolvedValue(undefined); fixture.factor.mockResolvedValue(true) })
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } })
    await prisma.user.deleteMany({ where: { OR: [{ id: { in: users } }, { email: { startsWith: 'google-' } }] } })
    await prisma.$disconnect()
  })
  it('exposes readiness without credentials and requires signup consent and trusted request origin', async () => {
    const config = await request('/google/config')
    expect(config.body.data.enabled).toBe(true); expect(JSON.stringify(config.body)).not.toMatch(/fixture-client|fixture-secret/)
    expect((await request('/google/start', { method: 'POST', values: { intent: 'signup' } })).status).toBe(400)
    expect((await request('/google/start', { method: 'POST', origin: 'https://evil.test', values: { intent: 'signin' } })).status).toBe(403)
    const start = await begin()
    expect(start.url.searchParams.get('scope').split(' ').sort()).toEqual(['email', 'openid', 'profile'])
    expect(start.url.searchParams.get('code_challenge_method')).toBe('S256'); expect(start.url.searchParams.get('access_type')).toBe('online')
    expect(start.flowCookie).not.toContain(start.url.searchParams.get('nonce')); expect(start.start.response.headers.getSetCookie().join(' ')).toContain('HttpOnly')
  })
  it('rejects missing, altered and expired browser state before exchanging the Google code', async () => {
    const start = await begin()
    for (const [state, cookies] of [['wrong', start.flowCookie], [start.url.searchParams.get('state'), undefined]]) {
      const result = await request(`/google/callback?state=${state}&code=fixture`, { cookies })
      expect(result.response.headers.get('location')).toContain('GOOGLE_FLOW_EXPIRED')
    }
    const flow = JSON.parse(decrypt(decodeURIComponent(start.flowCookie.split('=').slice(1).join('='))))
    const expired = `ts_google_flow=${encodeURIComponent(encrypt(JSON.stringify({ ...flow, expires: 0 })))}`
    expect((await request(`/google/callback?state=${flow.state}&code=fixture`, { cookies: expired })).response.headers.get('location')).toContain('GOOGLE_FLOW_EXPIRED')
    expect(fixture.exchange).not.toHaveBeenCalled()
  })
  it('handles denial without leaking Google descriptions', async () => {
    const start = await begin(), result = await request(`/google/callback?state=${start.url.searchParams.get('state')}&error=access_denied&error_description=private-detail`, { cookies: start.flowCookie })
    expect(result.response.headers.get('location')).toContain('GOOGLE_CANCELLED'); expect(result.response.headers.get('location')).not.toContain('private-detail'); expect(fixture.exchange).not.toHaveBeenCalled()
  })
  it('creates a passwordless verified Google account, preserves the selected plan and issues a normal rotating session', async () => {
    const person = identity(), flow = await authorize(person, { intent: 'signup', acceptTerms: true, plan: 'business', remember: true, returnTo: '/app/leads' })
    expect(flow.callback.status).toBe(303); expect(flow.callback.response.headers.get('location')).toBe('https://example.test/auth/google/complete')
    const result = await request('/google/complete', { method: 'POST', cookies: flow.resultCookie })
    expect(result.status).toBe(200); expect(result.body.data.user).toMatchObject({ email: person.email, emailVerified: true, hasPassword: false, organization: null, termsUpToDate: true })
    expect(result.body.data.returnTo).toBe('/app/leads'); expect(JSON.stringify(result.body)).not.toMatch(/passwordHash|googleSubject|refreshToken/)
    const row = await prisma.user.findUnique({ where: { googleSubject: person.subject } })
    expect(row.signupPlan).toBe('business'); expect(row.passwordHash).toBeNull()
    const refreshed = await request('/refresh', { method: 'POST', cookies: cookie(result.response, 'ts_refresh') })
    expect(refreshed.status).toBe(200); expect(refreshed.body.data.user.id).toBe(row.id)
    expect((await request('/google/complete', { method: 'POST', cookies: flow.resultCookie })).status).toBe(400)
    expect((await request('/login', { method: 'POST', values: { email: person.email, password: 'cannot-guess' } })).status).toBe(401)
  })
  it('does not silently register a new account from the sign-in page', async () => {
    const person = identity(), flow = await authorize(person)
    expect(flow.callback.response.headers.get('location')).toContain('GOOGLE_SIGNUP_REQUIRED')
    expect(await prisma.user.count({ where: { email: person.email } })).toBe(0)
  })
  it('links a verified Google-authoritative existing account without duplicating it or changing its workspace', async () => {
    const user = await localUser(), person = identity({ email: user.email })
    const org = await prisma.organization.create({ data: { name: 'Google fixture', slug: `google-${crypto.randomUUID()}`, plan: 'starter', createdById: user.id } }); organizations.push(org.id)
    await prisma.membership.create({ data: { organizationId: org.id, userId: user.id, role: 'owner' } })
    const flow = await authorize(person), result = await request('/google/complete', { method: 'POST', cookies: flow.resultCookie })
    expect(result.status).toBe(200); expect(result.body.data.user.id).toBe(user.id); expect(result.body.data.user.hasPassword).toBe(true)
    expect(verifyAccessToken(result.body.data.accessToken).org).toBe(org.id)
    expect((await prisma.user.findUnique({ where: { id: user.id } })).passwordHash).toBe(user.passwordHash)
    const again = await authorize(person), signedIn = await request('/google/complete', { method: 'POST', cookies: again.resultCookie })
    expect(signedIn.body.data.user.id).toBe(user.id); expect(await prisma.user.count({ where: { email: user.email } })).toBe(1)
  })
  it('refuses automatic linking to unverified, external or already bound email accounts', async () => {
    for (const overrides of [{ emailVerifiedAt: null }, { email: `external-${crypto.randomUUID()}@example.test` }, { googleSubject: crypto.randomUUID() }]) {
      const user = await localUser(overrides), flow = await authorize(identity({ email: user.email, authoritative: !user.email.endsWith('@example.test') }))
      expect(flow.callback.response.headers.get('location')).toContain('GOOGLE_LINK_REQUIRED')
      expect((await prisma.user.findUnique({ where: { id: user.id } })).passwordHash).toBe(user.passwordHash)
    }
  })
  it('requires the existing local second factor and sets no full session until it succeeds', async () => {
    const person = identity(), user = await localUser({ email: person.email, googleSubject: person.subject, twoFactorEnabledAt: new Date() })
    const flow = await authorize(person), result = await request('/google/complete', { method: 'POST', cookies: flow.resultCookie })
    expect(result.body.data.twoFactorRequired).toBe(true); expect(cookie(result.response, 'ts_refresh')).toBeUndefined()
    fixture.factor.mockResolvedValueOnce(false)
    const input = { challengeToken: result.body.data.challengeToken, code: '123456' }
    expect((await request('/login/2fa', { method: 'POST', values: input })).status).toBe(400)
    const verified = await request('/login/2fa', { method: 'POST', values: input })
    expect(verified.status).toBe(200); expect(verified.body.data.user.id).toBe(user.id); expect(cookie(verified.response, 'ts_refresh')).toBeTruthy()
  })
  it('keeps account lockouts, deletion and changed provider bindings effective', async () => {
    const person = identity(), user = await localUser({ email: person.email, googleSubject: person.subject, lockedUntil: new Date(Date.now() + 60000) })
    const flow = await authorize(person)
    expect((await request('/google/complete', { method: 'POST', cookies: flow.resultCookie })).body.error.code).toBe('ACCOUNT_LOCKED')
    await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: null } })
    const second = await authorize(person)
    await prisma.user.update({ where: { id: user.id }, data: { googleSubject: null } })
    expect((await request('/google/complete', { method: 'POST', cookies: second.resultCookie })).body.error.code).toBe('GOOGLE_ACCOUNT_UNAVAILABLE')
    await prisma.user.update({ where: { id: user.id }, data: { googleSubject: person.subject, deletedAt: new Date() } })
    expect((await authorize(person)).callback.response.headers.get('location')).toContain('GOOGLE_ACCOUNT_UNAVAILABLE')
  })
  it('keeps external email signup behind inbox verification and sanitizes return paths', async () => {
    const person = identity({ email: `google-${crypto.randomUUID()}@example.test`, authoritative: false })
    const flow = await authorize(person, { intent: 'signup', acceptTerms: true, returnTo: '//evil.test/path' })
    const result = await request('/google/complete', { method: 'POST', cookies: flow.resultCookie })
    expect(result.status).toBe(200); expect(result.body.data.user.emailVerified).toBe(false); expect(result.body.data.returnTo).toBeNull(); expect(fixture.mail).toHaveBeenCalled()
  })
  it('preserves password login and never exposes the password hash', async () => {
    const user = await localUser(), result = await request('/login', { method: 'POST', values: { email: user.email, password: 'Fixture123' } })
    expect(result.status).toBe(200); expect(result.body.data.user.hasPassword).toBe(true); expect(JSON.stringify(result.body)).not.toContain('passwordHash')
  })
})
