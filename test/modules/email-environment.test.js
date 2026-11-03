import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const base = { NODE_ENV: 'test', JWT_ACCESS_SECRET: 'x'.repeat(40), DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  DATABASE_URL: 'postgresql://fixture@localhost/unused', SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SECRET_KEY: 'fixture', EMAIL_FEATURE_ENABLED: 'true' }
const valid = { GOOGLE_CLIENT_ID: 'fixture-id', GOOGLE_CLIENT_SECRET: 'fixture-secret', GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:5000/api/email/connect/google/callback', APP_BASE_URL: 'http://localhost:5173', EMAIL_TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', EMAIL_TOKEN_KEY_VERSION: '1' }
const check = (extra) => spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/env.js')"], { env: { ...base, ...extra }, encoding: 'utf8' })
describe('email feature startup validation without network access', () => {
  it('does not require email configuration while disabled', () => expect(check({ EMAIL_FEATURE_ENABLED: 'false' }).status).toBe(0))
  it.each(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI', 'APP_BASE_URL', 'EMAIL_TOKEN_ENCRYPTION_KEY'])('fails startup when %s is absent', (name) => {
    const config = { ...valid, [name]: '' }
    expect(check(config).status).not.toBe(0)
  })
  it('accepts local-key and existing KMS configurations and rejects bad key material', () => {
    expect(check(valid).status).toBe(0)
    expect(check({ ...valid, EMAIL_TOKEN_ENCRYPTION_KEY: '', GMAIL_KMS_KEY_NAME: 'projects/fixture/locations/global/keyRings/crm/cryptoKeys/email' }).status).toBe(0)
    expect(check({ ...valid, EMAIL_TOKEN_ENCRYPTION_KEY: 'not-a-32-byte-key' }).status).not.toBe(0)
  })
})
