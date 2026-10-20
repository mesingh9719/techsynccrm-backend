import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '../src/db/prisma.js'
import { env } from '../src/config/env.js'
import { recordAudit } from '../src/lib/audit.js'

// Operator-only command. No public registration route can grant staff access.
// Existing users are left untouched; it never resets an existing account's password.
const emails = process.argv
  .slice(2)
  .map((value) => z.email().parse(value.trim().toLowerCase()))
if (!emails.length)
  throw new Error(
    'Usage: npm run staff:provision -- staff@example.com [another@example.com]',
  )
if (emails.some((email) => !env.INTERNAL_STAFF_EMAILS.includes(email)))
  throw new Error(
    'Every email must already be in INTERNAL_STAFF_EMAILS. Update the backend configuration first.',
  )
const consoleUrl = (
  process.env.SUPERADMIN_URL || 'http://localhost:5174'
).replace(/\/$/, '')
try {
  const results = []
  for (const email of [...new Set(emails)]) {
    const existing = await prisma.user.findUnique({
      where: { email },
      select: { deletedAt: true, emailVerifiedAt: true },
    })
    if (existing) {
      results.push({
        email,
        status: existing.deletedAt
          ? 'deleted_account_requires_review'
          : 'existing_account_use_current_password',
        verified: !!existing.emailVerifiedAt,
      })
      continue
    }
    const token = crypto.randomBytes(32).toString('base64url')
    const passwordHash = await bcrypt.hash(
      crypto.randomBytes(48).toString('base64url'),
      12,
    )
    const expiresAt = new Date(
      Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60000,
    )
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          fullName: email
            .split('@')[0]
            .replace(/[._-]/g, ' ')
            .replace(/\b\w/g, (value) => value.toUpperCase()),
          passwordHash,
        },
      })
      await tx.userToken.create({
        data: {
          userId: user.id,
          type: 'password_reset',
          tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
          expiresAt,
        },
      })
      await recordAudit(
        tx,
        { actorType: 'system' },
        { action: 'staff.provisioned', entityType: 'user', entityId: user.id },
      )
    })
    results.push({
      email,
      status: 'created',
      setupUrl: `${consoleUrl}/#setup/${token}`,
      expiresAt: expiresAt.toISOString(),
    })
  }
  // Contains private single-use links: deliver directly to the operator, never commit or log publicly.
  console.log(JSON.stringify(results, null, 2))
} finally {
  await prisma.$disconnect()
}
