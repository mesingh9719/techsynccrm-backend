import { prisma } from '../db/prisma.js'
import { accessToken } from '../integrations/gmail/jobs.js'
import { SEND_ONLY_CONSENT_VERSION } from './config/googleOAuth.js'

/** Refresh-only health check: never reads Gmail messages. Invalid grants transition once. */
export async function checkEmailConnections(now = new Date(), organizationId) {
  const due = await prisma.gmailSyncState.findMany({ where: { ...(organizationId && { organizationId }), nextAttemptAt: { lte: now },
    account: { consentVersion: SEND_ONLY_CONSENT_VERSION, status: 'connected', credentialEnc: { not: null } } },
    orderBy: { nextAttemptAt: 'asc' }, take: 20, include: { account: true } })
  for (const row of due) {
    let delay = 15 * 60000
    try { await accessToken(row.account) } catch { delay = 5 * 60000 }
    await prisma.gmailSyncState.updateMany({ where: { organizationId: row.organizationId, accountId: row.accountId }, data: { nextAttemptAt: new Date(now.getTime() + delay) } })
  }
}
