import { Router } from 'express'
import { z } from 'zod'
import * as crm from '../controllers/crm.controller.js'
import { permit, requireOrg } from '../middlewares/org.js'
import { validate } from '../middlewares/validate.js'
import {
  allowDuplicateQuery,
  bulkSchema,
  checkDuplicatesSchema,
  companyListQuery,
  contactListQuery,
  createCompanySchema,
  createContactSchema,
  createCustomFieldSchema,
  customFieldListQuery,
  idParams,
  mergeSchema,
  reorderCustomFieldsSchema,
  tagSchema,
  updateCompanySchema,
  updateContactSchema,
  updateCustomFieldSchema,
  updateTagSchema,
} from '../validators/crm.validators.js'

/**
 * Contacts (/api/contacts), companies (/api/companies), tags (/api/tags) and custom fields
 * (/api/custom-fields) — M07. Record-level visibility (own/team/all) is enforced in the services;
 * `permit` here only rejects roles that can't do the action at all.
 */

/** `?allowDuplicate=true` → req.validated.allow (the query is otherwise unused on writes). */
export function allow(req, _res, next) {
  const parsed = allowDuplicateQuery.safeParse(req.query ?? {})
  req.validated = { ...req.validated, allow: parsed.success ? parsed.data : {} }
  next()
}

const companyDuplicatesSchema = z.object({
  name: z.string().trim().max(160).optional(),
  domain: z.string().trim().max(160).optional(),
  gstin: z.string().trim().toUpperCase().max(15).optional(),
  excludeId: z.uuid().optional(),
})

export const contactRoutes = Router()
contactRoutes.use(requireOrg)
contactRoutes.get('/', permit('contacts.read'), validate(contactListQuery, 'query'), crm.listContacts)
contactRoutes.post('/', permit('contacts.create'), allow, validate(createContactSchema), crm.createContact)
contactRoutes.post('/check-duplicates', permit('contacts.read'), validate(checkDuplicatesSchema), crm.checkContactDuplicates)
contactRoutes.post('/merge', permit('contacts.update'), validate(mergeSchema), crm.mergeContacts)
contactRoutes.post('/bulk', permit('contacts.update'), validate(bulkSchema), crm.bulkContacts)
contactRoutes.get('/:id', permit('contacts.read'), validate(idParams, 'params'), crm.getContact)
contactRoutes.patch('/:id', permit('contacts.update'), allow, validate(idParams, 'params'), validate(updateContactSchema), crm.updateContact)
contactRoutes.delete('/:id', permit('contacts.delete'), validate(idParams, 'params'), crm.deleteContact)
contactRoutes.post('/:id/restore', permit('contacts.delete'), validate(idParams, 'params'), crm.restoreContact)

export const companyRoutes = Router()
companyRoutes.use(requireOrg)
companyRoutes.get('/', permit('companies.read'), validate(companyListQuery, 'query'), crm.listCompanies)
companyRoutes.post('/', permit('companies.create'), allow, validate(createCompanySchema), crm.createCompany)
companyRoutes.post('/check-duplicates', permit('companies.read'), validate(companyDuplicatesSchema), crm.checkCompanyDuplicates)
companyRoutes.post('/merge', permit('companies.update'), validate(mergeSchema), crm.mergeCompanies)
companyRoutes.post('/bulk', permit('companies.update'), validate(bulkSchema), crm.bulkCompanies)
companyRoutes.get('/:id', permit('companies.read'), validate(idParams, 'params'), crm.getCompany)
companyRoutes.get('/:id/contacts', permit('companies.read'), validate(idParams, 'params'), crm.listCompanyContacts)
companyRoutes.patch('/:id', permit('companies.update'), allow, validate(idParams, 'params'), validate(updateCompanySchema), crm.updateCompany)
companyRoutes.delete('/:id', permit('companies.delete'), validate(idParams, 'params'), crm.deleteCompany)
companyRoutes.post('/:id/restore', permit('companies.delete'), validate(idParams, 'params'), crm.restoreCompany)

/** Anyone in the workspace can see tags; creating needs create rights on records; editing is for admins. */
export const tagRoutes = Router()
tagRoutes.use(requireOrg)
tagRoutes.get('/', crm.listTags)
tagRoutes.post('/', permit('contacts.create'), validate(tagSchema), crm.createTag)
tagRoutes.patch('/:id', permit('settings.workspace.manage'), validate(idParams, 'params'), validate(updateTagSchema), crm.updateTag)
tagRoutes.delete('/:id', permit('settings.workspace.manage'), validate(idParams, 'params'), crm.deleteTag)

export const customFieldRoutes = Router()
customFieldRoutes.use(requireOrg)
customFieldRoutes.get('/', validate(customFieldListQuery, 'query'), crm.listCustomFields)
customFieldRoutes.post('/', permit('settings.customFields.manage'), validate(createCustomFieldSchema), crm.createCustomField)
customFieldRoutes.patch('/order', permit('settings.customFields.manage'), validate(reorderCustomFieldsSchema), crm.reorderCustomFields)
customFieldRoutes.patch('/:id', permit('settings.customFields.manage'), validate(idParams, 'params'), validate(updateCustomFieldSchema), crm.updateCustomField)
customFieldRoutes.delete('/:id', permit('settings.customFields.manage'), validate(idParams, 'params'), crm.deleteCustomField)
