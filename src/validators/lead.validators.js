import { z } from 'zod'
import { GST_STATE_CODES } from '../lib/india.js'
import { customFields, emailList, expectedUpdatedAt, phoneList, recordListQuery, tagIds } from './crm.validators.js'

/** Leads, lead sources, lost reasons and saved views (M08). */

const text = (max) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters`)
    .nullish()
    .transform((v) => v || null)

const status = z.enum(['new', 'contacted', 'qualified', 'lost', 'junk'], { error: 'Choose a status' })

const leadFields = {
  firstName: text(80),
  lastName: text(80),
  emails: emailList,
  phones: phoneList,
  companyName: text(160),
  requirement: text(2000),
  /** Minor units (paise): ₹1,85,000 → 18500000 */
  budgetMinor: z.number().int('Use a whole amount in paise').min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  city: text(80),
  stateCode: z.enum(GST_STATE_CODES, { error: 'Choose a state' }).nullish().transform((v) => v ?? null),
  pincode: z
    .string()
    .trim()
    .nullish()
    .transform((v) => v || null)
    .refine((v) => v === null || /^[1-9][0-9]{5}$/.test(v), 'Enter a 6-digit PIN code'),
  sourceId: z.uuid('Choose a source').nullable(),
  sourceDetail: text(200),
  utm: z.record(z.string().max(40), z.string().max(200)).nullable(),
  tagIds,
  customFields,
}

export const createLeadSchema = z.object({ ...leadFields, ownerId: z.uuid('Choose a member').nullable() }).partial()

/** Status and owner change through their own endpoints (state machine, assignment rules). */
export const updateLeadSchema = z
  .object({ ...leadFields, expectedUpdatedAt })
  .partial()
  .refine((v) => Object.keys(v).some((k) => k !== 'expectedUpdatedAt'), 'Nothing to update')

export const leadListQuery = recordListQuery({
  status: z.string().max(100).optional(),
  sourceId: z.string().max(800).optional(),
  scoreMin: z.coerce.number().int().min(0).max(100).optional(),
  city: z.string().trim().max(80).optional(),
  stateCode: z.string().max(200).optional(),
  counts: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
})

export const leadStatusSchema = z.object({
  status,
  lostReasonId: z.uuid('Choose a reason').optional(),
  junkReason: z.enum(['spam', 'wrong_number', 'test', 'duplicate', 'other'], { error: 'Choose a reason' }).optional(),
  note: text(1000),
})

export const assignLeadSchema = z.object({ ownerId: z.uuid('Choose a member').nullable() })

export const convertLeadSchema = z.object({
  contact: z.discriminatedUnion('mode', [z.object({ mode: z.literal('create') }), z.object({ mode: z.literal('link'), contactId: z.uuid('Choose a contact') })]),
  company: z
    .discriminatedUnion('mode', [
      z.object({ mode: z.literal('none') }),
      z.object({ mode: z.literal('create'), name: text(160), role: text(60) }),
      z.object({ mode: z.literal('link'), companyId: z.uuid('Choose a company'), role: text(60) }),
    ])
    .default({ mode: 'none' }),
  deal: z
    .object({
      create: z.boolean(),
      pipelineId: z.uuid().optional(),
      stageId: z.uuid().optional(),
      title: text(160),
      valueMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      expectedCloseDate: z.iso.date().optional(),
      customFields: customFields.optional(),
    })
    .optional(),
})

export const leadBulkSchema = z.object({
  ids: z.array(z.uuid()).min(1, 'Select at least one lead').max(500, 'Select at most 500 leads'),
  action: z.enum(['assign', 'status', 'tag', 'untag', 'delete']),
  payload: z
    .object({
      ownerId: z.uuid().nullable().optional(),
      tagIds: tagIds.optional(),
      status: status.optional(),
      lostReasonId: z.uuid().optional(),
      junkReason: z.enum(['spam', 'wrong_number', 'test', 'duplicate', 'other']).optional(),
      note: text(1000),
    })
    .default({}),
})

export const leadDuplicatesSchema = z.object({
  emails: z.array(z.string().trim().max(254)).max(10).default([]),
  phones: z.array(z.string().trim().max(30)).max(10).default([]),
  excludeId: z.uuid().optional(),
})

// ---------- Settings ----------

export const sourceSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(60),
  scoreWeight: z.number().int().min(0, '0–20').max(20, '0–20').optional(),
})
export const updateSourceSchema = z
  .object({ name: z.string().trim().min(1).max(60), scoreWeight: z.number().int().min(0).max(20), archived: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')

export const lostReasonQuery = z.object({ entityType: z.enum(['lead', 'deal']).default('lead') })
export const lostReasonSchema = z.object({ entityType: z.enum(['lead', 'deal']).default('lead'), name: z.string().trim().min(1, 'Enter a reason').max(60) })
export const updateLostReasonSchema = z
  .object({ name: z.string().trim().min(1).max(60), archived: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')

// ---------- Saved views ----------

const viewEntity = z.enum(['lead', 'contact', 'company', 'deal'])
export const savedViewQuery = z.object({ entityType: viewEntity })
export const savedViewSchema = z.object({
  entityType: viewEntity,
  name: z.string().trim().min(1, 'Name the view').max(60),
  filters: z.record(z.string().max(60), z.string().max(400)).default({}),
  columns: z.array(z.string().max(60)).max(40).default([]),
  isShared: z.boolean().optional(),
})
export const updateSavedViewSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    filters: z.record(z.string().max(60), z.string().max(400)),
    columns: z.array(z.string().max(60)).max(40),
    isShared: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
