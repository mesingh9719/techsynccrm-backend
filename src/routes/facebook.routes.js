import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { requireOrg, permit } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import * as schema from '../validators/facebook.validators.js'
import * as facebook from '../controllers/facebook.controller.js'
export const facebookRoutes = Router()
const providerLimit = () => rateLimit({ windowMs: 60000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false })
// OAuth callback is public and protected by single-use state + a browser-bound httpOnly cookie.
facebookRoutes.get('/callback', facebook.callback)
facebookRoutes.post('/deauthorize', providerLimit(), facebook.deauthorize)
facebookRoutes.post('/data-deletion', providerLimit(), facebook.dataDeletion)
facebookRoutes.get('/data-deletion/status/:code', providerLimit(), validate(schema.facebookDeletionCode, 'params'), facebook.deletionStatus)
facebookRoutes.use(requireOrg, permit('settings.workspace.manage'))
facebookRoutes.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
facebookRoutes.get('/', facebook.status)
facebookRoutes.post('/connect', facebook.login)
facebookRoutes.post('/sdk/challenge', facebook.sdkChallenge)
facebookRoutes.post('/sdk/connect', validate(schema.facebookSdkLogin), facebook.sdkConnect)
facebookRoutes.delete('/', facebook.disconnect)
facebookRoutes.get('/pages', validate(schema.facebookCursorQuery, 'query'), facebook.pages)
facebookRoutes.post('/pages', validate(schema.facebookConnectPage), facebook.connectPage)
facebookRoutes.delete('/pages/:pageId', validate(schema.facebookPageParams, 'params'), facebook.disconnectPage)
facebookRoutes.get('/pages/:pageId/forms', validate(schema.facebookPageParams, 'params'), validate(schema.facebookCursorQuery, 'query'), facebook.forms)
facebookRoutes.put('/pages/:pageId/forms/:formId', validate(schema.facebookFormParams, 'params'), validate(schema.facebookFormSettings), facebook.configureForm)
facebookRoutes.post('/forms/:id/sync', validate(schema.facebookUuidParams, 'params'), facebook.sync)
facebookRoutes.get('/ad-accounts', validate(schema.facebookCursorQuery, 'query'), facebook.adAccounts)
facebookRoutes.get('/campaigns', validate(schema.facebookCampaignQuery, 'query'), facebook.campaigns)
facebookRoutes.get('/deliveries', validate(schema.facebookDeliveryQuery, 'query'), facebook.deliveries)
facebookRoutes.post('/deliveries/:id/retry', validate(schema.facebookUuidParams, 'params'), facebook.retry)
export const facebookWebhookRoutes = Router()
facebookWebhookRoutes.use(rateLimit({ windowMs: 60000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }))
facebookWebhookRoutes.get('/', facebook.verifyWebhook)
facebookWebhookRoutes.post('/', facebook.webhook)
