import { emptyOverlay, overlayStats, validateMappedRow, identityKeys } from '../lib/importCore.js'
import { editedDataset, mergeEditBatch, sourceIssues } from '../lib/importDraft.js'
import { validateCustomFields } from './customField.service.js'
import { GST_STATE_LIST } from '../lib/india.js'
import crypto from 'node:crypto'
import { prisma } from '../db/prisma.js'
import { hasPermission, scopeFor } from '../config/permissions.js'
import { planDefinition } from '../config/plans.js'
import { emit } from '../events/outbox.js'
import { recordAudit } from '../lib/audit.js'
import { normalizePhone } from '../lib/phone.js'
import { parseSpreadsheet, parseIndianMoney, parseImportDate, suggestMapping, writeSpreadsheet } from '../lib/spreadsheet.js'
import { visibilityWhere } from '../lib/visibility.js'
import { objectStore } from '../storage/objectStore.js'
import { enqueue } from '../jobs/queue.js'
import { ApiError } from '../utils/ApiError.js'
import { createContact, updateContact, listContacts } from './contact.service.js'
import { createCompany, updateCompany, listCompanies, normalizeDomain } from './company.service.js'
import { createLead, updateLead, listLeads } from './lead.service.js'
import { createDealTx, updateDeal, listDeals, missingFor } from './deal.service.js'
import { createContactSchema, createCompanySchema, contactListQuery, companyListQuery } from '../validators/crm.validators.js'
import { createLeadSchema, leadListQuery } from '../validators/lead.validators.js'
import { createDealSchema, dealListQuery } from '../validators/deal.validators.js'
import { accessibleFile, getFileWithUrl, storeGeneratedFile } from './file.service.js'
import { countUsage } from './entitlements.service.js'
import { notificationContext } from './notificationAccess.service.js'

export const IMPORT_FIELDS = { lead: ['fullName', 'firstName', 'lastName', 'phone', 'email', 'companyName', 'source', 'owner', 'budgetMinor', 'requirement', 'city', 'stateCode', 'pincode', 'tags'], contact: ['fullName', 'firstName', 'lastName', 'phone', 'email', 'companyName', 'source', 'owner', 'title', 'tags'], company: ['name', 'phone', 'email', 'owner', 'domain', 'gstin', 'industry', 'website', 'size', 'tags'], deal: ['title', 'valueMinor', 'expectedCloseDate', 'companyName', 'source', 'owner', 'pipeline', 'stage', 'lostReason', 'tags'] }
const ENTITIES = { lead: { create: createLead, update: updateLead, list: listLeads, schema: createLeadSchema, query: leadListQuery, resource: 'leads' }, contact: { create: createContact, update: updateContact, list: listContacts, schema: createContactSchema, query: contactListQuery, resource: 'contacts' }, company: { create: createCompany, update: updateCompany, list: listCompanies, schema: createCompanySchema, query: companyListQuery, resource: 'companies' }, deal: { update: updateDeal, list: listDeals, schema: createDealSchema, query: dealListQuery, resource: 'deals' } }
export const TRANSFER_COLUMNS = {
  lead: ['id', 'displayName', 'firstName', 'lastName', 'primaryEmail', 'primaryPhoneE164', 'companyName', 'requirement', 'budgetMinor', 'city', 'stateCode', 'pincode', 'status', 'score', 'sourceId', 'ownerId', 'createdAt', 'updatedAt', 'lastActivityAt', 'owner', 'tags', 'source', 'company', 'contacts', 'stage', 'pipeline'],
  contact: ['id', 'displayName', 'firstName', 'lastName', 'primaryEmail', 'primaryPhoneE164', 'title', 'lifecycleStage', 'source', 'ownerId', 'createdAt', 'updatedAt', 'lastActivityAt', 'owner', 'tags', 'source', 'company', 'contacts', 'stage', 'pipeline'],
  company: ['id', 'city', 'name', 'domain', 'industry', 'size', 'billingAddress', 'gstin', 'phoneE164', 'email', 'website', 'ownerId', 'createdAt', 'updatedAt', 'lastActivityAt', 'owner', 'tags', 'source', 'company', 'contacts', 'stage', 'pipeline'],
  deal: ['id', 'title', 'pipelineId', 'stageId', 'status', 'valueMinor', 'currency', 'expectedCloseDate', 'companyId', 'ownerId', 'createdAt', 'updatedAt', 'lastActivityAt', 'owner', 'tags', 'source', 'company', 'contacts', 'stage', 'pipeline'],
}
const hashHeaders = (headers) => crypto.createHash('sha256').update(JSON.stringify(headers)).digest('hex')
const invalid = (message, details) => new ApiError(400, message, { code: 'VALIDATION_ERROR', details })
const forbidden = () => new ApiError(403, 'You do not have permission to transfer these records.', { code: 'FORBIDDEN' })
const mustImport = (ctx) => { if (!hasPermission(ctx.permissions, 'records.import')) throw forbidden() }
const jobWhere = (ctx, id) => ({ id, organizationId: ctx.orgId, ...(!['owner', 'admin'].includes(ctx.role) && { createdById: ctx.userId }) })
async function getImport(ctx, id, db = prisma) {
  mustImport(ctx)
  const job = await db.importJob.findFirst({ where: jobWhere(ctx, id) })
  if (!job) throw ApiError.notFound('Import not found')
  return job
}
async function currentContext(orgId, userId, db = prisma) {
  const context = await notificationContext(orgId, userId, db)
  if (!context) throw forbidden()
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { country: true, currency: true, fiscalYearStartMonth: true } })
  return { ...context, ...org, plan: context.organization.plan, timezone: context.organization.timezone }
}
async function parsedJob(ctx, job) {
  const file = await accessibleFile(ctx, job.fileId)
  if (file.status !== 'ready' || file.deletedAt || !/\.(csv|xlsx)$/i.test(file.originalName)) throw invalid('Choose a ready CSV or XLSX upload.')
  const parsed = editedDataset(await parseSpreadsheet(file.originalName, await objectStore.bytes(file.storageKey), job), job.edits ?? emptyOverlay())
  parsed.issueRows = new Map()
  for (const entry of Object.entries(parsed.cellIssues)) {
    const rowId = entry[0].slice(0, entry[0].lastIndexOf(':'))
    if (!parsed.issueRows.has(rowId)) parsed.issueRows.set(rowId, [])
    parsed.issueRows.get(rowId).push(entry)
  }
  return parsed
}
async function setup(ctx, db = prisma) {
  const [members, sources, stages, definitions, lostReasons, tags] = await Promise.all([
    db.membership.findMany({ where: { organizationId: ctx.orgId, status: 'active' }, select: { userId: true, user: { select: { fullName: true, email: true } } } }),
    db.leadSource.findMany({ where: { organizationId: ctx.orgId, archivedAt: null } }),
    db.pipelineStage.findMany({ where: { organizationId: ctx.orgId, pipeline: { archivedAt: null } }, include: { pipeline: true }, orderBy: { position: 'asc' } }),
    db.customFieldDefinition.findMany({ where: { organizationId: ctx.orgId, archivedAt: null } }),
    db.lostReason.findMany({ where: { organizationId: ctx.orgId, entityType: 'deal', archivedAt: null } }),
    db.tag.findMany({ where: { organizationId: ctx.orgId } }),
  ])
  return { members, sources, stages, definitions, lostReasons, tags }
}
const equal = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
export async function transformImportRow(ctx, job, headers, row, lookup, db = prisma) {
  const checked = validateMappedRow(headers, row, job.mapping, { entityType: job.entityType, country: ctx.country, dateFormat: job.options.dateFormat, definitions: lookup.definitions.filter((definition) => definition.entityType === job.entityType) })
  const invalidCells = checked.issues.filter((issue) => issue.severity === 'error')
  if (invalidCells.length) throw invalid(invalidCells.map((issue) => issue.message).join('; '), { issues: invalidCells })
  const values = Object.create(null)
  for (const [index, header] of headers.entries()) {
    const field = job.mapping[header]
    if (field && !IMPORT_FIELDS[job.entityType].includes(field) && !field.startsWith('cf.')) throw invalid(`Unsupported ${job.entityType} field: ${field}`)
    if (field && row[index]?.trim()) values[field] = row[index].trim()
  }
  const warnings = []
  const pending = {}
  const input = Object.create(null)
  const simple = ['firstName', 'lastName', 'name', 'title', 'companyName', 'requirement', 'city', 'stateCode', 'pincode', 'domain', 'gstin', 'industry', 'website', 'size']
  for (const field of simple) if (values[field]) input[field] = values[field]
  if (values.fullName) { const parts = values.fullName.split(/\s+/); input.firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0]; if (parts.length > 1) input.lastName = parts.at(-1) }
  if (input.stateCode && !/^\d{2}$/.test(input.stateCode)) { input.stateCode = GST_STATE_LIST.find(([, name]) => equal(name, input.stateCode))?.[0] ?? input.stateCode }
  if (values.phone) {
    const phone = normalizePhone(values.phone, ctx.country)
    if (!phone.e164) warnings.push('Phone kept as entered because it could not be normalized.')
    if (job.entityType === 'company') input.phone = values.phone
    else input.phones = [{ raw: values.phone, primary: true }]
  }
  if (values.email) { if (job.entityType === 'company') input.email = values.email.toLowerCase(); else input.emails = [{ value: values.email.toLowerCase(), primary: true }] }
  for (const field of ['budgetMinor', 'valueMinor']) if (values[field]) input[field] = parseIndianMoney(values[field])
  if (values.expectedCloseDate) input.expectedCloseDate = parseImportDate(values.expectedCloseDate, job.options.dateFormat)
  const owner = values.owner && (lookup.members.find((m) => equal(m.user.email, values.owner)) ?? lookup.members.filter((m) => equal(m.user.fullName, values.owner)).filter((_m, _i, a) => a.length === 1)[0])
  input.ownerId = owner?.userId ?? job.options.defaultOwnerId ?? null
  if (values.owner && !owner) warnings.push('Owner not matched; using the selected default.')
  if (job.entityType === 'contact' && values.source) input.source = values.source
  else if (values.source) {
    let source = lookup.sources.find((s) => equal(s.name, values.source))
    if (!source && job.options.createMissingSources && ['owner', 'admin'].includes(ctx.role) && values.source.length <= 60) {
      pending.sourceName = values.source
      warnings.push(`Source will be created: ${values.source}`)
    } else if (!source) throw invalid(`Unknown lead source: ${values.source}`, { issues: [{ field: 'source', column: headers.findIndex((header) => job.mapping[header] === 'source'), severity: 'error', message: 'Choose an existing source name, or enable Create unknown lead sources in Import options.' }] })
    if (source) input.sourceId = source.id
  }
  if (values.companyName && ['contact', 'deal'].includes(job.entityType)) {
    if (values.companyName.length > 160) throw invalid('Keep company names under 160 characters.')
    const company = lookup.companies ? lookup.companies.get(values.companyName.trim().toLowerCase()) : await db.company.findFirst({ where: { organizationId: ctx.orgId, deletedAt: null, name: { equals: values.companyName, mode: 'insensitive' } } })
    if (company) {
      if (job.entityType === 'contact') input.companies = [{ companyId: company.id, isPrimary: true }]
      else input.companyId = company.id
    } else {
      pending.companyName = values.companyName
      warnings.push(`Company will be created: ${values.companyName}`)
    }
  }
  if (job.entityType === 'deal') {
    let stages = lookup.stages
    if (values.pipeline) stages = stages.filter((s) => equal(s.pipeline.name, values.pipeline))
    const candidates = values.stage ? stages.filter((s) => equal(s.name, values.stage)) : stages.filter((s) => s.pipeline.isDefault && s.type === 'open').slice(0, 1)
    if (candidates.length !== 1) throw invalid('Choose a unique existing pipeline and stage; outcome stages still require their business fields.')
    input.pipelineId = candidates[0].pipelineId; input.stageId = candidates[0].id
    if (candidates[0].type === 'lost') {
      const reason = lookup.lostReasons.find((r) => equal(r.name, values.lostReason))
      if (!reason) throw invalid('A lost deal needs an existing lost reason.')
      input.lostReasonId = reason.id
    }
  }
  const defs = lookup.definitions.filter((d) => d.entityType === job.entityType)
  const cf = Object.create(null)
  for (const [field, v] of Object.entries(values).filter(([k]) => k.startsWith('cf.'))) {
    const key = field.slice(3); const def = defs.find((d) => d.key === key)
    if (!def) throw invalid(`Unknown custom field: ${key}`)
    if (def.type === 'number') { cf[key] = Number(v); if (!Number.isFinite(cf[key])) throw invalid(`Invalid number for ${def.label}`) }
    else if (def.type === 'currency') cf[key] = parseIndianMoney(v)
    else if (def.type === 'date') cf[key] = parseImportDate(v, job.options.dateFormat)
    else if (def.type === 'checkbox') { if (!/^(yes|no|true|false|1|0)$/i.test(v)) throw invalid(`Use yes/no for ${def.label}`); cf[key] = /^(yes|true|1)$/i.test(v) }
    else if (['select', 'multiselect'].includes(def.type)) {
      const options = def.options ?? []; const match = (x) => options.find((o) => equal(o.label, x) || equal(o.value, x))?.value
      const selected = (def.type === 'multiselect' ? v.split(/[;,]/) : [v]).map(match)
      if (selected.some((x) => x === undefined)) throw invalid(`Unknown option for ${def.label}`)
      cf[key] = def.type === 'multiselect' ? selected : selected[0]
    } else cf[key] = v
  }
  if (Object.keys(cf).length) input.customFields = cf
  if (values.tags) {
    const names = [...new Set(values.tags.split(/[;,]/).map((name) => name.trim()).filter(Boolean))]
    const selected = names.map((name) => lookup.tags.find((tag) => equal(tag.name, name)))
    if (selected.some((tag) => !tag)) throw invalid('One or more tags do not exist. Create them in tag settings or correct the tag names.', { issues: [{ field: 'tags', column: headers.findIndex((header) => job.mapping[header] === 'tags'), severity: 'error', message: 'Use existing tag names separated by commas or semicolons.' }] })
    input.tagIds = selected.map((tag) => tag.id)
  }
  const result = ENTITIES[job.entityType].schema.safeParse(input)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = String(issue.path[0] ?? '')
      const field = ({ phones: 'phone', emails: 'email', sourceId: 'source', ownerId: 'owner', tagIds: 'tags' })[key] ?? (key === 'customFields' ? `cf.${issue.path[1]}` : key)
      const column = headers.findIndex((header) => job.mapping[header] === field || ['firstName', 'lastName'].includes(field) && job.mapping[header] === 'fullName')
      return { field, column, severity: 'error', message: issue.message }
    })
    throw invalid(issues.map((issue) => issue.message).join('; '), { issues })
  }
  if (['lead', 'contact'].includes(job.entityType) && !result.data.firstName && !result.data.emails?.length && !result.data.phones?.length) throw invalid('Enter a name, phone or email.')
  const custom = await validateCustomFields(ctx, job.entityType, result.data.customFields ?? {}, { isCreate: false, db })
  if (result.data.customFields) result.data.customFields = custom
  if (job.entityType === 'deal') { const stage = lookup.stages.find((s) => s.id === result.data.stageId); const missing = missingFor(stage, result.data, 0).filter((field) => !(field === 'companyId' && pending.companyName)); if (missing.length) throw invalid(`Stage requires: ${missing.join(', ')}`) }
  return { input: result.data, warnings, pending }
}
async function duplicateFor(ctx, type, input, db) {
  if (type === 'company') {
    const or = [{ name: { equals: input.name, mode: 'insensitive' } }]
    if (input.domain) or.push({ domain: normalizeDomain(input.domain) })
    if (input.gstin) or.push({ gstin: input.gstin })
    return db.company.findFirst({ where: { organizationId: ctx.orgId, deletedAt: null, OR: or }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  }
  if (type === 'deal') return null // No product-defined deal duplicate identity; never guess from title.
  const mails = (input.emails ?? []).map((e) => e.value)
  const phones = (input.phones ?? []).map((p) => normalizePhone(p.raw, ctx.country).e164).filter(Boolean)
  if (!mails.length && !phones.length) return null
  const identity = [{ emailLookups: { some: { email: { in: mails } } } }, { phoneLookups: { some: { e164: { in: phones } } } }]
  const existing = await db[type].findFirst({ where: { organizationId: ctx.orgId, deletedAt: null, ...(type === 'lead' && { status: { in: ['new', 'contacted', 'qualified'] } }), OR: identity }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  if (existing || type !== 'lead') return existing
  const contact = await db.contact.findFirst({ where: { organizationId: ctx.orgId, deletedAt: null, OR: identity }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return contact ? { ...contact, matchedEntityType: 'contact' } : null
}
export async function createImport(ctx, { entityType, fileId }) {
  mustImport(ctx)
  const file = await accessibleFile(ctx, fileId)
  if (file.status !== 'ready' || !/\.(csv|xlsx)$/i.test(file.originalName)) throw invalid('Choose a CSV or XLSX file.')
  const parsed = await parseSpreadsheet(file.originalName, await objectStore.bytes(file.storageKey))
  const definitions = await prisma.customFieldDefinition.findMany({ where: { organizationId: ctx.orgId, entityType, archivedAt: null } })
  const saved = await prisma.importMapping.findUnique({ where: { organizationId_entityType_headersHash: { organizationId: ctx.orgId, entityType, headersHash: hashHeaders(parsed.headers) } } })
  const job = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM files WHERE id = ${fileId}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`
    const source = await tx.file.findFirst({ where: { id: fileId, organizationId: ctx.orgId, status: 'ready', deletedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } })
    if (!source) throw invalid('The uploaded source is no longer available. Upload it again.')
    const job = await tx.importJob.create({ data: { organizationId: ctx.orgId, createdById: ctx.userId, entityType, fileId, sheetName: parsed.sheetName, headerRow: parsed.headerRow, totalRows: parsed.rows.length, mapping: saved?.mapping ?? suggestMapping(parsed.headers, entityType, definitions, IMPORT_FIELDS[entityType]), options: { duplicateStrategy: 'skip', updateMode: 'empty', dateFormat: 'DMY' } } })
    await tx.fileLink.create({ data: { fileId, organizationId: ctx.orgId, entityType: 'import', entityId: job.id, createdById: ctx.userId } })
    return job
  })
  return { ...job, sheets: parsed.sheets, headers: parsed.headers, sampleRows: parsed.rows.slice(0, 10), suggestedMapping: job.mapping }
}
export async function updateImport(ctx, id, input) {
  const job = await getImport(ctx, id)
  if (job.status !== 'draft') throw new ApiError(409, 'Only draft imports can be changed.', { code: 'CONFLICT' })
  if (input.mapping) {
    const fields = Object.values(input.mapping).filter(Boolean)
    if (new Set(fields).size !== fields.length) throw invalid('Map each CRM field once; ignore additional columns mapped to the same field.')
  }
  if (input.revision !== undefined && input.revision !== job.revision) throw new ApiError(409, 'This draft changed in another tab. Reload it before saving.', { code: 'CONFLICT' })
  const { mappingName, autoDetect, revision: _revision, editBatch, ...data } = input
  const parsing = { ...job, ...data }
  if (autoDetect) { parsing.sheetName = undefined; parsing.headerRow = undefined; parsing.hasHeader = true }
  else if ('sheetName' in data && data.sheetName !== job.sheetName && data.headerRow === undefined) parsing.headerRow = undefined
  const parsed = await parsedJob(ctx, { ...parsing, edits: emptyOverlay() })
  const layoutChanged = autoDetect || parsed.sheetName !== job.sheetName || parsed.headerRow !== job.headerRow || parsed.hasHeader !== job.hasHeader
  if (layoutChanged) {
    data.sheetName = parsed.sheetName
    data.headerRow = parsed.headerRow
    data.hasHeader = parsed.hasHeader
    data.edits = emptyOverlay()
    if (!data.mapping) {
      const definitions = await prisma.customFieldDefinition.findMany({ where: { organizationId: ctx.orgId, entityType: job.entityType, archivedAt: null } })
      const saved = await prisma.importMapping.findUnique({ where: { organizationId_entityType_headersHash: { organizationId: ctx.orgId, entityType: job.entityType, headersHash: hashHeaders(parsed.headers) } } })
      data.mapping = saved?.mapping ?? suggestMapping(parsed.headers, job.entityType, definitions, IMPORT_FIELDS[job.entityType])
    }
  }
  if (editBatch) data.edits = mergeEditBatch(layoutChanged ? emptyOverlay() : job.edits, editBatch, parsed, { ...job, ...data })
  const effective = editedDataset(parsed, data.edits ?? job.edits ?? emptyOverlay())
  const result = await prisma.importJob.updateMany({ where: { id, organizationId: ctx.orgId, status: 'draft', revision: job.revision }, data: { ...data, totalRows: effective.rows.length, revision: { increment: 1 }, analysis: {} } })
  if (!result.count) throw new ApiError(409, 'Import already started.', { code: 'CONFLICT' })
  if (job.analysis?.key) await objectStore.delete(job.analysis.key).catch(() => {})
  if (mappingName) await prisma.importMapping.upsert({ where: { organizationId_entityType_headersHash: { organizationId: ctx.orgId, entityType: job.entityType, headersHash: hashHeaders(parsed.headers) } }, create: { organizationId: ctx.orgId, entityType: job.entityType, name: mappingName, headersHash: hashHeaders(parsed.headers), mapping: data.mapping ?? job.mapping }, update: { name: mappingName, mapping: data.mapping ?? job.mapping } })
  return { ...(await getImport(ctx, id)), sheets: parsed.sheets, headers: parsed.headers, sampleRows: effective.rows.slice(0, 10) }
}
export async function importDataset(ctx, id, { offset = 0, limit = 1000 } = {}) {
  const job = await getImport(ctx, id)
  const parsed = await parsedJob(ctx, job)
  return { rows: parsed.sourceRows.slice(offset, offset + limit), totalSourceRows: parsed.sourceRows.length, totalRows: parsed.rows.length, columns: parsed.headers.map((key, index) => ({ key, index, label: parsed.originalHeaders[index] })), headerRow: parsed.headerRow, hasHeader: parsed.hasHeader, sheetName: parsed.sheetName, sheets: parsed.sheets, cellIssues: Object.fromEntries(Object.entries(parsed.cellIssues).filter(([key]) => { const number = Number(key.split(':')[1]); return number > offset && number <= offset + limit })), revision: job.revision, edits: job.edits, offset }
}
async function updateValues(ctx, job, input, duplicate, db) {
  const values = { ...input }
  if (!Object.values(job.mapping).includes('owner')) delete values.ownerId
  delete values.stageId; delete values.pipelineId
  if (job.options.updateMode !== 'overwrite') {
    for (const key of Object.keys(values)) {
      if (key === 'customFields') {
        values.customFields = Object.fromEntries(Object.entries(values.customFields).filter(([field]) => duplicate.customFields?.[field] == null || duplicate.customFields[field] === ''))
        if (!Object.keys(values.customFields).length) delete values.customFields
      } else if (key === 'companies' && job.entityType === 'contact') {
        if (duplicate._hasCompany ?? await db.contactCompany.count({ where: { organizationId: ctx.orgId, contactId: duplicate.id } })) delete values.companies
      } else if (duplicate[key] !== null && duplicate[key] !== '' && !(Array.isArray(duplicate[key]) && !duplicate[key].length) && duplicate[key] !== undefined) delete values[key]
    }
  }
  return values
}
async function preparePreviewLookups(ctx, job, parsed, lookup) {
  const duplicateIndex = new Map(), companies = new Map()
  const remember = (record, fallback = false) => {
    for (const key of identityKeys(job.entityType === 'lead' && fallback ? 'contact' : job.entityType, { ...record, country: ctx.country })) {
      const previous = duplicateIndex.get(key)
      if (!previous || previous.matchedEntityType === 'contact' && !fallback || !previous.matchedEntityType && !fallback && (new Date(record.createdAt) < new Date(previous.createdAt) || +new Date(record.createdAt) === +new Date(previous.createdAt) && record.id < previous.id)) duplicateIndex.set(key, fallback ? { ...record, matchedEntityType: 'contact' } : record)
    }
  }
  for (let offset = 0; offset < parsed.rows.length; offset += 200) {
    const normalized = parsed.rows.slice(offset, offset + 200).map((row) => validateMappedRow(parsed.headers, row, job.mapping, { entityType: job.entityType, country: ctx.country, dateFormat: job.options.dateFormat, definitions: lookup.definitions }))
    const names = [...new Set(normalized.map((row) => row.values.companyName).filter(Boolean))]
    if (names.length && ['contact', 'deal'].includes(job.entityType)) {
      for (const company of await prisma.company.findMany({ where: { organizationId: ctx.orgId, deletedAt: null, OR: names.map((name) => ({ name: { equals: name, mode: 'insensitive' } })) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) if (!companies.has(company.name.toLowerCase())) companies.set(company.name.toLowerCase(), company)
    }
    if (job.entityType === 'deal') continue
    let where
    if (job.entityType === 'company') {
      const OR = normalized.flatMap((row) => [row.values.name && { name: { equals: row.values.name, mode: 'insensitive' } }, row.values.domain && { domain: normalizeDomain(row.values.domain) }, row.values.gstin && { gstin: row.values.gstin.toUpperCase() }].filter(Boolean))
      if (!OR.length) continue
      where = { OR }
    } else {
      const emails = normalized.map((row) => row.values.email?.toLowerCase()).filter(Boolean), phones = normalized.map((row) => normalizePhone(row.values.phone, ctx.country).e164).filter(Boolean)
      if (!emails.length && !phones.length) continue
      where = { OR: [{ emailLookups: { some: { email: { in: emails } } } }, { phoneLookups: { some: { e164: { in: phones } } } }] }
    }
    const existing = await prisma[job.entityType].findMany({ where: { organizationId: ctx.orgId, deletedAt: null, ...where, ...(job.entityType === 'lead' && { status: { in: ['new', 'contacted', 'qualified'] } }) }, ...(job.entityType === 'contact' && { include: { companies: true } }), orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    for (const record of existing) remember({ ...record, ...(job.entityType === 'contact' && { _hasCompany: Boolean(record.companies?.length) }) })
    if (job.entityType === 'lead') for (const record of await prisma.contact.findMany({ where: { organizationId: ctx.orgId, deletedAt: null, ...where }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) remember(record, true)
  }
  return { duplicateIndex, companies }
}
function reviewValues(result, checked, fields, lookup, job) {
  const display = { ...checked.display }
  if ('fullName' in display) display.fullName = [result.input.firstName, result.input.lastName].filter(Boolean).join(' ')
  if ('firstName' in display) display.firstName = result.input.firstName ?? ''
  if ('lastName' in display) display.lastName = result.input.lastName ?? ''
  if ('email' in display) display.email = result.input.email ?? result.input.emails?.[0]?.value ?? ''
  if ('domain' in display) display.domain = normalizeDomain(result.input.domain) ?? result.input.domain ?? ''
  if ('tags' in display) display.tags = (result.input.tagIds ?? []).map((id) => lookup.tags.find((tag) => tag.id === id)?.name ?? '').filter(Boolean).join('; ')
  if (job.entityType === 'deal') {
    const stage = lookup.stages.find((item) => item.id === result.input.stageId)
    if ('stage' in display) display.stage = stage?.name ?? display.stage
    if ('pipeline' in display) display.pipeline = stage?.pipeline.name ?? display.pipeline
  }
  if ('ownerId' in result.input) display.owner = lookup.members.find((member) => member.userId === result.input.ownerId)?.user.fullName ?? 'Unassigned'
  if (result.input.sourceId) display.source = lookup.sources.find((source) => source.id === result.input.sourceId)?.name ?? checked.values.source
  for (const [key, value] of Object.entries(result.input.customFields ?? {})) {
    const definition = lookup.definitions.find((item) => item.entityType === job.entityType && item.key === key)
    display[`cf.${key}`] = definition?.type === 'currency' ? value / 100 : typeof value === 'boolean' ? value ? 'Yes' : 'No' : Array.isArray(value) ? value.join('; ') : value
  }
  for (const field of Object.keys(display)) if (!fields.includes(field)) delete display[field]
  if (fields.includes('status')) display.status = job.entityType === 'lead' ? 'New' : (lookup.stages.find((stage) => stage.id === result.input.stageId)?.type ?? 'open')
  return display
}
async function analyzeImport(ctx, job) {
  const parsed = await parsedJob(ctx, job), lookup = await setup(ctx)
  const firstIndex = job.status === 'failed' ? job.processed : 0
  const planned = { ...parsed, rows: parsed.rows.slice(firstIndex, job.options.maxRows ?? parsed.rows.length) }
  const { duplicateIndex, companies } = await preparePreviewLookups(ctx, job, planned, lookup)
  lookup.companies = companies
  const previewDb = new Proxy(prisma, { get: (target, key) => key === 'customFieldDefinition' ? { findMany: async ({ where }) => lookup.definitions.filter((definition) => definition.entityType === where.entityType) } : Reflect.get(target, key) })
  const fields = [...new Set([...Object.values(job.mapping).filter(Boolean), 'owner'])]
  if (['lead', 'deal'].includes(job.entityType) && !fields.includes('status')) fields.push('status')
  const rows = [], seen = new Map(), updatedRecords = new Map(), originalRows = new Map(parsed.sourceRows.map((row) => [row.id, row.values]))
  const summary = { rowsInFile: parsed.sourceRows.filter((row) => (row.sourceRow ?? 0) >= job.headerRow + (job.hasHeader === false ? 0 : 1) && row.values.some((value) => value.trim())).length, totalRows: planned.rows.length, willCreate: 0, willUpdate: 0, willSkip: 0, errorRows: 0, ...overlayStats(job.edits ?? emptyOverlay()) }
  for (const [relativeIndex, raw] of planned.rows.entries()) {
    const index = relativeIndex + firstIndex
    const rowId = parsed.rowIds[index]
    const checked = validateMappedRow(parsed.headers, raw, job.mapping, { entityType: job.entityType, country: ctx.country, dateFormat: job.options.dateFormat, definitions: lookup.definitions.filter((definition) => definition.entityType === job.entityType) })
    const row = { id: rowId, row: parsed.sourceNumbers[index], index, originalValues: Object.fromEntries(parsed.headers.map((header, column) => [job.mapping[header], originalRows.get(rowId)?.[column] ?? ''])), input: {}, values: { ...checked.display }, raw, issues: [...checked.issues, ...sourceIssues(parsed, job, rowId)], warnings: [], errors: [], duplicate: false, edited: Boolean(job.edits?.cells?.[rowId]) || rowId.startsWith('a:'), editedFields: Object.keys(job.edits?.cells?.[rowId] ?? {}).map((column) => job.mapping[parsed.headers[Number(column)]]).filter(Boolean), status: 'ready', action: 'create' }
    try {
      const cellErrors = row.issues.filter((issue) => issue.severity === 'error')
      if (cellErrors.length) throw invalid(cellErrors.map((issue) => issue.message).join('; '), { issues: cellErrors })
      const result = await transformImportRow(ctx, job, parsed.headers, raw, lookup, previewDb)
      row.input = result.input
      row.values = reviewValues(result, checked, fields, lookup, job)
      const identities = identityKeys(job.entityType, { ...result.input, country: ctx.country })
      const candidates = identities.map((key) => { const original = duplicateIndex.get(key); if (!original) return null; const current = updatedRecords.get(original.id) ?? original; return identityKeys(current.matchedEntityType === 'contact' ? 'contact' : job.entityType, { ...current, country: ctx.country }).includes(key) ? current : null }).filter(Boolean).sort((a, b) => Number(Boolean(a.matchedEntityType)) - Number(Boolean(b.matchedEntityType)) || +new Date(a.createdAt) - +new Date(b.createdAt) || a.id.localeCompare(b.id))
      const inFile = identities.map((key) => seen.get(key)).find(Boolean)
      const duplicate = candidates[0] ? updatedRecords.get(candidates[0].id) ?? candidates[0] : inFile
      row.duplicate = Boolean(duplicate)
      if (duplicate?.matchedEntityType === 'contact' && job.options.duplicateStrategy === 'update') throw invalid('This lead matches an existing contact. Choose Create anyway for a new linked enquiry.')
      row.action = duplicate && job.options.duplicateStrategy !== 'create' ? job.options.duplicateStrategy === 'update' ? 'update' : 'skip' : 'create'
      if (row.action !== 'skip') await validateCustomFields(ctx, job.entityType, result.input.customFields ?? {}, { existing: row.action === 'update' ? duplicate?.customFields ?? {} : {}, isCreate: row.action === 'create', db: previewDb })
      if (row.action === 'update') {
        const plannedInput = { ...result.input }
        if (result.pending.sourceName) plannedInput.sourceId = `pending:${result.pending.sourceName}`
        if (result.pending.companyName) {
          if (job.entityType === 'contact') plannedInput.companies = [{ companyId: `pending:${result.pending.companyName}`, isPrimary: true }]
          else plannedInput.companyId = `pending:${result.pending.companyName}`
        }
        const changed = await updateValues(ctx, job, plannedInput, duplicate, previewDb)
        if (!Object.keys(changed).length) row.action = 'skip'
        else {
          const allowed = new Set(Object.keys(changed).flatMap((key) => ({ firstName: ['firstName', 'fullName'], lastName: ['lastName', 'fullName'], emails: ['email'], phones: ['phone'], ownerId: ['owner'], sourceId: ['source'], companies: ['companyName'], companyId: ['companyName'], tagIds: ['tags'], customFields: Object.keys(changed.customFields ?? {}).map((key) => `cf.${key}`) })[key] ?? [key]))
          row.values = Object.fromEntries(Object.entries(row.values).filter(([field]) => allowed.has(field)))
          const simulated = { ...duplicate, ...changed, customFields: { ...duplicate.customFields, ...changed.customFields } }
          updatedRecords.set(duplicate.id, simulated)
          for (const key of identities) seen.set(key, simulated)
        }
      }
      for (const warning of result.warnings) {
        const field = /owner/i.test(warning) ? 'owner' : /source/i.test(warning) ? 'source' : /company/i.test(warning) ? 'companyName' : /phone/i.test(warning) ? 'phone' : ''
        if (field) row.issues.push({ field, column: parsed.headers.findIndex((header) => job.mapping[header] === field), message: warning, severity: 'warning' })
      }
      row.warnings = [...new Set([...result.warnings, ...row.issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message)])]
      if (row.duplicate) row.reason = `${duplicate._importRow ? `Matches source row ${duplicate._importRow}` : 'Matches an existing CRM record'}. ${row.action === 'skip' ? 'Will be skipped' : row.action === 'update' ? 'Will update matching fields' : 'Will create a separate record'}.`
      row.status = row.duplicate ? 'duplicate' : row.warnings.length ? 'warning' : 'ready'
      if (row.action === 'create') {
        const simulated = { ...result.input, id: `preview:${index}`, _hasCompany: Boolean(result.input.companies?.length || result.pending.companyName), _importRow: row.row ?? `added ${index + 1}`, createdAt: new Date().toISOString() }
        for (const key of identities) seen.set(key, simulated)
      }
      summary[row.action === 'create' ? 'willCreate' : row.action === 'update' ? 'willUpdate' : 'willSkip']++
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      row.errors = [error.message]; row.status = 'error'; row.action = 'skip'
      const fieldIssues = error.details?.issues ?? Object.entries(error.details?.fields ?? {}).map(([field, message]) => ({ field: field.replace(/^customFields\./, 'cf.'), column: parsed.headers.findIndex((header) => job.mapping[header] === field.replace(/^customFields\./, 'cf.')), message, severity: 'error' }))
      row.issues.push(...fieldIssues)
      summary.willSkip++; summary.errorRows++
    }
    rows.push(row)
  }
  const used = await countUsage(ctx.orgId, 'records'), limit = planDefinition(ctx.plan).limits.records
  const availableRecordSlots = Number.isFinite(limit) ? Math.max(0, limit - used) : null
  const counts = { all: rows.length, ready: rows.filter((row) => row.status === 'ready').length, attention: rows.filter((row) => row.errors.length || row.warnings.length).length, duplicates: rows.filter((row) => row.duplicate).length, edited: rows.filter((row) => row.edited).length }
  return { status: 'complete', revision: job.revision, rows, fields, summary, counts, totalRows: planned.rows.length, estimatedCreates: summary.willCreate, availableRecordSlots, generatedAt: new Date().toISOString() }
}
export async function runImportPreview(id, revision) {
  const job = await prisma.importJob.findUnique({ where: { id } })
  if (!job || job.revision !== revision || job.status !== 'draft') return
  await prisma.importJob.updateMany({ where: { id, revision, status: 'draft' }, data: { analysis: { status: 'running', revision } } })
  try {
    const ctx = await currentContext(job.organizationId, job.createdById)
    const result = await analyzeImport(ctx, job)
    const key = `orgs/${job.organizationId}/import-previews/${id}/${revision}.json`
    await objectStore.upload(key, Buffer.from(JSON.stringify(result)), 'application/json')
    const { rows: _rows, ...meta } = result
    const saved = await prisma.importJob.updateMany({ where: { id, revision, status: 'draft' }, data: { analysis: { ...meta, key } } })
    if (!saved.count) await objectStore.delete(key).catch(() => {})
  } catch (error) {
    await prisma.importJob.updateMany({ where: { id, revision, status: 'draft' }, data: { analysis: { status: 'error', revision, message: error instanceof ApiError ? error.message : 'Could not analyze the import. Retry the preview.' } } })
    throw error
  }
}
export async function previewImport(ctx, id, query = {}, request = true) {
  let job = await getImport(ctx, id)
  if (job.analysis?.revision !== job.revision || !job.analysis?.status || job.analysis.status === 'error' && request) {
    if (!request) return { status: 'stale', revision: job.revision, rows: [] }
    if (job.status !== 'draft') return analyzeImport(ctx, job)
    await prisma.importJob.updateMany({ where: { id, revision: job.revision, status: 'draft' }, data: { analysis: { status: 'pending', revision: job.revision } } })
    if (Math.min(job.totalRows, job.options.maxRows ?? job.totalRows) <= 1000) await runImportPreview(id, job.revision)
    else await enqueue('import.preview', { importId: id, revision: job.revision }, { singletonKey: `${id}:${job.revision}` }).catch(() => {})
    job = await getImport(ctx, id)
  }
  const analysis = job.analysis
  if (analysis.status !== 'complete') return { ...analysis, rows: [] }
  const all = JSON.parse((await objectStore.bytes(analysis.key)).toString('utf8'))
  const q = (query.q ?? '').toLowerCase()
  const filtered = all.rows.filter((row) => (!q || JSON.stringify([row.values, row.row, row.errors, row.warnings]).toLowerCase().includes(q)) && (query.filter === 'attention' ? row.errors.length || row.warnings.length : query.filter === 'duplicates' ? row.duplicate : query.filter === 'edited' ? row.edited : query.filter === 'ready' ? row.status === 'ready' : true))
  const offset = query.offset ?? 0, limit = query.limit ?? 1000
  return { ...all, rows: filtered.slice(offset, offset + limit), filteredTotal: filtered.length, offset }
}
export async function importAttentionData(ctx, id) {
  const job = await getImport(ctx, id)
  if (job.analysis?.status !== 'complete' || job.analysis.revision !== job.revision) throw invalid('Generate a current preview before downloading attention rows.')
  const data = JSON.parse((await objectStore.bytes(job.analysis.key)).toString('utf8'))
  return { headers: ['Source row', ...data.fields, 'Reason'], rows: data.rows.filter((row) => row.errors.length || row.warnings.length).map((row) => [String(row.row ?? 'Added'), ...data.fields.map((field) => String(row.values[field] ?? '')), [...row.errors, ...row.warnings].join('; ')]) }
}
export async function importAttention(ctx, id) {
  const job = await getImport(ctx, id)
  if (job.analysis?.status !== 'complete' || job.analysis.revision !== job.revision) throw invalid('Generate a current preview before downloading attention rows.')
  const data = JSON.parse((await objectStore.bytes(job.analysis.key)).toString('utf8'))
  const rows = data.rows.filter((row) => row.errors.length || row.warnings.length)
  return writeSpreadsheet(['Source row', ...data.fields, 'Reason'], rows.map((row) => [row.row ?? 'Added', ...data.fields.map((field) => row.values[field] ?? ''), [...row.errors, ...row.warnings].join('; ')]), 'csv')
}
export async function startImport(ctx, id, { revision, acceptSkippedRows } = {}) {
  const job = await getImport(ctx, id)
  if (!['draft', 'failed'].includes(job.status)) return job
  if (revision !== undefined && revision !== job.revision) throw new ApiError(409, 'The draft changed. Review the latest data before importing.', { code: 'CONFLICT' })
  if (!Object.values(job.mapping).some(Boolean)) throw invalid('Map at least one column.')
  let preview
  if (revision !== undefined) {
    if (job.analysis?.revision !== revision || job.analysis?.status !== 'complete') throw invalid('Wait for the current preview to finish before starting.')
    preview = job.analysis
    if (preview.summary.errorRows && !acceptSkippedRows) throw invalid(`${preview.summary.errorRows} rows have errors. Confirm that they will be skipped.`)
  } else preview = await analyzeImport(ctx, job)
  if (!preview.totalRows) throw invalid('There are no data rows to import. Add data or adjust the sheet and header.')
  const limit = planDefinition(ctx.plan).limits.records, used = await countUsage(ctx.orgId, 'records')
  if (['lead', 'contact'].includes(job.entityType) && Number.isFinite(limit) && preview.summary.willCreate > Math.max(0, limit - used)) throw new ApiError(403, 'Reduce the number of rows or upgrade your plan.', { code: 'PLAN_LIMIT_REACHED', details: { resource: 'records', available: Math.max(0, limit - used) } })
  const changed = await prisma.importJob.updateMany({ where: { id, organizationId: ctx.orgId, revision: job.revision, status: { in: ['draft', 'failed'] } }, data: { status: 'queued', lastError: null, finishedAt: null } })
  if (!changed.count) throw new ApiError(409, 'The import changed. Refresh before starting.', { code: 'CONFLICT' })
  await enqueue('import.run', { importId: id }, { singletonKey: id }).catch(() => {})
  return getImport(ctx, id)
}

async function finishImport(job, status, lastError = null) {
  await prisma.$transaction(async (tx) => {
    const changed = await tx.importJob.updateMany({ where: { id: job.id, organizationId: job.organizationId, status: { in: ['queued', 'running'] } }, data: { status, lastError, finishedAt: new Date() } })
    if (!changed.count) return
    await emit(tx, { orgId: job.organizationId, userId: null }, status === 'failed' ? 'import.failed' : 'import.completed', { entityType: 'import', entityId: job.id }, { importerId: job.createdById, title: `Import ${status}` })
    await recordAudit(tx, { orgId: job.organizationId, userId: job.createdById }, { action: `import.${status}`, entityType: 'import', entityId: job.id })
  })
}
export async function runImport(importId) {
  let job = await prisma.importJob.findUnique({ where: { id: importId } })
  if (!job || !['queued', 'running'].includes(job.status)) return
  try {
    let ctx = await currentContext(job.organizationId, job.createdById); mustImport(ctx)
    const parsed = await parsedJob(ctx, job), lookup = await setup(ctx)
    const total = Math.min(parsed.rows.length, job.options.maxRows ?? parsed.rows.length)
    for (;;) {
      const step = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM import_jobs WHERE id = ${importId}::uuid FOR UPDATE`
        const current = await tx.importJob.findUnique({ where: { id: importId } })
        if (!['queued', 'running'].includes(current.status) || current.processed >= total) return null
        // Check current membership/permission every row; role changes stop queued work immediately.
        ctx = { ...(await currentContext(job.organizationId, job.createdById, tx)), importId }
        mustImport(ctx)
        await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${ctx.orgId}::uuid FOR UPDATE`
        const index = current.processed
        let action, entityId = null, recordUpdatedAt = null, error = null
        // Failed row writes must roll back without rolling back the import's error/progress journal.
        await tx.$executeRawUnsafe('SAVEPOINT import_row')
        try {
          const fileErrors = sourceIssues(parsed, job, parsed.rowIds[index]).filter((issue) => issue.severity === 'error')
          if (fileErrors.length) throw invalid(fileErrors.map((issue) => issue.message).join('; '))
          const { input, pending } = await transformImportRow(ctx, job, parsed.headers, parsed.rows[index], lookup, tx)
          const duplicate = await duplicateFor(ctx, job.entityType, input, tx)
          if (!duplicate || job.options.duplicateStrategy !== 'skip') {
            if (pending.sourceName) input.sourceId = (await tx.leadSource.upsert({ where: { organizationId_name: { organizationId: ctx.orgId, name: pending.sourceName } }, create: { organizationId: ctx.orgId, name: pending.sourceName }, update: {} })).id
            if (pending.companyName) {
              const keepCompany = duplicate && job.entityType === 'contact' && job.options.updateMode !== 'overwrite' && await tx.contactCompany.count({ where: { organizationId: ctx.orgId, contactId: duplicate.id } })
              if (!keepCompany) {
                const existingCompany = await tx.company.findFirst({ where: { organizationId: ctx.orgId, deletedAt: null, name: { equals: pending.companyName, mode: 'insensitive' } } })
                const company = existingCompany ?? await createCompany(ctx, { name: pending.companyName }, { allowDuplicate: true, tx })
                if (job.entityType === 'contact') input.companies = [{ companyId: company.id, isPrimary: true }]
                else input.companyId = company.id
              }
            }
          }
          if (duplicate && job.options.duplicateStrategy !== 'create') {
            if (job.options.duplicateStrategy !== 'update') action = 'skipped'
            else {
              if (duplicate.matchedEntityType === 'contact') throw invalid('This lead matches an existing contact. Choose Create anyway to import a new enquiry linked to that contact.')
              const values = await updateValues(ctx, job, input, duplicate, tx)
              if (Object.keys(values).length) { await ENTITIES[job.entityType].update(ctx, duplicate.id, values, { allowDuplicate: true, tx }); action = 'updated' }
              else action = 'skipped'
              entityId = duplicate.id
            }
          } else {
            const record = job.entityType === 'deal' ? await createDealTx(tx, ctx, input) : await ENTITIES[job.entityType].create(ctx, input, { allowDuplicate: true, tx, ...(duplicate?.matchedEntityType === 'contact' && { linkedContactId: duplicate.id }) })
            entityId = record.id; action = 'created'
            await tx[job.entityType].update({ where: { id: entityId, organizationId: ctx.orgId }, data: { importId } })
          }
          if (entityId) recordUpdatedAt = (await tx[job.entityType].findFirst({ where: { id: entityId, organizationId: ctx.orgId }, select: { updatedAt: true } })).updatedAt
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT import_row')
        } catch (err) {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT import_row')
          if (!(err instanceof ApiError) && !['P2002', 'P2025'].includes(err.code)) throw err
          action = 'failed'; entityId = null; error = err instanceof ApiError ? err.message.slice(0, 2000) : 'A duplicate or stale record prevented this row from being saved.'
        }
        await tx.importRecord.create({ data: { importId, organizationId: ctx.orgId, rowIndex: index, entityType: job.entityType, entityId, recordUpdatedAt, action, error } })
        await tx.importJob.update({ where: { id: importId }, data: { processed: { increment: 1 }, [action]: { increment: 1 }, status: 'running', startedAt: current.startedAt ?? new Date() } })
        return index
      }, { timeout: 30000 })
      if (step === null) break
    }
    job = await prisma.importJob.findUnique({ where: { id: importId } })
    if (['queued', 'running'].includes(job.status)) await finishImport(job, 'completed')
  } catch (err) { await finishImport(job, 'failed', err instanceof ApiError ? err.message : 'Processing failed. Contact support with the import ID.'); throw err }
}
export async function importStatus(ctx, id) { const job = await getImport(ctx, id); if (job.status !== 'draft') return job; const parsed = await parsedJob(ctx, job); return { ...job, headers: parsed.headers, sheets: parsed.sheets, sampleRows: parsed.rows.slice(0, 10) } }
export async function importHistory(ctx) { mustImport(ctx); return prisma.importJob.findMany({ where: { organizationId: ctx.orgId }, orderBy: { createdAt: 'desc' }, take: 100 }) }
export async function cancelImport(ctx, id) {
  await getImport(ctx, id)
  await prisma.importJob.updateMany({ where: { id, organizationId: ctx.orgId, status: { in: ['draft', 'queued', 'running'] } }, data: { status: 'cancelled', finishedAt: new Date() } })
  return getImport(ctx, id)
}
export async function undoImport(ctx, id) {
  const job = await getImport(ctx, id)
  if (!['completed', 'cancelled', 'failed'].includes(job.status) || !job.finishedAt || Date.now() - job.finishedAt > 7 * 86400000) throw invalid('Undo is available within seven days after the import finishes.')
  const rows = await prisma.importRecord.findMany({ where: { importId: id, organizationId: ctx.orgId, action: 'created' } })
  let removed = 0
  for (const r of rows) {
    await prisma.$transaction(async (tx) => {
      const result = await tx[r.entityType].updateMany({ where: { AND: [{ id: r.entityId, organizationId: ctx.orgId, importId: id, updatedAt: r.recordUpdatedAt, deletedAt: null }, visibilityWhere(ctx, ENTITIES[r.entityType].resource, 'delete')] }, data: { deletedAt: new Date() } })
      removed += result.count
      if (result.count) { await emit(tx, ctx, `${r.entityType}.deleted`, { entityType: r.entityType, entityId: r.entityId }, { importId: id }); await tx.importRecord.update({ where: { importId_rowIndex: { importId: id, rowIndex: r.rowIndex } }, data: { action: 'undone' } }) }
    })
  }
  await prisma.$transaction(async (tx) => { await tx.importJob.update({ where: { id, organizationId: ctx.orgId }, data: { status: 'undone' } }); await recordAudit(tx, ctx, { action: 'import.undo', entityType: 'import', entityId: id, changes: { removed } }) })
  return { removed, kept: rows.length - removed }
}
export async function importErrors(ctx, id) {
  const job = await getImport(ctx, id)
  if (!job.finishedAt || Date.now() - job.finishedAt > 30 * 86400000) throw invalid('Error reports are available for 30 days after completion.')
  if (job.errorFileId) { try { return await getFileWithUrl(ctx, job.errorFileId) } catch (err) { if (err.statusCode !== 404) throw err } }
  const parsed = await parsedJob(ctx, job)
  const failed = await prisma.importRecord.findMany({ where: { importId: id, organizationId: ctx.orgId, action: 'failed' }, orderBy: { rowIndex: 'asc' } })
  const bytes = await writeSpreadsheet([...parsed.headers, 'error'], failed.map((r) => [...(parsed.rows[r.rowIndex] ?? []), r.error]), 'csv')
  const file = await storeGeneratedFile(ctx, `import-${id}-errors.csv`, bytes, Math.max(1 / 86400, 30 - (Date.now() - job.finishedAt.getTime()) / 86400000))
  await prisma.importJob.update({ where: { id, organizationId: ctx.orgId }, data: { errorFileId: file.id } })
  return getFileWithUrl(ctx, file.id)
}

function exportContext(ctx) {
  const scope = scopeFor(ctx.permissions, 'records', 'export')
  if (!scope) throw forbidden()
  if (scope === 'team') return { ...ctx, forExport: true, permissions: ctx.permissions.filter((p) => !Object.values(ENTITIES).some((e) => p === `${e.resource}.read.all`)).concat(Object.values(ENTITIES).map((e) => `${e.resource}.read.team`)) }
  return ctx
}
async function exportRows(ctx, job, cap = 50001) {
  ctx = exportContext(ctx)
  const config = ENTITIES[job.entityType]
  const query = config.query.parse(Object.fromEntries(Object.entries({ ...job.filters, limit: 100 }).map(([k, v]) => [k, typeof v === 'boolean' ? String(v) : v])))
  const rows = []; let cursor
  do { ctx = exportContext(await currentContext(ctx.orgId, ctx.userId)); const page = await config.list(ctx, { ...query, cursor }); rows.push(...page.items); cursor = page.nextCursor } while (cursor && rows.length < cap)
  return rows
}
async function exportFile(ctx, job, rows) {
  const labels = { displayName: 'Name', firstName: 'First name', lastName: 'Last name', name: 'Company Name', companyName: 'Company Name', primaryEmail: 'Email ID', primaryPhoneE164: 'Mobile', budgetMinor: 'Budget', valueMinor: 'Amount', owner: 'Assigned To', source: 'Lead Source', title: 'Title', company: 'Company', stage: 'Stage', pipeline: 'Pipeline', expectedCloseDate: 'Expected close date' }
  const definitions = await prisma.customFieldDefinition.findMany({ where: { organizationId: ctx.orgId, entityType: job.entityType } })
  const headers = job.columns.map((c) => c.startsWith('cf.') ? definitions.find((d) => d.key === c.slice(3))?.label ?? c : labels[c] ?? c)
  const money = (value) => { const n = BigInt(value); const magnitude = n < 0n ? -n : n; return `${n < 0n ? '-' : ''}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}` }
  const cell = (r, c) => {
    if (c.startsWith('cf.')) {
      const key = c.slice(3), value = r.customFields?.[key], definition = definitions.find((d) => d.key === key)
      if (value == null) return ''
      if (definition?.type === 'currency') return money(value)
      if (definition?.type === 'multiselect') return value.join('; ')
      return value
    }
    if (['valueMinor', 'budgetMinor'].includes(c) && r[c] != null) return money(r[c])
    if (c === 'owner') return r.owner?.fullName ?? ''
    if (c === 'source') return r.source?.name ?? r.source ?? ''
    if (c === 'company') return r.company?.name ?? r.companies?.map((x) => x.name).join('; ') ?? r.companyName ?? ''
    if (c === 'contacts') return r.contactCount ?? r.contacts?.map((x) => x.displayName ?? x.contact?.displayName).filter(Boolean).join('; ') ?? ''
    if (c === 'city' && job.entityType === 'company') return r.billingAddress?.city ?? ''
    if (c === 'tags') return r.tags?.map((x) => x.name).join('; ') ?? ''
    if (c === 'stage') return job.entityType === 'contact' ? r.lifecycleStage : r.stage?.name ?? r.stageId ?? ''
    if (c === 'pipeline') return r.pipeline?.name ?? r.pipelineId ?? ''
    return r[c]
  }
  const values = rows.map((r) => job.columns.map((c) => cell(r, c)))
  const bytes = await writeSpreadsheet(headers, values, job.format)
  const file = await storeGeneratedFile(ctx, `${job.entityType}-export-${job.id}.${job.format}`, bytes, 7)
  await prisma.$transaction(async (tx) => {
    await tx.exportJob.update({ where: { id: job.id, organizationId: ctx.orgId }, data: { status: 'completed', fileId: file.id, rowCount: rows.length, finishedAt: new Date() } })
    await recordAudit(tx, ctx, { action: 'data.export', entityType: 'export', entityId: job.id, changes: { rowCount: rows.length, columns: job.columns } })
    await emit(tx, { orgId: ctx.orgId, userId: null }, 'export.completed', { entityType: 'export', entityId: job.id }, { createdById: job.createdById })
  })
  return getFileWithUrl(ctx, file.id)
}
export async function createExport(ctx, input) {
  exportContext(ctx)
  const definitions = await prisma.customFieldDefinition.findMany({ where: { organizationId: ctx.orgId, entityType: input.entityType, archivedAt: null }, select: { key: true } })
  const allowed = new Set([...TRANSFER_COLUMNS[input.entityType], ...definitions.map((d) => `cf.${d.key}`)])
  if (input.columns.some((c) => !allowed.has(c))) throw invalid('Choose valid export columns.')
  const job = await prisma.exportJob.create({ data: { ...input, status: 'preparing', organizationId: ctx.orgId, createdById: ctx.userId } })
  try {
    const rows = await exportRows(ctx, job, 5001)
    if (rows.length <= 5000) return { exportId: job.id, status: 'completed', file: await exportFile(ctx, job, rows) }
    await prisma.exportJob.update({ where: { id: job.id }, data: { status: 'queued' } })
    await enqueue('export.run', { exportId: job.id }, { singletonKey: job.id }).catch(() => {})
    return { exportId: job.id, status: 'queued' }
  } catch (err) { await prisma.exportJob.update({ where: { id: job.id }, data: { status: 'failed', lastError: err instanceof ApiError ? err.message : 'Export failed.' } }); throw err }
}
export async function runExport(id) {
  const job = await prisma.exportJob.findUnique({ where: { id } })
  if (!job || job.status !== 'queued') return
  const claim = await prisma.exportJob.updateMany({ where: { id, status: 'queued' }, data: { status: 'running', startedAt: new Date() } })
  if (!claim.count) return
  try {
    const ctx = await currentContext(job.organizationId, job.createdById)
    const rows = await exportRows(ctx, job)
    if (rows.length > 50000) throw invalid('Narrow the export filters to at most 50,000 rows.')
    await exportFile(ctx, job, rows)
  } catch (err) { await prisma.exportJob.update({ where: { id }, data: { status: 'failed', lastError: err instanceof ApiError ? err.message : 'Export failed.', finishedAt: new Date() } }); throw err }
}
export async function exportStatus(ctx, id) {
  exportContext(ctx)
  const job = await prisma.exportJob.findFirst({ where: { id, organizationId: ctx.orgId, createdById: ctx.userId } })
  if (!job) throw ApiError.notFound('Export not found')
  return { ...job, file: job.status === 'completed' ? await getFileWithUrl(ctx, job.fileId) : null }
}
export async function exportHistory(ctx) { exportContext(ctx); return prisma.exportJob.findMany({ where: { organizationId: ctx.orgId, createdById: ctx.userId }, orderBy: { createdAt: 'desc' }, take: 100 }) }
export async function recoverTransfers() {
  await prisma.exportJob.updateMany({ where: { OR: [{ status: 'preparing', createdAt: { lt: new Date(Date.now() - 5 * 60000) } }, { status: 'running', startedAt: { lt: new Date(Date.now() - 35 * 60000) } }] }, data: { status: 'queued' } })
  const imports = await prisma.importJob.findMany({ where: { status: { in: ['queued', 'running'] } }, select: { id: true }, take: 100 })
  for (const job of imports) await enqueue('import.run', { importId: job.id }, { singletonKey: job.id })
  const stale = await prisma.importJob.findMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * 86400000) }, analysis: { path: ['status'], equals: 'complete' } }, select: { id: true, revision: true, analysis: true }, take: 20 })
  for (const job of stale) if (job.analysis.key && new Date(job.analysis.generatedAt).getTime() < Date.now() - 30 * 86400000) {
    await objectStore.delete(job.analysis.key)
    await prisma.importJob.updateMany({ where: { id: job.id, revision: job.revision }, data: { analysis: {} } })
  }
  const previews = await prisma.importJob.findMany({ where: { status: 'draft', OR: [{ analysis: { path: ['status'], equals: 'pending' } }, { analysis: { path: ['status'], equals: 'running' } }] }, select: { id: true, revision: true }, take: 100 })
  for (const job of previews) await enqueue('import.preview', { importId: job.id, revision: job.revision }, { singletonKey: `${job.id}:${job.revision}` })
  const exports = await prisma.exportJob.findMany({ where: { status: 'queued' }, select: { id: true }, take: 100 })
  for (const job of exports) await enqueue('export.run', { exportId: job.id }, { singletonKey: job.id })
}
