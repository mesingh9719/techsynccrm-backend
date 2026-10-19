import * as companies from '../services/company.service.js'
import * as contacts from '../services/contact.service.js'
import * as customFields from '../services/customField.service.js'
import * as tags from '../services/tag.service.js'

/** Contacts, companies, tags and custom fields (M07). Thin: parse request, call service, send envelope. */

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data })

/** If-Match header, or `expectedUpdatedAt` in the body for clients that can't set headers. */
export function concurrency(req) {
  const { expectedUpdatedAt, ...body } = req.body ?? {}
  return { body, expectedUpdatedAt: req.get('if-match') || expectedUpdatedAt || null }
}

export const allowDuplicate = (req) => Boolean(req.validated?.allow?.allowDuplicate)

// ---------- Contacts ----------

export async function listContacts(req, res) {
  ok(res, await contacts.listContacts(req.ctx, req.validated.query))
}

export async function getContact(req, res) {
  ok(res, { contact: await contacts.getContact(req.ctx, req.validated.params.id) })
}

export async function createContact(req, res) {
  ok(res, { contact: await contacts.createContact(req.ctx, req.body, { allowDuplicate: allowDuplicate(req) }) }, 201)
}

export async function updateContact(req, res) {
  const { body, expectedUpdatedAt } = concurrency(req)
  ok(res, { contact: await contacts.updateContact(req.ctx, req.validated.params.id, body, { expectedUpdatedAt, allowDuplicate: allowDuplicate(req) }) })
}

export async function deleteContact(req, res) {
  await contacts.deleteContact(req.ctx, req.validated.params.id)
  res.status(204).end()
}

export async function restoreContact(req, res) {
  ok(res, { contact: await contacts.restoreContact(req.ctx, req.validated.params.id) })
}

export async function checkContactDuplicates(req, res) {
  ok(res, { duplicates: await contacts.checkDuplicates(req.ctx, req.body) })
}

export async function mergeContacts(req, res) {
  ok(res, { contact: await contacts.mergeContacts(req.ctx, req.body) })
}

export async function bulkContacts(req, res) {
  ok(res, await contacts.bulkContacts(req.ctx, req.body))
}

// ---------- Companies ----------

export async function listCompanies(req, res) {
  ok(res, await companies.listCompanies(req.ctx, req.validated.query))
}

export async function getCompany(req, res) {
  ok(res, { company: await companies.getCompany(req.ctx, req.validated.params.id) })
}

export async function listCompanyContacts(req, res) {
  ok(res, { contacts: await companies.listCompanyContacts(req.ctx, req.validated.params.id) })
}

export async function createCompany(req, res) {
  ok(res, { company: await companies.createCompany(req.ctx, req.body, { allowDuplicate: allowDuplicate(req) }) }, 201)
}

export async function updateCompany(req, res) {
  const { body, expectedUpdatedAt } = concurrency(req)
  ok(res, { company: await companies.updateCompany(req.ctx, req.validated.params.id, body, { expectedUpdatedAt, allowDuplicate: allowDuplicate(req) }) })
}

export async function deleteCompany(req, res) {
  await companies.deleteCompany(req.ctx, req.validated.params.id)
  res.status(204).end()
}

export async function restoreCompany(req, res) {
  ok(res, { company: await companies.restoreCompany(req.ctx, req.validated.params.id) })
}

export async function checkCompanyDuplicates(req, res) {
  const { name, domain, gstin, excludeId } = req.body
  ok(res, { duplicates: await companies.findCompanyDuplicates(req.ctx, { name, domain, gstin }, excludeId ?? null) })
}

export async function mergeCompanies(req, res) {
  ok(res, { company: await companies.mergeCompanies(req.ctx, req.body) })
}

export async function bulkCompanies(req, res) {
  ok(res, await companies.bulkCompanies(req.ctx, req.body))
}

// ---------- Tags ----------

export async function listTags(req, res) {
  ok(res, { tags: await tags.listTags(req.ctx) })
}

export async function createTag(req, res) {
  ok(res, { tag: await tags.createTag(req.ctx, req.body) }, 201)
}

export async function updateTag(req, res) {
  ok(res, { tag: await tags.updateTag(req.ctx, req.validated.params.id, req.body) })
}

export async function deleteTag(req, res) {
  await tags.deleteTag(req.ctx, req.validated.params.id)
  res.status(204).end()
}

// ---------- Custom fields ----------

export async function listCustomFields(req, res) {
  ok(res, { fields: await customFields.listDefinitions(req.ctx, req.validated.query.entityType) })
}

export async function createCustomField(req, res) {
  ok(res, { field: await customFields.createDefinition(req.ctx, req.body) }, 201)
}

export async function updateCustomField(req, res) {
  ok(res, { field: await customFields.updateDefinition(req.ctx, req.validated.params.id, req.body) })
}

export async function deleteCustomField(req, res) {
  await customFields.deleteDefinition(req.ctx, req.validated.params.id)
  res.status(204).end()
}

export async function reorderCustomFields(req, res) {
  ok(res, { fields: await customFields.reorderDefinitions(req.ctx, req.body.entityType, req.body.ids) })
}
