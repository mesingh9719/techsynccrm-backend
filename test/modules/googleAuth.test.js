import { describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ verify: vi.fn(), token: vi.fn() }))
vi.mock('../../src/config/env.js', () => ({ env: { GOOGLE_AUTH_ENABLED: true, GOOGLE_AUTH_CLIENT_ID: 'fixture-client', GOOGLE_AUTH_CLIENT_SECRET: 'fixture-secret', GOOGLE_AUTH_REDIRECT_URI: 'https://example.test/api/auth/google/callback' } }))
vi.mock('google-auth-library', () => ({ OAuth2Client: class { getToken(input) { return fixture.token(input) } verifyIdToken(input) { return fixture.verify(input) } } }))
import { googleAuthEnvironment } from '../../src/config/googleAuth.js'
import { googleIdentity, verifiedIdentity, googleConfiguration } from '../../src/services/googleIdentity.js'
const nonce = 'fixture-nonce-long-enough-for-authentication'
const claims = { sub: 'google-fixture-subject', email: 'REP@gmail.com', email_verified: true, name: 'Representative', nonce }
describe('Google authentication boundaries', () => {
  it('uses generic credentials, preserves dedicated pairs, and keeps the sign-in callback independent from Gmail', () => {
    const settings = googleAuthEnvironment({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REDIRECT_URI: 'https://gmail.example/callback' })
    expect(settings.GOOGLE_AUTH_CLIENT_ID).toBe('id'); expect(settings.GOOGLE_AUTH_REDIRECT_URI).toBe('http://localhost:5000/api/auth/google/callback')
    expect(googleAuthEnvironment({ NODE_ENV: 'production' }).GOOGLE_AUTH_REDIRECT_URI).toBe('')
    expect(googleAuthEnvironment({ GOOGLE_AUTH_CLIENT_ID: 'dedicated', GOOGLE_CLIENT_SECRET: 'other-secret' }).GOOGLE_AUTH_CLIENT_SECRET).toBe('')
    expect(googleAuthEnvironment({ GOOGLE_AUTH_ENABLED: 'false' }).GOOGLE_AUTH_ENABLED).toBe(false)
  })
  it('publishes no secret in readiness and binds identity to a stable verified subject and nonce', () => {
    expect(googleConfiguration()).toEqual({ enabled: true, redirectUri: 'https://example.test/api/auth/google/callback' })
    expect(verifiedIdentity(claims, nonce)).toMatchObject({ subject: claims.sub, email: 'rep@gmail.com', authoritative: true })
    for (const payload of [{ ...claims, email_verified: false }, { ...claims, nonce: 'wrong' }, { ...claims, sub: '' }, { ...claims, azp: 'another-client' }]) expect(() => verifiedIdentity(payload, nonce)).toThrow('could not be verified')
  })
  it('does not treat externally managed Google email addresses as authoritative', () => {
    expect(verifiedIdentity({ ...claims, email: 'rep@example.test' }, nonce).authoritative).toBe(false)
    expect(verifiedIdentity({ ...claims, email: 'rep@example.test', hd: 'example.test' }, nonce).authoritative).toBe(true)
  })
  it('passes PKCE and the expected audience to Google and sanitizes library failures', async () => {
    fixture.token.mockResolvedValueOnce({ tokens: { id_token: 'fixture-id-token' } })
    fixture.verify.mockResolvedValueOnce({ getPayload: () => claims })
    await googleIdentity.exchange('fixture-code', 'fixture-verifier', nonce)
    expect(fixture.token).toHaveBeenCalledWith({ code: 'fixture-code', codeVerifier: 'fixture-verifier' })
    expect(fixture.verify).toHaveBeenCalledWith({ idToken: 'fixture-id-token', audience: 'fixture-client' })
    fixture.token.mockRejectedValueOnce(new Error('private upstream credentials'))
    await expect(googleIdentity.exchange('bad-code', 'verifier', nonce)).rejects.toMatchObject({ code: 'GOOGLE_AUTH_FAILED', message: 'Google sign-in could not be completed. Please try again.' })
  })
})
