import crypto from 'node:crypto'
import { prisma } from '../db/prisma.js'
import { env } from '../config/env.js'
import { recordAudit } from '../lib/audit.js'
import { toJsonValue } from '../lib/json.js'
import { logger } from '../lib/logger.js'
import { validationError } from '../lib/records.js'
import { isSpam } from '../lib/spam.js'
import { queueEmail } from '../email/mailer.js'
import { objectStore } from '../storage/objectStore.js'
import { ApiError } from '../utils/ApiError.js'
import { normalizeWebFormConfig } from '../validators/webForm.validators.js'
import { assignCapturedLead } from './assignment.service.js'
import { assertWithinLimit } from './entitlements.service.js'
import { createLeadFromCapture } from './lead.service.js'
import { profileImageUrl } from './profileImage.service.js'
import { mapSubmission } from './webFormSubmission.js'

/** Web forms (M14): the builder's CRUD, the hosted/embedded public form, and submission → lead. */

const log = logger.child({ component: 'web-forms' })
const ENTITY = 'web_form'
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const formSelect = { id: true, key: true, name: true, fields: true, settings: true, sourceId: true, isActive: true, views: true, submissions: true, createdAt: true, updatedAt: true }
/** 22 URL-safe characters, matching the web_forms_key_check constraint and the /f/:key route. */
export const newFormKey = () => crypto.randomBytes(16).toString('base64url')

/** Signed URL for a form's own logo: only a ready image of the same workspace. */
async function formLogoUrl(orgId, fileId) {
  if (!fileId) return null
  const file = await prisma.file.findFirst({ where: { id: fileId, organizationId: orgId, status: 'ready', deletedAt: null, contentType: { in: IMAGE_TYPES } }, select: { storageKey: true, contentType: true } })
  if (!file) return null
  try {
    return await objectStore.url(file.storageKey, file.contentType, 'inline', env.STORAGE_URL_EXPIRES_IN)
  } catch {
    return null
  }
}

/** Uploaded logos are referenced by file id; the stored URL is refreshed on every read because signed URLs expire. */
async function withLogo(orgId, settings) {
  if (settings.logo.mode !== 'custom' || !settings.logo.fileId) return settings
  return { ...settings, logo: { ...settings.logo, url: (await formLogoUrl(orgId, settings.logo.fileId)) ?? '' } }
}

async function present({ organizationId, ...row }, { resolveLogo = false } = {}) {
  const { fields, settings } = normalizeWebFormConfig(row)
  return {
    ...row,
    fields,
    settings: { ...(resolveLogo ? await withLogo(organizationId, settings) : settings), sourceId: row.sourceId },
  }
}

async function findForm(ctx, id, db = prisma) {
  const row = await db.webForm.findFirst({ where: { id, organizationId: ctx.orgId, deletedAt: null }, select: { ...formSelect, organizationId: true } })
  if (!row) throw ApiError.notFound('Form not found')
  return row
}

/**
 * Checks references a form makes to other workspace data, and returns what to store. A form keeps a
 * source that was disabled after it was chosen (`before`); a newly chosen source must be enabled.
 */
async function prepare(ctx, input, db = prisma, before = null) {
  const data = {}
  if ('name' in input) data.name = input.name
  if ('fields' in input) data.fields = toJsonValue(input.fields)
  if ('isActive' in input) data.isActive = input.isActive
  const sourceId = input.sourceId !== undefined ? input.sourceId : input.settings?.sourceId
  if (sourceId !== undefined) {
    if (sourceId && sourceId !== before?.sourceId && !(await db.leadSource.count({ where: { id: sourceId, organizationId: ctx.orgId, archivedAt: null } }))) throw validationError({ 'settings.sourceId': 'Choose an active lead source' })
    data.sourceId = sourceId
  }
  if (input.settings) {
    const { sourceId: _s, ...settings } = input.settings
    const { logo } = settings
    if (logo.mode === 'custom' && logo.fileId) {
      const file = await db.file.findFirst({ where: { id: logo.fileId, organizationId: ctx.orgId, status: 'ready', deletedAt: null }, select: { contentType: true } })
      if (!file) throw validationError({ 'settings.logo': 'Upload the logo again' })
      if (!IMAGE_TYPES.includes(file.contentType)) throw validationError({ 'settings.logo': 'Use a PNG, JPG or WebP image' })
    }
    // Signed URLs expire, so only an external https logo (no file) keeps its URL.
    data.settings = toJsonValue({ ...settings, logo: logo.fileId ? { ...logo, url: '' } : logo })
  }
  return data
}

export async function listForms(ctx) {
  const rows = await prisma.webForm.findMany({ where: { organizationId: ctx.orgId, deletedAt: null }, select: { ...formSelect, organizationId: true }, orderBy: { createdAt: 'desc' } })
  return Promise.all(rows.map((r) => present(r)))
}

export async function getForm(ctx, id) {
  return present(await findForm(ctx, id), { resolveLogo: true })
}

export async function createForm(ctx, input) {
  const data = await prepare(ctx, input)
  const row = await prisma.$transaction(async (tx) => {
    await assertWithinLimit(ctx, 'webForms', 1, tx)
    const created = await tx.webForm.create({ data: { ...data, organizationId: ctx.orgId, key: newFormKey(), createdById: ctx.userId ?? null }, select: { ...formSelect, organizationId: true } })
    await recordAudit(tx, ctx, { action: 'web_form.created', entityType: ENTITY, entityId: created.id, changes: { name: [null, created.name] } })
    return created
  })
  return present(row, { resolveLogo: true })
}

export async function updateForm(ctx, id, input) {
  const before = await findForm(ctx, id)
  const data = await prepare(ctx, input, prisma, before)
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.webForm.update({ where: { id: before.id }, data, select: { ...formSelect, organizationId: true } })
    const changes = Object.fromEntries(['name', 'isActive', 'sourceId'].filter((k) => k in data && data[k] !== before[k]).map((k) => [k, [before[k], data[k]]]))
    await recordAudit(tx, ctx, { action: 'web_form.updated', entityType: ENTITY, entityId: id, changes: { ...changes, ...('fields' in data && { fields: 'edited' }), ...('settings' in data && { settings: 'edited' }) } })
    return updated
  })
  return present(row, { resolveLogo: true })
}

/** Soft delete: the public link stops working; leads it created are kept. */
export async function deleteForm(ctx, id) {
  const before = await findForm(ctx, id)
  await prisma.$transaction(async (tx) => {
    await tx.webForm.update({ where: { id: before.id }, data: { deletedAt: new Date(), isActive: false } })
    await recordAudit(tx, ctx, { action: 'web_form.deleted', entityType: ENTITY, entityId: id, changes: { name: [before.name, null] } })
  })
}

export async function listSubmissions(ctx, id, { limit }) {
  await findForm(ctx, id)
  return prisma.webFormSubmission.findMany({ where: { formId: id, organizationId: ctx.orgId }, select: { id: true, formId: true, leadId: true, outcome: true, payload: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: limit })
}

export function embedCode(form) {
  const hostedUrl = `${env.FRONTEND_URL}/f/${form.key}`
  return {
    hostedUrl,
    script: `<script src="${env.FRONTEND_URL}/embed.js" data-form="${form.key}" async></script>`,
    iframe: `<iframe src="${hostedUrl}?embed=1" title="Enquiry form" width="100%" height="720" style="border:0" loading="lazy"></iframe>`,
  }
}

export async function getEmbedCode(ctx, id) {
  return embedCode(await findForm(ctx, id))
}

// ---------- Public ----------

const publicSelect = { id: true, key: true, organizationId: true, name: true, fields: true, settings: true, sourceId: true, isActive: true, createdAt: true, updatedAt: true }

async function findPublic(key) {
  const row = await prisma.webForm.findFirst({ where: { key, deletedAt: null }, select: publicSelect })
  if (!row) throw ApiError.notFound('This form doesn’t exist or has been removed.')
  return row
}

const visibleSettings = ({ autoReply: _a, autoReplyTemplate: _t, notifyOwner: _n, allowedDomains: _d, sourceId: _s, ...visible }) => visible

/** What a visitor's browser receives: no internal name, ids, owner settings or follow-up templates. */
export async function getPublicForm(key) {
  const row = await findPublic(key)
  if (!row.isActive) return { id: row.key, key: row.key, name: '', fields: [], settings: visibleSettings(normalizeWebFormConfig({}).settings), isActive: false, views: 0, submissions: 0, createdAt: row.createdAt, updatedAt: row.updatedAt }
  const { fields, settings } = normalizeWebFormConfig(row)
  const visible = visibleSettings(await withLogo(row.organizationId, settings))
  const org = settings.logo.mode === 'workspace' ? await prisma.organization.findUnique({ where: { id: row.organizationId }, select: { logoFileId: true } }) : null
  return {
    id: row.key,
    key: row.key,
    name: '',
    fields,
    settings: visible,
    isActive: true,
    views: 0,
    submissions: 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    workspaceLogoUrl: org ? await profileImageUrl(org.logoFileId) : null,
  }
}

export async function recordView(key) {
  await prisma.webForm.updateMany({ where: { key, deletedAt: null, isActive: true }, data: { views: { increment: 1 } } })
}

/**
 * Embeds are only accepted from the listed websites (and the hosted page itself). The page address
 * comes from the browser, so this keeps honest sites from misusing a form rather than stopping a
 * determined attacker; rate limits and the honeypot handle abuse.
 */
export function isAllowedPage(allowedDomains, pageUrl) {
  if (!allowedDomains.length) return true
  let host
  try {
    host = new URL(pageUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === new URL(env.FRONTEND_URL).hostname) return true
  return allowedDomains.some((d) => host === d || host.endsWith(`.${d}`))
}

const utmOf = (utm = {}) => {
  const clean = Object.fromEntries(Object.entries(utm).filter(([, v]) => v))
  return Object.keys(clean).length ? clean : null
}

export async function submitPublicForm(key, input, request) {
  const form = await findPublic(key)
  if (!form.isActive) throw new ApiError(410, 'This form is closed. Please contact the business directly.', { code: 'FORM_CLOSED' })
  const { fields, settings } = normalizeWebFormConfig(form)
  const reply = { ok: true, message: settings.thankYouMessage, ...(settings.redirectUrl && { redirectUrl: settings.redirectUrl }) }
  if (isSpam(input)) {
    log.info({ formId: form.id, ip: request.ip }, 'web form submission discarded as spam')
    return reply
  }
  if (!isAllowedPage(settings.allowedDomains, input.pageUrl)) throw ApiError.forbidden('This form can’t be used on this website.')
  if (settings.consentEnabled && input.consent !== true) throw validationError({ consent: 'Please agree before sending.' })
  const mapped = mapSubmission(fields, input.fields)
  if (!mapped.ok) throw new ApiError(400, Object.values(mapped.errors)[0], { code: 'VALIDATION_ERROR', details: { fields: mapped.errors } })

  const org = await prisma.organization.findUnique({ where: { id: form.organizationId }, select: { name: true, country: true, currency: true, plan: true } })
  const ctx = { orgId: form.organizationId, userId: null, actorType: 'system', country: org.country, currency: org.currency, plan: org.plan, permissions: [] }
  const utm = utmOf(input.utm)
  const payload = {
    ...mapped.lead,
    customFields: mapped.customFields,
    sourceDetail: mapped.lead.sourceDetail ?? `Web form: ${form.name}`.slice(0, 200),
    ...(utm && { utm }),
  }
  const result = await prisma.$transaction(async (tx) => {
    const captured = await createLeadFromCapture(ctx, payload, { sourceKey: 'website', sourceId: form.sourceId, tx })
    const now = new Date()
    // A repeat enquiry stays with the open lead's owner; new, unowned leads go through the assignment rules.
    const assignment = captured.outcome !== 'merged_into_open' && !captured.lead.ownerId ? await assignCapturedLead(tx, ctx, captured.lead, { formId: form.id, now }) : null
    await tx.lead.update({
      where: { id: captured.lead.id },
      data: { latestWebFormId: form.id, latestEnquiryAt: now, latestSourceId: captured.lead.sourceId ?? null, ...(captured.outcome !== 'merged_into_open' && { webFormId: form.id }) },
    })
    await tx.webFormSubmission.create({
      data: {
        organizationId: form.organizationId,
        formId: form.id,
        leadId: captured.lead.id,
        outcome: captured.outcome,
        payload: toJsonValue({ ...mapped.answers, ...(settings.consentEnabled && { consentText: settings.consentText }) }),
        meta: toJsonValue({
          ip: request.ip ?? null,
          userAgent: request.userAgent ?? null,
          pageUrl: input.pageUrl ?? null,
          referrer: input.referrer ?? null,
          ...(utm && { utm }),
          ...(assignment && { assignment: assignment.reason, ruleId: assignment.ruleId, ruleName: assignment.ruleName, ownerId: assignment.ownerId }),
        }),
      },
    })
    await tx.webForm.update({ where: { id: form.id }, data: { submissions: { increment: 1 } } })
    return captured
  }, { timeout: 20000 }).catch((err) => {
    // Visitors never see workspace internals such as plan limits or custom-field rules.
    if (err.code === 'PLAN_LIMIT_REACHED') {
      log.warn({ formId: form.id }, 'web form submission refused: workspace record limit reached')
      throw new ApiError(503, 'This form can’t accept enquiries right now. Please contact the business directly.', { code: 'FORM_UNAVAILABLE' })
    }
    if (err.code === 'VALIDATION_ERROR') {
      const fieldErrors = err.details?.fields ?? {}
      throw new ApiError(400, Object.values(fieldErrors)[0] ?? 'Please check your answers and try again.', { code: 'VALIDATION_ERROR', details: { fields: Object.fromEntries(Object.entries(fieldErrors).map(([k, v]) => [k.startsWith('customFields.') ? `cf.${k.slice(13)}` : k, v])) } })
    }
    throw err
  })

  const email = mapped.lead.emails?.[0]?.value
  if (settings.autoReply && email && settings.autoReplyTemplate) {
    // Best effort: the enquiry is already saved, so a mail failure must not fail the visitor's submit.
    queueEmail({ to: email, subject: `Thanks for contacting ${org.name}`, text: settings.autoReplyTemplate }).catch((err) => log.warn({ err, formId: form.id }, 'web form acknowledgement failed'))
  }
  log.info({ formId: form.id, leadId: result.lead.id, outcome: result.outcome }, 'web form submission captured')
  return reply
}
