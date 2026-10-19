import { z } from 'zod'
import { GST_STATE_CODES } from '../lib/india.js'
import { listQuerySchema } from '../lib/pagination.js'
import { MAX_CONTACT_POINTS } from '../lib/records.js'
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES } from '../services/customField.service.js'
import { TAG_COLORS } from '../services/tag.service.js'

/** Shared building blocks for CRM records (M07, reused by leads and deals). */

export const idParams = z.object({ id: z.uuid('Invalid id') })

const text = (max, message = `Keep it under ${max} characters`) =>
  z
    .string()
    .trim()
    .max(max, message)
    .nullish()
    .transform((v) => v || null)

export const queryBool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1')

export const emailItem = z.object({
  value: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  label: text(30),
  primary: z.boolean().optional(),
})

export const phoneItem = z.object({
  raw: z.string().trim().min(3, 'Enter a phone number').max(30, 'That number is too long'),
  label: text(30),
  primary: z.boolean().optional(),
  whatsapp: z.boolean().optional(),
})

export const emailList = z.array(emailItem).max(MAX_CONTACT_POINTS, `Add at most ${MAX_CONTACT_POINTS} emails`)
export const phoneList = z.array(phoneItem).max(MAX_CONTACT_POINTS, `Add at most ${MAX_CONTACT_POINTS} phone numbers`)
export const tagIds = z.array(z.uuid('Invalid tag')).max(20, 'Use at most 20 tags')
export const customFields = z.record(z.string().max(60), z.unknown())
export const ownerId = z.uuid('Choose a member').nullable()
/** Sent by clients that can't set the If-Match header. */
export const expectedUpdatedAt = z.iso.datetime({ offset: true }).optional()

const address = z
  .object({
    line1: text(120),
    line2: text(120),
    city: text(60),
    stateCode: z.enum(GST_STATE_CODES, { error: 'Choose a state' }).nullish().transform((v) => v ?? null),
    pincode: z
      .string()
      .trim()
      .nullish()
      .transform((v) => v || null)
      .refine((v) => v === null || /^[1-9][0-9]{5}$/.test(v), 'Enter a 6-digit PIN code'),
    country: z.string().trim().toUpperCase().length(2).nullish().transform((v) => v ?? 'IN'),
  })
  .nullable()

const recordListShape = {
  q: z.string().trim().max(100).optional(),
  ownerId: z.string().max(400).optional(),
  tag: z.string().max(400).optional(),
  createdFrom: z.string().max(40).optional(),
  createdTo: z.string().max(40).optional(),
  count: queryBool,
  deleted: queryBool,
}

/**
 * Query schema for a CRM list: pagination + common filters + `extra`. Unknown params pass through
 * as strings so `cf.<key>` custom field filters reach the service (which rejects unknown keys).
 */
export const recordListQuery = (extra = {}) => listQuerySchema.extend({ ...recordListShape, ...extra }).catchall(z.string().max(200))

export const allowDuplicateQuery = z.object({ allowDuplicate: queryBool }).catchall(z.unknown())

// ---------- Contacts ----------

const lifecycleStage = z.enum(['subscriber', 'lead', 'customer', 'inactive'], { error: 'Choose a lifecycle stage' })
const companyLinks = z
  .array(z.object({ companyId: z.uuid('Invalid company'), role: text(60), isPrimary: z.boolean().optional() }))
  .max(20, 'Link at most 20 companies')

const contactFields = {
  firstName: text(80),
  lastName: text(80),
  title: text(80),
  emails: emailList,
  phones: phoneList,
  lifecycleStage,
  source: text(60),
  ownerId,
  whatsappOptIn: z.boolean(),
  emailOptIn: z.boolean(),
  optedOut: z.boolean(),
  consentSource: text(60),
  companies: companyLinks,
  tagIds,
  customFields,
}

export const createContactSchema = z.object(contactFields).partial()
export const updateContactSchema = z
  .object({ ...contactFields, expectedUpdatedAt })
  .partial()
  .refine((v) => Object.keys(v).some((k) => k !== 'expectedUpdatedAt'), 'Nothing to update')

export const contactListQuery = recordListQuery({
  companyId: z.string().max(400).optional(),
  lifecycleStage: z.string().max(100).optional(),
})

export const checkDuplicatesSchema = z.object({
  emails: z.array(z.string().trim().max(254)).max(10).default([]),
  phones: z.array(z.string().trim().max(30)).max(10).default([]),
  excludeId: z.uuid().optional(),
})

export const mergeSchema = z.object({
  primaryId: z.uuid('Choose the record to keep'),
  duplicateIds: z.array(z.uuid()).min(1, 'Choose at least one duplicate').max(10, 'Merge at most 10 at a time'),
  /** { field: recordId } — which record's value to keep; custom fields as "cf.<key>". */
  fieldChoices: z.record(z.string().max(70), z.uuid()).default({}),
})

export const bulkSchema = z.object({
  ids: z.array(z.uuid()).min(1, 'Select at least one record').max(500, 'Select at most 500 records'),
  action: z.enum(['assign', 'tag', 'untag', 'delete']),
  payload: z.object({ ownerId: z.uuid().nullable().optional(), tagIds: tagIds.optional() }).default({}),
})

// ---------- Companies ----------

const companyFields = {
  name: z.string().trim().min(1, 'Enter the company name').max(160),
  domain: text(160),
  industry: text(80),
  size: text(30),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .nullish()
    .transform((v) => v || null),
  phone: text(30),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address')
    .max(254)
    .nullish()
    .or(z.literal(''))
    .transform((v) => v || null),
  website: text(300),
  billingAddress: address,
  shippingAddress: address,
  ownerId,
  tagIds,
  customFields,
}

export const createCompanySchema = z.object(companyFields).partial({ domain: true, industry: true, size: true, gstin: true, phone: true, email: true, website: true, billingAddress: true, shippingAddress: true, ownerId: true, tagIds: true, customFields: true })
export const updateCompanySchema = z
  .object({ ...companyFields, expectedUpdatedAt })
  .partial()
  .refine((v) => Object.keys(v).some((k) => k !== 'expectedUpdatedAt'), 'Nothing to update')

export const companyListQuery = recordListQuery({ industry: z.string().max(400).optional() })

// ---------- Tags ----------

export const tagSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(40, 'Keep it under 40 characters'),
  color: z.enum(TAG_COLORS).optional(),
})
export const updateTagSchema = tagSchema.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update')

// ---------- Custom fields ----------

const entityType = z.enum(CUSTOM_FIELD_ENTITIES, { error: 'Choose a record type' })
const option = z.object({
  value: z.string().trim().max(60).optional(),
  label: z.string().trim().min(1, 'Enter a label').max(60),
  color: z.enum(TAG_COLORS).optional(),
})

export const customFieldListQuery = z.object({ entityType })

export const createCustomFieldSchema = z.object({
  entityType,
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use 2–40 lowercase letters, numbers and underscores, starting with a letter'),
  label: z.string().trim().min(1, 'Enter a label').max(60),
  type: z.enum(CUSTOM_FIELD_TYPES, { error: 'Choose a field type' }),
  options: z.array(option).max(100).optional(),
  required: z.boolean().optional(),
})

export const updateCustomFieldSchema = z
  .object({
    label: z.string().trim().min(1, 'Enter a label').max(60),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: z.array(option).max(100),
    required: z.boolean(),
    archived: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')

export const reorderCustomFieldsSchema = z.object({ entityType, ids: z.array(z.uuid()).min(1).max(500) })
