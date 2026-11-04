import { redactEmailSecrets } from '../../src/email-integration/redaction.js'
import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encryptToken, decryptToken, keyring, rotateToken } from '../../src/email-integration/crypto/tokenCrypto.js'
import { GOOGLE_EMAIL_SCOPES, GMAIL_SEND_SCOPE, hasSendScope, validReturnTo, canSyncAccount } from '../../src/email-integration/config/googleOAuth.js'
import { accountDto } from '../../src/email-integration/dto.js'
import { reminderBody, settingsBody, teamQuery } from '../../src/email-integration/validators.js'

describe('email foundation security boundaries', () => {
  it('redacts nested OAuth credentials without mutating the original log object', () => {
    const input = { event: { nested: { state: 'private', code: 'private', refresh_token: 'private', authorization: 'Bearer private' } }, label: 'safe' }
    const output = redactEmailSecrets(input)
    expect(JSON.stringify(output)).not.toContain('private'); expect(output.label).toBe('safe')
    expect(input.event.nested.state).toBe('private')
  })
  it('encrypts with a fresh IV, authenticates tenant and detects tampering', () => {
    const ring = keyring({ EMAIL_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') })
    const one = encryptToken('fixture-refresh-secret', 'tenant-one:user-one', ring)
    const two = encryptToken('fixture-refresh-secret', 'tenant-one:user-one', ring)
    expect(one.iv).not.toBe(two.iv); expect(JSON.stringify(one)).not.toContain('fixture-refresh-secret')
    expect(decryptToken(one, 'tenant-one:user-one', ring)).toBe('fixture-refresh-secret')
    expect(() => decryptToken(one, 'tenant-two:user-one', ring)).toThrow()
    expect(() => decryptToken({ ...one, authTag: crypto.randomBytes(16).toString('base64') }, 'tenant-one:user-one', ring)).toThrow()
  })
  it('rotates keys and refuses unavailable versions or invalid keys', () => {
    const old = crypto.randomBytes(32).toString('base64'), current = crypto.randomBytes(32).toString('base64')
    const before = encryptToken('fixture-refresh', 'tenant', keyring({ EMAIL_TOKEN_ENCRYPTION_KEY: old, EMAIL_TOKEN_KEY_VERSION: '1' }))
    const ring = keyring({ EMAIL_TOKEN_KEY_VERSION: '2', EMAIL_TOKEN_ENCRYPTION_KEY: current, EMAIL_TOKEN_ENCRYPTION_KEYS: JSON.stringify({ 1: old }) })
    const after = rotateToken(before, 'tenant', ring)
    expect(after.keyVersion).toBe('2'); expect(decryptToken(after, 'tenant', ring)).toBe('fixture-refresh')
    expect(() => decryptToken(before, 'tenant', keyring({ EMAIL_TOKEN_KEY_VERSION: '2', EMAIL_TOKEN_ENCRYPTION_KEY: current }))).toThrow()
    expect(() => keyring({ EMAIL_TOKEN_ENCRYPTION_KEY: 'short' })).toThrow()
  })
  it('requests send-only scopes and checks granular permission grants', () => {
    expect(GOOGLE_EMAIL_SCOPES).toEqual(['openid', 'email', 'profile', GMAIL_SEND_SCOPE])
    expect(hasSendScope(['openid', 'email'])).toBe(false)
    expect(hasSendScope([GMAIL_SEND_SCOPE])).toBe(true)
    expect(canSyncAccount({ consentVersion: '2026-10-23-send-only-v1', scopes: [GMAIL_SEND_SCOPE, 'https://www.googleapis.com/auth/gmail.readonly'] })).toBe(false)
  })
  it.each(['https://evil.test', '//evil.test', '/\\evil.test', '/app/settings/gmail%0a', '/app/settings/gmail?next=https://evil.test', '/app/settings/gmail\n', '/app/../logout'])('rejects redirect tricks: %s', (value) => {
    expect(validReturnTo(value)).toBe('/app/settings/gmail')
  })
  it('keeps permitted return paths and exposes only connection metadata', () => {
    expect(validReturnTo('/app/settings/email')).toBe('/app/settings/email')
    expect(validReturnTo('/app/settings/connections')).toBe('/app/settings/connections')
    const dto = accountDto({ id: 'one', status: 'connected', credentialEnc: 'secret', wrappedKey: 'secret', googleSubject: 'private' })
    expect(dto.status).toBe('CONNECTED'); expect(JSON.stringify(dto)).not.toMatch(/secret|credential|wrapped|googleSubject/)
  })
  it('rejects caller-supplied tenant identifiers, invalid settings and oversized reminder batches', () => {
    expect(teamQuery.safeParse({ tenantId: 'foreign-tenant' }).success).toBe(false)
    expect(settingsBody.safeParse({ organizationId: 'foreign', emailEnabled: false }).success).toBe(false)
    expect(settingsBody.safeParse({ emailVisibility: 'EVERYONE' }).success).toBe(false)
    expect(reminderBody.safeParse({ userIds: Array.from({ length: 101 }, () => crypto.randomUUID()) }).success).toBe(false)
  })
})
