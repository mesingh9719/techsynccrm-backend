import { z } from 'zod'
import { GST_STATE_CODES } from '../lib/india.js'
import { industries, teamSizes } from './auth.validators.js'

/** Slugs that would be confusing or collide with app routes if workspaces get subdomains/URLs later. */
const RESERVED_SLUGS = new Set(['app', 'api', 'admin', 'www', 'help', 'login', 'signup', 'settings', 'support', 'status', 'billing', 'static', 'assets'])

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/, 'Use 3–40 lowercase letters, numbers and hyphens (not at the start or end)')
  .refine((v) => !v.includes('--'), 'Don’t use two hyphens in a row')
  .refine((v) => !RESERVED_SLUGS.has(v), 'That address is reserved — try another')

const isTimeZone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const nullableText = (max, message) =>
  z
    .string()
    .trim()
    .max(max, message)
    .nullish()
    .transform((v) => v || null)

const companyName = z.string().trim().min(2, 'Company name is required').max(80, 'Keep it under 80 characters')

/** POST /api/organizations — same fields as the onboarding company step. */
export const createOrganizationSchema = z.object({
  company: companyName,
  industry: z.enum(industries, { error: 'Choose your industry' }),
  teamSize: z.enum(teamSizes, { error: 'Select your team size' }),
})

const address = z
  .object({
    line1: nullableText(120, 'Keep it under 120 characters'),
    line2: nullableText(120, 'Keep it under 120 characters'),
    city: nullableText(60, 'Keep it under 60 characters'),
    pincode: z
      .string()
      .trim()
      .nullish()
      .transform((v) => v || null)
      .refine((v) => v === null || /^[1-9][0-9]{5}$/.test(v), 'Enter a 6-digit PIN code'),
  })
  .nullable()

/** PATCH /api/organizations/current — every field optional; GSTIN ↔ state is checked in the service. */
export const updateOrganizationSchema = z
  .object({
    name: companyName,
    slug,
    industry: z.enum(industries, { error: 'Choose your industry' }).nullable(),
    teamSize: z.enum(teamSizes, { error: 'Select your team size' }).nullable(),
    logoFileId: z.uuid('Invalid file').nullable(),
    timezone: z.string().refine(isTimeZone, 'Choose a valid time zone'),
    currency: z.enum(['INR', 'USD'], { error: 'Choose INR or USD' }),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'Choose a country'),
    stateCode: z.enum(GST_STATE_CODES, { error: 'Choose a state' }).nullable(),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .nullish()
      .transform((v) => v || null),
    legalName: nullableText(120, 'Keep it under 120 characters'),
    address,
    /** Members must turn on 2FA (Business plan from M06). */
    require2fa: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')

export const switchOrganizationSchema = z.object({ organizationId: z.uuid('Choose a workspace') })

export const deleteOrganizationSchema = z.object({ confirmName: z.string().trim().min(1, 'Type the workspace name to confirm') })

export const transferOwnershipSchema = z.object({
  userId: z.uuid('Choose a member'),
  password: z.string().min(1, 'Enter your password').max(200),
})

// ---------- Plans (M06) ----------

const plan = z.enum(['starter', 'growth', 'business', 'enterprise'], { error: 'Choose a plan' })

/** POST /api/organizations/current/upgrade-request — until self-serve billing (M16). */
export const upgradeRequestSchema = z.object({
  plan: z.enum(['growth', 'business', 'enterprise'], { error: 'Choose a plan' }),
  message: z
    .string()
    .trim()
    .max(1000, 'Keep it under 1,000 characters')
    .optional()
    .transform((v) => v || null),
})

/** POST /api/organizations/current/seat-selection — owner picks who stays after a downgrade. */
export const seatSelectionSchema = z.object({
  keepUserIds: z.array(z.uuid('Invalid member')).max(500),
})

// Staff tools (/api/internal)
export const organizationIdParamSchema = z.object({ id: z.uuid('Invalid workspace') })
export const extendTrialSchema = z.object({ days: z.coerce.number().int().min(1, 'At least 1 day').max(14, 'At most 14 days') })
export const setPlanSchema = z.object({ plan })
