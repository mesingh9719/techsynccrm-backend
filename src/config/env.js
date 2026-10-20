/** Reads and validates environment variables once at startup. Fails fast on anything missing. */

const NODE_ENV = process.env.NODE_ENV ?? 'development'
const isProduction = NODE_ENV === 'production'

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function number(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value)) throw new Error(`Environment variable ${name} must be a number`)
  return value
}

const jwtSecret = required('JWT_ACCESS_SECRET')
if (jwtSecret.length < 32) throw new Error('JWT_ACCESS_SECRET must be at least 32 characters')

const sameSite = (process.env.COOKIE_SAMESITE ?? 'lax').toLowerCase()
if (!['lax', 'strict', 'none'].includes(sameSite)) throw new Error('COOKIE_SAMESITE must be lax, strict or none')

const emailDelivery = (process.env.EMAIL_DELIVERY ?? 'queue').toLowerCase()
if (!['queue', 'direct'].includes(emailDelivery)) throw new Error('EMAIL_DELIVERY must be queue or direct')

const encryptionKey = required('DATA_ENCRYPTION_KEY')
if (Buffer.from(encryptionKey, 'base64').length !== 32) {
  throw new Error(
    `DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
  )
}

const helloInbox = process.env.HELLO_INBOX || process.env.SMTP_USER || null

export const env = Object.freeze({
  NODE_ENV,
  isProduction,
  PORT: number('PORT', 5000),
  /** Comma-separated list of allowed browser origins. */
  CORS_ORIGINS: (isProduction ? required('CORS_ORIGINS') : (process.env.CORS_ORIGINS ?? 'http://localhost:5173'))
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  RATE_LIMIT_WINDOW_MS: number('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  RATE_LIMIT_MAX: number('RATE_LIMIT_MAX', 300),
  AUTH_RATE_LIMIT_MAX: number('AUTH_RATE_LIMIT_MAX', 20),

  /** Neon Postgres — pooled connection for app traffic (migrations use DATABASE_URL_UNPOOLED). */
  DATABASE_URL: required('DATABASE_URL'),
  /** Direct connection, needed by the job queue (pg-boss) and migrations. Falls back to DATABASE_URL. */
  DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED || required('DATABASE_URL'),
  DB_POOL_MAX: number('DB_POOL_MAX', 10),

  /** JWT access tokens */
  JWT_ACCESS_SECRET: jwtSecret,
  JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
  JWT_ISSUER: process.env.JWT_ISSUER ?? 'techsync-crm-api',
  JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? 'techsync-crm',

  /** AES-256-GCM key for secrets stored in the database (2FA secrets, integration credentials). */
  DATA_ENCRYPTION_KEY: encryptionKey,

  /** Account security (M05) */
  LOGIN_LOCKOUT_THRESHOLD: number('LOGIN_LOCKOUT_THRESHOLD', 10),
  LOGIN_LOCKOUT_MINUTES: number('LOGIN_LOCKOUT_MINUTES', 15),
  INVITATION_TTL_DAYS: number('INVITATION_TTL_DAYS', 7),

  /** Refresh tokens (httpOnly cookie, rotated on every use) */
  REFRESH_TOKEN_TTL_DAYS: number('REFRESH_TOKEN_TTL_DAYS', 7),
  REFRESH_TOKEN_REMEMBER_TTL_DAYS: number('REFRESH_TOKEN_REMEMBER_TTL_DAYS', 30),
  COOKIE_SAMESITE: sameSite,

  /** Neon Object Storage — credentials/endpoint come from the AWS_* vars read by the SDK. */
  STORAGE_BUCKET: process.env.STORAGE_BUCKET ?? 'assets',
  STORAGE_URL_EXPIRES_IN: number('STORAGE_URL_EXPIRES_IN', 900),
  MAX_UPLOAD_MB: number('MAX_UPLOAD_MB', 25),

  /** Public URL of the frontend — used to build links in emails. */
  FRONTEND_URL: (isProduction ? required('FRONTEND_URL') : (process.env.FRONTEND_URL ?? 'http://localhost:5173')).replace(/\/$/, ''),

  /** Outgoing email (SMTP). Without SMTP_HOST in development, emails are printed to the console instead. */
  SMTP_HOST: isProduction ? required('SMTP_HOST') : process.env.SMTP_HOST,
  SMTP_PORT: number('SMTP_PORT', 587),
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
  /** Sender shown to recipients; defaults to the SMTP user. */
  SMTP_FROM: process.env.SMTP_FROM || (process.env.SMTP_USER ? `TechSync CRM <${process.env.SMTP_USER}>` : 'TechSync CRM <no-reply@techsynccrm.com>'),

  EMAIL_VERIFICATION_TTL_HOURS: number('EMAIL_VERIFICATION_TTL_HOURS', 24),
  PASSWORD_RESET_TTL_MINUTES: number('PASSWORD_RESET_TTL_MINUTES', 60),
  EMAIL_RESEND_COOLDOWN_SECONDS: number('EMAIL_RESEND_COOLDOWN_SECONDS', 60),
  /**
   * "queue" (default): emails are sent by the worker with retries — run `npm run worker`.
   * "direct": sent inline by the API, for local development without a worker.
   */
  EMAIL_DELIVERY: emailDelivery,

  /** Where marketing-form notifications go. Sales/support fall back to HELLO_INBOX, which falls back to SMTP_USER. */
  HELLO_INBOX: helloInbox,
  SALES_INBOX: process.env.SALES_INBOX || helloInbox,
  SUPPORT_INBOX: process.env.SUPPORT_INBOX || helloInbox,
  /** Comma-separated emails of TechSync staff allowed to read /api/internal/* (until the admin console exists). */
  INTERNAL_STAFF_EMAILS: (process.env.INTERNAL_STAFF_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  /** Marketing forms */
  PUBLIC_FORM_RATE_LIMIT_MAX: number('PUBLIC_FORM_RATE_LIMIT_MAX', 10),
  DEMO_SLOT_CAPACITY: number('DEMO_SLOT_CAPACITY', 3),
  DEMO_MAX_DAYS_AHEAD: number('DEMO_MAX_DAYS_AHEAD', 30),
  NEWSLETTER_CONFIRM_TTL_DAYS: number('NEWSLETTER_CONFIRM_TTL_DAYS', 7),
})

// The storage SDK reads these directly from process.env; check them here so startup fails clearly.
for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ENDPOINT_URL_S3']) required(name)
