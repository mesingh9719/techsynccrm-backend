import { z } from 'zod'

// Mirrors the frontend's form rules and messages (frontend/src/lib/schemas.ts: contactSchema,
// demoSchema, newsletterSchema) so both sides agree. Server-only rules (demo date window, slot
// capacity) live in services/demoSlots.js and services/public.service.js.

const PERSONAL_DOMAINS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'rediffmail.com', 'icloud.com']

const email = z.string().trim().toLowerCase().min(1, 'Email is required').email('Enter a valid email address').max(254)

const workEmail = email.refine((value) => !PERSONAL_DOMAINS.includes(value.split('@')[1] ?? ''), 'Please use your work email')

const name = z.string().trim().min(2, 'Enter at least 2 characters').max(60, 'Keep it under 60 characters')

const phone = z
  .string()
  .trim()
  .refine((v) => v === '' || /^\+?[0-9][0-9\s-]{7,15}$/.test(v), 'Enter a valid phone number')

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || null)

export const contactTopics = {
  sales: 'Sales & pricing',
  support: 'Product support',
  partnership: 'Partnerships',
  press: 'Press & media',
  other: 'Something else',
}

export const companySizes = ['1–10', '11–50', '51–200', '201–500', '500+']
export const demoInterests = ['Lead management', 'Sales pipeline', 'WhatsApp inbox', 'Automation', 'Quotes & invoices', 'Reports']
export const demoSlots = ['10:00 AM', '11:30 AM', '2:00 PM', '3:30 PM', '5:00 PM']

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']

/**
 * Anti-spam and attribution fields sent by every public form:
 * - `website`: hidden honeypot input — humans leave it empty.
 * - `elapsedMs`: time between the form rendering and submit, measured in the browser
 *   (a duration rather than a timestamp, so client clock skew doesn't matter).
 */
const tracking = {
  website: z.string().max(500).optional(),
  elapsedMs: z.number().int().min(0).max(86_400_000 * 7).optional(),
  pageUrl: z.string().trim().max(500).optional(),
  referrer: z.string().trim().max(500).optional(),
  utm: z.object(Object.fromEntries(UTM_KEYS.map((k) => [k, z.string().trim().max(200).optional()]))).optional(),
}

export const contactSchema = z.object({
  name,
  email,
  company: optionalText(80),
  phone: phone.optional().transform((v) => v || null),
  topic: z.enum(Object.keys(contactTopics), { error: 'Choose a topic' }),
  message: z.string().trim().min(20, 'Tell us a bit more (at least 20 characters)').max(2000, 'Keep it under 2,000 characters'),
  consent: z.literal(true, { error: 'Please agree so we can respond to you' }),
  ...tracking,
})

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date')

export const demoSchema = z.object({
  firstName: name,
  lastName: name,
  email: workEmail,
  phone: z.string().trim().min(1, 'Phone number is required').pipe(phone),
  company: z.string().trim().min(2, 'Company name is required').max(80),
  companySize: z.enum(companySizes, { error: 'Select your team size' }),
  role: z.string().trim().min(2, 'Tell us your role').max(60),
  interests: z.array(z.enum(demoInterests)).min(1, 'Pick at least one area').max(demoInterests.length),
  date: isoDate,
  slot: z.enum(demoSlots, { error: 'Choose a time slot' }),
  notes: z
    .string()
    .trim()
    .max(1000, 'Keep it under 1,000 characters')
    .optional()
    .transform((v) => v || null),
  ...tracking,
})

export const demoSlotsQuerySchema = z.object({ date: isoDate })

export const newsletterSchema = z.object({ email, ...tracking })

export const tokenSchema = z.object({ token: z.string().trim().min(20, 'Invalid link').max(200, 'Invalid link') })

export const inboundListQuerySchema = z.object({
  type: z.enum(['contact', 'demo', 'newsletter']),
  status: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
})
