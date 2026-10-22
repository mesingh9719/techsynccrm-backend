import { z } from 'zod'

const nullableText = (max) => z.string().trim().max(max).nullable()
/** JSON qualification details belong to the lead and use its existing tenant/write guards. */
export const leadQualificationSchema = z.object({
  priority: z.enum(['hot', 'warm', 'cold']).nullable(),
  dealValueMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  expectedCloseDate: z.iso.date().nullable(),
  timeline: z.enum(['immediate', '1_month', '3_months', '6_months', 'exploring']).nullable(),
  preferences: nullableText(2000),
  objections: z.array(z.string().trim().min(1).max(120)).max(30),
  decisionMakers: z.array(z.object({
    id: z.uuid(), name: z.string().trim().min(1).max(80),
    role: z.enum(['decision_maker', 'influencer', 'user', 'finance']), note: z.string().trim().max(1000).optional(),
  }).strict()).max(30),
}).strict().partial()
