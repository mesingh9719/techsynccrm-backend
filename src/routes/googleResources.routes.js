import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../middlewares/validate.js'
import { permit } from '../middlewares/org.js'
import { ApiError } from '../utils/ApiError.js'
import * as calendar from '../integrations/google/calendar.js'
import * as sheets from '../integrations/google/sheets.js'

const guarded = (fn) => async (req, res, next) => { try { res.json({ success: true, data: await fn(req) }) } catch (error) { next(error instanceof ApiError ? error : new ApiError(503, 'Google is temporarily unavailable. Review the operation status before retrying.', { code: 'GOOGLE_UNAVAILABLE' })) } }
const id = validate(z.object({ id: z.uuid() }), 'params')
const instant = z.iso.datetime({ offset: true })
const timeZone = z.string().max(80).refine((zone) => { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true } catch { return false } }, 'Choose a valid time zone.')
const details = z.object({ title: z.string().trim().min(1).max(160), startAt: instant, endAt: instant, timeZone, location: z.string().trim().max(300).default(''), includeMeet: z.boolean().default(false),
  attendees: z.array(z.email().max(254).transform((email) => email.toLowerCase())).max(20).default([]), sendInvites: z.boolean().default(false) }).strict()
const timed = (value) => new Date(value.endAt) > new Date(value.startAt) && new Date(value.endAt) - new Date(value.startAt) <= 7 * 86400000
const consented = (value) => !value.attendees.length || value.sendInvites
const createMeeting = details.extend({ requestId: z.uuidv4(), leadId: z.uuid().optional() }).refine(timed, 'Choose an end after the start, within seven days.').refine(consented, 'Confirm sending invitations to the guests.')
const updateMeeting = details.extend({ revision: z.number().int().positive() }).refine(timed, 'Choose an end after the start, within seven days.').refine(consented, 'Confirm sending invitations to the guests.')
const columns = z.array(z.enum(['id', 'displayName', 'primaryEmail', 'primaryPhoneE164', 'companyName', 'status', 'city', 'budgetMinor', 'source', 'owner'])).min(1).max(10).default(['id', 'displayName', 'primaryEmail', 'primaryPhoneE164', 'companyName', 'status', 'city', 'budgetMinor', 'source', 'owner'])
export const googleResourcesRoutes = Router()
googleResourcesRoutes.use(['/calendar', '/sheets'], permit('google.connect.own'))
googleResourcesRoutes.get('/calendar', guarded((req) => calendar.calendarStatus(req.ctx)))
googleResourcesRoutes.post('/calendar/setup', validate(z.object({ calendarId: z.string().min(3).max(300).regex(/^[a-zA-Z0-9@._-]+$/).refine((id) => id !== 'primary').optional(), refresh: z.boolean().optional() }).strict()), guarded((req) => calendar.setupCalendar(req.ctx, req.body)))
googleResourcesRoutes.get('/calendar/events', validate(z.object({ from: instant, to: instant, leadId: z.uuid().optional() }).refine((value) => new Date(value.to) > new Date(value.from) && new Date(value.to) - new Date(value.from) <= 93 * 86400000, 'Choose a date range within 93 days.'), 'query'), guarded((req) => calendar.listCalendarEvents(req.ctx, req.validated.query)))
googleResourcesRoutes.post('/calendar/events', permit('tasks.create'), validate(createMeeting), guarded((req) => calendar.createCalendarEvent(req.ctx, req.body)))
googleResourcesRoutes.patch('/calendar/events/:id', permit('tasks.update'), id, validate(updateMeeting), guarded((req) => calendar.updateCalendarEvent(req.ctx, req.params.id, req.body)))
googleResourcesRoutes.post('/calendar/events/:id/cancel', permit('tasks.update'), id, guarded((req) => calendar.cancelCalendarEvent(req.ctx, req.params.id)))
googleResourcesRoutes.post('/calendar/events/:id/retry', permit('tasks.update'), id, guarded((req) => calendar.retryCalendarEvent(req.ctx, req.params.id)))
googleResourcesRoutes.get('/sheets', validate(z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), leadId: z.uuid().optional() }), 'query'), guarded((req) => sheets.listGoogleSheets(req.ctx, req.validated.query)))
googleResourcesRoutes.post('/sheets', validate(z.object({ requestId: z.uuidv4(), title: z.string().trim().min(1).max(120), kind: z.enum(['blank', 'leads']).default('blank'), leadId: z.uuid().optional(), columns,
  filters: z.record(z.string().max(80), z.union([z.string().max(500), z.boolean(), z.number()])).default({}) }).strict()), guarded((req) => sheets.createGoogleSheet(req.ctx, req.body)))
googleResourcesRoutes.get('/sheets/:id', id, validate(z.object({ offset: z.coerce.number().int().min(0).max(5000).multipleOf(50).default(0) }), 'query'), guarded((req) => sheets.readGoogleSheet(req.ctx, req.params.id, req.validated.query.offset)))
googleResourcesRoutes.patch('/sheets/:id/cells', id, validate(z.object({ changes: z.array(z.object({ row: z.number().int().min(1).max(5001), column: z.number().int().min(1).max(10), previous: z.string().max(10000), value: z.string().max(10000) }).strict()).min(1).max(200) }).strict()), guarded((req) => sheets.editGoogleSheet(req.ctx, req.params.id, req.body.changes)))
googleResourcesRoutes.post('/sheets/:id/retry', id, guarded((req) => sheets.retryGoogleSheet(req.ctx, req.params.id)))
