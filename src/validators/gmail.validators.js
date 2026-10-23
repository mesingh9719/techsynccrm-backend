import { z } from 'zod'
import { CONSENT_VERSION } from '../integrations/gmail/config.js'
import { listQuerySchema } from '../lib/pagination.js'

const email = z.email().max(254).transform((v) => v.toLowerCase())
const exclusions = {
  excludedAddresses: z.array(email).max(100).default([]),
  excludedDomains: z.array(z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/)).max(100).default([]),
}
export const gmailStart = z.object({
  returnTo: z.string().max(200).default('/app/settings/gmail'),
  shareWithTeam: z.literal(true), consentVersion: z.literal(CONSENT_VERSION),
  backfillDays: z.union([z.literal(0), z.literal(30)]).default(0), ...exclusions,
}).strict()
export const gmailSettings = z.object({ signatureHtml: z.string().max(10000).optional(), ...exclusions }).partial().strict()
export const gmailId = z.object({ id: z.uuid() })
export const emailRecordQuery = listQuerySchema.extend({ entityType: z.enum(['lead', 'contact']), entityId: z.uuid() })
export const emailSend = z.object({
  entityType: z.enum(['lead', 'contact']).default('lead'), entityId: z.uuid(), to: email,
  subject: z.string().trim().min(1).max(998).refine((v) => !/[\r\n\0]/.test(v)),
  bodyHtml: z.string().min(1).max(100000), templateId: z.uuid().optional(), replyToMessageId: z.uuid().optional(),
  attachmentFileIds: z.array(z.uuid()).max(3).default([]),
}).strict()
export const emailTemplate = z.object({ name: z.string().trim().min(1).max(120), subject: z.string().min(1).max(998).refine((v) => !/[\r\n\0]/.test(v)), bodyHtml: z.string().min(1).max(100000), shared: z.boolean().default(false) }).strict()
export { listQuerySchema as gmailList }
