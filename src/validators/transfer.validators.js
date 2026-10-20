import { z } from 'zod'
export const transferEntity = z.enum(['lead', 'contact', 'company', 'deal'])
const mapping = z.record(z.string().max(10000), z.string().max(80).refine((v) => !['__proto__', 'constructor', 'prototype'].some((k) => v.split('.').includes(k)), 'Invalid mapping'))
export const createImportSchema = z.object({ entityType: transferEntity, fileId: z.uuid() })
export const updateImportSchema = z.object({
  sheetName: z.string().max(100).optional(), headerRow: z.number().int().min(1).max(100).optional(), mapping: mapping.optional(),
  mappingName: z.string().trim().min(1).max(80).optional(),
  options: z.object({ duplicateStrategy: z.enum(['skip', 'update', 'create']).default('skip'), updateMode: z.enum(['empty', 'overwrite']).default('empty'), dateFormat: z.enum(['DMY', 'MDY']).default('DMY'), defaultOwnerId: z.uuid().nullable().optional(), createMissingSources: z.boolean().default(false), maxRows: z.number().int().min(1).max(50000).optional() }).optional(),
})
export const exportSchema = z.object({ entityType: transferEntity, filters: z.record(z.string().max(80), z.union([z.string().max(500), z.boolean(), z.number()])).default({}), columns: z.array(z.string().max(80)).min(1).max(100), format: z.enum(['csv', 'xlsx']).default('csv') })
