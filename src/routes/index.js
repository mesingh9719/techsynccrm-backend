import { gmailRoutes, emailRoutes, emailTemplateRoutes, gmailWebhookRoutes } from './gmail.routes.js'
import { importRoutes, exportRoutes } from './transfer.routes.js'
import { facebookRoutes, facebookWebhookRoutes } from './facebook.routes.js'
import { Router } from 'express'
import { getHealth } from '../controllers/health.controller.js'
import authRoutes from './auth.routes.js'
import fileRoutes from './file.routes.js'
import { companyRoutes, contactRoutes, customFieldRoutes, tagRoutes } from './crm.routes.js'
import { leadRoutes, leadSourceRoutes, lostReasonRoutes, savedViewRoutes } from './lead.routes.js'
import { dealRoutes, pipelineRoutes, pipelineTemplateRoutes } from './deal.routes.js'
import { activityRoutes, taskRoutes, timelineRoutes } from './activity.routes.js'
import internalRoutes from './internal.routes.js'
import superadminRoutes from './superadmin.routes.js'
import metaRoutes from './meta.routes.js'
import organizationRoutes from './organization.routes.js'
import publicRoutes from './public.routes.js'
import { invitationRoutes, memberRoutes, teamRoutes } from './team.routes.js'
import userRoutes from './user.routes.js'
import { notificationRoutes } from './notification.routes.js'
import { campaignRoutes } from './campaign.routes.js'
import { getOpenApiDocument } from '../docs/openapi.js'
import { env } from '../config/env.js'

/** Root API router, mounted at /api. */
const router = Router()
router.use('/integrations/gmail', gmailRoutes)
router.use('/emails', emailRoutes)
router.use('/email-templates', emailTemplateRoutes)
router.use('/webhooks/gmail', gmailWebhookRoutes)
router.use('/integrations/facebook', facebookRoutes)
router.use('/webhooks/in/facebook', facebookWebhookRoutes)

router.get('/health', getHealth)
router.use('/auth', authRoutes)
router.use('/users', userRoutes)
router.use('/organizations', organizationRoutes)
router.use('/members', memberRoutes)
router.use('/invitations', invitationRoutes)
router.use('/teams', teamRoutes)
router.use('/files', fileRoutes)
router.use('/imports', importRoutes)
router.use('/exports', exportRoutes)
// CRM records (M07, M08)
router.use('/contacts', contactRoutes)
router.use('/companies', companyRoutes)
router.use('/tags', tagRoutes)
router.use('/custom-fields', customFieldRoutes)
router.use('/leads', leadRoutes)
router.use('/campaigns', campaignRoutes)
router.use('/lead-sources', leadSourceRoutes)
router.use('/lost-reasons', lostReasonRoutes)
router.use('/saved-views', savedViewRoutes)
// Pipelines & deals (M09)
router.use('/pipelines', pipelineRoutes)
router.use('/pipeline-templates', pipelineTemplateRoutes)
router.use('/deals', dealRoutes)
// Activities, tasks & timeline (M10)
router.use('/timeline', timelineRoutes)
router.use('/activities', activityRoutes)
router.use('/tasks', taskRoutes)
router.use('/notifications', notificationRoutes)
router.use('/public', publicRoutes)
router.use('/meta', metaRoutes)
router.use('/internal', internalRoutes)
router.use('/superadmin', superadminRoutes)

// API reference for developers; not exposed in production until the public API (M20) is published.
if (!env.isProduction) router.get('/docs.json', (_req, res) => res.json(getOpenApiDocument()))

export default router
