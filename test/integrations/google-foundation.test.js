import crypto from 'node:crypto'
import { OAuth2Client } from 'google-auth-library'
import { describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ env: { GOOGLE_GMAIL_CLIENT_ID: '987654321-gmail.apps.googleusercontent.com', GOOGLE_AUTH_CLIENT_ID: '987654321-auth.apps.googleusercontent.com', GOOGLE_WORKSPACE_TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } }))
vi.mock('../../src/config/env.js', () => ({ env: fixture.env }))
import { configurationStatus, safeReturn, scopesAllowed, SERVICE_SCOPES } from '../../src/integrations/google/config.js'
import { sealValue, openValue, workspaceContext } from '../../src/integrations/google/envelope.js'
import { seal, open } from '../../src/integrations/gmail/vault.js'
import { safeRequestUrl } from '../../src/lib/requestUrl.js'
import { googleProvider } from '../../src/integrations/google/provider.js'
const config = { enabled: true, clientId: '123456789-fixture.apps.googleusercontent.com', clientSecret: 'fixture', projectNumber: '123456789', redirectUri: 'https://api.example.test/api/google/oauth/callback' }
describe('Google configuration and credential compatibility', () => {
  it('checks the identity token with the configured audience and requires nonce and verified identity', async () => {
    Object.assign(fixture.env, { GOOGLE_WORKSPACE_ENABLED: true, GOOGLE_WORKSPACE_CLIENT_ID: config.clientId, GOOGLE_WORKSPACE_CLIENT_SECRET: config.clientSecret,
      GOOGLE_WORKSPACE_PROJECT_NUMBER: config.projectNumber, GOOGLE_WORKSPACE_REDIRECT_URI: config.redirectUri })
    const verify = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken')
    const payload = { sub: 'fixture-subject', email: 'WORK@example.test', email_verified: true, nonce: 'expected-nonce' }
    try {
      verify.mockResolvedValue({ getPayload: () => payload })
      expect(await googleProvider.identity('identity-fixture', 'expected-nonce')).toEqual({ subject: 'fixture-subject', email: 'work@example.test' })
      expect(verify).toHaveBeenCalledWith({ idToken: 'identity-fixture', audience: config.clientId })
      for (const changed of [{ nonce: 'wrong' }, { email_verified: false }, { email_verified: 'false' }, { sub: '' }, { email: undefined }]) {
        verify.mockResolvedValueOnce({ getPayload: () => ({ ...payload, ...changed }) })
        await expect(googleProvider.identity('identity-fixture', 'expected-nonce')).rejects.toMatchObject({ code: 'GOOGLE_OAUTH_INVALID' })
      }
    } finally { verify.mockRestore() }
  })
  it.each(['calendar', 'drive', 'sheets'])('identifies the disabled %s API without exposing provider payloads', async (api) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'private-provider-value', details: [{ reason: 'SERVICE_DISABLED', metadata: { consumer: 'private-project-value' } }] } }), { status: 403 }))
    try {
      await expect(googleProvider.request('private-token', api, 'fixture')).rejects.toMatchObject({ code: `GOOGLE_${api.toUpperCase()}_API_DISABLED`, providerStatus: 403 })
      try { await googleProvider.request('private-token', api, 'fixture') } catch (error) { expect(error.message).not.toContain('private-provider-value'); expect(JSON.stringify(error)).not.toContain('private-project-value') }
    } finally { fetch.mockRestore() }
  })
  it('keeps ordinary Google permission errors distinct from disabled APIs', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 }))
    try { await expect(googleProvider.request('fixture', 'drive', 'files')).rejects.toMatchObject({ code: 'GOOGLE_PERMISSION_DENIED' }) } finally { fetch.mockRestore() }
  })
  it('accepts a shared Google project while requiring a valid callback and encryption', () => {
    expect(configurationStatus(config).ready).toBe(true)
    expect(configurationStatus({ ...config, clientId: fixture.env.GOOGLE_GMAIL_CLIENT_ID, projectNumber: '987654321' })).toMatchObject({ ready: true, missing: [], sharedProject: true })
    expect(configurationStatus({ ...config, projectNumber: 'wrong' }).missing).toContain('projectNumber')
    for (const redirectUri of ['https://api.example.test/elsewhere', 'https://api.example.test/api/google/oauth/callback?x=1', 'http://api.example.test/api/google/oauth/callback']) expect(configurationStatus({ ...config, redirectUri }).missing).toContain('redirectUri')
    expect(configurationStatus({ ...config, kmsKey: 'invalid-key' }).missing).toContain('encryption')
    expect(configurationStatus({ ...config, kmsKey: 'projects/test/locations/global/keyRings/techsync/cryptoKeys/google' }).ready).toBe(true)
  })
  it('accepts existing supported Gmail grants only when the project is shared and never allows broad Drive scopes', () => {
    const original = fixture.env.GOOGLE_WORKSPACE_PROJECT_NUMBER
    try {
      fixture.env.GOOGLE_WORKSPACE_PROJECT_NUMBER = '123456789'
      expect(scopesAllowed(['https://www.googleapis.com/auth/gmail.send'])).toBe(false)
      fixture.env.GOOGLE_WORKSPACE_PROJECT_NUMBER = '987654321'
      expect(scopesAllowed(['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'])).toBe(true)
      expect(scopesAllowed(['https://www.googleapis.com/auth/drive'])).toBe(false)
      expect(scopesAllowed(['https://mail.google.com/'])).toBe(false)
    } finally { fixture.env.GOOGLE_WORKSPACE_PROJECT_NUMBER = original }
  })
  it('accepts only exact narrow scopes and safe internal returns', () => {
    expect(scopesAllowed(['openid', 'email', 'profile', ...Object.values(SERVICE_SCOPES)])).toBe(true)
    expect(scopesAllowed(['https://www.googleapis.com/auth/drive'])).toBe(false)
    expect(safeReturn('https://evil.test')).toBe('/app/settings/google')
    expect(safeReturn('/app/settings/google-team')).toBe('/app/settings/google-team')
    expect(safeRequestUrl('/api/google/oauth/callback?error=denied&error_description=private')).toBe('/api/google/oauth/callback')
  })
  it('preserves the pre-refactor Gmail envelope wire format and binds tenant, account and purpose', () => {
    const key = crypto.randomBytes(32), row = { organizationId: crypto.randomUUID(), id: crypto.randomUUID() }, context = `${row.organizationId}:${row.id}`
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(`${context}:v1:credentials`))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ refreshToken: 'legacy-fixture' })), cipher.final()])
    const legacy = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.')
    expect(open(key, row, 'credentials', legacy)).toEqual({ refreshToken: 'legacy-fixture' })
    expect(openValue(key, context, 'credentials', seal(key, row, 'credentials', { refreshToken: 'new-fixture' }))).toEqual({ refreshToken: 'new-fixture' })
    expect(() => openValue(key, workspaceContext(row), 'credentials', legacy)).toThrow()
    expect(() => open(key, { ...row, organizationId: crypto.randomUUID() }, 'credentials', legacy)).toThrow()
    const workspace = sealValue(key, workspaceContext(row), 'credentials', { refreshToken: 'workspace-fixture' })
    expect(() => openValue(key, workspaceContext(row), 'content', workspace)).toThrow()
  })
})
