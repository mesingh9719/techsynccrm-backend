import { prisma } from '../../db/prisma.js'
import { emit } from '../../events/outbox.js'
import { provider } from './provider.js'
import { accessToken } from './jobs.js'
import { accountContext } from './access.js'
import { contentOf } from './mail.js'
import { addresses, headerMap, permanentDeliveryFailure } from './content.js'

/** Bounded, conservative Google delivery-report detection; never infer a bounce from subject text. */
export async function checkDeliveryReports(message) {
  const account = await prisma.gmailAccount.findFirst({ where: { id: message.accountId, organizationId: message.organizationId, status: { in: ['connected', 'syncing', 'delayed'] }, credentialEnc: { not: null } } })
  if (!account || !/^<[\w-]+@mail\.techsynccrm\.invalid>$/.test(message.rfcMessageId)) return
  const ctx = await accountContext(account), token = await accessToken(account), original = await contentOf(message)
  if (!original) return
  const result = await provider.api(token, 'messages', { query: { q: `after:${Math.floor(message.occurredAt.getTime() / 1000)} -in:spam -in:trash from:mailer-daemon@googlemail.com "${message.rfcMessageId.slice(1, -1)}"`, maxResults: 5 }, fields: 'messages(id)' })
  for (const item of result.messages || []) {
    const path = `messages/${encodeURIComponent(item.id)}`
    const metadata = await provider.api(token, path, { query: { format: 'metadata', metadataHeaders: ['From', 'To', 'In-Reply-To', 'References', 'Authentication-Results'] }, fields: 'payload(mimeType,headers),sizeEstimate,labelIds' })
    const headers = headerMap(metadata), refs = `${headers['in-reply-to'] || ''} ${headers.references || ''}`.match(/<[^<>\r\n]+>/g) || []
    // Use the first receiving Google's authentication result, rather than a later supplied header.
    const auth = (metadata.payload?.headers || []).find((h) => h.name.toLowerCase() === 'authentication-results' && /^mx\.google\.com;/i.test(h.value.trim()))?.value || ''
    if (addresses(headers.from)[0] !== 'mailer-daemon@googlemail.com' || !addresses(headers.to).includes(account.email) || !/dkim=pass\b[^;]*header\.(?:i|d)=@?(?:googlemail\.com|google\.com)\b/i.test(auth) || !refs.includes(message.rfcMessageId) || metadata.payload?.mimeType !== 'multipart/report' || metadata.sizeEstimate > 1000000 || (metadata.labelIds || []).some((l) => ['SPAM', 'TRASH'].includes(l))) continue
    const report = await provider.api(token, path, { query: { format: 'full' } })
    if (!permanentDeliveryFailure(report, original)) continue
    await prisma.$transaction(async (tx) => {
      await accountContext(account, tx)
      if (!await tx.gmailAccount.count({ where: { id: account.id, organizationId: ctx.orgId, generation: account.generation, credentialEnc: { not: null } } })) return
      const changed = await tx.emailMessage.updateMany({ where: { id: message.id, organizationId: ctx.orgId, status: 'provider_accepted' }, data: { status: 'bounced', lastError: 'EMAIL_DELIVERY_FAILED' } })
      if (!changed.count) return
      await tx.emailSuppression.upsert({ where: { organizationId_recipientKey: { organizationId: ctx.orgId, recipientKey: original.to[0] } }, create: { organizationId: ctx.orgId, recipientKey: original.to[0], reason: 'permanent_delivery_failure' }, update: {} })
      await emit(tx, { ...ctx, actorType: 'system' }, 'email.bounced', { entityType: 'email_message', entityId: message.id }, { messageId: message.id })
    })
    return
  }
}
