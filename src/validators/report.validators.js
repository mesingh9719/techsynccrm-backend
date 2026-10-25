import { z } from 'zod'
import { parseIsoDate } from '../lib/time.js'

const isoDate = z.string().refine((v) => Boolean(parseIsoDate(v)), 'Use a date like 2026-10-21')

/** Shared report filters (M15). from/to are whole days in the workspace time zone; both or neither. */
export const reportQuery = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    ownerId: z.union([z.literal('me'), z.uuid()]).optional(),
    sourceId: z.union([z.literal('none'), z.uuid()]).optional(),
    compare: z.enum(['previous']).optional(),
    interval: z.literal('month').optional(),
    months: z.coerce.number().int().min(1).max(24).optional(),
  })
  .refine((q) => Boolean(q.from) === Boolean(q.to), { path: ['to'], message: 'Give both from and to' })
  .refine((q) => !q.from || q.from <= q.to, { path: ['to'], message: 'The end date must be on or after the start date' })
  .refine((q) => !q.from || Date.parse(q.to) - Date.parse(q.from) <= 3 * 366 * 86_400_000, { path: ['from'], message: 'Choose a period of three years or less' })
