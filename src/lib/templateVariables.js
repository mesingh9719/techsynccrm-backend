import { z } from 'zod'

export const normalizeVariableKey = (value) => String(value).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
const reserved = new Set(['firstname', 'lastname', 'first_name', 'last_name', 'name', 'company', 'owner', 'workspace', 'user', 'lead', 'contact', 'record', 'constructor', 'prototype', '__proto__'])
const scalar = z.union([z.string().max(10000), z.number().finite(), z.boolean()])
export const variableDefinition = z.object({
  key: z.string().max(100).transform(normalizeVariableKey).refine((v) => /^[a-z][a-z0-9_]{0,59}$/.test(v) && !reserved.has(v), 'Use a unique key starting with a letter, without a reserved CRM name.'),
  label: z.string().trim().min(1).max(100), type: z.enum(['text', 'textarea', 'number', 'date', 'url', 'email', 'checkbox']).default('text'),
  required: z.boolean().default(true), defaultValue: scalar.optional(), helpText: z.string().trim().max(300).default(''), placeholder: z.string().max(160).default(''),
  position: z.number().int().min(0).max(999).default(0),
  rules: z.object({ min: z.number().finite().optional(), max: z.number().finite().optional(), minLength: z.number().int().min(0).max(10000).optional(), maxLength: z.number().int().min(1).max(10000).optional() }).strict().default({}),
}).strict()
export const variableDefinitions = z.array(variableDefinition).max(30).superRefine((defs, ctx) => {
  const keys = new Set()
  defs.forEach((def, i) => {
    const issue = (message) => ctx.addIssue({ code: 'custom', path: [i], message })
    if (keys.has(def.key)) issue(`Duplicate variable key: ${def.key}`)
    keys.add(def.key)
    if (def.rules.min !== undefined && def.rules.max !== undefined && def.rules.min > def.rules.max) issue('Minimum must not exceed maximum.')
    if (def.rules.minLength !== undefined && def.rules.maxLength !== undefined && def.rules.minLength > def.rules.maxLength) issue('Minimum length must not exceed maximum length.')
    if (Object.keys(def.rules).some((rule) => ['min', 'max'].includes(rule) ? def.type !== 'number' : !['text', 'textarea'].includes(def.type))) issue('These validation rules do not apply to this variable type.')
    if (!emptyValue(def.defaultValue)) { const result = variableValue(def, def.defaultValue); if (result.error) issue(`Default value: ${result.error}`) }
  })
})
export const emptyValue = (value) => value === undefined || value === null || typeof value === 'string' && !value.trim()

/** Flat, allowlisted keys only. No object-path traversal, evaluation, or recursive substitution. */
export function references(text) {
  const keys = new Set(), errors = []
  const remainder = String(text).replace(/\{\{([^{}]*)\}\}/g, (_token, raw) => {
    const key = raw.trim()
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(key)) errors.push('Check your personalization fields. Use {{lead.first_name}} or a variable from the picker.')
    else keys.add(key)
    return ''
  })
  if (/\{\{|\}\}/.test(remainder)) errors.push('Check your personalization fields: a placeholder is incomplete.')
  return { keys: [...keys], errors }
}

export function variableValue(def, raw) {
  if (emptyValue(raw)) return { value: '', error: def.required ? `${def.label} is required.` : null }
  let value = raw
  const error = (message) => ({ value: '', error: message })
  if (typeof raw === 'object' || String(raw).length > 10000 || /\{\{|\}\}|\0/.test(String(raw))) return error('Use a plain value without template placeholders (maximum 10,000 characters).')
  const text = String(raw).trim(), rules = def.rules || {}
  switch (def.type) {
    case 'number':
      if (typeof raw === 'boolean' || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text) || !Number.isFinite(Number(raw))) return error('Enter a valid number.')
      value = Number(raw)
      if (rules.min !== undefined && value < rules.min) return error(`Enter at least ${rules.min}.`)
      if (rules.max !== undefined && value > rules.max) return error(`Enter no more than ${rules.max}.`)
      break
    case 'checkbox':
      if (![true, false, 'true', 'false'].includes(raw)) return error('Choose Yes or No.')
      value = raw === true || raw === 'true' ? 'Yes' : 'No'; break
    case 'date': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) return error('Enter a valid date (YYYY-MM-DD).')
      value = text; break
    }
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) || text.length > 254) return error('Enter a valid email address.')
      value = text; break
    case 'url':
      try { const url = new URL(text); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return error('Use an http:// or https:// link without credentials.') } catch { return error('Enter a valid http:// or https:// link.') }
      value = text; break
    default:
      if (typeof raw !== 'string') return error('Enter text.')
      if (rules.minLength !== undefined && text.length < rules.minLength) return error(`Use at least ${rules.minLength} characters.`)
      if (text.length > (rules.maxLength ?? 10000)) return error(`Use no more than ${rules.maxLength ?? 10000} characters.`)
      value = def.type === 'textarea' ? raw : text
  }
  return { value: String(value), error: null }
}

const entityFields = { first_name: 'First name', last_name: 'Last name', name: 'Full name', email: 'Email', phone: 'Phone' }
export function systemVariables(recordType = 'any') {
  const fields = Object.entries({ firstName: 'First name', lastName: 'Last name', name: 'Full name', company: 'Company', owner: 'Your name', workspace: 'Workspace', 'user.name': 'Your name', 'user.email': 'Your email', 'workspace.name': 'Workspace name' }).map(([key, label]) => ({ key, label, source: 'system', type: key === 'user.email' ? 'email' : 'text', required: true }))
  for (const entity of ['lead', 'contact']) if (recordType === 'any' || recordType === entity) {
    const available = { ...entityFields, ...(entity === 'lead' ? { company: 'Company', city: 'City', requirement: 'Requirement' } : { title: 'Job title' }) }
    for (const [key, label] of Object.entries(available)) fields.push({ key: `${entity}.${key}`, label: `${entity === 'lead' ? 'Lead' : 'Contact'} · ${label}`, source: 'system', type: key === 'email' ? 'email' : 'text', required: true })
  }
  if (recordType !== 'lead') for (const key of ['name', 'domain', 'website', 'industry']) fields.push({ key: `company.${key}`, label: `Primary company · ${key}`, source: 'system', type: key === 'website' ? 'url' : 'text', required: true })
  return fields
}

export function renderVariables(subject, html, catalogue, context, supplied = {}) {
  const errors = {}, fields = [], rendered = Object.create(null), byKey = new Map(catalogue.map((d) => [d.key, d]))
  const subjectRefs = references(subject), bodyRefs = references(html)
  const syntax = [...subjectRefs.errors, ...bodyRefs.errors]
  if (syntax.length) errors.template = syntax[0]
  for (const key of new Set([...subjectRefs.keys, ...bodyRefs.keys])) {
    const def = byKey.get(key)
    if (!def) { errors[key] = `Unknown field {{${key}}}. Choose a field supported by this recipient and template context.`; rendered[key] = ''; continue }
    const resolved = Object.hasOwn(context, key) && !emptyValue(context[key])
    const raw = resolved ? context[key] : Object.hasOwn(supplied, key) ? supplied[key] : def.defaultValue
    const result = variableValue(def, raw)
    if (subjectRefs.keys.includes(key) && /[\r\n]/.test(result.value)) result.error = 'Subject values must fit on one line.'
    if (result.error) errors[key] = result.error
    rendered[key] = result.error ? '' : result.value
    if (def.source === 'template' || !resolved) fields.push({ ...def, value: emptyValue(raw) ? '' : raw, error: result.error || null })
  }
  const escape = (value) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const substitute = (text, htmlMode) => text.replace(/\{\{([^{}]*)\}\}/g, (_token, key) => htmlMode ? escape(rendered[key.trim()] || '') : rendered[key.trim()] || '')
  return { subject: substitute(subject, false), bodyHtml: substitute(html, true), fields: fields.sort((a, b) => (a.position || 0) - (b.position || 0)), errors, valid: Object.keys(errors).length === 0 }
}
