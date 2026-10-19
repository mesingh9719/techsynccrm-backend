import { z } from 'zod'
import { NOTIFICATION_TYPES, NOTIFICATION_TYPE_KEYS } from '../config/notifications.js'
import { listQuerySchema } from '../lib/pagination.js'
import { queryBool } from './crm.validators.js'

export const notificationListQuery = listQuerySchema.extend({ unread: queryBool })
export const streamQuery = z.object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid stream ticket') }).strict()
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')
export const notificationPreferencesSchema = z.object({
  preferences: z.array(z.object({ type: z.enum(NOTIFICATION_TYPE_KEYS), inApp: z.boolean(), email: z.boolean() })).max(NOTIFICATION_TYPE_KEYS.length),
  quietHours: z.object({ start: clock, end: clock }).refine((v) => v.start !== v.end, 'Choose different start and end times').nullable(),
  digestEnabled: z.boolean(),
}).superRefine((v, ctx) => {
  const seen = new Set()
  for (const [i, pref] of v.preferences.entries()) {
    if (seen.has(pref.type)) ctx.addIssue({ code: 'custom', path: ['preferences', i, 'type'], message: 'Duplicate notification type' })
    if (NOTIFICATION_TYPES[pref.type].mandatory && !pref.inApp) ctx.addIssue({ code: 'custom', path: ['preferences', i, 'inApp'], message: 'This notification must remain available in your inbox' })
    seen.add(pref.type)
  }
})
