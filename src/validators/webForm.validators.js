import { z } from 'zod'

/**
 * Web form (M14) config: fields, branding/layout and follow-up settings. Mirrors
 * frontend/src/features/capture/formConfig.ts. Every setting has a default so forms saved before
 * the redesign (title/description/brandColor only, `hidden: true` fields) still parse unchanged.
 * All visitor-facing text is plain text: renderers escape it and never inject HTML.
 */

export const FIELD_TYPES = ['text', 'textarea', 'email', 'tel', 'number', 'currency', 'date', 'select', 'radio', 'checkboxes', 'checkbox', 'hidden', 'heading', 'paragraph']
/** Layout-only blocks: shown to visitors, never submitted. */
export const STATIC_TYPES = ['heading', 'paragraph']
export const CHOICE_TYPES = ['select', 'radio', 'checkboxes']
/** Lead columns a field can save into. `q_*` answers go into the enquiry notes, `cf.*` into custom fields. */
export const LEAD_FIELD_KEYS = ['firstName', 'lastName', 'email', 'phone', 'companyName', 'requirement', 'city', 'stateCode', 'pincode', 'budgetMinor', 'sourceDetail']
const FIELD_KEY = new RegExp(`^(${LEAD_FIELD_KEYS.join('|')}|cf\\.[a-zA-Z][a-zA-Z0-9_]{0,59}|q_[a-z0-9]{4,24}|block_[a-z0-9]{4,24})$`)

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const HTML_TAG = /<\/?[a-z!][^>]*>/gi
/** Plain text only: drops control characters and anything that looks like an HTML tag. */
export const cleanText = (value) => String(value ?? '').replace(CONTROL_CHARS, '').replace(HTML_TAG, '').trim()

const text = (max, fallback = '') => z.string().max(max * 2).default(fallback).transform((v) => cleanText(v).slice(0, max))
const hex = (fallback) => z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #3349df').default(fallback).transform((v) => v.toLowerCase())
/** Anything but a plain https address becomes '' (no javascript:, data: or http: links). */
const httpsUrl = z
  .string()
  .max(2000)
  .default('')
  .transform((v) => {
    const value = v.trim()
    if (!value) return ''
    try {
      return new URL(value).protocol === 'https:' ? value : ''
    } catch {
      return ''
    }
  })

const option = z.object({ label: text(100), value: text(100) }).refine((o) => o.label && o.value, 'Every choice needs a label')

export const formFieldSchema = z
  .preprocess(
    (raw) => (raw && typeof raw === 'object' && raw.hidden === true && raw.type !== 'hidden' ? { ...raw, type: 'hidden' } : raw),
    z.object({
      key: z.string().regex(FIELD_KEY, 'Choose where this answer is saved'),
      type: z.enum(FIELD_TYPES, { error: 'Choose a field type' }),
      label: text(200),
      required: z.boolean().default(false),
      placeholder: text(150),
      helpText: text(2000),
      width: z.enum(['full', 'half']).default('full'),
      options: z.array(option).max(50, 'Use at most 50 choices').default([]),
      defaultValue: text(200),
      urlParam: z.string().trim().max(60).regex(/^[a-zA-Z0-9_.-]*$/, 'Use letters, numbers, dots, dashes or underscores').default(''),
    }),
  )
  .transform((f) => {
    const isStatic = STATIC_TYPES.includes(f.type)
    return {
      ...f,
      required: f.type === 'hidden' || isStatic ? false : f.required,
      options: CHOICE_TYPES.includes(f.type) ? f.options : [],
      width: f.type === 'hidden' || isStatic ? 'full' : f.width,
    }
  })
  .superRefine((f, ctx) => {
    if (!f.label && f.type !== 'paragraph') ctx.addIssue({ code: 'custom', path: ['label'], message: 'Every field needs a label' })
    if (f.type === 'paragraph' && !f.helpText) ctx.addIssue({ code: 'custom', path: ['helpText'], message: 'Add the text to show' })
    if (CHOICE_TYPES.includes(f.type) && !f.options.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Add at least one choice' })
    if (STATIC_TYPES.includes(f.type) !== f.key.startsWith('block_')) ctx.addIssue({ code: 'custom', path: ['key'], message: 'Choose where this answer is saved' })
  })

export const LOGO_POSITIONS = ['left', 'center', 'right']
/** card-top: inside the card above everything; above-title: next to the headline; header-band: on a coloured band. */
export const LOGO_PLACEMENTS = ['card-top', 'above-title', 'header-band']

const logoSchema = z
  .object({
    mode: z.enum(['none', 'workspace', 'custom']).default('none'),
    fileId: z.uuid().nullable().default(null),
    url: httpsUrl,
    position: z.enum(LOGO_POSITIONS).default('left'),
    placement: z.enum(LOGO_PLACEMENTS).default('card-top'),
    size: z.enum(['sm', 'md', 'lg']).default('md'),
  })
  .prefault({})
  .transform((l) => (l.mode === 'custom' && !l.fileId && !l.url ? { ...l, mode: 'none' } : l))

const themeSchema = z
  .object({
    pageBackground: hex('#f4f5f7'),
    cardBackground: hex('#ffffff'),
    textColor: hex('#18181b'),
    corners: z.enum(['sharp', 'soft', 'round']).default('soft'),
    cardStyle: z.enum(['shadow', 'border', 'flat']).default('shadow'),
    buttonWidth: z.enum(['full', 'auto']).default('full'),
    font: z.enum(['system', 'serif', 'rounded']).default('system'),
    titleAlign: z.enum(['left', 'center']).default('left'),
  })
  .prefault({})

const settingsShape = z.object({
  title: text(120, 'Let’s talk about your business'),
  description: text(500),
  headerBand: z.boolean().default(false),
  footerText: text(500),
  showPoweredBy: z.boolean().default(true),
  submitLabel: text(40, 'Send enquiry'),
  consentEnabled: z.boolean().default(true),
  consentText: text(1000, 'I agree to be contacted about my enquiry and understand how my information will be used.'),
  successTitle: text(120, 'You’re all set!'),
  thankYouMessage: text(1000, 'Thank you! We’ve received your enquiry and will be in touch soon.'),
  redirectUrl: httpsUrl,
  autoReply: z.boolean().default(false),
  autoReplyTemplate: text(2000),
  notifyOwner: z.boolean().default(true),
  allowedDomains: z
    .array(z.string().trim().toLowerCase().max(253))
    .max(50)
    .default([])
    .transform((list) => [...new Set(list.filter(Boolean))])
    .refine((list) => list.every((d) => /^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(d)), 'Enter hostnames such as www.example.com'),
  brandColor: hex('#3349df'),
  language: z.string().trim().max(10).default('en'),
  sourceId: z.uuid().nullable().default(null),
  logo: logoSchema,
  theme: themeSchema,
})

export const formSettingsSchema = settingsShape.superRefine((s, ctx) => {
  if (!s.title) ctx.addIssue({ code: 'custom', path: ['title'], message: 'Add a headline' })
  if (!s.submitLabel) ctx.addIssue({ code: 'custom', path: ['submitLabel'], message: 'Add a button label' })
  if (s.consentEnabled && !s.consentText) ctx.addIssue({ code: 'custom', path: ['consentText'], message: 'Add the consent wording' })
})

const fieldList = z
  .array(formFieldSchema)
  .min(1, 'Add at least one field')
  .max(60, 'Use at most 60 fields')
  .superRefine((fields, ctx) => {
    const seen = new Set()
    fields.forEach((f, i) => {
      if (seen.has(f.key)) ctx.addIssue({ code: 'custom', path: [i, 'key'], message: 'Two fields save to the same place' })
      seen.add(f.key)
    })
    if (!fields.some((f) => ['email', 'phone'].includes(f.key) && f.required))
      ctx.addIssue({ code: 'custom', path: [], message: 'Make email or phone required so your team can follow up' })
  })

const formBody = {
  name: z.string().trim().min(1, 'Name your form').max(100).transform(cleanText),
  fields: fieldList,
  settings: formSettingsSchema,
  sourceId: z.uuid().nullable().optional(),
  isActive: z.boolean(),
}

export const createWebFormSchema = z.object({ ...formBody, isActive: formBody.isActive.default(false) })
export const updateWebFormSchema = z.object(formBody).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update')

/**
 * Read path: upgrades a stored config (any age) to the current shape and never throws. Settings are
 * parsed one key at a time, so a single bad value falls back to its default instead of all of them.
 */
export function normalizeWebFormConfig({ fields, settings } = {}) {
  const stored = settings && typeof settings === 'object' ? settings : {}
  return {
    fields: (Array.isArray(fields) ? fields : []).flatMap((f) => {
      const r = formFieldSchema.safeParse(f)
      return r.success ? [r.data] : []
    }),
    settings: Object.fromEntries(
      Object.entries(settingsShape.shape).map(([key, schema]) => {
        const r = schema.safeParse(stored[key])
        return [key, r.success ? r.data : schema.parse(undefined)]
      }),
    ),
  }
}

export const webFormIdParams = z.object({ id: z.uuid('Form not found') })
export const webFormKeyParams = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{22}$/, 'Form not found') })
export const submissionsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) })

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
/** Body sent by the public renderer (frontend/src/features/capture/FormRenderer.tsx). Answers are checked per form in services/webFormSubmission.js. */
export const publicSubmissionSchema = z.object({
  fields: z.record(z.string().max(80), z.union([z.string().max(5000), z.number(), z.boolean(), z.array(z.string().max(200)).max(50), z.null()])).refine((v) => Object.keys(v).length <= 80, 'Too many answers'),
  consent: z.boolean().default(false),
  consentText: z.string().max(2000).optional(),
  website: z.string().max(500).optional(),
  elapsedMs: z.number().int().min(0).max(86_400_000 * 7).optional(),
  pageUrl: z.string().trim().max(2000).optional(),
  referrer: z.string().trim().max(2000).optional(),
  utm: z.object(Object.fromEntries(UTM_KEYS.map((k) => [k, z.string().trim().max(200).optional()]))).optional(),
})
