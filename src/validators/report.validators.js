import { z } from 'zod'
import { parseIsoDate } from '../lib/time.js'

const isoDate = z.string().refine((v) => Boolean(parseIsoDate(v)), 'Use a date like 2026-10-21')
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-10')

/** Shared report filters (M15). from/to are whole days in the workspace time zone; both or neither. */
export const reportQuery = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    ownerId: z.union([z.literal('me'), z.uuid()]).optional(),
    sourceId: z.union([z.literal('none'), z.uuid()]).optional(),
    pipelineId: z.uuid().optional(),
    compare: z.enum(['previous']).optional(),
    // `month` is the dashboard's revenue series; trend charts pick day/week/month for `auto`.
    interval: z.enum(['auto', 'day', 'week', 'month']).optional(),
    months: z.coerce.number().int().min(1).max(24).optional(),
  })
  .refine((q) => Boolean(q.from) === Boolean(q.to), { path: ['to'], message: 'Give both from and to' })
  .refine((q) => !q.from || q.from <= q.to, { path: ['to'], message: 'The end date must be on or after the start date' })
  .refine((q) => !q.from || Date.parse(q.to) - Date.parse(q.from) <= 3 * 366 * 86_400_000, { path: ['from'], message: 'Choose a period of three years or less' })
  // Daily buckets over long ranges would draw thousands of points.
  .refine((q) => q.interval !== 'day' || !q.from || Date.parse(q.to) - Date.parse(q.from) <= 92 * 86_400_000, { path: ['interval'], message: 'Choose weekly or monthly for periods over three months' })

export const targetsQuery = z.object({ month })

const amount = z.number().int().min(0).max(1e15)
export const targetsBody = z.object({
  month,
  targets: z
    .array(
      z.object({
        userId: z.uuid(),
        // Minor units of the workspace currency; null clears the target, omitted leaves it unchanged.
        revenueMinor: amount.nullable().optional(),
        dealsWon: z.number().int().min(0).max(100_000).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
})

export const scheduleParams = z.object({ frequency: z.enum(['weekly', 'monthly']) })
export const scheduleBody = z.object({
  enabled: z.boolean(),
  filters: z.object({ ownerId: z.union([z.literal('me'), z.uuid()]).optional(), sourceId: z.union([z.literal('none'), z.uuid()]).optional() }).optional(),
})
