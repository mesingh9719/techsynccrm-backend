import crypto from 'node:crypto'
import { prisma } from '../../db/prisma.js'
import { enqueue } from '../../jobs/queue.js'
import { recordAudit } from '../../lib/audit.js'
import { parseListQuery, buildPage } from '../../lib/pagination.js'
import { loadRecord } from '../../services/recordRef.service.js'
import { accessibleFile } from '../../services/file.service.js'
import { hasPermission } from '../../config/permissions.js'
import { open, seal } from './vault.js'
import { provider } from './provider.js'
import { permitEmail, ownAccount, assertThreadAccess, sendRecord } from './access.js'
import { requireConfiguration, settings, gmailError } from './config.js'
import { cleanHtml, plainText, fillTemplate, normalizeEmail, excluded, safeHeader } from './content.js'

export const fileTypes = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
export async function attachmentFiles(ctx, ids) {
  if (ids.length > 3 || new Set(ids).size !== ids.length) throw gmailError('EMAIL_ATTACHMENT_TOO_LARGE', 'Choose up to three different files.', 413)
  const files = []
  for (const id of ids) {
    const row = await accessibleFile(ctx, id)
    if (row.status !== 'ready' || !fileTypes.has(row.contentType)) throw gmailError('EMAIL_ATTACHMENT_INVALID', 'Choose a ready PDF, document, spreadsheet or image from CRM files.', 422)
    files.push(row)
  }
  if (files.reduce((sum, f) => sum + Number(f.sizeBytes), 0) > 10 * 1024 * 1024) throw gmailError('EMAIL_ATTACHMENT_TOO_LARGE', 'Keep attachments under 10 MiB in total.', 413)
  return files
}
export const contentOf = async (row) => {
  if (!row.contentEnc) return null
  const account = row.account || await prisma.gmailAccount.findFirst({ where: { id: row.accountId, organizationId: row.organizationId } })
  if (!account) return null
  return open(await provider.unwrapKey(account), account, `message:${row.id}`, row.contentEnc)
}
export function messageStatus(row) {
  return { id: row.id, threadId: row.threadId, status: row.status, direction: row.direction, occurredAt: row.occurredAt, acceptedAt: row.acceptedAt, lastError: row.lastError }
}
export async function getMessage(ctx, id) {
  const row = await prisma.emailMessage.findFirst({ where: { organizationId: ctx.orgId, id }, include: { account: true } })
  if (!row) throw gmailError('NOT_FOUND', 'This email is unavailable.', 404)
  await assertThreadAccess(ctx, row.threadId)
  if (row.expiresAt <= new Date()) return { ...messageStatus(row), content: null, status: 'redacted' }
  return { ...messageStatus(row), content: await contentOf(row), canReply: Boolean(row.contentEnc && hasPermission(ctx.permissions, 'email.send')) }
}
export async function queueSend(ctx, input, idempotencyKey) {
  requireConfiguration(); permitEmail(ctx)
  if (!/^[\w-]{16,100}$/.test(idempotencyKey || '')) throw gmailError('EMAIL_IDEMPOTENCY_REQUIRED', 'Reopen the composer and try again.', 422)
  const requestHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const existing = await prisma.emailMessage.findFirst({ where: { organizationId: ctx.orgId, actorId: ctx.userId, idempotencyKey } })
  if (existing) {
    await assertThreadAccess(ctx, existing.threadId)
    if (existing.requestHash !== requestHash) throw gmailError('EMAIL_IDEMPOTENCY_CONFLICT', 'This send request changed. Open a new draft.')
    return messageStatus(existing)
  }
  const account = await ownAccount(ctx), record = await sendRecord(ctx, input.entityType, input.entityId)
  const to = normalizeEmail(input.to)
  if (!(record.emails || []).some((e) => normalizeEmail(e.value) === to) || excluded(to, account) || to === account.email) throw gmailError('EMAIL_RECIPIENT_INVALID', 'Choose an allowed email address on this record.', 422)
  if (await prisma.emailSuppression.count({ where: { organizationId: ctx.orgId, recipientKey: to } })) throw gmailError('EMAIL_SUPPRESSED', 'This email address is suppressed. Review the contact before sending.')
  const files = await attachmentFiles(ctx, input.attachmentFileIds)
  const fields = { firstName: record.firstName, lastName: record.lastName, name: record.displayName, company: record.companyName || '', owner: ctx.user?.fullName || (await prisma.user.findUnique({ where: { id: ctx.userId }, select: { fullName: true } }))?.fullName, workspace: ctx.organization?.name || (await prisma.organization.findUnique({ where: { id: ctx.orgId }, select: { name: true } }))?.name }
  const subject = safeHeader(fillTemplate(input.subject, fields)).trim()
  const html = cleanHtml(fillTemplate(`${input.bodyHtml}${account.signatureHtml ? `<br>${account.signatureHtml}` : ''}`, fields, true))
  if (Buffer.byteLength(html) > 200000 || !plainText(html)) throw gmailError('EMAIL_BODY_INVALID', 'Write a message under 200 KB.', 422)
  let reply = null, replyContent = null
  if (input.replyToMessageId) {
    reply = await prisma.emailMessage.findFirst({ where: { organizationId: ctx.orgId, id: input.replyToMessageId, contentEnc: { not: null }, expiresAt: { gt: new Date() } } })
    const link = reply && await prisma.emailRecordLink.count({ where: { organizationId: ctx.orgId, threadId: reply.threadId, [input.entityType === 'lead' ? 'leadId' : 'contactId']: input.entityId } })
    if (!link) throw gmailError('NOT_FOUND', 'This reply is unavailable for this record.', 404)
    replyContent = await contentOf(reply)
    if (![normalizeEmail(replyContent.from), ...replyContent.to.map(normalizeEmail)].includes(to)) throw gmailError('EMAIL_RECIPIENT_INVALID', 'Choose the recipient from this conversation.', 422)
  }
  const id = crypto.randomUUID(), now = new Date(Math.floor(Date.now() / 1000) * 1000), rfcMessageId = `<${id}@mail.techsynccrm.invalid>`
  const content = { from: account.email, to: [to], subject, html, text: plainText(html), rfcMessageId, date: now.toISOString(), inReplyTo: reply?.rfcMessageId || null,
    references: [...new Set([...(replyContent?.references || []), ...(reply ? [reply.rfcMessageId] : [])])].slice(-30), attachments: files.map((f) => ({ id: f.id, name: f.originalName, contentType: f.contentType, size: Number(f.sizeBytes) })) }
  const key = await provider.unwrapKey(account)
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.gmailAccount.findFirst({ where: { id: account.id, organizationId: ctx.orgId, generation: account.generation, credentialEnc: { not: null }, status: { in: ['connected', 'syncing', 'delayed'] } } })
      if (!current) throw gmailError('GMAIL_RECONNECT_REQUIRED', 'Mailbox settings changed. Try again.')
      const threadId = reply?.threadId || crypto.randomUUID()
      if (!reply) {
        await tx.emailThread.create({ data: { id: threadId, organizationId: ctx.orgId, rootKey: `send:${id}`, lastMessageAt: now } })
        await tx.emailRecordLink.create({ data: { organizationId: ctx.orgId, threadId, [input.entityType === 'lead' ? 'leadId' : 'contactId']: input.entityId } })
      }
      const row = await tx.emailMessage.create({ data: { id, organizationId: ctx.orgId, accountId: account.id, threadId, actorId: ctx.userId, direction: 'outbound', status: 'queued', contentEnc: seal(key, account, `message:${id}`, content), rfcMessageId, generation: account.generation, idempotencyKey, requestHash, attachmentFileIds: input.attachmentFileIds, occurredAt: now, expiresAt: new Date(now.getTime() + settings().retentionDays * 86400000) } })
      await recordAudit(tx, ctx, { action: 'email.queued', entityType: 'email_message', entityId: id })
      return messageStatus(row)
    })
  } catch (err) {
    if (err.code === 'P2002') {
      const row = await prisma.emailMessage.findFirst({ where: { organizationId: ctx.orgId, actorId: ctx.userId, idempotencyKey } })
      if (row?.requestHash === requestHash) return messageStatus(row)
      throw gmailError('EMAIL_IDEMPOTENCY_CONFLICT', 'This send request changed.')
    }
    throw err
  } finally { await enqueue('gmail.send', { organizationId: ctx.orgId, messageId: id }).catch(() => {}) }
}
export async function listThreads(ctx, entityType, entityId, query) {
  await loadRecord(ctx, entityType, entityId)
  const page = parseListQuery(query, { sortable: { lastMessageAt: 'date' }, defaultSort: '-lastMessageAt' })
  const rows = await prisma.emailThread.findMany({ where: { AND: [{ organizationId: ctx.orgId, records: { some: { organizationId: ctx.orgId, [entityType === 'lead' ? 'leadId' : 'contactId']: entityId } } }, page.cursorWhere] }, orderBy: page.orderBy, take: page.take, include: { messages: { orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 1, include: { account: true } }, _count: { select: { messages: true } } } })
  const result = buildPage(rows, page)
  return { ...result, items: await Promise.all(result.items.map(async (thread) => ({ id: thread.id, lastMessageAt: thread.lastMessageAt, count: thread._count.messages, latest: thread.messages[0] ? { ...messageStatus(thread.messages[0]), content: thread.messages[0].expiresAt > new Date() ? await contentOf(thread.messages[0]) : null } : null }))) }
}
export async function threadMessages(ctx, id, query) {
  await assertThreadAccess(ctx, id)
  const page = parseListQuery(query, { sortable: { occurredAt: 'date' }, defaultSort: '-occurredAt' })
  const rows = await prisma.emailMessage.findMany({ where: { AND: [{ organizationId: ctx.orgId, threadId: id }, page.cursorWhere] }, orderBy: page.orderBy, take: page.take, include: { account: true } })
  const result = buildPage(rows, page)
  return { ...result, items: await Promise.all(result.items.map(async (r) => ({ ...messageStatus(r), content: r.expiresAt > new Date() ? await contentOf(r) : null }))) }
}
export async function templates(ctx) {
  return prisma.emailTemplate.findMany({ where: { organizationId: ctx.orgId, OR: [{ ownerId: ctx.userId }, { shared: true }] }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 100 })
}
export async function saveTemplate(ctx, input, id) {
  permitEmail(ctx, 'email.templates.write.own')
  const old = id && await prisma.emailTemplate.findFirst({ where: { id, organizationId: ctx.orgId, OR: [{ ownerId: ctx.userId }, ...(hasPermission(ctx.permissions, 'email.templates.manage') ? [{ shared: true }] : [])] } })
  if (id && !old) throw gmailError('NOT_FOUND', 'This template is unavailable.', 404)
  if ((input.shared || old?.shared) && !hasPermission(ctx.permissions, 'email.templates.manage')) throw gmailError('FORBIDDEN', 'Ask an owner or admin to manage shared templates.', 403)
  const data = { ...input, bodyHtml: cleanHtml(input.bodyHtml), subject: safeHeader(input.subject) }
  return id ? prisma.emailTemplate.update({ where: { id, organizationId: ctx.orgId }, data: { ...data, version: { increment: 1 } } }) : prisma.emailTemplate.create({ data: { ...data, organizationId: ctx.orgId, ownerId: ctx.userId } })
}
export async function deleteTemplate(ctx, id) {
  permitEmail(ctx, 'email.templates.write.own')
  const row = await prisma.emailTemplate.findFirst({ where: { id, organizationId: ctx.orgId } })
  if (!row || row.ownerId !== ctx.userId && !hasPermission(ctx.permissions, 'email.templates.manage')) throw gmailError('NOT_FOUND', 'This template is unavailable.', 404)
  if (row.shared && !hasPermission(ctx.permissions, 'email.templates.manage')) throw gmailError('FORBIDDEN', 'Ask an admin to manage shared templates.', 403)
  await prisma.emailTemplate.delete({ where: { id, organizationId: ctx.orgId } }); return { deleted: true }
}
