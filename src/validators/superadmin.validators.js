import { z } from 'zod'
import { listQuerySchema } from '../lib/pagination.js'

export const clientListSchema = listQuerySchema.extend({
  search: z.string().trim().max(120).optional(),
  plan: z.enum(['starter', 'growth', 'business', 'enterprise']).optional(),
})
export const queryListSchema = listQuerySchema.extend({
  type: z.enum(['contact', 'demo']).default('contact'),
  status: z.enum(['new', 'in_progress', 'closed', 'spam']).optional(),
  search: z.string().trim().max(120).optional(),
  topic: z
    .enum(['sales', 'support', 'partnership', 'press', 'other'])
    .optional(),
})
export const queryParams = z.object({
  type: z.enum(['contact', 'demo']),
  id: z.uuid(),
})
export const messageParams = queryParams.extend({ messageId: z.uuid() })
export const queryStatusSchema = z.object({
  status: z.enum(['new', 'in_progress', 'closed', 'spam']),
})
export const queryMessageSchema = z
  .object({
    kind: z.enum(['note', 'reply']),
    body: z.string().trim().min(1, 'Write a message').max(10000),
  })
  .strict()
