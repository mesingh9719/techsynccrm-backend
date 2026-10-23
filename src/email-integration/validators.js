import { z } from 'zod'

export const startQuery = z.object({ returnTo: z.string().max(200).optional() }).strict()
export const accountParams = z.object({ id: z.uuid() }).strict()
export const teamQuery = z.object({ q: z.string().trim().max(100).default(''),
  status: z.enum(['all', 'CONNECTED', 'DISCONNECTED', 'NEEDS_RECONNECT', 'ERROR']).default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict()
export const reminderBody = z.object({ userIds: z.array(z.uuid()).min(1).max(100).optional() }).strict()
export const settingsBody = z.object({ emailEnabled: z.boolean(), emailVisibility: z.enum(['OWNER_ONLY', 'LEAD_ACCESS']),
  defaultSignatureHtml: z.string().max(10000), allowEmployeeCustomSignature: z.boolean(), requireConnectedEmailToSend: z.boolean() }).partial().strict().refine((v) => Object.keys(v).length > 0, 'Choose a setting to update')
