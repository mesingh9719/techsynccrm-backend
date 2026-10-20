import crypto from 'node:crypto'
import { prisma } from '../../db/prisma.js'
import { env } from '../../config/env.js'
import { decrypt, safeEqual } from '../../lib/crypto.js'
import { recordAudit } from '../../lib/audit.js'
import { ApiError } from '../../utils/ApiError.js'
import { enqueue } from '../../jobs/queue.js'
import { createLeadFromCapture } from '../../services/lead.service.js'
import { createLeadSchema } from '../../validators/lead.validators.js'
import { graph, graphPage } from './graph.js'
import { connectorContext, formSelect } from './connection.js'
import { parseFacebookSignedRequest, facebookRequestCutoff, lockFacebookSubject } from './identity.js'

const isId = (id) => typeof id === 'string' && /^\d{1,40}$/.test(id)
const safeError = (err) => err instanceof ApiError ? err.message.slice(0, 500) : 'Facebook processing failed. Retry or reconnect Facebook.'
export function verifyFacebookSignature(rawBody, signature) {
  if (!env.FACEBOOK_APP_SECRET || !Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !/^sha256=[a-f\d]{64}$/i.test(signature)) return false
  const expected = `sha256=${crypto.createHmac('sha256', env.FACEBOOK_APP_SECRET).update(rawBody).digest('hex')}`
  return safeEqual(signature.toLowerCase(), expected)
}
export async function receiveFacebookWebhook(payload) {
  if (payload?.object !== 'page') return
  const events = []
  const entries = Array.isArray(payload.entry) ? payload.entry : []
  if (entries.length > 100 || entries.some((e) => Array.isArray(e?.changes) && e.changes.length > 100)) throw new ApiError(413, 'Webhook batch is too large.', { code: 'FACEBOOK_BATCH_TOO_LARGE' })
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    if (!isId(entry.id)) continue
    for (const change of (Array.isArray(entry.changes) ? entry.changes : [])) {
      const value = change?.value
      if (change?.field !== 'leadgen' || !isId(value?.leadgen_id) || !isId(value?.form_id)) continue
      if (value.page_id && String(value.page_id) !== entry.id) continue
      events.push({ facebookPageId: entry.id, facebookLeadId: value.leadgen_id, facebookFormId: value.form_id, adId: isId(value.ad_id) ? value.ad_id : null })
    }
  }
  if (!events.length) return
  // Commit the durable receipt before acknowledging Meta; enqueue failure is recovered by cron.
  const pages = await prisma.facebookPage.findMany({ where: { facebookPageId: { in: [...new Set(events.map((e) => e.facebookPageId))] }, enabled: true, connection: { tokenEnc: { not: '' } } }, select: { id: true, facebookPageId: true, organizationId: true } })
  const rows = events.flatMap((event) => { const page = pages.find((p) => p.facebookPageId === event.facebookPageId); return page ? [{ organizationId: page.organizationId, pageId: page.id, facebookLeadId: event.facebookLeadId, facebookFormId: event.facebookFormId, metadata: { adId: event.adId } }] : [] })
  if (rows.length) {
    await prisma.facebookLeadDelivery.createMany({ data: rows, skipDuplicates: true })
    await enqueue('facebook.recover', {}, { singletonKey: 'webhook-recovery' }).catch(() => {})
  }
}
const DEFAULT_MAPPING = { full_name: 'fullName', first_name: 'firstName', last_name: 'lastName', email: 'email', phone_number: 'phone', company_name: 'companyName', city: 'city', zip_code: 'pincode' }
export function mapFacebookLead(data, form, page) {
  const fields = Object.create(null)
  for (const field of data.field_data ?? []) {
    const target = Object.hasOwn(form.mapping, field.name) ? form.mapping[field.name] : Object.hasOwn(DEFAULT_MAPPING, field.name) ? DEFAULT_MAPPING[field.name] : ''
    if (!target || !Array.isArray(field.values)) continue
    const value = field.values.map(String).join('; ').trim()
    if (value) fields[target] = value
  }
  if (fields.fullName && !fields.firstName) { const parts = fields.fullName.split(/\s+/); fields.firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0]; fields.lastName ||= parts.length > 1 ? parts.at(-1) : null }
  const payload = { firstName: fields.firstName, lastName: fields.lastName, companyName: fields.companyName, city: fields.city, pincode: fields.pincode, requirement: fields.requirement, ownerId: form.defaultOwnerId, sourceDetail: `Page ${page.facebookPageId}; Form ${form.facebookFormId}; Lead ${data.id}`.slice(0, 200), utm: { source: 'facebook', medium: 'paid_social', ...(data.campaign_id && { campaign: String(data.campaign_id) }), ...(data.ad_id && { content: String(data.ad_id) }) } }
  if (fields.email) payload.emails = [{ value: fields.email.toLowerCase(), primary: true }]
  if (fields.phone) payload.phones = [{ raw: fields.phone, primary: true }]
  const parsed = createLeadSchema.safeParse(payload)
  if (!parsed.success) throw new ApiError(400, 'Lead fields do not match CRM validation. Adjust this form’s mapping before retrying.', { code: 'FACEBOOK_FIELD_MAPPING' })
  if (!parsed.data.firstName && !parsed.data.lastName && !parsed.data.emails?.length && !parsed.data.phones?.length) throw ApiError.badRequest('Map at least a name, email or phone for this form.')
  return parsed.data
}
export async function processFacebookDelivery(id) {
  const delivery = await prisma.facebookLeadDelivery.findUnique({ where: { id }, include: { page: { include: { connection: true } } } })
  if (!delivery || !['pending', 'failed'].includes(delivery.status) || delivery.attempts >= 5 || delivery.nextAttemptAt > new Date()) return
  try {
    const page = delivery.page
    const form = await prisma.facebookForm.findUnique({ where: { pageId_facebookFormId: { pageId: page.id, facebookFormId: delivery.facebookFormId } } })
    if (!page.enabled || !page.tokenEnc || !page.connection.tokenEnc || !form?.enabled) {
      await prisma.facebookLeadDelivery.updateMany({ where: { id, status: { in: ['pending', 'failed'] } }, data: { status: 'ignored', lastError: 'Page or form is disconnected or capture is disabled. Configure it, then retry this delivery.' } })
      return
    }
    await connectorContext(page.connection)
    const data = await graph(delivery.facebookLeadId, decrypt(page.tokenEnc), { fields: 'id,form_id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name,adset_id' })
    if (data.id !== delivery.facebookLeadId || String(data.form_id) !== form.facebookFormId) throw ApiError.badRequest('Facebook lead does not match the subscribed form.')
    await prisma.$transaction(async (tx) => {
      // Page lock serializes disconnection/form edits; receipt lock serializes duplicate jobs.
      await tx.$queryRaw`SELECT id FROM facebook_pages WHERE id = ${page.id}::uuid FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM facebook_lead_deliveries WHERE id = ${id}::uuid FOR UPDATE`
      const current = await tx.facebookLeadDelivery.findUnique({ where: { id } })
      if (!current || !['pending', 'failed'].includes(current.status) || current.attempts >= 5) return
      const livePage = await tx.facebookPage.findUnique({ where: { id: page.id }, include: { connection: true } })
      const liveForm = await tx.facebookForm.findUnique({ where: { id: form.id } })
      if (!livePage?.enabled || !livePage.tokenEnc || !livePage.connection.tokenEnc || !liveForm?.enabled) throw ApiError.conflict('Capture was disabled while this lead was loading.')
      const ctx = await connectorContext(livePage.connection, tx)
      if (liveForm.defaultOwnerId && !await tx.membership.count({ where: { organizationId: ctx.orgId, userId: liveForm.defaultOwnerId, status: 'active' } })) throw ApiError.badRequest('The selected lead owner is inactive. Update the form owner and retry.')
      const payload = mapFacebookLead(data, liveForm, livePage)
      const result = await createLeadFromCapture({ ...ctx, userId: null, actorType: 'system' }, payload, { sourceKey: 'facebook_lead_ads', dedupe: liveForm.dedupe, tx })
      await tx.facebookLeadDelivery.update({ where: { id }, data: { status: 'processed', leadId: result.lead.id, outcome: result.outcome, attempts: { increment: 1 }, processedAt: new Date(), lastError: null, metadata: { adId: data.ad_id ?? null, adName: data.ad_name ?? null, campaignId: data.campaign_id ?? null, campaignName: data.campaign_name ?? null, adsetId: data.adset_id ?? null, submittedAt: data.created_time ?? null } } })
      await recordAudit(tx, { orgId: ctx.orgId, actorType: 'system' }, { action: 'facebook.lead_captured', entityType: 'lead', entityId: result.lead.id, changes: { deliveryId: id, outcome: result.outcome } })
    }, { timeout: 20000 })
  } catch (err) {
    await prisma.facebookLeadDelivery.updateMany({ where: { id, status: { in: ['pending', 'failed'] } }, data: { status: 'failed', attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** delivery.attempts)), lastError: safeError(err) } })
    // Retry state is durable; cron owns the backoff. Avoid logging provider bodies or lead PII.
  }
}
export async function requestFacebookSync(ctx, id) {
  const form = await prisma.facebookForm.findFirst({ where: { id, organizationId: ctx.orgId, enabled: true, page: { enabled: true } } })
  if (!form) throw ApiError.notFound('Enable this form before syncing leads.')
  const changed = await prisma.facebookForm.updateMany({ where: { id, syncStatus: { notIn: ['queued', 'running'] } }, data: { syncStatus: 'queued', syncAfter: null, syncLeaseUntil: null, lastError: null } })
  if (changed.count) await enqueue('facebook.sync', { formId: id }, { singletonKey: id }).catch(() => {})
  return prisma.facebookForm.findFirst({ where: { id, organizationId: ctx.orgId }, select: formSelect })
}
export async function syncFacebookForm(id) {
  const lease = new Date(Date.now() + 3 * 60000)
  const claimed = await prisma.facebookForm.updateMany({ where: { id, enabled: true, page: { enabled: true }, OR: [{ syncStatus: 'queued' }, { syncStatus: 'running', syncLeaseUntil: { lt: new Date() } }] }, data: { syncStatus: 'running', syncLeaseUntil: lease } })
  if (!claimed.count) return
  let form = await prisma.facebookForm.findUnique({ where: { id }, include: { page: { include: { connection: true } } } })
  try {
    for (let i = 0; i < 5; i++) {
      form = await prisma.facebookForm.findUnique({ where: { id }, include: { page: { include: { connection: true } } } })
      if (!form?.enabled || !form.page.enabled || !form.page.tokenEnc || !form.page.connection.tokenEnc) throw ApiError.conflict('Page or form disconnected during sync.')
      await connectorContext(form.page.connection)
      const data = graphPage(await graph(`${form.facebookFormId}/leads`, decrypt(form.page.tokenEnc), { fields: 'id', limit: 100, after: form.syncAfter }))
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM facebook_pages WHERE id = ${form.pageId}::uuid FOR UPDATE`
        const live = await tx.facebookForm.findFirst({ where: { id, enabled: true, syncStatus: 'running', syncLeaseUntil: lease, page: { enabled: true } } })
        if (!live) throw ApiError.conflict('Sync was paused or claimed elsewhere.')
        const rows = data.items.filter((lead) => isId(lead.id)).map((lead) => ({ organizationId: form.organizationId, pageId: form.pageId, facebookLeadId: lead.id, facebookFormId: form.facebookFormId }))
        if (rows.length) await tx.facebookLeadDelivery.createMany({ data: rows, skipDuplicates: true })
        await tx.facebookForm.update({ where: { id }, data: { syncAfter: data.nextCursor, ...(data.nextCursor ? {} : { syncStatus: 'completed', lastSyncedAt: new Date(), syncLeaseUntil: null }) } })
      })
      if (!data.nextCursor) return
    }
    await prisma.facebookForm.updateMany({ where: { id, syncLeaseUntil: lease }, data: { syncStatus: 'queued', syncLeaseUntil: null } })
  } catch (err) { await prisma.facebookForm.updateMany({ where: { id, syncLeaseUntil: lease }, data: { syncStatus: 'failed', syncLeaseUntil: null, lastError: safeError(err) } }) }
}
export async function recoverFacebookJobs() {
  if (!env.FACEBOOK_APP_ID || !env.FACEBOOK_APP_SECRET) return
  await prisma.facebookOAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  const deliveries = await prisma.facebookLeadDelivery.findMany({ where: { status: { in: ['pending', 'failed'] }, attempts: { lt: 5 }, nextAttemptAt: { lte: new Date() }, page: { enabled: true } }, select: { id: true }, orderBy: { nextAttemptAt: 'asc' }, take: 100 })
  for (const delivery of deliveries) await enqueue('facebook.lead', { deliveryId: delivery.id }, { singletonKey: delivery.id })
  const forms = await prisma.facebookForm.findMany({ where: { enabled: true, page: { enabled: true }, OR: [{ syncStatus: 'queued' }, { syncStatus: 'running', syncLeaseUntil: { lt: new Date() } }] }, select: { id: true }, take: 50 })
  for (const form of forms) await enqueue('facebook.sync', { formId: form.id }, { singletonKey: form.id })
}
export async function facebookDeliveries(ctx, before) {
  const cursor = before && await prisma.facebookLeadDelivery.findFirst({ where: { id: before, organizationId: ctx.orgId }, select: { id: true, createdAt: true } })
  if (before && !cursor) throw ApiError.badRequest('Capture history changed. Reload the first page.')
  return prisma.facebookLeadDelivery.findMany({ where: { organizationId: ctx.orgId, ...(cursor && { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }) }, select: { id: true, facebookLeadId: true, facebookFormId: true, leadId: true, status: true, outcome: true, attempts: true, metadata: true, lastError: true, createdAt: true, processedAt: true, page: { select: { name: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 })
}
export async function retryFacebookDelivery(ctx, id) {
  const count = await prisma.facebookLeadDelivery.updateMany({ where: { id, organizationId: ctx.orgId, status: { in: ['failed', 'ignored'] }, page: { enabled: true } }, data: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null } })
  if (!count.count) throw ApiError.badRequest('Reconnect the Page and enable its form before retrying a failed delivery.')
  await enqueue('facebook.lead', { deliveryId: id }, { singletonKey: id }).catch(() => {})
}
export async function deauthorizeFacebook(signedRequest) {
  const data = parseFacebookSignedRequest(signedRequest)
  const cutoff = facebookRequestCutoff(data)
  await prisma.$transaction(async (tx) => {
    await lockFacebookSubject(tx, data.user_id)
    const connections = await tx.$queryRaw`SELECT id, organization_id FROM facebook_connections WHERE facebook_user_id = ${data.user_id} AND authorized_at <= ${cutoff} ORDER BY id FOR UPDATE`
    const ids = connections.map((c) => c.id)
    await tx.facebookPage.updateMany({ where: { connectionId: { in: ids } }, data: { tokenEnc: '', enabled: false } })
    await tx.facebookConnection.updateMany({ where: { id: { in: ids } }, data: { tokenEnc: '', connectedById: null } })
    for (const connection of connections) await recordAudit(tx, { orgId: connection.organization_id, actorType: 'system' }, { action: 'facebook.deauthorized', entityType: 'facebook_connection', entityId: connection.id })
  })
}
