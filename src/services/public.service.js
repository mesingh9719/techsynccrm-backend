import crypto from 'node:crypto'
import { env } from '../config/env.js'
import { prisma, UNIQUE_VIOLATION } from '../db/prisma.js'
import { queueEmail } from '../email/mailer.js'
import {
  contactConfirmationEmail,
  contactInternalEmail,
  demoConfirmationEmail,
  demoInternalEmail,
  newsletterConfirmEmail,
} from '../email/templates.js'
import { emit } from '../events/outbox.js'
import { buildIcs } from '../lib/ics.js'
import { logger } from '../lib/logger.js'
import { buildPage, parseListQuery } from '../lib/pagination.js'
import { isSpam } from '../lib/spam.js'
import { zonedTimeToUtc, parseIsoDate } from '../lib/time.js'
import { ApiError } from '../utils/ApiError.js'
import { contactTopics } from '../validators/public.validators.js'
import { DEMO_DURATION_MINUTES, DEMO_TZ, formatSlotLabel, listSlots, slotStart, validateDemoTime } from './demoSlots.js'

const log = logger.child({ component: 'public-forms' })

/** The consent wording shown next to the contact form's checkbox (frontend/src/pages/Contact.tsx). */
export const CONTACT_CONSENT_TEXT = 'I agree to TechSync contacting me about this enquiry, as described in the Privacy Policy.'

const NEWSLETTER_RESEND_COOLDOWN_MS = 60_000
const CONFIRMATION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I

// ---------- helpers ----------

function buildMeta(input, request) {
  const utm = Object.fromEntries(Object.entries(input.utm ?? {}).filter(([, v]) => v))
  return {
    ip: request.ip ?? null,
    userAgent: request.userAgent ?? null,
    pageUrl: input.pageUrl || null,
    referrer: input.referrer || null,
    ...(Object.keys(utm).length && { utm }),
  }
}

const ticketNumber = () => `TS-${crypto.randomInt(100_000, 1_000_000)}`
const confirmationCode = () => Array.from({ length: 8 }, () => CONFIRMATION_ALPHABET[crypto.randomInt(CONFIRMATION_ALPHABET.length)]).join('')
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex')

/** Retries `fn` when a randomly generated unique code collides. */
async function withUniqueRetry(fn, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (err.code !== UNIQUE_VIOLATION || i >= attempts) throw err
    }
  }
}

/** The submission is already saved; an email problem must not turn it into an error for the visitor. */
async function sendSafely(label, message) {
  if (!message.to) {
    log.warn(`${label}: no recipient configured (set HELLO_INBOX / SALES_INBOX / SUPPORT_INBOX)`)
    return
  }
  try {
    await queueEmail(message)
  } catch (err) {
    log.error({ err }, `${label} failed`)
  }
}

const validationError = (fields) => new ApiError(400, 'Validation failed', { code: 'VALIDATION_ERROR', details: { fields } })

function inboxForTopic(topic) {
  if (topic === 'sales') return env.SALES_INBOX
  if (topic === 'support') return env.SUPPORT_INBOX
  return env.HELLO_INBOX
}

// ---------- Contact ----------

export async function submitContact(input, request) {
  if (isSpam(input)) {
    log.info({ ip: request.ip }, 'contact submission discarded as spam')
    return { ticketId: ticketNumber() }
  }

  const meta = buildMeta(input, request)
  const row = await withUniqueRetry(() =>
    prisma.$transaction(async (tx) => {
      const created = await tx.contactRequest.create({
        data: {
          ticketNo: ticketNumber(),
          name: input.name,
          email: input.email,
          company: input.company,
          phone: input.phone,
          topic: input.topic,
          message: input.message,
          consentText: CONTACT_CONSENT_TEXT,
          consentAt: new Date(),
          meta,
        },
      })
      await emit(tx, null, 'contact_request.created', { entityType: 'contact_request', entityId: created.id }, { topic: created.topic })
      return created
    }),
  )

  const topicLabel = contactTopics[row.topic]
  await sendSafely('contact internal email', { to: inboxForTopic(row.topic), ...contactInternalEmail({ ...row, topicLabel, meta }) })
  await sendSafely('contact confirmation email', {
    to: row.email,
    ...contactConfirmationEmail({ name: row.name, ticketNo: row.ticketNo, topicLabel, helpUrl: `${env.FRONTEND_URL}/help` }),
  })
  return { ticketId: row.ticketNo }
}

// ---------- Demo ----------

async function bookedCountsForDay(date) {
  const d = parseIsoDate(date)
  const dayStart = zonedTimeToUtc(d, DEMO_TZ)
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000)
  const groups = await prisma.demoRequest.groupBy({
    by: ['slotStart'],
    where: { slotStart: { gte: dayStart, lt: dayEnd } },
    _count: { _all: true },
  })
  return new Map(groups.map((g) => [g.slotStart.getTime(), g._count._all]))
}

export async function getDemoSlots(date) {
  if (!parseIsoDate(date)) throw validationError({ date: 'Choose a valid date' })
  const now = new Date()
  const slots = listSlots(date, now, await bookedCountsForDay(date), { capacity: env.DEMO_SLOT_CAPACITY, maxDaysAhead: env.DEMO_MAX_DAYS_AHEAD })
  return { date, timezone: DEMO_TZ, slots }
}

export async function requestDemo(input, request) {
  if (!parseIsoDate(input.date)) throw validationError({ date: 'Choose a valid date' })
  const start = slotStart(input.date, input.slot)
  if (isSpam(input)) {
    log.info({ ip: request.ip }, 'demo submission discarded as spam')
    return { confirmationId: confirmationCode(), slotStart: start.toISOString() }
  }

  const fieldErrors = validateDemoTime(input.date, input.slot, new Date(), { maxDaysAhead: env.DEMO_MAX_DAYS_AHEAD })
  if (Object.keys(fieldErrors).length) throw validationError(fieldErrors)

  const meta = buildMeta(input, request)
  const row = await withUniqueRetry(
    () =>
      prisma.$transaction(async (tx) => {
        // Serialises bookings for this slot so concurrent requests can't exceed capacity.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`demo-slot:${start.toISOString()}`}))`
        const booked = await tx.demoRequest.count({ where: { slotStart: start } })
        if (booked >= env.DEMO_SLOT_CAPACITY) {
          throw new ApiError(409, 'That time slot has just been booked. Please pick another.', {
            code: 'SLOT_FULL',
            details: { fields: { slot: 'This time slot is fully booked. Please pick another.' } },
          })
        }
        const created = await tx.demoRequest.create({
          data: {
            confirmationId: confirmationCode(),
            firstName: input.firstName,
            lastName: input.lastName,
            email: input.email,
            phone: input.phone,
            company: input.company,
            companySize: input.companySize,
            role: input.role,
            interests: input.interests,
            slotStart: start,
            notes: input.notes,
            meta,
          },
        })
        await emit(tx, null, 'demo_request.created', { entityType: 'demo_request', entityId: created.id }, { slotStart: start.toISOString() })
        return created
      }),
    3,
  )

  const whenLabel = formatSlotLabel(input.date, input.slot)
  const ics = buildIcs({
    uid: `demo-${row.id}@techsynccrm.com`,
    start,
    durationMinutes: DEMO_DURATION_MINUTES,
    summary: 'TechSync CRM demo',
    description: `Personalised demo for ${row.company}. Confirmation ${row.confirmationId}. We'll email you the video link before the call.`,
  })
  await sendSafely('demo internal email', { to: env.SALES_INBOX, ...demoInternalEmail({ ...row, whenLabel, meta }) })
  await sendSafely('demo confirmation email', {
    to: row.email,
    ...demoConfirmationEmail({
      firstName: row.firstName,
      company: row.company,
      whenLabel,
      confirmationId: row.confirmationId,
      featuresUrl: `${env.FRONTEND_URL}/features`,
    }),
    attachments: [{ filename: 'techsync-demo.ics', content: ics, contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }],
  })
  return { confirmationId: row.confirmationId, slotStart: start.toISOString() }
}

// ---------- Newsletter (double opt-in) ----------

/**
 * Always resolves the same way whatever the email's current state, so the endpoint can't be used
 * to find out who is subscribed.
 */
export async function subscribeNewsletter(input, request) {
  if (isSpam(input)) return
  const existing = await prisma.newsletterSubscriber.findUnique({ where: { email: input.email } })
  if (existing?.status === 'confirmed') return
  if (existing?.status === 'pending' && existing.confirmSentAt && Date.now() - existing.confirmSentAt.getTime() < NEWSLETTER_RESEND_COOLDOWN_MS) return

  const token = crypto.randomBytes(32).toString('base64url')
  const now = new Date()
  const confirm = {
    status: 'pending',
    confirmTokenHash: hashToken(token),
    confirmExpiresAt: new Date(now.getTime() + env.NEWSLETTER_CONFIRM_TTL_DAYS * 86_400_000),
    confirmSentAt: now,
    meta: buildMeta(input, request),
  }

  let subscriber
  try {
    subscriber = await prisma.newsletterSubscriber.upsert({
      where: { email: input.email },
      create: { email: input.email, unsubscribeToken: crypto.randomBytes(24).toString('base64url'), ...confirm },
      update: confirm,
    })
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) return // a parallel request for the same email won
    throw err
  }

  const unsubscribeUrl = `${env.FRONTEND_URL}/newsletter/unsubscribe?token=${subscriber.unsubscribeToken}`
  await sendSafely('newsletter confirmation email', {
    to: subscriber.email,
    ...newsletterConfirmEmail({ url: `${env.FRONTEND_URL}/newsletter/confirm?token=${token}`, days: env.NEWSLETTER_CONFIRM_TTL_DAYS }),
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` },
  })
}

export async function confirmNewsletter(token) {
  const tokenHash = hashToken(token)
  const subscriber = await prisma.newsletterSubscriber.findUnique({ where: { confirmTokenHash: tokenHash } })
  if (!subscriber) throw new ApiError(400, 'This link is invalid or has already been used.', { code: 'TOKEN_INVALID' })
  if (subscriber.confirmExpiresAt && subscriber.confirmExpiresAt <= new Date()) {
    throw new ApiError(400, 'This link has expired. Subscribe again to get a new one.', { code: 'TOKEN_EXPIRED_LINK' })
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Conditional on the token so a double click can't confirm twice.
    const { count } = await tx.newsletterSubscriber.updateMany({
      where: { id: subscriber.id, confirmTokenHash: tokenHash },
      data: { status: 'confirmed', confirmedAt: new Date(), unsubscribedAt: null, confirmTokenHash: null, confirmExpiresAt: null },
    })
    if (count === 1) await emit(tx, null, 'newsletter_subscriber.confirmed', { entityType: 'newsletter_subscriber', entityId: subscriber.id })
    return count
  })
  if (updated !== 1) throw new ApiError(400, 'This link is invalid or has already been used.', { code: 'TOKEN_INVALID' })
  return { confirmed: true, email: subscriber.email }
}

/** Idempotent: unsubscribing twice succeeds both times. */
export async function unsubscribeNewsletter(token) {
  const subscriber = await prisma.newsletterSubscriber.findUnique({ where: { unsubscribeToken: token } })
  if (!subscriber) throw new ApiError(400, 'This link is invalid.', { code: 'TOKEN_INVALID' })
  if (subscriber.status !== 'unsubscribed') {
    await prisma.newsletterSubscriber.update({
      where: { id: subscriber.id },
      data: { status: 'unsubscribed', unsubscribedAt: new Date(), confirmTokenHash: null, confirmExpiresAt: null },
    })
  }
  return { unsubscribed: true, email: subscriber.email }
}

// ---------- Internal (staff) ----------

const INBOUND = {
  contact: { model: 'contactRequest', statuses: ['new', 'in_progress', 'closed', 'spam'], select: undefined },
  demo: { model: 'demoRequest', statuses: ['new', 'in_progress', 'closed', 'spam'], select: undefined },
  newsletter: {
    model: 'newsletterSubscriber',
    statuses: ['pending', 'confirmed', 'unsubscribed'],
    select: { id: true, email: true, status: true, confirmedAt: true, unsubscribedAt: true, meta: true, createdAt: true },
  },
}

export async function listInbound({ type, status, ...query }) {
  const config = INBOUND[type]
  if (status && !config.statuses.includes(status)) throw validationError({ status: `Status must be one of: ${config.statuses.join(', ')}` })
  const page = parseListQuery(query, { sortable: { createdAt: 'date' }, defaultSort: '-createdAt' })
  const rows = await prisma[config.model].findMany({
    where: { ...(status && { status }), ...page.cursorWhere },
    orderBy: page.orderBy,
    take: page.take,
    ...(config.select && { select: config.select }),
  })
  return buildPage(rows, page)
}
