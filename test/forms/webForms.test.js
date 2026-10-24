import { describe, expect, it } from 'vitest'
import { cleanText, createWebFormSchema, formFieldSchema, normalizeWebFormConfig, updateWebFormSchema } from '../../src/validators/webForm.validators.js'
import { mapSubmission } from '../../src/services/webFormSubmission.js'

const issues = (result) => Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]))

const fields = [
  { key: 'firstName', label: 'Your name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true, width: 'half' },
  { key: 'phone', label: 'Phone', type: 'tel', width: 'half' },
  { key: 'block_intro', label: 'About your project', type: 'heading' },
  { key: 'q_service', label: 'Service', type: 'radio', options: [{ label: 'Website design', value: 'web' }, { label: 'SEO', value: 'seo' }] },
  { key: 'q_extras', label: 'Extras', type: 'checkboxes', options: [{ label: 'Hosting', value: 'hosting' }, { label: 'Logo', value: 'logo' }] },
  { key: 'stateCode', label: 'State', type: 'select', options: [{ label: 'Karnataka', value: '29' }] },
  { key: 'cf.visitors', label: 'Visitors', type: 'number' },
  { key: 'budgetMinor', label: 'Budget (₹)', type: 'currency' },
  { key: 'q_newsletter', label: 'Send me updates', type: 'checkbox' },
  { key: 'sourceDetail', label: 'Campaign', type: 'hidden', defaultValue: 'Diwali', urlParam: 'utm_campaign' },
  { key: 'requirement', label: 'Message', type: 'textarea' },
]
const normalised = createWebFormSchema.parse({ name: 'Quote', fields, settings: {} }).fields

describe('web form config', () => {
  it('fills defaults for every new branding option', () => {
    const { settings } = createWebFormSchema.parse({ name: 'Quote', fields, settings: {} })
    expect(settings.logo).toEqual({ mode: 'none', fileId: null, url: '', position: 'left', placement: 'card-top', size: 'md' })
    expect(settings.theme).toMatchObject({ corners: 'soft', buttonWidth: 'full', pageBackground: '#f4f5f7' })
    expect(settings).toMatchObject({ consentEnabled: true, submitLabel: 'Send enquiry', footerText: '', showPoweredBy: true })
  })

  it('keeps forms saved before the redesign working', () => {
    const legacy = {
      fields: [
        { key: 'email', label: 'Email address', type: 'email', required: true, placeholder: 'alex@company.com' },
        { key: 'sourceDetail', label: 'Source detail', type: 'text', required: false, placeholder: '', hidden: true, defaultValue: 'Website enquiry' },
        { key: 'broken', label: 'Not a real key', type: 'text' },
      ],
      settings: { title: 'Hi', description: 'Old intro', brandColor: '#FF0000', submitLabel: 'Go', consentText: 'OK', redirectUrl: 'javascript:alert(1)', theme: 'nope' },
    }
    const { fields: out, settings } = normalizeWebFormConfig(legacy)
    expect(out.map((f) => f.key)).toEqual(['email', 'sourceDetail'])
    expect(out[1]).toMatchObject({ type: 'hidden', required: false, defaultValue: 'Website enquiry', width: 'full' })
    expect(settings).toMatchObject({ title: 'Hi', description: 'Old intro', brandColor: '#ff0000', redirectUrl: '' })
    expect(settings.theme.corners).toBe('soft')
    expect(normalizeWebFormConfig().settings.title).toBe('Let’s talk about your business')
  })

  it('strips HTML and control characters from visitor-facing text', () => {
    expect(cleanText(' <script>alert(1)</script>Hello\u0000 <b>there</b> ')).toBe('alert(1)Hello there')
    expect(cleanText('Budget < 5 lakh, team > 10')).toBe('Budget < 5 lakh, team > 10')
    const { settings } = createWebFormSchema.parse({ name: 'x', fields, settings: { title: '<img src=x onerror=alert(1)>Book a visit', footerText: 'GSTIN 29ABC\nBengaluru' } })
    expect(settings.title).toBe('Book a visit')
    expect(settings.footerText).toBe('GSTIN 29ABC\nBengaluru')
  })

  it('only accepts https redirects and logo links', () => {
    const parse = (redirectUrl, url) => createWebFormSchema.parse({ name: 'x', fields, settings: { redirectUrl, logo: { mode: 'custom', url } } }).settings
    expect(parse('https://acme.in/thanks', 'https://cdn.acme.in/logo.png')).toMatchObject({ redirectUrl: 'https://acme.in/thanks', logo: { mode: 'custom', url: 'https://cdn.acme.in/logo.png' } })
    const unsafe = parse('http://acme.in', 'data:image/svg+xml,<svg onload=alert(1)>')
    expect(unsafe.redirectUrl).toBe('')
    expect(unsafe.logo).toMatchObject({ mode: 'none', url: '' })
  })

  it('explains what is missing in plain language', () => {
    const r = createWebFormSchema.safeParse({
      name: 'x',
      settings: { title: ' ', brandColor: 'red', allowedDomains: ['https://acme.in/'] },
      fields: [
        { key: 'email', label: 'Email', type: 'email' },
        { key: 'email', label: 'Email again', type: 'email' },
        { key: 'q_size', label: 'Size', type: 'select', options: [] },
        { key: 'q_note', label: 'Note', type: 'heading' },
        { key: 'block_text', type: 'paragraph' },
      ],
    })
    expect(issues(r)).toMatchObject({
      'fields.1.key': 'Two fields save to the same place',
      'fields.2.options': 'Add at least one choice',
      'fields.3.key': 'Choose where this answer is saved',
      'fields.4.helpText': 'Add the text to show',
      fields: 'Make email or phone required so your team can follow up',
      'settings.brandColor': 'Use a colour like #3349df',
      'settings.allowedDomains': 'Enter hostnames such as www.example.com',
      'settings.title': 'Add a headline',
    })
  })

  it('drops options, width and required from fields that cannot use them', () => {
    const block = formFieldSchema.parse({ key: 'block_x1y2', type: 'heading', label: 'Hi', required: true, width: 'half', options: [{ label: 'a', value: 'a' }] })
    expect(block).toMatchObject({ required: false, width: 'full', options: [] })
    expect(updateWebFormSchema.safeParse({}).success).toBe(false)
    expect(updateWebFormSchema.parse({ isActive: true })).toEqual({ isActive: true })
  })
})

describe('submission mapping', () => {
  const valid = {
    firstName: ' Ritika ',
    email: 'Ritika@Saffron.IN',
    phone: '+91 98450 12345',
    block_intro: 'ignored',
    q_service: 'seo',
    q_extras: ['hosting', 'logo'],
    stateCode: '29',
    'cf.visitors': '1200',
    budgetMinor: '185000.5',
    q_newsletter: true,
    requirement: 'Need a new site',
  }

  it('saves answers to lead fields, custom fields and the requirement notes', () => {
    const r = mapSubmission(normalised, valid)
    expect(r.ok).toBe(true)
    expect(r.lead).toEqual({
      firstName: 'Ritika',
      emails: [{ value: 'ritika@saffron.in', primary: true }],
      phones: [{ raw: '+91 98450 12345', primary: true }],
      stateCode: '29',
      budgetMinor: 18500050,
      sourceDetail: 'Diwali',
      requirement: 'Need a new site\nService: SEO\nExtras: Hosting, Logo\nSend me updates: Yes',
    })
    expect(r.customFields).toEqual({ visitors: 1200 })
    expect(r.answers).not.toHaveProperty('block_intro')
  })

  it('uses the visitor value for hidden fields when the page supplied one', () => {
    expect(mapSubmission(normalised, { ...valid, sourceDetail: 'Navratri' }).lead.sourceDetail).toBe('Navratri')
  })

  it('rejects missing, malformed and unlisted answers with the renderer messages', () => {
    const r = mapSubmission(normalised, { firstName: '', email: 'nope', phone: 'call me', q_service: 'ads', q_extras: ['hosting', 'x'], 'cf.visitors': 'lots', budgetMinor: '-5' })
    expect(r).toEqual({
      ok: false,
      errors: {
        firstName: 'Your name is required.',
        email: 'Enter a valid email address.',
        phone: 'Enter a valid phone number.',
        q_service: 'Choose from the listed options.',
        q_extras: 'Choose from the listed options.',
        'cf.visitors': 'Enter a valid number.',
        budgetMinor: 'Enter a valid amount.',
      },
    })
  })

  it('requires ticked boxes and chosen options when marked required', () => {
    const strict = normalizeWebFormConfig({
      fields: [
        { key: 'phone', label: 'Phone', type: 'tel', required: true },
        { key: 'q_terms', label: 'Terms', type: 'checkbox', required: true },
        { key: 'q_days', label: 'Days', type: 'checkboxes', required: true, options: [{ label: 'Mon', value: 'mon' }] },
        { key: 'q_date', label: 'Date', type: 'date' },
      ],
    }).fields
    expect(mapSubmission(strict, { phone: '9845012345', q_terms: false, q_days: [], q_date: '2026-13-45' }).errors).toEqual({
      q_terms: 'Terms is required.',
      q_days: 'Days is required.',
      q_date: 'Enter a valid date.',
    })
  })

  it('strips markup from free-text answers', () => {
    const r = mapSubmission(normalised, { ...valid, requirement: '<a href="x">Click</a> me' })
    expect(r.lead.requirement.startsWith('Click me\n')).toBe(true)
  })
})
