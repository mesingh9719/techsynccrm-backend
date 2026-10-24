import { z } from 'zod'

/** Assignment rules, working hours and out-of-office (M14). Mirrors frontend/src/features/capture/AssignmentPage.tsx. */

const CONDITION_FIELD = /^(sourceId|formId|city|stateCode|pincode|budgetMinor|tag|createdVia|cf\.[a-zA-Z][a-zA-Z0-9_]{0,59})$/
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

export const ruleIdParams = z.object({ id: z.uuid('Rule not found') })
export const absenceIdParams = z.object({ id: z.uuid('Out-of-office period not found') })

export const assignmentRuleSchema = z.object({
  name: z.string().trim().min(1, 'Give this rule a name.').max(100),
  isActive: z.boolean().default(true),
  conditions: z
    .array(
      z.object({
        field: z.string().regex(CONDITION_FIELD, 'Choose a condition field'),
        operator: z.enum(['equals', 'contains', 'starts_with', 'gte', 'lte'], { error: 'Choose how to compare' }),
        value: z.string().trim().min(1, 'Complete each condition, or remove it.').max(200),
      }),
    )
    .max(10, 'Use at most 10 conditions')
    .default([]),
  strategy: z.enum(['round_robin', 'load_balanced', 'specific_user'], { error: 'Choose how leads are shared' }),
  memberIds: z
    .array(z.uuid('Choose an active teammate'))
    .min(1, 'Choose at least one active teammate.')
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, 'Each teammate can be added once'),
  outsideHours: z.enum(['assign_anyway', 'hold_until_open', 'fallback']).default('assign_anyway'),
  onlyWorkingHours: z.boolean().default(true),
  dailyCap: z.number().int('Daily cap must be a positive whole number.').min(1, 'Daily cap must be a positive whole number.').max(10_000).nullable().default(null),
})

export const ruleOrderSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(200).refine((ids) => new Set(ids).size === ids.length, 'Each rule can appear once'),
})

export const assignmentTestSchema = z.object({
  leadSample: z.record(z.string().max(80), z.string().max(500)).refine((v) => Object.keys(v).length <= 40, 'Use at most 40 fields'),
})

const isTimeZone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export const workingHoursSchema = z
  .object({
    timezone: z.string().trim().max(60).refine(isTimeZone, 'Choose a valid time zone'),
    days: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .transform((d) => [...new Set(d)].sort()),
    start: z.string().regex(HHMM, 'Use a time like 10:00'),
    end: z.string().regex(HHMM, 'Use a time like 19:00'),
    fallbackOwnerId: z.uuid('Choose an active teammate').nullable().default(null),
    firstResponseSlaMinutes: z.number().int().min(1, 'Use 1 to 1440 minutes').max(1440, 'Use 1 to 1440 minutes').nullable().default(null),
    slaAutoReassign: z.boolean().default(false),
  })
  .refine((h) => h.start !== h.end, { path: ['end'], message: 'Closing time must differ from opening time' })

export const outOfOfficeSchema = z
  .object({
    startsAt: z.iso.datetime({ offset: true, error: 'Choose a start date and time' }),
    endsAt: z.iso.datetime({ offset: true, error: 'Choose an end date and time' }),
    note: z.string().trim().max(200).default(''),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), { path: ['endsAt'], message: 'The end must be after the start' })
  .refine((v) => new Date(v.endsAt) > new Date(), { path: ['endsAt'], message: 'The end must be in the future' })
