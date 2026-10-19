import { Router } from 'express'
import * as deals from '../controllers/deal.controller.js'
import { permit, requireOrg } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import { idParams } from '../validators/crm.validators.js'
import {
  boardQuery,
  contactParams,
  createDealSchema,
  createPipelineSchema,
  createStageSchema,
  dealBulkSchema,
  dealContactSchema,
  dealListQuery,
  deletePipelineSchema,
  deleteStageSchema,
  forecastQuery,
  moveDealSchema,
  reorderStagesSchema,
  stageParams,
  updateDealSchema,
  updatePipelineSchema,
  updateStageSchema,
} from '../validators/deal.validators.js'

/**
 * Pipelines (/api/pipelines), templates (/api/pipeline-templates) and deals (/api/deals) — M09.
 * Record visibility is enforced in the services.
 */

const id = validate(idParams, 'params')
const manage = permit('settings.pipelines.manage')

export const pipelineRoutes = Router()
pipelineRoutes.use(requireOrg)
pipelineRoutes.get('/', deals.listPipelines)
pipelineRoutes.post('/', manage, validate(createPipelineSchema), deals.createPipeline)
pipelineRoutes.patch('/:id', manage, id, validate(updatePipelineSchema), deals.updatePipeline)
pipelineRoutes.delete('/:id', manage, id, validate(deletePipelineSchema), deals.deletePipeline)
pipelineRoutes.post('/:id/stages', manage, id, validate(createStageSchema), deals.createStage)
pipelineRoutes.patch('/:id/stages/order', manage, id, validate(reorderStagesSchema), deals.reorderStages)
pipelineRoutes.patch('/:id/stages/:stageId', manage, validate(stageParams, 'params'), validate(updateStageSchema), deals.updateStage)
pipelineRoutes.delete('/:id/stages/:stageId', manage, validate(stageParams, 'params'), validate(deleteStageSchema), deals.deleteStage)

export const pipelineTemplateRoutes = Router()
pipelineTemplateRoutes.use(requireOrg)
pipelineTemplateRoutes.get('/', deals.listTemplates)

export const dealRoutes = Router()
dealRoutes.use(requireOrg)
dealRoutes.get('/', permit('deals.read'), validate(dealListQuery, 'query'), deals.list)
dealRoutes.get('/board', permit('deals.read'), validate(boardQuery, 'query'), deals.board)
dealRoutes.get('/forecast', permit('deals.read'), validate(forecastQuery, 'query'), deals.forecast)
dealRoutes.post('/', permit('deals.create'), validate(createDealSchema), deals.create)
dealRoutes.post('/bulk', permit('deals.update'), validate(dealBulkSchema), deals.bulk)
dealRoutes.get('/:id', permit('deals.read'), id, deals.get)
dealRoutes.get('/:id/history', permit('deals.read'), id, deals.history)
dealRoutes.patch('/:id', permit('deals.update'), id, validate(updateDealSchema), deals.update)
dealRoutes.post('/:id/move', permit('deals.update'), id, validate(moveDealSchema), deals.move)
dealRoutes.post('/:id/contacts', permit('deals.update'), id, validate(dealContactSchema), deals.addContact)
dealRoutes.delete('/:id/contacts/:contactId', permit('deals.update'), validate(contactParams, 'params'), deals.removeContact)
dealRoutes.delete('/:id', permit('deals.delete'), id, deals.remove)
dealRoutes.post('/:id/restore', permit('deals.delete'), id, deals.restore)
