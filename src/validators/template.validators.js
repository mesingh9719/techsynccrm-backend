import { z } from 'zod'
import { listQuerySchema } from '../lib/pagination.js'
import { variableDefinitions } from '../lib/templateVariables.js'

export const variableCatalogueQuery = z.object({ recordType: z.enum(['any', 'lead', 'contact']).default('any') })
export const variableValuesSchema = z.record(z.string().max(100), z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null()])).refine((v) => Object.keys(v).length <= 100, 'Use no more than 100 variable values.')
export const templateRender = z.object({
  entityType: z.enum(['lead', 'contact']), entityId: z.uuid(), to: z.email().max(254).optional(),
  subject: z.string().max(998).optional(), bodyHtml: z.string().max(100000).optional(), expectedVersion: z.number().int().positive().optional(),
  values: variableValuesSchema.default({}),
}).strict()

export const templateChannel = z.enum(['email', 'whatsapp', 'sms'])
export const templateCategory = z.enum(['general', 'introduction', 'follow_up', 'meeting', 'proposal', 'customer_care'])
export const templateId = z.object({ id: z.uuid() })
export const templateList = listQuerySchema.extend({
  q: z.string().trim().max(200).optional(), channel: templateChannel.optional(), category: templateCategory.optional(),
  scope: z.enum(['all', 'personal', 'team']).default('all'),
  status: z.enum(['active', 'archived']).default('active'),
  sort: z.enum(['-updatedAt', 'name', '-createdAt']).default('-updatedAt'),
})
const fields = {
  name: z.string().trim().min(1, 'Give your template a name.').max(120),
  subject: z.string().trim().max(998).refine((s) => !/[\r\n\0]/.test(s), 'Use a single line for the subject.'),
  bodyHtml: z.string().min(1).max(100000),
  shared: z.boolean(), category: templateCategory,
  variables: variableDefinitions, recordType: z.enum(['any', 'lead', 'contact']),
}
export const templateCreate = z.object({ ...fields, channel: templateChannel, variables: variableDefinitions.default([]), recordType: fields.recordType.default('any') }).strict()
export const templatePreview = templateCreate.pick({ subject: true, bodyHtml: true, variables: true, recordType: true, channel: true }).extend({ values: templateRender.shape.values, bodyHtml: z.string().max(100000) })
export const templateUpdate = z.object({ ...fields, archived: z.boolean(), expectedVersion: z.number().int().positive() }).partial().required({ expectedVersion: true }).strict()
