import { scheduleRevocation } from '../../email-integration/revocation.js'
import { auditEmail } from '../../email-integration/service.js'
import { registerConversionHook, registerMergeHook } from '../../lib/merge.js'

registerConversionHook(async (tx, ctx, { leadId, contactId }) => {
  const links = await tx.emailRecordLink.findMany({ where: { organizationId: ctx.orgId, leadId }, select: { threadId: true } })
  if (links.length) await tx.emailRecordLink.createMany({ data: links.map((r) => ({ organizationId: ctx.orgId, threadId: r.threadId, contactId })), skipDuplicates: true })
})
registerMergeHook('contact', async (tx, ctx, { primaryId, ids }) => {
  const links = await tx.emailRecordLink.findMany({ where: { organizationId: ctx.orgId, contactId: { in: ids } }, select: { threadId: true } })
  if (links.length) {
    await tx.emailRecordLink.createMany({ data: links.map((r) => ({ organizationId: ctx.orgId, threadId: r.threadId, contactId: primaryId })), skipDuplicates: true })
    await tx.emailRecordLink.deleteMany({ where: { organizationId: ctx.orgId, contactId: { in: ids } } })
  }
})

/** Run within membership/account deactivation transactions; no provider calls or credentials in jobs. */
export async function disableMemberMailboxes(tx, userId, organizationId) {
  const accounts = await tx.gmailAccount.findMany({ where: { userId, ...(organizationId && { organizationId }), credentialEnc: { not: null } } })
  for (const account of accounts) {
    await tx.$queryRaw`SELECT id FROM gmail_accounts WHERE id = ${account.id}::uuid AND organization_id = ${account.organizationId}::uuid FOR UPDATE`
    const current = await tx.gmailAccount.findFirst({ where: { id: account.id, organizationId: account.organizationId } })
    if (current?.credentialEnc) {
      await scheduleRevocation(tx, current)
      await auditEmail(tx, current.organizationId, null, userId, 'DISCONNECTED', { accountId: current.id, reason: 'membership_inactive' })
    }
  }
  await tx.gmailAccount.updateMany({ where: { userId, ...(organizationId && { organizationId }), status: { notIn: ['disconnected', 'deleting'] } }, data: { status: 'disconnected', credentialEnc: null, disconnectedAt: new Date(), generation: { increment: 1 }, lastError: 'GMAIL_MEMBER_INACTIVE' } })
  await tx.emailMessage.updateMany({ where: { actorId: userId, ...(organizationId && { organizationId }), status: 'queued' }, data: { status: 'cancelled', lastError: 'GMAIL_MEMBER_INACTIVE' } })
}
