import { z } from 'zod'

// Mirrors the frontend's form rules (frontend/src/lib/schemas.ts) so both sides agree.
const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254)

const password = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(72, 'Use at most 72 characters') // bcrypt only uses the first 72 bytes
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/[0-9]/, 'Include at least one number')

const token = z.string().trim().min(20, 'Invalid link').max(200, 'Invalid link')

const fullName = z.string().trim().min(2, 'Enter at least 2 characters').max(60)

/** Consent to the current Terms and Privacy Policy (stored with their versions). */
const acceptTerms = z.literal(true, { error: 'You need to accept the terms to continue' })

export const signupSchema = z.object({
  fullName,
  email,
  plan: z.enum(['starter', 'growth', 'business']).default('starter'),
  password,
  acceptTerms,
})

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required').max(200),
  remember: z.boolean().optional().default(false),
})

export const verifyEmailSchema = z.object({ token })

export const forgotPasswordSchema = z.object({ email })

export const resetPasswordSchema = z.object({ token, password })

export const teamSizes = ['1–10', '11–50', '51–200', '201–500', '500+']
export const industries = [
  'Retail & distribution',
  'Manufacturing',
  'Professional services',
  'Real estate',
  'Education',
  'Healthcare',
  'Other',
]
export const goals = ['capture_leads', 'manage_pipeline', 'whatsapp', 'automate_followups', 'quotes_invoices', 'reports']

export const onboardingSchema = z.object({
  jobRole: z.string().trim().min(2, 'Tell us your role').max(60),
  phone: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\+?[0-9][0-9\s-]{7,15}$/.test(v), 'Enter a valid phone number')
    .transform((v) => v || null)
    .optional(),
  company: z.string().trim().min(2, 'Company name is required').max(80),
  industry: z.enum(industries, { error: 'Choose your industry' }),
  teamSize: z.enum(teamSizes, { error: 'Select your team size' }),
  goals: z.array(z.enum(goals)).min(1, 'Pick at least one goal').max(goals.length),
})

// ---------- M05: account & security ----------

const code = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your app')
const recoveryCode = z.string().trim().min(8, 'Enter a recovery code').max(20, 'Enter a recovery code')
const phone = z
  .string()
  .trim()
  .refine((v) => v === '' || /^\+?[0-9][0-9\s-]{7,15}$/.test(v), 'Enter a valid phone number')
  .transform((v) => v || null)

export const loginSecondFactorSchema = z
  .object({ challengeToken: z.string().min(20).max(200), code: code.optional(), recoveryCode: recoveryCode.optional() })
  .refine((v) => v.code || v.recoveryCode, { path: ['code'], message: 'Enter the 6-digit code from your app' })

export const acceptTermsSchema = z.object({ termsVersion: z.string().max(20), privacyVersion: z.string().max(20) })

const isTimeZone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export const profileSchema = z
  .object({
    fullName,
    jobRole: z.string().trim().max(60).nullish().transform((v) => v || null),
    phone: phone.nullish().transform((v) => v ?? null),
    avatarFileId: z.uuid('Invalid file').nullable(),
    timezone: z.string().refine(isTimeZone, 'Choose a valid time zone').nullable(),
    locale: z.enum(['en-IN', 'en-US']).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(200),
  newPassword: password,
})

export const changeEmailSchema = z.object({ newEmail: email, password: z.string().min(1, 'Enter your password').max(200) })

export const twoFactorCodeSchema = z.object({ code })

export const reauthSchema = z
  .object({ password: z.string().min(1, 'Enter your password').max(200), code: code.optional(), recoveryCode: recoveryCode.optional() })
  .refine((v) => v.code || v.recoveryCode, { path: ['code'], message: 'Enter the 6-digit code from your app' })

export const passwordOnlySchema = z.object({ password: z.string().min(1, 'Enter your password').max(200) })

export const sessionIdParams = z.object({ sessionId: z.uuid('Invalid session') })
