import crypto from 'node:crypto'
import { prisma, DB_NULL } from '../../db/prisma.js'
import { enqueue } from '../../jobs/queue.js'
import { emit } from '../../events/outbox.js'
import { logger } from '../../lib/logger.js'
import { visibilityWhere, canAccessRecord } from '../../lib/visibility.js'
import { recordLeadActivity } from '../../services/lead.service.js'
import { loadRecord } from '../../services/recordRef.service.js'
import { objectStore } from '../../storage/objectStore.js'
import { provider } from './provider.js'
import { accountContext, assertThreadAccess, sendRecord } from './access.js'
import { contentOf, attachmentFiles } from './mail.js'
import { open, seal } from './vault.js'
import { settings, ACTIVE, gmailError } from './config.js'
import { addresses, normalizeEmail, headerMap, decodeMessage, cleanHtml, contentFingerprint, excluded, mimeMessage } from './content.js'

const log = logger.child({ component: 'gmail' })
const accessTokens = new Map()
export function safeFailure(error) {
  const allowed = new Set(['GMAIL_RECONNECT_REQUIRED', 'GMAIL_RATE_LIMITED', 'GMAIL_HISTORY_EXPIRED', 'GMAIL_ENCRYPTION_UNAVAILABLE', 'GMAIL_MEMBER_INACTIVE', 'FEATURE_NOT_IN_PLAN', 'FORBIDDEN', 'NOT_FOUND', 'EMAIL_RECIPIENT_INVALID', 'EMAIL_SUPPRESSED', 'EMAIL_ATTACHMENT_INVALID', 'EMAIL_ATTACHMENT_TOO_LARGE', 'EMAIL_RECORD_CLOSED', 'GMAIL_MESSAGE_TOO_LARGE', 'EMAIL_SEND_UNKNOWN', 'EMAIL_SEND_REJECTED'])
  return allowed.has(error?.code) ? error.code : 'GMAIL_TEMPORARILY_UNAVAILABLE'
}
const later = (attempt = 1, floor = 30) => new Date(Date.now() + Math.min(86400, Math.max(floor, 30 * 2 ** Math.min(attempt, 8))) * (1 + Math.random() * .2) * 1000)
async function currentAccount(orgId, accountId) {
  const row = await prisma.gmailAccount.findFirst({ where: { organizationId: orgId, id: accountId, status: { in: ['connected', 'syncing', 'delayed'] }, credentialEnc: { not: null }, deletionRequestedAt: null } })
  if (!row) throw gmailError('GMAIL_NOT_CONNECTED', 'Mailbox is disconnected.')
  const ctx = await accountContext(row)
  return { row, ctx }
}
async function stillActive(account) {
  const { row, ctx } = await currentAccount(account.organizationId, account.id)
  if (row.generation !== account.generation) throw gmailError('GMAIL_RECONNECT_REQUIRED', 'Mailbox configuration changed.')
  return ctx
}
export async function accessToken(account) {
  const cached = accessTokens.get(account.id)
  if (cached?.generation === account.generation && cached.expiresAt > Date.now() + 60000) return cached.token
  const refreshUntil = new Date(Date.now() + 45000)
  const claimed = await prisma.gmailSyncState.updateMany({ where: { organizationId: account.organizationId, accountId: account.id, OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: new Date() } }] }, data: { refreshLeaseUntil: refreshUntil } })
  if (!claimed.count) throw gmailError('GMAIL_REFRESH_BUSY', 'Gmail access is refreshing. Try again shortly.', 503)
  try {
    await stillActive(account)
    const key = await provider.unwrapKey(account), credentials = open(key, account, 'credentials', account.credentialEnc)
    const tokens = await provider.refresh(credentials.refreshToken)
    if (!tokens.access_token) throw gmailError('GMAIL_RECONNECT_REQUIRED', 'Reconnect Gmail.')
    await stillActive(account)
    if (tokens.refresh_token) await prisma.gmailAccount.updateMany({ where: { organizationId: account.organizationId, id: account.id, generation: account.generation, credentialEnc: { not: null } }, data: { credentialEnc: seal(key, account, 'credentials', { refreshToken: tokens.refresh_token }) } })
    if (accessTokens.size > 500) accessTokens.clear()
    accessTokens.set(account.id, { generation: account.generation, token: tokens.access_token, expiresAt: tokens.expiry_date || Date.now() + 300000 })
    return tokens.access_token
  } catch (error) {
    if (error.code === 'GMAIL_RECONNECT_REQUIRED') await prisma.gmailAccount.updateMany({ where: { organizationId: account.organizationId, id: account.id, generation: account.generation }, data: { status: 'reconnect_required', lastError: 'GMAIL_RECONNECT_REQUIRED' } })
    throw error
  } finally { await prisma.gmailSyncState.updateMany({ where: { organizationId: account.organizationId, accountId: account.id, refreshLeaseUntil: refreshUntil }, data: { refreshLeaseUntil: null } }) }
}
/** Content-free provenance; provider messages cannot be edited through manual activity APIs. */
async function attachActivity(tx, ctx, message) {
  if (message.activityId) return
  const links = await tx.emailRecordLink.findMany({ where: { organizationId: ctx.orgId, threadId: message.threadId } })
  const visible = []
  for (const link of links) {
    const ref = { entityType: link.leadId ? 'lead' : 'contact', entityId: link.leadId || link.contactId }
    try { await loadRecord(ctx, ref.entityType, ref.entityId, 'read', tx); visible.push(ref) } catch (err) { if (![403, 404].includes(err.statusCode)) throw err }
  }
  if (!visible.length) throw gmailError('NOT_FOUND', 'Record access changed.', 404)
  const primary = visible.find((r) => r.entityType === 'contact') || visible[0]
  const at = new Date(message.acceptedAt || message.occurredAt)
  const activity = await tx.activity.create({ data: { organizationId: ctx.orgId, type: 'email', ...primary, direction: message.direction, subject: message.direction === 'inbound' ? 'Email received' : 'Email sent', body: null, actorId: message.direction === 'outbound' ? message.actorId : null, occurredAt: at, meta: { provider: 'gmail', emailMessageId: message.id, threadId: message.threadId } } })
  await tx.activityLink.createMany({ data: visible.map((r) => ({ ...r, organizationId: ctx.orgId, activityId: activity.id, occurredAt: at })), skipDuplicates: true })
  await tx.emailMessage.update({ where: { id: message.id, organizationId: ctx.orgId }, data: { activityId: activity.id } })
  for (const ref of visible) {
    if (ref.entityType === 'lead') await recordLeadActivity(ctx, ref.entityId, { outbound: message.direction === 'outbound', at }, tx)
    else await tx.contact.updateMany({ where: { organizationId: ctx.orgId, id: ref.entityId, lastActivityAt: { lt: at } }, data: { lastActivityAt: at } })
  }
  await emit(tx, { ...ctx, actorType: 'system' }, message.direction === 'inbound' ? 'email.received' : 'email.sent', { entityType: primary.entityType, entityId: primary.entityId }, { messageId: message.id, threadId: message.threadId })
}
async function accepted(account, message, result) {
  await stillActive(account)
  return prisma.$transaction(async (tx) => {
    const ctx = await accountContext(account, tx)
    await tx.$queryRaw`SELECT id FROM email_messages WHERE organization_id = ${account.organizationId}::uuid AND id = ${message.id}::uuid FOR UPDATE`
    const current = await tx.emailMessage.findFirst({ where: { organizationId: account.organizationId, id: message.id } })
    if (!current || current.status === 'redacted') return
    const row = await tx.emailMessage.update({ where: { id: message.id, organizationId: account.organizationId }, data: { status: 'provider_accepted', acceptedAt: new Date(), leaseUntil: null, lastError: null } })
    await tx.emailMailboxCopy.upsert({ where: { organizationId_accountId_gmailMessageId: { organizationId: account.organizationId, accountId: account.id, gmailMessageId: result.id } }, create: { organizationId: account.organizationId, accountId: account.id, messageId: message.id, gmailMessageId: result.id, gmailThreadId: result.threadId }, update: {} })
    await attachActivity(tx, ctx, row)
    await tx.emailThread.update({ where: { id: row.threadId, organizationId: account.organizationId }, data: { lastMessageAt: row.acceptedAt } })
  })
}
export async function reconcileUnknown(message) {
  const { row: account } = await currentAccount(message.organizationId, message.accountId)
  const result = await provider.api(await accessToken(account), 'messages', { query: { q: `in:sent rfc822msgid:${message.rfcMessageId}`, maxResults: 2 }, fields: 'messages(id,threadId)' })
  if (result.messages?.length === 1) await accepted(account, message, result.messages[0])
}
export async function sendQueued({ organizationId, messageId }) {
  if (!settings().enabled) return
  const claimed = await prisma.emailMessage.updateMany({ where: { organizationId, id: messageId, status: 'queued', nextAttemptAt: { lte: new Date() } }, data: { status: 'sending', leaseUntil: new Date(Date.now() + 120000), attempts: { increment: 1 } } })
  if (!claimed.count) return
  const message = await prisma.emailMessage.findFirst({ where: { organizationId, id: messageId } })
  let attempted = false
  try {
    const { row: account, ctx } = await currentAccount(organizationId, message.accountId)
    if (account.generation !== message.generation) throw gmailError('GMAIL_RECONNECT_REQUIRED', 'Mailbox settings changed.')
    const ref = await assertThreadAccess(ctx, message.threadId)
    const record = await sendRecord(ctx, ref.entityType, ref.id)
    const content = await contentOf(message), recipient = content.to[0]
    if (!(record.emails || []).some((e) => normalizeEmail(e.value) === recipient) || excluded(recipient, account)) throw gmailError('EMAIL_RECIPIENT_INVALID', 'Record email changed.')
    if (await prisma.emailSuppression.count({ where: { organizationId, recipientKey: recipient } })) throw gmailError('EMAIL_SUPPRESSED', 'Recipient is suppressed.')
    const files = await attachmentFiles(ctx, message.attachmentFileIds), attachments = []
    for (const file of files) {
      const bytes = await objectStore.bytes(file.storageKey)
      if (bytes.length !== Number(file.sizeBytes) || bytes.length > 10 * 1024 * 1024) throw gmailError('EMAIL_ATTACHMENT_INVALID', 'File changed.')
      attachments.push({ filename: file.originalName, content: bytes, contentType: file.contentType })
    }
    const token = await accessToken(account)
    let threadId
    if (content.inReplyTo) {
      const parent = await prisma.emailMessage.findFirst({ where: { organizationId, threadId: message.threadId, rfcMessageId: content.inReplyTo } })
      if (parent) threadId = (await prisma.emailMailboxCopy.findFirst({ where: { organizationId, accountId: account.id, messageId: parent.id } }))?.gmailThreadId
    }
    const raw = await mimeMessage({ ...content, to: recipient, attachments })
    await stillActive(account)
    if (!await prisma.emailMessage.count({ where: { organizationId, id: messageId, status: 'sending', leaseUntil: { gt: new Date() } } })) return
    attempted = true
    const result = await provider.api(token, 'messages/send', { method: 'POST', body: { raw, ...(threadId && { threadId }) }, send: true })
    if (!result.id || !result.threadId) throw gmailError('EMAIL_SEND_UNKNOWN', 'Check Gmail before retrying.')
    await accepted(account, message, result)
    log.info({ accountId: account.id, messageId, outcome: 'provider_accepted' }, 'Gmail send completed')
  } catch (error) {
    const code = safeFailure(error)
    const uncertain = code === 'EMAIL_SEND_UNKNOWN' || attempted && (error.uncertain || !error.providerStatus)
    const retryable = !uncertain && (['GMAIL_RATE_LIMITED', 'GMAIL_TEMPORARILY_UNAVAILABLE', 'GMAIL_ENCRYPTION_UNAVAILABLE'].includes(code)) && message.attempts < 5
    await prisma.emailMessage.updateMany({ where: { organizationId, id: messageId, status: 'sending' }, data: { status: uncertain ? 'unknown' : retryable ? 'queued' : 'failed', leaseUntil: null, lastError: uncertain ? 'EMAIL_SEND_UNKNOWN' : code, nextAttemptAt: later(message.attempts, error.retryAfter) } })
    log.warn({ messageId, outcome: uncertain ? 'unknown' : 'failed', code }, 'Gmail send needs attention')
  }
}
async function historyBaseline(account, token, state) {
  if (!state.historyId) return { baselineId: (await provider.api(token, 'profile', { fields: 'historyId' })).historyId, gap: false }
  let pageToken, lastId = state.historyId
  try {
    for (let i = 0; i < 20; i++) {
      // Opaque change IDs only; never fetch messages based on these IDs alone.
      const result = await provider.api(token, 'history', { query: { startHistoryId: state.historyId, pageToken, maxResults: 500, historyTypes: 'messageAdded' }, fields: 'historyId,nextPageToken,history(id)' })
      lastId = result.historyId || lastId; pageToken = result.nextPageToken
      if (!pageToken) return { baselineId: lastId, gap: false }
    }
    return { baselineId: (await provider.api(token, 'profile', { fields: 'historyId' })).historyId, gap: true }
  } catch (error) {
    if (error.code !== 'GMAIL_HISTORY_EXPIRED') throw error
    return { baselineId: (await provider.api(token, 'profile', { fields: 'historyId' })).historyId, gap: true }
  }
}
async function candidateRecord(account, ctx, headers, tokenDate) {
  const from = addresses(headers.from), to = [...addresses(headers.to), ...addresses(headers.cc)]
  const outbound = from.length === 1 && from[0] === account.email
  if (!outbound && !to.includes(account.email)) return null
  const external = [...new Set((outbound ? to : from).filter((e) => e !== account.email && !excluded(e, account)))]
  if (external.length !== 1) return null
  const email = external[0]
  if (await prisma.membership.count({ where: { organizationId: ctx.orgId, user: { email } } })) return null
  const matches = await prisma.leadEmail.findMany({ where: { organizationId: ctx.orgId, email, lead: { deletedAt: null } }, select: { leadId: true, lead: { select: { ownerId: true, status: true, createdAt: true } } }, take: 3 })
  // Duplicate addresses are deliberately unresolved, even if only one is currently visible.
  if (matches.length !== 1) return null
  const match = matches[0]
  if (['lost', 'junk', 'converted'].includes(match.lead.status) || !canAccessRecord(ctx, 'leads', 'read', match.lead.ownerId)) return null
  if (tokenDate < account.syncFrom || tokenDate < match.lead.createdAt) return null
  return { entityType: 'lead', entityId: match.leadId, outbound, email }
}
export async function ingestCandidate(account, ctx, token, gmailId) {
  if (await prisma.emailMailboxCopy.count({ where: { organizationId: ctx.orgId, accountId: account.id, gmailMessageId: gmailId } })) return false
  const candidate = async (options) => {
    try { return await provider.api(token, `messages/${encodeURIComponent(gmailId)}`, options) }
    catch (error) { if (['GMAIL_MESSAGE_GONE', 'GMAIL_MESSAGE_TOO_LARGE'].includes(error.code)) return null; throw error }
  }
  const metadata = await candidate({ query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'In-Reply-To', 'References', 'Date'] }, fields: 'id,threadId,labelIds,internalDate,sizeEstimate,payload/headers' })
  if (!metadata) return false
  if ((metadata.labelIds || []).some((l) => ['SPAM', 'TRASH', 'DRAFT'].includes(l)) || metadata.sizeEstimate > 15 * 1024 * 1024) return false
  const headers = headerMap(metadata), receivedAt = new Date(Number(metadata.internalDate))
  if (!Number.isFinite(receivedAt.getTime()) || receivedAt.getTime() < Date.now() - settings().retentionDays * 86400000) return false
  let match = await candidateRecord(account, ctx, headers, receivedAt)
  // Explicit CRM-initiated threads may continue after conversion and address ambiguity.
  const rfcId = String(headers['message-id'] || '').slice(0, 500)
  const references = String(headers.references || '').match(/<[^<>\r\n]{1,490}>/g)?.slice(-30) || []
  const inReplyTo = String(headers['in-reply-to'] || '').match(/<[^<>\r\n]{1,490}>/)?.[0]
  const parent = await prisma.emailMessage.findFirst({ where: { organizationId: ctx.orgId, rfcMessageId: { in: [rfcId, inReplyTo, ...references].filter(Boolean) }, direction: 'outbound', status: { in: ['provider_accepted', 'unknown', 'sending'] } } })
  if (parent) {
    try {
      const record = await assertThreadAccess(ctx, parent.threadId), saved = await contentOf(parent)
      const from = addresses(headers.from), to = [...addresses(headers.to), ...addresses(headers.cc)]
      const outbound = from.length === 1 && from[0] === account.email
      const correspondent = outbound ? to : from
      if (correspondent.length === 1 && saved?.to.includes(correspondent[0]) && !excluded(correspondent[0], account) && (outbound || to.includes(account.email)))
        match = { entityType: record.entityType, entityId: record.id, outbound, email: correspondent[0] }
    } catch (err) { if (![403, 404].includes(err.statusCode)) throw err }
  }
  if (!match) return false // Crucially, no full body read for unmatched headers.
  const activeCtx = await stillActive(account)
  try { await loadRecord(activeCtx, match.entityType, match.entityId) }
  catch (error) { if ([403, 404].includes(error.statusCode)) return false; throw error }
  const currentRecord = await prisma[match.entityType].findFirst({ where: { organizationId: ctx.orgId, id: match.entityId, deletedAt: null } })
  if (!(currentRecord?.emails || []).some((e) => normalizeEmail(e.value) === match.email)) return false
  const full = await candidate({ query: { format: 'full' } })
  if (!full) return false
  const body = decodeMessage(full), date = new Date(headers.date)
  const content = { ...body, from: addresses(headers.from)[0], to: addresses(headers.to), subject: String(headers.subject || '(No subject)').slice(0, 998), rfcMessageId: rfcId || `<gmail-${account.id}-${gmailId}@unknown.invalid>`, date: (Number.isFinite(date.getTime()) ? date : receivedAt).toISOString(), references, inReplyTo: inReplyTo || null }
  const fingerprint = contentFingerprint(ctx.orgId, content), key = await provider.unwrapKey(account), id = crypto.randomUUID()
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.gmailAccount.findFirst({ where: { id: account.id, organizationId: ctx.orgId, generation: account.generation, status: { in: ['connected', 'syncing', 'delayed'] }, deletionRequestedAt: null } })
    if (!fresh) throw gmailError('GMAIL_NOT_CONNECTED', 'Mailbox changed.')
    const freshCtx = await accountContext(fresh, tx)
    await loadRecord(freshCtx, match.entityType, match.entityId, 'read', tx)
    const target = await tx[match.entityType].findFirst({ where: { organizationId: ctx.orgId, id: match.entityId, deletedAt: null } })
    if (!target || !(target.emails || []).some((e) => normalizeEmail(e.value) === match.email)) throw gmailError('EMAIL_RECIPIENT_INVALID', 'Record email changed.')
    // Serialize canonical ingestion to avoid two mailboxes creating the same activity.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.orgId}:${fingerprint}`}, 0))`
    let message = await tx.emailMessage.findFirst({ where: { organizationId: ctx.orgId, OR: [{ fingerprint }, ...(parent?.rfcMessageId === rfcId ? [{ id: parent.id }] : [])] } })
    if (!message) {
      const copy = await tx.emailMailboxCopy.findFirst({ where: { organizationId: ctx.orgId, accountId: account.id, gmailThreadId: metadata.threadId }, include: { message: { select: { threadId: true } } } })
      const copyLink = copy && await tx.emailRecordLink.count({ where: { organizationId: ctx.orgId, threadId: copy.message.threadId, [match.entityType === 'lead' ? 'leadId' : 'contactId']: match.entityId } })
      const threadId = parent?.threadId || (copyLink ? copy.message.threadId : null) || crypto.randomUUID()
      if (!parent && !copyLink) {
        await tx.emailThread.create({ data: { id: threadId, organizationId: ctx.orgId, rootKey: `${account.id}:${metadata.threadId}:${match.entityType}:${match.entityId}`, lastMessageAt: receivedAt } })
        await tx.emailRecordLink.create({ data: { organizationId: ctx.orgId, threadId, [match.entityType === 'lead' ? 'leadId' : 'contactId']: match.entityId } })
      }
      message = await tx.emailMessage.create({ data: { id, organizationId: ctx.orgId, accountId: account.id, threadId, actorId: match.outbound ? account.userId : null, direction: match.outbound ? 'outbound' : 'inbound', status: match.outbound ? 'provider_accepted' : 'received', contentEnc: seal(key, account, `message:${id}`, content), fingerprint, rfcMessageId: content.rfcMessageId, generation: account.generation, occurredAt: receivedAt, acceptedAt: match.outbound ? receivedAt : null, expiresAt: new Date(receivedAt.getTime() + settings().retentionDays * 86400000) } })
    } else if (['sending', 'unknown'].includes(message.status) && parent?.rfcMessageId === rfcId) {
      message = await tx.emailMessage.update({ where: { organizationId: ctx.orgId, id: message.id }, data: { status: 'provider_accepted', acceptedAt: receivedAt, leaseUntil: null, lastError: null } })
    }
    await tx.emailMailboxCopy.upsert({ where: { organizationId_accountId_gmailMessageId: { organizationId: ctx.orgId, accountId: account.id, gmailMessageId: gmailId } }, create: { organizationId: ctx.orgId, accountId: account.id, messageId: message.id, gmailMessageId: gmailId, gmailThreadId: metadata.threadId }, update: {} })
    await tx.$queryRaw`SELECT id FROM email_messages WHERE organization_id = ${ctx.orgId}::uuid AND id = ${message.id}::uuid FOR UPDATE`
    message = await tx.emailMessage.findUnique({ where: { id: message.id } })
    if (message.status !== 'redacted') await attachActivity(tx, freshCtx, message)
    await tx.emailThread.updateMany({ where: { organizationId: ctx.orgId, id: message.threadId, lastMessageAt: { lt: receivedAt } }, data: { lastMessageAt: receivedAt } })
  })
  return true
}
export async function syncMailbox({ organizationId, accountId }) {
  if (!settings().enabled || !settings().syncEnabled) return
  const lease = crypto.randomUUID(), until = new Date(Date.now() + 150000)
  const claimed = await prisma.gmailSyncState.updateMany({ where: { organizationId, accountId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseUntil: until, leaseToken: lease } })
  if (!claimed.count) return
  try {
    const { row: account, ctx } = await currentAccount(organizationId, accountId), token = await accessToken(account)
    const state = await prisma.gmailSyncState.findUnique({ where: { organizationId_accountId: { organizationId, accountId } } })
    let scan = state.scanState
    if (!scan) {
      const { baselineId, gap } = await historyBaseline(account, token, state)
      const from = Math.max(account.syncFrom.getTime(), gap ? Date.now() - 30 * 86400000 : state.searchFrom.getTime() - 120000)
      scan = { baselineId, from, upper: Date.now() + 1000, cursor: null, pageToken: null, imported: 0, started: Date.now(), initial: !state.lastSyncedAt }
      await prisma.gmailSyncState.update({ where: { organizationId_accountId: { organizationId, accountId } }, data: { scanState: scan, coverageGap: state.coverageGap || gap } })
    }
    if (scan.initial) {
      // Count durable mailbox copies, so a crash after committing a page cannot reset the import cap.
      scan.imported = await prisma.emailMailboxCopy.count({ where: { organizationId, accountId, observedAt: { gte: new Date(scan.started || account.consentAt) } } })
    }
    const contactPhase = scan.phase === 'contacts', recordKey = contactPhase ? 'contactId' : 'leadId'
    const cursorWhere = scan.cursor ? { OR: [{ email: { gt: scan.cursor.email } }, { email: scan.cursor.email, [recordKey]: { gt: scan.cursor[recordKey] } }] } : {}
    const lookups = await prisma[contactPhase ? 'contactEmail' : 'leadEmail'].findMany({
      where: { AND: [{ organizationId, [contactPhase ? 'contact' : 'lead']: { AND: [{ deletedAt: null, ...(!contactPhase && { status: { in: ['new', 'contacted', 'qualified'] } }) }, visibilityWhere(ctx, contactPhase ? 'contacts' : 'leads')] } }, cursorWhere] },
      orderBy: [{ email: 'asc' }, { [recordKey]: 'asc' }], take: 50,
    })
    const boundWhere = { organizationId, contactId: { not: null }, thread: { messages: { some: { copies: { some: { organizationId, accountId } } } } } }
    // Scan contact addresses in bounded pages, then select only existing conversation bindings.
    const bound = contactPhase ? await prisma.emailRecordLink.findMany({ where: { ...boundWhere, contactId: { in: lookups.map((r) => r.contactId) } }, select: { contactId: true } }) : []
    const boundIds = new Set(bound.map((r) => r.contactId))
    const hasContacts = !contactPhase && Boolean(await prisma.emailRecordLink.findFirst({ where: boundWhere, select: { id: true } }))
    const internal = new Set((await prisma.membership.findMany({ where: { organizationId }, select: { user: { select: { email: true } } } })).map((m) => m.user.email.toLowerCase()))
    const emails = [...new Set(lookups.filter((r) => !contactPhase || boundIds.has(r.contactId)).map((r) => r.email))].filter((e) => !internal.has(e) && e !== account.email && !excluded(e, account))
    const queryHash = crypto.createHash('sha256').update(JSON.stringify(emails)).digest('hex')
    if (scan.queryHash !== queryHash) scan.pageToken = null
    let nextPageToken
    if (emails.length && (!scan.initial || scan.imported < 500)) {
      const query = `after:${Math.floor(scan.from / 1000)} before:${Math.ceil(scan.upper / 1000)} -in:spam -in:trash -in:drafts {${emails.map((e) => `from:${e} to:${e}`).join(' ')}}`
      const result = await provider.api(token, 'messages', { query: { q: query, maxResults: 20, pageToken: scan.pageToken }, fields: 'messages(id),nextPageToken' })
      for (const m of result.messages || []) {
        if (Date.now() > until.getTime() - 20000) throw gmailError('GMAIL_SCAN_YIELDED', 'Continuing sync.')
        if (await ingestCandidate(account, ctx, token, m.id)) scan.imported++
        if (scan.initial && scan.imported >= 500) break
      }
      nextPageToken = result.nextPageToken
    }
    await stillActive(account)
    const capped = scan.initial && scan.imported >= 500
    const switchPhase = !nextPageToken && lookups.length < 50 && hasContacts
    const more = !capped && Boolean(nextPageToken || lookups.length === 50 || switchPhase)
    if (more) {
      scan = { ...scan, queryHash, pageToken: nextPageToken || null, cursor: switchPhase ? null : nextPageToken ? scan.cursor : lookups.at(-1), phase: switchPhase ? 'contacts' : scan.phase }
      await prisma.gmailSyncState.updateMany({ where: { organizationId, accountId, leaseToken: lease }, data: { scanState: scan, nextAttemptAt: new Date() } })
    } else {
      await prisma.gmailSyncState.updateMany({ where: { organizationId, accountId, leaseToken: lease }, data: { scanState: DB_NULL, historyId: scan.baselineId, searchFrom: new Date(scan.upper - 1000), lastSyncedAt: new Date(), nextAttemptAt: new Date(Date.now() + settings().pollSeconds * 1000), failures: 0, ...(capped && { coverageGap: true }) } })
    }
    await prisma.gmailAccount.updateMany({ where: { organizationId, id: accountId, generation: account.generation }, data: { status: more ? 'syncing' : 'connected', lastError: null } })
    log.info({ accountId, outcome: more ? 'continuing' : 'synced' }, 'Gmail sync completed')
  } catch (error) {
    const code = safeFailure(error)
    await prisma.gmailSyncState.updateMany({ where: { organizationId, accountId, leaseToken: lease }, data: { failures: { increment: 1 }, nextAttemptAt: later(2, error.retryAfter) } })
    await prisma.gmailAccount.updateMany({ where: { organizationId, id: accountId, status: { in: ['connected', 'syncing', 'delayed'] } }, data: { status: code === 'GMAIL_RECONNECT_REQUIRED' ? 'reconnect_required' : 'delayed', lastError: code } })
    log.warn({ accountId, code }, 'Gmail sync delayed')
  } finally { await prisma.gmailSyncState.updateMany({ where: { organizationId, accountId, leaseToken: lease }, data: { leaseUntil: null, leaseToken: null } }) }
}
