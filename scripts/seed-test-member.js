/**
 * Development helper: adds a verified test member to the demo workspace with a given role, to see
 * the app as that role. Idempotent; running it again just changes the member's role.
 *
 *   node --env-file=.env scripts/seed-test-member.js "Lead list viewer"
 *   node --env-file=.env scripts/seed-test-member.js viewer
 *
 * Login: member@techsync.local / Member12345 (override with TEST_MEMBER_EMAIL / TEST_MEMBER_PASSWORD).
 * Refuses to run against production, like scripts/seed.js.
 */
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db/prisma.js'
import { ASSIGNABLE_ROLES } from '../src/config/permissions.js'
import { CUSTOM_ROLE_TIER } from '../src/services/role.service.js'

const EMAIL = process.env.TEST_MEMBER_EMAIL ?? 'member@techsync.local'
const PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? 'Member12345'
const DEMO_EMAIL = process.env.SEED_EMAIL ?? 'demo@techsync.local'

const branch = process.env.DB_ENVIRONMENT ?? ''
if (process.env.NODE_ENV === 'production' || /^(main|production)$/i.test(branch)) {
  console.error('[seed] Refusing to run against production.')
  process.exit(1)
}

const roleArg = process.argv[2]
if (!roleArg) {
  console.error('Usage: node --env-file=.env scripts/seed-test-member.js "<role name or key>"')
  process.exit(1)
}

const owner = await prisma.membership.findFirst({ where: { user: { email: DEMO_EMAIL }, status: 'active' }, select: { organizationId: true } })
if (!owner) throw new Error('Run npm run db:seed first (no demo workspace).')
const orgId = owner.organizationId

let role, roleId
if (ASSIGNABLE_ROLES.includes(roleArg)) {
  role = roleArg
  roleId = null
} else {
  const custom = await prisma.role.findFirst({ where: { organizationId: orgId, systemKey: null, archivedAt: null, name: { equals: roleArg, mode: 'insensitive' } }, select: { id: true } })
  if (!custom) throw new Error(`No role named "${roleArg}" in the demo workspace.`)
  role = CUSTOM_ROLE_TIER
  roleId = custom.id
}

const now = new Date()
const user = await prisma.user.upsert({
  where: { email: EMAIL },
  update: {},
  create: { fullName: 'Test Member', email: EMAIL, passwordHash: await bcrypt.hash(PASSWORD, 12), emailVerifiedAt: now, onboardingCompletedAt: now, lastActiveOrganizationId: orgId },
  select: { id: true },
})
await prisma.membership.upsert({
  where: { organizationId_userId: { organizationId: orgId, userId: user.id } },
  update: { role, roleId, status: 'active', deactivatedAt: null },
  create: { organizationId: orgId, userId: user.id, role, roleId, status: 'active', joinedAt: now },
})
console.log(`[seed] ${EMAIL} is now "${roleArg}" in the demo workspace (password in scripts/seed-test-member.js).`)
await prisma.$disconnect()
