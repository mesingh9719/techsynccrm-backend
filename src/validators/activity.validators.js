import { z } from 'zod'
import { listQuerySchema } from '../lib/pagination.js'
import { queryBool } from './crm.validators.js'

/** Activities, timeline and tasks (M10). */

const entityType = z.enum(['lead', 'contact', 'company', 'deal'], { error: 'Choose a record' })
const text = (max) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters`)
    .nullish()
    .transform((v) => v || null)
const instant = z.iso.datetime({ offset: true, error: 'Enter a date and time' })
const calendarDate = z.iso.date({ error: 'Enter a valid date' })
const location = z.object({ text: z.string().trim().max(200).optional(), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() }).nullable()

const activityFields = {
  subject: text(200),
  body: z.string().max(10_000, 'Keep it under 10,000 characters').nullish(),
  occurredAt: instant,
  endAt: instant.nullable(),
  direction: z.enum(['inbound', 'outbound']).nullable(),
  outcome: z.enum(['connected', 'no_answer', 'busy', 'wrong_number', 'callback_requested', 'voicemail']).nullable(),
  durationSeconds: z.number().int().min(0).max(24 * 3600).nullable(),
  location,
}

export const logActivitySchema = z
  .object({
    type: z.enum(['note', 'call', 'meeting', 'site_visit', 'whatsapp', 'email', 'sms'], { error: 'Choose what to log' }),
    entityType,
    entityId: z.uuid('Choose a record'),
    ...activityFields,
    participantUserIds: z.array(z.uuid()).max(20).optional(),
    participantContactIds: z.array(z.uuid()).max(20).optional(),
    relatedRefs: z.array(z.object({ entityType, entityId: z.uuid() })).max(10).optional(),
  })
  .partial({ subject: true, body: true, occurredAt: true, endAt: true, direction: true, outcome: true, durationSeconds: true, location: true })

export const updateActivitySchema = z
  .object(activityFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')

export const pinSchema = z.object({ pinned: z.boolean().default(true) })

export const timelineQuery = listQuerySchema.extend({
  entityType,
  entityId: z.uuid('Choose a record'),
  types: z.string().max(200).refine((v) => v.split(',').every((t) => ['note', 'call', 'meeting', 'site_visit', 'whatsapp', 'email', 'sms', 'system'].includes(t)), 'Choose valid activity types').optional(),
})

// ---------- Tasks ----------

const recurrence = z
  .object({
    freq: z.enum(['daily', 'weekly', 'monthly']),
    interval: z.number().int().min(1).max(12).optional(),
    byWeekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    byMonthDay: z.number().int().min(1).max(31).optional(),
    count: z.number().int().min(2).max(365).optional(),
    until: calendarDate.optional(),
  })
  .nullable()

const taskFields = {
  title: z.string().trim().min(1, 'What needs doing?').max(200),
  description: text(5000),
  type: z.enum(['todo', 'call', 'meeting', 'follow_up', 'email', 'whatsapp']),
  priority: z.enum(['low', 'normal', 'high']),
  /** A specific time … */
  dueAt: instant.nullable(),
  /** … or a whole day (due by end of day, workspace time zone). */
  dueDate: calendarDate.nullable(),
  reminderOffsetMinutes: z.number().int().min(0).max(7 * 24 * 60).nullable(),
  recurrence,
  entityType: entityType.nullable(),
  entityId: z.uuid().nullable(),
  assigneeId: z.uuid('Choose a member'),
}

const recordPair = (v) => !('entityType' in v || 'entityId' in v) || (v.entityType ? Boolean(v.entityId) : !v.entityId)

export const createTaskSchema = z
  .object(taskFields)
  .partial({ description: true, type: true, priority: true, dueAt: true, dueDate: true, reminderOffsetMinutes: true, recurrence: true, entityType: true, entityId: true, assigneeId: true })
  .refine(recordPair, { message: 'Choose the record', path: ['entityId'] })
  .refine((v) => !(v.dueAt && v.dueDate), { message: 'Give a time or a date, not both', path: ['dueAt'] })
  .refine((v) => !v.recurrence || v.dueAt || v.dueDate, { message: 'Recurring tasks need a due date', path: ['recurrence'] })

export const updateTaskSchema = z
  .object(taskFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
  .refine(recordPair, { message: 'Choose the record', path: ['entityId'] })
  .refine((v) => !(v.dueAt && v.dueDate), { message: 'Give a time or a date, not both', path: ['dueAt'] })

export const completeTaskSchema = z
  .object({
    logActivity: z
      .object({
        outcome: z.enum(['connected', 'no_answer', 'busy', 'wrong_number', 'callback_requested', 'voicemail']).optional(),
        notes: z.string().max(10_000).optional(),
        durationSeconds: z.number().int().min(0).max(24 * 3600).optional(),
      })
      .optional(),
  })
  .default({})

export const taskListQuery = z.object({
  view: z.enum(['today', 'overdue', 'upcoming', 'completed', 'all', 'open']).default('today'),
  assigneeId: z.string().max(400).refine((v) => v.split(',').every((id) => id === 'me' || z.uuid().safeParse(id).success), 'Choose valid members').optional(),
  entityType: entityType.optional(),
  entityId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  counts: queryBool,
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().regex(/^\d+$/).refine((v) => Number.isSafeInteger(Number(v)), 'Invalid cursor').optional(),
}).refine(recordPair, { message: 'Choose the record', path: ['entityId'] })

export const taskBulkSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(200),
  action: z.enum(['complete', 'reassign', 'reschedule', 'delete']),
  payload: z
    .object({ assigneeId: z.uuid().optional(), dueAt: instant.optional(), dueDate: calendarDate.optional() })
    .default({}),
}).superRefine((v, ctx) => {
  if (v.action === 'reassign' && !v.payload.assigneeId) ctx.addIssue({ code: 'custom', path: ['payload', 'assigneeId'], message: 'Choose a member' })
  if (v.action === 'reschedule' && Boolean(v.payload.dueAt) === Boolean(v.payload.dueDate)) ctx.addIssue({ code: 'custom', path: ['payload', 'dueAt'], message: 'Give a time or a date' })
})
