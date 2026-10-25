import { prisma } from '../../db/prisma.js'
import { accountDto, accountMetadata } from '../../email-integration/dto.js'
import { canSyncAccount, hasSendScope } from '../../email-integration/config/googleOAuth.js'

/** Read-compatible facade: the legacy module remains Gmail's credential authority. */
export const gmailAdapter = {
  async metadata(ctx) {
    const row = await prisma.gmailAccount.findFirst({ where: { organizationId: ctx.orgId, userId: ctx.userId },
      orderBy: [{ consentAt: 'desc' }, { createdAt: 'desc' }], select: { ...accountMetadata, scopes: true, consentVersion: true } })
    if (!row) return null
    return { ...accountDto(row), profile: 'gmail', sendEnabled: hasSendScope(row.scopes), historyEnabled: canSyncAccount(row) }
  },
  async accessToken(account) { return (await import('../gmail/jobs.js')).accessToken(account) },
}
