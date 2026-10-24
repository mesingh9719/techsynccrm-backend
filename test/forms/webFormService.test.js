import { beforeEach, describe, expect, it, vi } from 'vitest'

const { db, tx, capture, assign, queueEmail, env } = vi.hoisted(() => {
  const tx = {
    lead: { update: vi.fn() },
    webFormSubmission: { create: vi.fn() },
    webForm: { update: vi.fn(), create: vi.fn() },
  }
  return {
    tx,
    db: {
      webForm: { findFirst: vi.fn(), updateMany: vi.fn() },
      organization: { findUnique: vi.fn() },
      leadSource: { count: vi.fn() },
      file: { findFirst: vi.fn() },
      $transaction: vi.fn((fn) => fn(tx)),
    },
    capture: vi.fn(),
    assign: vi.fn(),
    queueEmail: vi.fn(() => Promise.resolve()),
    env: { FRONTEND_URL: 'https://app.techsync.test', STORAGE_URL_EXPIRES_IN: 600 },
  }
})
vi.mock('../../src/db/prisma.js', () => ({ prisma: db }))
vi.mock('../../src/config/env.js', () => ({ env }))
vi.mock('../../src/email/mailer.js', () => ({ queueEmail }))
vi.mock('../../src/storage/objectStore.js', () => ({ objectStore: { url: vi.fn(async (key) => `https://files.test/${key}?sig=1`) } }))
vi.mock('../../src/services/lead.service.js', () => ({ createLeadFromCapture: capture }))
vi.mock('../../src/services/assignment.service.js', () => ({ assignCapturedLead: assign }))
vi.mock('../../src/services/profileImage.service.js', () => ({ profileImageUrl: vi.fn(async (id) => (id ? `https://files.test/org/${id}` : null)) }))
vi.mock('../../src/services/entitlements.service.js', () => ({ assertWithinLimit: vi.fn() }))
vi.mock('../../src/lib/audit.js', () => ({ recordAudit: vi.fn() }))

import { createForm, embedCode, updateForm, getPublicForm, isAllowedPage, newFormKey, submitPublicForm } from '../../src/services/webForm.service.js'
import { createWebFormSchema, normalizeWebFormConfig } from '../../src/validators/webForm.validators.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const FORM = '22222222-2222-4222-8222-222222222222'
const config = createWebFormSchema.parse({
  name: 'Quote',
  fields: [
    { key: 'firstName', label: 'Your name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email', required: true },
    { key: 'budgetMinor', label: 'Budget', type: 'currency' },
  ],
  settings: { autoReply: true, autoReplyTemplate: 'Thanks! We will call you.', allowedDomains: ['acme.in'], redirectUrl: '', thankYouMessage: 'Got it!' },
})
const row = (patch = {}) => ({ id: FORM, key: 'abcdefghijklmnopqrstuv', organizationId: ORG, name: 'Quote', fields: config.fields, settings: config.settings, sourceId: null, isActive: true, createdAt: new Date(0), updatedAt: new Date(0), ...patch })
const body = (patch = {}) => ({ fields: { firstName: 'Ritika', email: 'ritika@acme.in', budgetMinor: '1500' }, consent: true, elapsedMs: 9000, website: '', pageUrl: 'https://www.acme.in/contact', utm: { utm_source: 'google', utm_medium: '' }, ...patch })
const request = { ip: '203.0.113.9', userAgent: 'test' }

beforeEach(() => {
  vi.clearAllMocks()
  db.webForm.findFirst.mockResolvedValue(row())
  db.organization.findUnique.mockResolvedValue({ name: 'Acme', country: 'IN', currency: 'INR', plan: 'growth', logoFileId: 'org-logo' })
  capture.mockResolvedValue({ lead: { id: 'lead-1', sourceId: 'src-web', ownerId: null }, outcome: 'created' })
  assign.mockResolvedValue({ ownerId: 'owner-1', ruleId: 'rule-1', ruleName: 'Web leads', held: false, reason: 'rule' })
})

describe('web form helpers', () => {
  it('creates keys that satisfy the database check and the /f/:key route', () => {
    for (let i = 0; i < 20; i++) expect(newFormKey()).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('builds embed code for the hosted page and the script', () => {
    expect(embedCode({ key: 'abcdefghijklmnopqrstuv' })).toEqual({
      hostedUrl: 'https://app.techsync.test/f/abcdefghijklmnopqrstuv',
      script: '<script src="https://app.techsync.test/embed.js" data-form="abcdefghijklmnopqrstuv" async></script>',
      iframe: '<iframe src="https://app.techsync.test/f/abcdefghijklmnopqrstuv?embed=1" title="Enquiry form" width="100%" height="720" style="border:0" loading="lazy"></iframe>',
    })
  })

  it('accepts embeds only on listed sites, their subdomains and the hosted page', () => {
    expect(isAllowedPage([], 'not a url')).toBe(true)
    expect(isAllowedPage(['acme.in'], 'https://www.acme.in/contact?x=1')).toBe(true)
    expect(isAllowedPage(['acme.in'], 'https://acme.in')).toBe(true)
    expect(isAllowedPage(['acme.in'], 'https://app.techsync.test/f/abc')).toBe(true)
    expect(isAllowedPage(['acme.in'], 'https://notacme.in')).toBe(false)
    expect(isAllowedPage(['acme.in'], undefined)).toBe(false)
  })

  it('reads forms saved by the earlier production builder, including currency budgets', () => {
    const legacy = normalizeWebFormConfig({
      fields: [
        { key: 'budgetMinor', type: 'currency', label: 'Budget', width: 'full', required: false, placeholder: '', helpText: '' },
        { key: 'stateCode', type: 'select', label: 'State', width: 'half', options: [{ label: 'Karnataka', value: '29' }] },
        { key: 'cf.service', type: 'select', label: 'Service', options: [{ label: 'SEO', value: 'seo' }] },
      ],
      settings: { title: 'Quote', language: 'en', autoReply: false, brandColor: '#3349df', consentText: 'OK', description: '', notifyOwner: true, redirectUrl: '', submitLabel: 'Send', allowedDomains: [], thankYouMessage: 'Thanks', autoReplyTemplate: '' },
    })
    expect(legacy.fields.map((f) => f.key)).toEqual(['budgetMinor', 'stateCode', 'cf.service'])
    expect(legacy.settings).toMatchObject({ title: 'Quote', consentEnabled: true, logo: { mode: 'none' } })
  })
})

describe('public web form', () => {
  it('hides internal settings and resolves the logos', async () => {
    db.webForm.findFirst.mockResolvedValue(row({ settings: { ...config.settings, logo: { ...config.settings.logo, mode: 'workspace' } } }))
    const form = await getPublicForm('abcdefghijklmnopqrstuv')
    expect(form).toMatchObject({ id: 'abcdefghijklmnopqrstuv', name: '', isActive: true, workspaceLogoUrl: 'https://files.test/org/org-logo' })
    for (const key of ['autoReply', 'autoReplyTemplate', 'notifyOwner', 'allowedDomains', 'sourceId']) expect(form.settings).not.toHaveProperty(key)
    expect(JSON.stringify(form)).not.toContain(ORG)
  })

  it('returns an empty closed form when unpublished', async () => {
    db.webForm.findFirst.mockResolvedValue(row({ isActive: false }))
    const closed = await getPublicForm('abcdefghijklmnopqrstuv')
    expect(closed).toMatchObject({ isActive: false, fields: [] })
    expect(closed.settings).not.toHaveProperty('allowedDomains')
  })

  it('captures a lead, records the submission and sends the acknowledgement', async () => {
    const reply = await submitPublicForm('abcdefghijklmnopqrstuv', body(), request)
    expect(reply).toEqual({ ok: true, message: 'Got it!' })
    const [ctx, payload, options] = capture.mock.calls[0]
    expect(ctx).toMatchObject({ orgId: ORG, userId: null, actorType: 'system', country: 'IN' })
    expect(payload).toEqual({
      firstName: 'Ritika',
      emails: [{ value: 'ritika@acme.in', primary: true }],
      budgetMinor: 150000,
      customFields: {},
      sourceDetail: 'Web form: Quote',
      utm: { utm_source: 'google' },
    })
    expect(options).toMatchObject({ sourceKey: 'website', sourceId: null })
    expect(tx.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: expect.objectContaining({ webFormId: FORM, latestWebFormId: FORM, latestSourceId: 'src-web' }) })
    expect(assign).toHaveBeenCalledWith(tx, ctx, { id: 'lead-1', sourceId: 'src-web', ownerId: null }, expect.objectContaining({ formId: FORM }))
    expect(tx.webFormSubmission.create.mock.calls[0][0].data).toMatchObject({
      formId: FORM,
      leadId: 'lead-1',
      outcome: 'created',
      meta: { ip: '203.0.113.9', pageUrl: 'https://www.acme.in/contact', assignment: 'rule', ruleId: 'rule-1', ruleName: 'Web leads', ownerId: 'owner-1' },
    })
    expect(tx.webForm.update).toHaveBeenCalledWith({ where: { id: FORM }, data: { submissions: { increment: 1 } } })
    expect(queueEmail).toHaveBeenCalledWith({ to: 'ritika@acme.in', subject: 'Thanks for contacting Acme', text: 'Thanks! We will call you.' })
  })

  it('keeps the original form on a lead when a repeat enquiry merges into it', async () => {
    capture.mockResolvedValue({ lead: { id: 'lead-1', sourceId: null, ownerId: 'existing-owner' }, outcome: 'merged_into_open' })
    await submitPublicForm('abcdefghijklmnopqrstuv', body(), request)
    expect(tx.lead.update.mock.calls[0][0].data).not.toHaveProperty('webFormId')
    expect(assign).not.toHaveBeenCalled()
    expect(tx.webFormSubmission.create.mock.calls[0][0].data.meta).not.toHaveProperty('assignment')
  })

  it('quietly drops bot submissions', async () => {
    expect(await submitPublicForm('abcdefghijklmnopqrstuv', body({ website: 'spam.example' }), request)).toEqual({ ok: true, message: 'Got it!' })
    expect(capture).not.toHaveBeenCalled()
  })

  it('refuses closed forms, other websites, missing consent and bad answers', async () => {
    db.webForm.findFirst.mockResolvedValueOnce(row({ isActive: false }))
    await expect(submitPublicForm('abcdefghijklmnopqrstuv', body(), request)).rejects.toMatchObject({ statusCode: 410 })
    await expect(submitPublicForm('abcdefghijklmnopqrstuv', body({ pageUrl: 'https://evil.example' }), request)).rejects.toMatchObject({ statusCode: 403 })
    await expect(submitPublicForm('abcdefghijklmnopqrstuv', body({ consent: false }), request)).rejects.toMatchObject({ details: { fields: { consent: 'Please agree before sending.' } } })
    await expect(submitPublicForm('abcdefghijklmnopqrstuv', body({ fields: { firstName: '', email: 'x' } }), request)).rejects.toMatchObject({
      statusCode: 400,
      message: 'Your name is required.',
      details: { fields: { firstName: 'Your name is required.', email: 'Enter a valid email address.' } },
    })
    expect(capture).not.toHaveBeenCalled()
  })

  it('never shows visitors workspace plan limits or custom-field internals', async () => {
    capture.mockRejectedValueOnce(Object.assign(new Error('Your Starter plan includes 1,000 leads'), { code: 'PLAN_LIMIT_REACHED' }))
    await expect(submitPublicForm('abcdefghijklmnopqrstuv', body(), request)).rejects.toMatchObject({ statusCode: 503, code: 'FORM_UNAVAILABLE' })
    capture.mockRejectedValueOnce(Object.assign(new Error('Validation failed'), { code: 'VALIDATION_ERROR', details: { fields: { 'customFields.service': 'Choose one of the options' } } }))
    await expect(submitPublicForm('abcdefghijklmnopqrstuv', body(), request)).rejects.toMatchObject({ message: 'Choose one of the options', details: { fields: { 'cf.service': 'Choose one of the options' } } })
  })
})

describe('saving a form', () => {
  const ctx = { orgId: ORG, userId: '33333333-3333-4333-8333-333333333333' }
  it('rejects a logo or lead source from outside the workspace', async () => {
    const logo = { ...config.settings.logo, mode: 'custom', fileId: '44444444-4444-4444-8444-444444444444' }
    db.file.findFirst.mockResolvedValueOnce(null)
    await expect(createForm(ctx, { ...config, settings: { ...config.settings, logo } })).rejects.toMatchObject({ details: { fields: { 'settings.logo': 'Upload the logo again' } } })
    expect(db.file.findFirst.mock.calls[0][0].where).toMatchObject({ organizationId: ORG })
    db.leadSource.count.mockResolvedValueOnce(0)
    await expect(createForm(ctx, { ...config, sourceId: '55555555-5555-4555-8555-555555555555' })).rejects.toMatchObject({ details: { fields: { 'settings.sourceId': 'Choose an active lead source' } } })
  })

  it('keeps a lead source that was turned off after the form chose it, but refuses switching to one', async () => {
    const OFF = '55555555-5555-4555-8555-555555555555'
    db.webForm.findFirst.mockResolvedValue(row({ sourceId: OFF }))
    tx.webForm.update.mockImplementation(async ({ data }) => ({ ...row({ sourceId: OFF }), ...data, views: 0, submissions: 0 }))
    db.leadSource.count.mockResolvedValue(0)
    await updateForm(ctx, FORM, { ...config, sourceId: OFF })
    expect(db.leadSource.count).not.toHaveBeenCalled()
    await expect(updateForm(ctx, FORM, { ...config, sourceId: '66666666-6666-4666-8666-666666666666' })).rejects.toMatchObject({ details: { fields: { 'settings.sourceId': 'Choose an active lead source' } } })
  })

  it('stores uploaded logos by file id, never by expiring URL', async () => {
    const logo = { ...config.settings.logo, mode: 'custom', fileId: '44444444-4444-4444-8444-444444444444', url: 'https://files.test/old?sig=expired' }
    db.file.findFirst.mockResolvedValue({ contentType: 'image/png', storageKey: 'org/logo.png' })
    tx.webForm.create.mockImplementation(async ({ data }) => ({ ...data, id: FORM, views: 0, submissions: 0, isActive: false, createdAt: new Date(0), updatedAt: new Date(0) }))
    const form = await createForm(ctx, { ...config, settings: { ...config.settings, logo } })
    expect(tx.webForm.create.mock.calls[0][0].data.settings.logo.url).toBe('')
    expect(tx.webForm.create.mock.calls[0][0].data.key).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(form.settings.logo.url).toBe('https://files.test/org/logo.png?sig=1')
    expect(form).not.toHaveProperty('organizationId')
  })
})
