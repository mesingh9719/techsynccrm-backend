import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import * as n from '../controllers/notification.controller.js'
import { loadOrgContext, requireOrg } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import { consumeStreamTicket } from '../services/notification.service.js'
import { idParams } from '../validators/crm.validators.js'
import { notificationListQuery, notificationPreferencesSchema, streamQuery } from '../validators/notification.validators.js'

export const notificationRoutes = Router()
notificationRoutes.get('/stream', validate(streamQuery, 'query'), async (req, res, next) => {
  req.user = await consumeStreamTicket(req.validated.query.ticket)
  return loadOrgContext(req, res, next)
}, n.stream)
notificationRoutes.use(requireOrg)
notificationRoutes.get('/', validate(notificationListQuery, 'query'), n.list)
notificationRoutes.get('/unread-count', n.count)
notificationRoutes.post('/read-all', n.readAll)
notificationRoutes.post('/stream-ticket', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }), n.ticket)
notificationRoutes.post('/:id/read', validate(idParams, 'params'), n.read)

export const notificationPreferenceRoutes = Router()
notificationPreferenceRoutes.use(requireOrg)
notificationPreferenceRoutes.get('/', n.preferences)
notificationPreferenceRoutes.put('/', validate(notificationPreferencesSchema), n.updatePreferences)
