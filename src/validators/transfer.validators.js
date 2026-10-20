import { z } from 'zod'
export const transferEntity = z.enum(['lead', 'contact', 'company', 'deal'])
const mapping = z.record(z.string().max(10000), z.string().max(80).refine((v) => !['__proto__', 'constructor', 'prototype'].some((k) => v.split('.').includes(k)), 'Invalid mapping'))
export const createImportSchema = z.object({ entityType: transferEntity, fileId: z.uuid() })
const rowId = z.string().regex(/^(r:\d+|a:[a-zA-Z0-9-]+)$/).max(80)
const editBatch = z.object({
  reset: z.boolean().optional(),
  cells: z.array(z.object({ rowId, column: z.number().int().min(0).max(199), value: z.string().max(10000).nullable() })).max(2000).optional(),
  deletedRows: z.array(z.object({ rowId, deleted: z.boolean() })).max(5000).optional(),
  addedRows: z.array(z.object({ id: z.string().regex(/^a:[a-zA-Z0-9-]+$/).max(80), values: z.array(z.string().max(10000)).max(200) })).max(1000).optional(),
})
export const updateImportSchema = z.object({
  sheetName: z.string().max(100).nullable().optional(), headerRow: z.number().int().min(1).max(100).optional(), mapping: mapping.optional(),
  autoDetect: z.boolean().optional(),
  hasHeader: z.boolean().optional(), revision: z.number().int().min(0).optional(), editBatch: editBatch.optional(),
  mappingName: z.string().trim().min(1).max(80).optional(),
  options: z.object({ duplicateStrategy: z.enum(['skip', 'update', 'create']).default('skip'), updateMode: z.enum(['empty', 'overwrite']).default('empty'), dateFormat: z.enum(['DMY', 'MDY']).default('DMY'), defaultOwnerId: z.uuid().nullable().optional(), createMissingSources: z.boolean().default(false), maxRows: z.number().int().min(1).max(50000).optional() }).optional(),
})
export const datasetQuery = z.object({ offset: z.coerce.number().int().min(0).max(50100).default(0), limit: z.coerce.number().int().min(1).max(1000).default(1000) })
export const previewQuery = datasetQuery.extend({ filter: z.enum(['all', 'ready', 'attention', 'duplicates', 'edited']).default('all'), q: z.string().max(200).default('') })
export const startImportSchema = z.object({ revision: z.number().int().min(0).optional(), acceptSkippedRows: z.boolean().optional() })
export const exportSchema = z.object({ entityType: transferEntity, filters: z.record(z.string().max(80), z.union([z.string().max(500), z.boolean(), z.number()])).default({}), columns: z.array(z.string().max(80)).min(1).max(100), format: z.enum(['csv', 'xlsx']).default('csv') })
