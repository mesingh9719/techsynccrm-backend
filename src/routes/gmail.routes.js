import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { requireOrg, permit } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import * as s from '../validators/gmail.validators.js'
import * as c from '../controllers/gmail.controller.js'
import '../integrations/gmail/hooks.js'

const limited = (limit = 60) => rateLimit({ windowMs: 60000, limit, standardHeaders: 'draft-8', legacyHeaders: false, message: { success: false, error: { code: 'RATE_LIMITED', message: 'Wait a moment before trying Gmail again.' } } })
const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() }
const id = validate(s.gmailId, 'params')
export const gmailRoutes = Router()
gmailRoutes.use(noStore)
gmailRoutes.get('/callback', limited(), c.callback)
gmailRoutes.use(requireOrg)
gmailRoutes.get('/me', c.me)
gmailRoutes.post('/oauth/start', limited(10), validate(s.gmailStart), c.start)
gmailRoutes.patch('/me', validate(s.gmailSettings), c.settingsUpdate)
gmailRoutes.post('/me/sync', limited(6), c.sync)
gmailRoutes.get('/accounts', permit('email.connections.manage'), validate(s.gmailList, 'query'), c.accounts)
gmailRoutes.delete('/accounts/:id', id, c.disconnect)
gmailRoutes.post('/accounts/:id/delete-history', id, limited(3), c.historyDelete)
export const emailRoutes = Router()
emailRoutes.use(requireOrg, noStore)
emailRoutes.post('/send', limited(30), validate(s.emailSend), c.send)
emailRoutes.get('/threads', validate(s.emailRecordQuery, 'query'), c.threads)
emailRoutes.get('/threads/:id/messages', id, validate(s.gmailList, 'query'), c.messages)
emailRoutes.get('/:id', id, c.message)
export const emailTemplateRoutes = Router()
emailTemplateRoutes.use(requireOrg, noStore)
emailTemplateRoutes.get('/', c.templates)
emailTemplateRoutes.post('/', validate(s.emailTemplate), c.templateSave)
emailTemplateRoutes.patch('/:id', id, validate(s.emailTemplate), c.templateSave)
emailTemplateRoutes.delete('/:id', id, c.templateDelete)
export const gmailWebhookRoutes = Router()
gmailWebhookRoutes.post('/', limited(600), c.push)
