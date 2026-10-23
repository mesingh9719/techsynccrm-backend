import { afterEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ payload: {}, refresh: vi.fn() }))
vi.mock('../../src/config/env.js', () => ({ env: { GMAIL_ENABLED: true, GOOGLE_GMAIL_CLIENT_ID: 'fixture', GOOGLE_GMAIL_CLIENT_SECRET: 'fixture', GOOGLE_GMAIL_REDIRECT_URI: 'https://fixture.invalid/callback', GMAIL_KMS_KEY_NAME: 'fixture', GMAIL_PUBSUB_AUDIENCE: 'https://fixture.invalid/push', GMAIL_PUBSUB_SERVICE_ACCOUNT: 'push@fixture.iam.gserviceaccount.com' } }))
vi.mock('google-auth-library', () => ({ GoogleAuth: class {}, OAuth2Client: class {
  async verifyIdToken() { return { getPayload: () => fixture.payload } }
  setCredentials() {}
  refreshAccessToken() { return fixture.refresh() }
} }))
import { provider } from '../../src/integrations/gmail/provider.js'
afterEach(() => vi.unstubAllGlobals())
describe('Gmail provider boundary', () => {
  it('sends repeated metadataHeader query parameters and bounds response bodies', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'fixture' })))
    vi.stubGlobal('fetch', fetch)
    await provider.api('private-fixture-token', 'messages/one', { query: { format: 'metadata', metadataHeaders: ['From', 'To'] } })
    expect(fetch.mock.calls[0][0].searchParams.getAll('metadataHeaders')).toEqual(['From', 'To'])
    fetch.mockResolvedValueOnce(new Response('x'.repeat(4_000_001)))
    await expect(provider.api('fixture', 'messages/one')).rejects.toMatchObject({ code: 'GMAIL_MESSAGE_TOO_LARGE' })
  })
  it('separates retryable quotas, rejected sends and uncertain provider failures without exposing upstream details', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), { status: 403, headers: { 'retry-after': '120' } }))
    await expect(provider.api('fixture', 'messages/send', { send: true })).rejects.toMatchObject({ code: 'GMAIL_RATE_LIMITED', retryAfter: 120, uncertain: false })
    fetch.mockResolvedValueOnce(new Response('private upstream detail', { status: 400 }))
    await expect(provider.api('fixture', 'messages/send', { send: true })).rejects.toMatchObject({ message: 'EMAIL_SEND_REJECTED', uncertain: false })
    fetch.mockResolvedValueOnce(new Response('provider error', { status: 503 }))
    await expect(provider.api('fixture', 'messages/send', { send: true })).rejects.toMatchObject({ code: 'EMAIL_SEND_UNKNOWN', uncertain: true })
    fetch.mockResolvedValueOnce(new Response('', { status: 404 }))
    await expect(provider.api('fixture', 'history')).rejects.toMatchObject({ code: 'GMAIL_HISTORY_EXPIRED' })
  })
  it('requires verified identity, matching nonce and the configured Pub/Sub service identity', async () => {
    fixture.payload = { sub: 'google-subject', email: 'REP@example.test', email_verified: true, nonce: 'expected' }
    expect(await provider.identity('fixture-id-token', 'expected')).toEqual({ subject: 'google-subject', email: 'rep@example.test' })
    await expect(provider.identity('fixture-id-token', 'wrong')).rejects.toMatchObject({ code: 'GMAIL_OAUTH_INVALID' })
    fixture.payload = { email: 'someone-else@example.test', email_verified: true }
    await expect(provider.verifyPush('fixture-jwt')).rejects.toMatchObject({ code: 'GMAIL_PUSH_INVALID' })
    fixture.payload = { email: 'push@fixture.iam.gserviceaccount.com', email_verified: true }
    await provider.verifyPush('fixture-jwt')
  })
  it('normalizes rejected refresh credentials to a reconnect response', async () => {
    fixture.refresh.mockRejectedValueOnce({ response: { data: { error: 'invalid_grant', secret: 'never exposed' } } })
    await expect(provider.refresh('fixture-refresh')).rejects.toMatchObject({ message: 'GMAIL_RECONNECT_REQUIRED' })
  })
})
