import { describe, expect, it, vi } from 'vitest'

const { db, hashSync } = vi.hoisted(() => ({ db: { user: { findFirst: vi.fn().mockResolvedValue(null) } }, hashSync: vi.fn(() => { throw new Error('Synchronous bcrypt must not run during import') }) }))
vi.mock('../../src/db/prisma.js', () => ({ prisma: db, DB_NULL: 'DB_NULL', UNIQUE_VIOLATION: 'P2002' }))
vi.mock('../../src/config/env.js', () => ({ env: { NODE_ENV: 'test', DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', FRONTEND_URL: 'https://example.test' } }))
vi.mock('../../src/email/mailer.js', () => ({ queueEmail: vi.fn() }))
vi.mock('bcryptjs', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, default: { ...actual.default, hashSync } }
})
import bcrypt from 'bcryptjs'
import { BCRYPT_ROUNDS, login } from '../../src/services/auth.service.js'

describe('auth startup and unknown-user timing defense', () => {
  it('imports without hashing and still performs a valid cost-12 comparison for unknown emails', async () => {
    expect(hashSync).not.toHaveBeenCalled()
    const compare = vi.spyOn(bcrypt, 'compare')
    try {
      await expect(login({ email: 'absent@example.test', password: 'wrong-password', remember: false }, {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
      const [, dummy] = compare.mock.calls[0]
      expect(bcrypt.getRounds(dummy)).toBe(BCRYPT_ROUNDS)
      expect(BCRYPT_ROUNDS).toBe(12)
      expect(await bcrypt.compare('timing-safe-dummy-password', dummy)).toBe(true)
      // Knowing the dummy password must never authenticate an absent account.
      await expect(login({ email: 'absent@example.test', password: 'timing-safe-dummy-password' }, {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
    } finally { compare.mockRestore() }
  })
})
