import { prisma } from '../db/prisma.js'
import { sendEmail } from '../email/mailer.js'
import { env } from '../config/env.js'

const escape = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  )

/** The transactional outbox retries failed deliveries. A row lock serialises retries. */
export async function deliverInboundReply(event) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM inbound_messages WHERE id = ${event.entityId}::uuid FOR UPDATE`
        const message = await tx.inboundMessage.findUnique({
          where: { id: event.entityId },
          include: { contactRequest: true, demoRequest: true },
        })
        if (!message || message.kind !== 'reply' || message.sentAt) return
        const request = message.contactRequest ?? message.demoRequest
        const reference = request.ticketNo ?? request.confirmationId
        await sendEmail({
          to: request.email,
          ...(env.SUPPORT_INBOX && { replyTo: env.SUPPORT_INBOX }),
          messageId: `<inbound-${message.id}@techsynccrm.com>`,
          subject: `Re: Your TechSync CRM enquiry [${reference}]`,
          text: `${message.body}\n\nTechSync CRM Support\nReference: ${reference}`,
          html: `<div style="font-family:Arial,sans-serif;line-height:1.6;white-space:pre-wrap">${escape(message.body)}</div><p>TechSync CRM Support<br>Reference: ${escape(reference)}</p>`,
        })
        await tx.inboundMessage.update({
          where: { id: message.id },
          data: { deliveryStatus: 'sent', sentAt: new Date() },
        })
      },
      { timeout: 30000 },
    )
  } catch (err) {
    await prisma.inboundMessage.updateMany({
      where: { id: event.entityId, kind: 'reply', sentAt: null },
      data: { deliveryStatus: 'failed' },
    })
    throw err
  }
}
