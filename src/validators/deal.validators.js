import { z } from 'zod'
import { PIPELINE_TEMPLATES } from '../config/pipelineTemplates.js'
import { customFields, expectedUpdatedAt, queryBool, recordListQuery, tagIds } from './crm.validators.js'

/** Pipelines, stages and deals (M09). */

const text = (max) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters`)
    .nullish()
    .transform((v) => v || null)

const isoDate = z.iso.date({ error: 'Enter a valid date' }).nullable()

const money = z.number().int('Use a whole amount in paise').min(0).max(Number.MAX_SAFE_INTEGER)

export const stageParams = z.object({ id: z.uuid('Invalid pipeline'), stageId: z.uuid('Invalid stage') })
export const contactParams = z.object({ id: z.uuid('Invalid deal'), contactId: z.uuid('Invalid contact') })

// ---------- Pipelines & stages ----------

export const createPipelineSchema = z.object({
  name: z.string().trim().min(1, 'Name the pipeline').max(60),
  templateKey: z.enum(Object.keys(PIPELINE_TEMPLATES), { error: 'Choose a template' }).default('default'),
})

export const updatePipelineSchema = z
  .object({ name: z.string().trim().min(1).max(60), isDefault: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')

export const deletePipelineSchema = z.object({ moveDealsToStageId: z.uuid().optional() }).default({})

const stageFields = {
  name: z.string().trim().min(1, 'Name the stage').max(60),
  probability: z.number().int().min(0, '0–100').max(100, '0–100'),
  rottingDays: z.number().int().min(1, 'At least 1 day').max(365).nullable(),
  requiredFields: z.array(z.string().max(70)).max(20),
}

export const createStageSchema = z.object(stageFields).partial({ probability: true, rottingDays: true, requiredFields: true })
export const updateStageSchema = z
  .object(stageFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
export const deleteStageSchema = z.object({ moveDealsToStageId: z.uuid().optional() }).default({})
export const reorderStagesSchema = z.object({ stageIds: z.array(z.uuid()).min(1).max(50) })

// ---------- Deals ----------

const dealContacts = z.array(z.object({ contactId: z.uuid('Invalid contact'), role: text(60), isPrimary: z.boolean().optional() })).max(20)

const dealFields = {
  title: z.string().trim().min(1, 'Give the deal a title').max(160),
  valueMinor: money,
  probabilityOverride: z.number().int().min(0).max(100).nullable(),
  expectedCloseDate: isoDate,
  companyId: z.uuid('Choose a company').nullable(),
  sourceId: z.uuid('Choose a source').nullable(),
  ownerId: z.uuid('Choose a member').nullable(),
  contacts: dealContacts,
  tagIds,
  customFields,
}

export const createDealSchema = z
  .object({
    ...dealFields,
    pipelineId: z.uuid('Choose a pipeline').optional(),
    stageId: z.uuid('Choose a stage'),
    lostReasonId: z.uuid().optional(),
    lostNote: text(1000),
  })
  .partial({ valueMinor: true, probabilityOverride: true, expectedCloseDate: true, companyId: true, sourceId: true, ownerId: true, contacts: true, tagIds: true, customFields: true })

export const updateDealSchema = z
  .object({ ...dealFields, expectedUpdatedAt })
  .partial()
  .refine((v) => Object.keys(v).some((k) => k !== 'expectedUpdatedAt'), 'Nothing to update')

/** POST /deals/:id/move — `fields` fills the target stage's required fields in the same request. */
export const moveDealSchema = z.object({
  stageId: z.uuid('Choose a stage'),
  pipelineId: z.uuid().optional(),
  position: z.number().finite().optional(),
  fields: z
    .object({
      valueMinor: money,
      expectedCloseDate: isoDate,
      companyId: z.uuid().nullable(),
      ownerId: z.uuid().nullable(),
      contacts: dealContacts,
      customFields,
    })
    .partial()
    .optional(),
  lostReasonId: z.uuid('Choose a reason').optional(),
  lostNote: text(1000),
  expectedUpdatedAt,
})

export const dealContactSchema = z.object({ contactId: z.uuid('Choose a contact'), role: text(60), isPrimary: z.boolean().optional() })

export const dealListQuery = recordListQuery({
  status: z.string().max(40).optional(),
  pipelineId: z.uuid().optional(),
  stageId: z.string().max(400).optional(),
  companyId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  leadId: z.uuid().optional(),
  closeFrom: z.iso.date().optional(),
  closeTo: z.iso.date().optional(),
  closedFrom: z.iso.datetime({ offset: true }).optional(),
  valueMin: z.coerce.number().int().min(0).optional(),
  valueMax: z.coerce.number().int().min(0).optional(),
  rotting: queryBool,
})

export const boardQuery = z
  .object({
    pipelineId: z.uuid().optional(),
    ownerId: z.string().max(400).optional(),
    q: z.string().trim().max(100).optional(),
    tag: z.string().max(400).optional(),
  })
  .catchall(z.string().max(200))

export const forecastQuery = z.object({
  pipelineId: z.uuid().optional(),
  period: z.enum(['month', 'quarter']).default('month'),
  ownerId: z.string().max(400).optional(),
})

export const dealBulkSchema = z.object({
  ids: z.array(z.uuid()).min(1, 'Select at least one deal').max(500, 'Select at most 500 deals'),
  action: z.enum(['assign', 'move', 'tag', 'untag', 'delete']),
  payload: z
    .object({
      ownerId: z.uuid().nullable().optional(),
      tagIds: tagIds.optional(),
      stageId: z.uuid().optional(),
      lostReasonId: z.uuid().optional(),
      lostNote: text(1000),
    })
    .default({}),
})
