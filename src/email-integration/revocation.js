import { prisma } from '../db/prisma.js'
import { provider } from '../integrations/gmail/provider.js'
import { open } from '../integrations/gmail/vault.js'
import { gmailSharesWorkspaceProject } from '../integrations/google/config.js'

/** Save encrypted credentials in the same transaction that disables local access. */
export async function scheduleRevocation(tx, account) {
  if (!account.credentialEnc) return null
  return tx.emailTokenRevocation.create({ data: { organizationId: account.organizationId, accountId: account.id,
    credentialEnc: account.credentialEnc, wrappedKey: account.wrappedKey, keyVersion: account.keyVersion } })
}

/** Retries survive process restarts. Provider errors are never logged or returned. */
export async function processRevocations(now = new Date(), scope = {}) {
  const rows = await prisma.emailTokenRevocation.findMany({ where: { ...scope, nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, take: 50, orderBy: { nextAttemptAt: 'asc' } })
  for (const row of rows) {
    // Shared-project disconnect is local only: Google's revoke endpoint would also
    // invalidate Calendar/Drive/Sheets and sign-in grants. Full removal is user-led
    // at Google Account connections. Retain no encrypted cleanup snapshot here.
    if (gmailSharesWorkspaceProject()) {
      await prisma.emailTokenRevocation.deleteMany({ where: { id: row.id, organizationId: row.organizationId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] } })
      continue
    }
    const leaseUntil = new Date(Date.now() + 60000)
    if (!(await prisma.emailTokenRevocation.updateMany({ where: { id: row.id, organizationId: row.organizationId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseUntil } })).count) continue
    try {
      const account = { ...row, id: row.accountId }
      const credentials = open(await provider.unwrapKey(account), account, 'credentials', row.credentialEnc)
      await provider.revoke(credentials.refreshToken)
      await prisma.emailTokenRevocation.deleteMany({ where: { id: row.id, organizationId: row.organizationId, leaseUntil } })
    } catch {
      await prisma.emailTokenRevocation.updateMany({ where: { id: row.id, organizationId: row.organizationId, leaseUntil }, data: {
        attempts: { increment: 1 }, leaseUntil: null, nextAttemptAt: new Date(Date.now() + Math.min(86400, 60 * 2 ** Math.min(row.attempts, 10)) * 1000),
      } })
    }
  }
}
