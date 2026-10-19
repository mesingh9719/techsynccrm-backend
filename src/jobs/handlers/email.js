import { sendEmail } from '../../email/mailer.js'

/** `email.send`: delivers one queued email. Throwing lets pg-boss retry with backoff (jobs/queues.js). */
export async function sendQueuedEmail(job) {
  const { messageId } = await sendEmail(job.data)
  return { messageId }
}
