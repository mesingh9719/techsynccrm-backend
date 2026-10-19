import nodemailer from 'nodemailer'
import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { enqueue } from '../jobs/queue.js'

const log = logger.child({ component: 'email' })

/**
 * SMTP transport. Port 465 uses implicit TLS; other ports (587) upgrade with STARTTLS,
 * which is required rather than optional so credentials never go out in plain text.
 *
 * Without SMTP_HOST (development only), emails are printed to the console instead,
 * so the flows can still be tested end to end.
 */
const transporter = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      requireTLS: env.SMTP_PORT !== 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      pool: true,
      maxConnections: 3,
      connectionTimeout: 15_000,
    })
  : null

/** Checks the SMTP connection at startup. Logs instead of crashing so the API can still serve. */
export async function verifyMailer() {
  if (!transporter) {
    log.warn('SMTP_HOST not set — emails will be printed to the console (development only)')
    return false
  }
  try {
    await transporter.verify()
    log.info(`SMTP connection OK (${env.SMTP_HOST}:${env.SMTP_PORT})`)
    return true
  } catch (err) {
    log.error(`SMTP connection failed: ${err.message}`)
    return false
  }
}

/**
 * Sends an email now. `message` = { to, subject, html, text, replyTo?, headers?, attachments? }.
 * Prefer `queueEmail` from request handlers; this is what the `email.send` job calls.
 */
export async function sendEmail(message) {
  if (!transporter) {
    console.log(`\n[email:console] To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n`)
    return { messageId: 'console' }
  }
  return transporter.sendMail({ from: env.SMTP_FROM, ...message })
}

/**
 * Hands an email to the worker, which sends it with retries (see jobs/handlers/email.js).
 * With EMAIL_DELIVERY=direct — or if the queue can't be reached — it is sent inline instead, so
 * an email is never silently dropped. The message must be JSON-serialisable (attachment content as strings).
 */
export async function queueEmail(message) {
  if (env.EMAIL_DELIVERY === 'queue') {
    try {
      await enqueue('email.send', message)
      return { queued: true }
    } catch (err) {
      log.error({ err, subject: message.subject }, 'could not queue email, sending directly')
    }
  }
  await sendEmail(message)
  return { queued: false }
}

export function closeMailer() {
  transporter?.close()
}
