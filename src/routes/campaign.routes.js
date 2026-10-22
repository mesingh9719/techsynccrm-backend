import { Router } from 'express'
import { permit, requireOrg } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import { idParams } from '../validators/crm.validators.js'
import { leadListQuery } from '../validators/lead.validators.js'
import {
  campaignListQuery,
  createCampaignSchema,
  updateCampaignSchema,
  campaignStatusSchema,
  campaignSyncSchema,
} from '../validators/campaign.validators.js'
import * as campaigns from '../controllers/campaign.controller.js'

export const campaignRoutes = Router()
const params = validate(idParams, 'params')
campaignRoutes.use(requireOrg)
campaignRoutes.get('/', permit('campaigns.read'), validate(campaignListQuery, 'query'), campaigns.list)
campaignRoutes.post('/', permit('campaigns.create'), validate(createCampaignSchema), campaigns.create)
campaignRoutes.post(
  '/sync/meta',
  permit('campaigns.create', 'settings.workspace.manage'),
  validate(campaignSyncSchema),
  campaigns.syncMeta,
)
campaignRoutes.get('/:id', permit('campaigns.read'), params, campaigns.get)
campaignRoutes.get('/:id/meta-status', permit('campaigns.read', 'settings.workspace.manage'), params, campaigns.metaState)
campaignRoutes.get(
  '/:id/leads',
  permit('campaigns.read', 'leads.read'),
  params,
  validate(leadListQuery, 'query'),
  campaigns.leads,
)
campaignRoutes.patch('/:id', permit('campaigns.update'), params, validate(updateCampaignSchema), campaigns.update)
campaignRoutes.post('/:id/status', permit('campaigns.update'), params, validate(campaignStatusSchema), campaigns.setStatus)
campaignRoutes.delete('/:id', permit('campaigns.delete'), params, campaigns.remove)
