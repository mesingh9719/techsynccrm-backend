import { prisma, UNIQUE_VIOLATION } from '../db/prisma.js'
import { emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { normalizePhone } from '../lib/phone.js'
import { validationError } from '../lib/records.js'
import { parseIsoDate } from '../lib/time.js'
import { ApiError } from '../utils/ApiError.js'
import { assertWithinLimit } from './entitlements.service.js'

/**
 * Custom fields (M07): definitions per entity type, and validation/filtering of the values stored
 * in each record's `custom_fields` JSONB (keyed by definition key).
 */

export const CUSTOM_FIELD_ENTITIES = ['contact', 'company', 'lead', 'deal']
export const CUSTOM_FIELD_TYPES = ['text', 'textarea', 'number', 'currency', 'date', 'datetime', 'select', 'multiselect', 'checkbox', 'url', 'email', 'phone', 'user']

/** Tables holding each entity's values. */
const VALUE_TABLES = { contact: 'contacts', company: 'companies', lead: 'leads', deal: 'deals' }

/** Core field names a custom key may not shadow (also used as list sort/filter params). */
const RESERVED_KEYS = new Set([
  'id', 'name', 'first_name', 'last_name', 'display_name', 'email', 'emails', 'phone', 'phones', 'title', 'owner', 'owner_id',
  'status', 'source', 'source_id', 'score', 'tags', 'company', 'company_name', 'domain', 'industry', 'size', 'gstin', 'website',
  'created_at', 'updated_at', 'deleted_at', 'last_activity_at', 'lifecycle_stage', 'requirement', 'budget', 'city', 'state_code',
  'pincode', 'value', 'stage', 'pipeline', 'custom_fields', 'q', 'sort', 'cursor', 'limit',
])

const definitionSelect = {
  id: true,
  entityType: true,
  key: true,
  label: true,
  type: true,
  options: true,
  required: true,
  position: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
}

const present = ({ archivedAt, ...d }) => ({ ...d, archived: Boolean(archivedAt), archivedAt })

// ---------- Definitions ----------

/** Active (or all) definitions for an entity type, in display order. */
export async function getDefinitions(orgId, entityType, { includeArchived = false } = {}, db = prisma) {
  return db.customFieldDefinition.findMany({
    where: { organizationId: orgId, entityType, ...(!includeArchived && { archivedAt: null }) },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: definitionSelect,
  })
}

export async function listDefinitions(ctx, entityType) {
  const rows = await getDefinitions(ctx.orgId, entityType, { includeArchived: true })
  return rows.map(present)
}

async function getDefinition(ctx, id) {
  const def = await prisma.customFieldDefinition.findFirst({ where: { id, organizationId: ctx.orgId }, select: definitionSelect })
  if (!def) throw ApiError.notFound('Custom field not found')
  return def
}

/** Number of records with a value for `key` — gates type changes and deletion. */
async function countValues(orgId, entityType, key) {
  const table = VALUE_TABLES[entityType]
  if (!table) return 0
  const [row] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "${table}" WHERE organization_id = $1::uuid AND jsonb_exists(custom_fields, $2)`,
    orgId,
    key,
  )
  return row?.n ?? 0
}

function normalizeOptions(type, options) {
  if (type !== 'select' && type !== 'multiselect') return null
  if (!options?.length) throw validationError({ options: 'Add at least one option' })
  const seen = new Set()
  return options.map((o) => {
    const value = (o.value || o.label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'option'
    if (seen.has(value)) throw validationError({ options: `Two options have the same value “${value}”` })
    seen.add(value)
    return { value, label: o.label.trim(), ...(o.color && { color: o.color }) }
  })
}

export async function createDefinition(ctx, input) {
  if (RESERVED_KEYS.has(input.key)) throw validationError({ key: 'This name is used by a built-in field — choose another' })
  const options = normalizeOptions(input.type, input.options)
  try {
    return await prisma.$transaction(async (tx) => {
      // Archived fields still count; only deleting frees a slot (M07).
      await assertWithinLimit(ctx, 'customFields', 1, tx, { entityType: input.entityType })
      const last = await tx.customFieldDefinition.aggregate({ where: { organizationId: ctx.orgId, entityType: input.entityType }, _max: { position: true } })
      const def = await tx.customFieldDefinition.create({
        data: {
          organizationId: ctx.orgId,
          entityType: input.entityType,
          key: input.key,
          label: input.label,
          type: input.type,
          options: options ?? undefined,
          required: input.required ?? false,
          position: (last._max.position ?? -1) + 1,
        },
        select: definitionSelect,
      })
      await recordAudit(tx, ctx, { action: 'custom_field.create', entityType: 'custom_field', entityId: def.id, changes: { key: [null, def.key], type: [null, def.type] } })
      await emit(tx, ctx, 'custom_field.created', { entityType: 'custom_field', entityId: def.id }, { entityType: def.entityType, key: def.key })
      return present(def)
    })
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw validationError({ key: 'A field with this key already exists' })
    throw err
  }
}

export async function updateDefinition(ctx, id, input) {
  const def = await getDefinition(ctx, id)
  const type = input.type ?? def.type
  if (input.type && input.type !== def.type && (await countValues(ctx.orgId, def.entityType, def.key)) > 0) {
    throw validationError({ type: 'The type can’t change once records have a value for this field' })
  }
  const options = input.options !== undefined || input.type ? normalizeOptions(type, input.options ?? def.options) : undefined
  const data = {
    ...(input.label !== undefined && { label: input.label }),
    ...(input.type !== undefined && { type }),
    ...(options !== undefined && { options: options ?? null }),
    ...(input.required !== undefined && { required: input.required }),
    ...(input.archived !== undefined && { archivedAt: input.archived ? (def.archivedAt ?? new Date()) : null }),
  }
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.customFieldDefinition.update({ where: { id }, data, select: definitionSelect })
    await recordAudit(tx, ctx, { action: 'custom_field.update', entityType: 'custom_field', entityId: id, changes: data })
    return row
  })
  return present(updated)
}

/** Only fields no record has a value for can be deleted (archive the rest). */
export async function deleteDefinition(ctx, id) {
  const def = await getDefinition(ctx, id)
  if ((await countValues(ctx.orgId, def.entityType, def.key)) > 0) {
    throw new ApiError(409, 'Records have values for this field. Archive it instead — archived fields are hidden but keep their data.', { code: 'FIELD_IN_USE' })
  }
  await prisma.$transaction(async (tx) => {
    await tx.customFieldDefinition.delete({ where: { id } })
    await recordAudit(tx, ctx, { action: 'custom_field.delete', entityType: 'custom_field', entityId: id, changes: { key: [def.key, null] } })
  })
}

/** PATCH /custom-fields/order { entityType, ids } — ids in their new order. */
export async function reorderDefinitions(ctx, entityType, ids) {
  const defs = await prisma.customFieldDefinition.findMany({ where: { organizationId: ctx.orgId, entityType }, select: { id: true } })
  const known = new Set(defs.map((d) => d.id))
  if (ids.some((id) => !known.has(id))) throw validationError({ ids: 'One of these fields no longer exists' })
  await prisma.$transaction(ids.map((id, position) => prisma.customFieldDefinition.update({ where: { id }, data: { position } })))
  return listDefinitions(ctx, entityType)
}

// ---------- Values ----------

const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/** Validates and normalises one value; returns it or throws a message. */
async function coerce(ctx, def, value) {
  const fail = (message) => {
    throw new FieldValueError(message)
  }
  switch (def.type) {
    case 'text':
      if (typeof value !== 'string') fail('Enter text')
      if (value.length > 255) fail('Keep it under 255 characters')
      return value.trim()
    case 'textarea':
      if (typeof value !== 'string') fail('Enter text')
      if (value.length > 5000) fail('Keep it under 5,000 characters')
      return value
    case 'number': {
      const n = typeof value === 'string' ? Number(value) : value
      if (typeof n !== 'number' || !Number.isFinite(n)) fail('Enter a number')
      return n
    }
    case 'currency': {
      // Integer minor units in the workspace currency (₹1,250.50 → 125050).
      const n = typeof value === 'string' ? Number(value) : value
      if (!Number.isSafeInteger(n)) fail('Enter an amount in paise/cents (whole number)')
      return n
    }
    case 'date':
      if (typeof value !== 'string' || !parseIsoDate(value)) fail('Enter a date (YYYY-MM-DD)')
      return value
    case 'datetime': {
      const d = typeof value === 'string' ? new Date(value) : null
      if (!d || Number.isNaN(d.getTime())) fail('Enter a date and time')
      return d.toISOString()
    }
    case 'select': {
      const allowed = (def.options ?? []).map((o) => o.value)
      if (typeof value !== 'string' || !allowed.includes(value)) fail('Choose one of the options')
      return value
    }
    case 'multiselect': {
      const allowed = new Set((def.options ?? []).map((o) => o.value))
      if (!Array.isArray(value) || value.some((v) => !allowed.has(v))) fail('Choose from the options')
      return [...new Set(value)]
    }
    case 'checkbox':
      if (typeof value !== 'boolean') fail('Choose yes or no')
      return value
    case 'url': {
      try {
        const u = new URL(String(value).trim())
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error()
        return u.toString()
      } catch {
        return fail('Enter a web address starting with http:// or https://')
      }
    }
    case 'email': {
      const v = String(value).trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || v.length > 254) fail('Enter a valid email address')
      return v
    }
    case 'phone': {
      const { e164, raw } = normalizePhone(String(value), ctx.country ?? 'IN')
      if (!raw) fail('Enter a phone number')
      return e164 ?? raw
    }
    case 'user': {
      if (typeof value !== 'string') fail('Choose a member')
      const member = await prisma.membership.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: value } }, select: { status: true } }).catch(() => null)
      if (member?.status !== 'active') fail('Choose an active member')
      return value
    }
    default:
      return fail('Unsupported field type')
  }
}

class FieldValueError extends Error {}

/**
 * Validates `input` (a partial { key: value } map) against the entity's definitions and merges it
 * into `existing`. `null`/"" clears a value. On create, required fields must be present.
 * Errors come back as VALIDATION_ERROR with `customFields.<key>` field names.
 *
 * @returns {Promise<object>} the full custom_fields object to store
 */
export async function validateCustomFields(ctx, entityType, input, { existing = {}, isCreate = false, db = prisma } = {}) {
  const defs = await getDefinitions(ctx.orgId, entityType, { includeArchived: true }, db)
  const byKey = new Map(defs.map((d) => [d.key, d]))
  const out = { ...(existing ?? {}) }
  const errors = {}

  for (const [key, value] of Object.entries(input ?? {})) {
    const def = byKey.get(key)
    if (!def) {
      errors[`customFields.${key}`] = 'This field doesn’t exist'
      continue
    }
    if (def.archivedAt) {
      errors[`customFields.${key}`] = 'This field is archived'
      continue
    }
    if (isEmpty(value)) {
      if (def.required) errors[`customFields.${key}`] = `${def.label} is required`
      else delete out[key]
      continue
    }
    try {
      out[key] = await coerce(ctx, def, value)
    } catch (err) {
      if (!(err instanceof FieldValueError)) throw err
      errors[`customFields.${key}`] = err.message
    }
  }
  if (isCreate) {
    for (const def of defs) if (def.required && !def.archivedAt && isEmpty(out[def.key])) errors[`customFields.${def.key}`] ??= `${def.label} is required`
  }
  if (Object.keys(errors).length) throw validationError(errors)
  return out
}

/**
 * Copies values between entity types (lead → contact/company on conversion): only keys that exist
 * on the target with the same type.
 */
export async function copyMatchingCustomFields(orgId, fromType, toType, values, db = prisma) {
  if (!values || !Object.keys(values).length) return {}
  const [from, to] = await Promise.all([getDefinitions(orgId, fromType, {}, db), getDefinitions(orgId, toType, {}, db)])
  const fromTypes = new Map(from.map((d) => [d.key, d.type]))
  const out = {}
  for (const def of to) if (def.key in values && fromTypes.get(def.key) === def.type) out[def.key] = values[def.key]
  return out
}

// ---------- Filters ----------

/**
 * `cf.<key>=value` query params → Prisma `where` conditions on custom_fields.
 * select/checkbox/user/text/email/phone/url: equality (select accepts a comma list → any of);
 * multiselect: contains all given; number/currency/date/datetime: `from..to` range (either side optional).
 */
export async function customFieldWhere(orgId, entityType, query) {
  const entries = Object.entries(query ?? {}).filter(([k, v]) => k.startsWith('cf.') && v !== undefined && v !== '')
  if (!entries.length) return []
  const defs = new Map((await getDefinitions(orgId, entityType, { includeArchived: true })).map((d) => [d.key, d]))
  const conditions = []
  for (const [param, raw] of entries) {
    const key = param.slice(3)
    const def = defs.get(key)
    if (!def) throw validationError({ [param]: 'Unknown custom field' })
    const value = String(raw)
    const path = [key]
    switch (def.type) {
      case 'checkbox':
        conditions.push({ customFields: { path, equals: value === 'true' } })
        break
      case 'select': {
        const values = value.split(',').filter(Boolean)
        conditions.push(values.length === 1 ? { customFields: { path, equals: values[0] } } : { OR: values.map((v) => ({ customFields: { path, equals: v } })) })
        break
      }
      case 'multiselect':
        conditions.push({ customFields: { path, array_contains: value.split(',').filter(Boolean) } })
        break
      case 'number':
      case 'currency':
      case 'date':
      case 'datetime': {
        const [from, to] = value.includes('..') ? value.split('..') : [value, value]
        const cast = (v) => (def.type === 'number' || def.type === 'currency' ? Number(v) : def.type === 'datetime' ? new Date(v).toISOString() : v)
        if (from) conditions.push({ customFields: { path, gte: cast(from) } })
        if (to) conditions.push({ customFields: { path, lte: cast(to) } })
        break
      }
      default:
        conditions.push({ customFields: { path, equals: value } })
    }
  }
  return conditions
}
