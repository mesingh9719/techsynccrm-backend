import { afterEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ env: { isProduction: false } }))
vi.mock('../../src/config/env.js', () => ({ env: fixture.env }))
import { gmailOAuthEnvironment } from '../../src/config/gmailOAuth.js'
import { configurationStatus, requireConfiguration } from '../../src/integrations/gmail/config.js'

afterEach(() => { for (const key of Object.keys(fixture.env)) delete fixture.env[key]; fixture.env.isProduction = false })
describe('Gmail OAuth environment and readiness', () => {
  it('uses the existing generic Google client variables and a local backend callback', () => {
    expect(gmailOAuthEnvironment({ GOOGLE_CLIENT_ID: 'generic-id', GOOGLE_CLIENT_SECRET: 'generic-secret' })).toEqual({
      GOOGLE_GMAIL_CLIENT_ID: 'generic-id', GOOGLE_GMAIL_CLIENT_SECRET: 'generic-secret', GOOGLE_GMAIL_REDIRECT_URI: 'http://localhost:5000/api/integrations/gmail/callback',
    })
    expect(gmailOAuthEnvironment({ PORT: '5050' }).GOOGLE_GMAIL_REDIRECT_URI).toBe('http://localhost:5050/api/integrations/gmail/callback')
  })
  it('preserves a dedicated Gmail client and never mixes credentials from different clients', () => {
    const source = { GOOGLE_CLIENT_ID: 'generic-id', GOOGLE_CLIENT_SECRET: 'generic-secret', GOOGLE_GMAIL_CLIENT_ID: 'gmail-id', GOOGLE_GMAIL_CLIENT_SECRET: 'gmail-secret' }
    expect(gmailOAuthEnvironment(source)).toMatchObject({ GOOGLE_GMAIL_CLIENT_ID: 'gmail-id', GOOGLE_GMAIL_CLIENT_SECRET: 'gmail-secret' })
    expect(gmailOAuthEnvironment({ ...source, GOOGLE_GMAIL_CLIENT_SECRET: '' }).GOOGLE_GMAIL_CLIENT_SECRET).toBe('')
    expect(gmailOAuthEnvironment({ ...source, GOOGLE_GMAIL_CLIENT_ID: '' }).GOOGLE_GMAIL_CLIENT_ID).toBe('')
  })
  it('requires an explicit production callback and accepts either documented redirect variable', () => {
    expect(gmailOAuthEnvironment({ NODE_ENV: 'production' }).GOOGLE_GMAIL_REDIRECT_URI).toBe('')
    expect(gmailOAuthEnvironment({ GOOGLE_REDIRECT_URI: 'https://api.example.test/api/integrations/gmail/callback' }).GOOGLE_GMAIL_REDIRECT_URI).toBe('https://api.example.test/api/integrations/gmail/callback')
    expect(gmailOAuthEnvironment({ GOOGLE_REDIRECT_URI: 'generic', GOOGLE_GMAIL_REDIRECT_URI: 'dedicated' }).GOOGLE_GMAIL_REDIRECT_URI).toBe('dedicated')
  })
  const complete = { enabled: true, clientId: 'private-client-id', clientSecret: 'private-client-secret', redirectUri: 'http://localhost:5000/api/integrations/gmail/callback', kmsKey: 'private-kms-resource' }
  it('reports missing setup without exposing credentials or the KMS resource', () => {
    expect(configurationStatus({ ...complete, enabled: false, kmsKey: '' })).toEqual({ ready: false, missing: ['enabled', 'encryption'], redirectUri: complete.redirectUri })
    expect(configurationStatus(complete).ready).toBe(true)
    expect(JSON.stringify(configurationStatus(complete))).not.toMatch(/private-/)
    Object.assign(fixture.env, gmailOAuthEnvironment({ GOOGLE_CLIENT_ID: 'fixture-id', GOOGLE_CLIENT_SECRET: 'fixture-secret' }), { GMAIL_ENABLED: true })
    expect(() => requireConfiguration()).toThrow('Gmail is not enabled')
    fixture.env.GMAIL_KMS_KEY_NAME = 'configured-kms-resource'
    expect(requireConfiguration().clientId).toBe('fixture-id')

  })
  it('rejects malformed callbacks, embedded credentials, alternate paths, queries and remote plain HTTP', () => {
    for (const redirectUri of ['invalid', 'https://user:password@example.test/api/integrations/gmail/callback', 'https://api.example.test/another-path', 'https://api.example.test/api/integrations/gmail/callback?next=external', 'https://api.example.test/api/integrations/gmail/callback#fragment', 'http://api.example.test/api/integrations/gmail/callback']) {
      expect(configurationStatus({ ...complete, redirectUri })).toMatchObject({ ready: false, missing: ['redirectUri'], redirectUri: null })
    }
    fixture.env.isProduction = true
    expect(configurationStatus(complete).ready).toBe(false)
    expect(configurationStatus({ ...complete, redirectUri: 'https://api.example.test/api/integrations/gmail/callback' }).ready).toBe(true)
  })
})
