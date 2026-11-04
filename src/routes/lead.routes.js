import { Router } from 'express'
import { hideContactInfo } from '../lib/contactInfo.js'
import * as leads from '../controllers/lead.controller.js'
import { permit, requireOrg } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import { idParams } from '../validators/crm.validators.js'
import {
  assignLeadSchema,
  convertLeadSchema,
  createLeadSchema,
  leadBulkSchema,
  leadDuplicatesSchema,
  leadListQuery,
  leadStatusSchema,
  lostReasonQuery,
  lostReasonSchema,
  savedViewQuery,
  savedViewSchema,
  sourceOrderSchema,
  sourceSchema,
  updateLeadSchema,
  updateLostReasonSchema,
  updateSavedViewSchema,
  updateSourceSchema,
} from '../validators/lead.validators.js'
import { allow } from './crm.routes.js'

/**
 * Leads (/api/leads), lead sources (/api/lead-sources), lost reasons (/api/lost-reasons) and saved
 * views (/api/saved-views) — M08. Record visibility is enforced in the services.
 */

const params = validate(idParams, 'params')

export const leadRoutes = Router()
leadRoutes.use(requireOrg, hideContactInfo('leads'))
leadRoutes.get('/', permit('leads.list'), validate(leadListQuery, 'query'), leads.list)
leadRoutes.post('/', permit('leads.create'), allow, validate(createLeadSchema), leads.create)
leadRoutes.post('/check-duplicates', permit('leads.read'), validate(leadDuplicatesSchema), leads.checkDuplicates)
leadRoutes.post('/bulk', permit('leads.update'), validate(leadBulkSchema), leads.bulk)
leadRoutes.get('/:id', permit('leads.view'), params, leads.get)
leadRoutes.patch('/:id', permit('leads.update'), allow, params, validate(updateLeadSchema), leads.update)
leadRoutes.delete('/:id', permit('leads.delete'), params, leads.remove)
leadRoutes.post('/:id/restore', permit('leads.delete'), params, leads.restore)
leadRoutes.post('/:id/status', permit('leads.status'), params, validate(leadStatusSchema), leads.changeStatus)
leadRoutes.post('/:id/claim', permit('leads.read'), params, leads.claim)
leadRoutes.post('/:id/assign', permit('leads.assign'), params, validate(assignLeadSchema), leads.assign)
leadRoutes.get('/:id/conversion', permit('leads.convert'), params, leads.conversionSuggestions)
leadRoutes.post('/:id/convert', permit('leads.convert'), params, validate(convertLeadSchema), leads.convert)

/** Everyone reads the lists (pickers); admins manage them. */
export const leadSourceRoutes = Router()
leadSourceRoutes.use(requireOrg)
leadSourceRoutes.get('/', leads.listSources)
leadSourceRoutes.get('/suggestions', permit('settings.workspace.manage'), leads.listSourceSuggestions)
leadSourceRoutes.patch('/order', permit('settings.workspace.manage'), validate(sourceOrderSchema), leads.orderSources)
leadSourceRoutes.post('/', permit('settings.workspace.manage'), validate(sourceSchema), leads.createSource)
leadSourceRoutes.patch('/:id', permit('settings.workspace.manage'), params, validate(updateSourceSchema), leads.updateSource)
leadSourceRoutes.delete('/:id', permit('settings.workspace.manage'), params, leads.deleteSource)

export const lostReasonRoutes = Router()
lostReasonRoutes.use(requireOrg)
lostReasonRoutes.get('/', validate(lostReasonQuery, 'query'), leads.listLostReasons)
lostReasonRoutes.post('/', permit('settings.workspace.manage'), validate(lostReasonSchema), leads.createLostReason)
lostReasonRoutes.patch('/:id', permit('settings.workspace.manage'), params, validate(updateLostReasonSchema), leads.updateLostReason)

export const savedViewRoutes = Router()
savedViewRoutes.use(requireOrg)
savedViewRoutes.get('/', validate(savedViewQuery, 'query'), leads.listViews)
savedViewRoutes.post('/', validate(savedViewSchema), leads.createView)
savedViewRoutes.patch('/:id', params, validate(updateSavedViewSchema), leads.updateView)
savedViewRoutes.delete('/:id', params, leads.deleteView)
