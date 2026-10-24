import { z } from 'zod'
import { CHOICE_TYPES, STATIC_TYPES, cleanText } from '../validators/webForm.validators.js'

/**
 * Public web form submissions → lead input (pure, no I/O). `fields` is a normalised form config
 * (validators/webForm.validators.js). Answers are checked against the field types (messages match
 * the frontend renderer), then each one is saved where the form owner chose: a lead column, a lead
 * custom field (`cf.*`), or — for extra questions (`q_*`) — a "Label: answer" line in the requirement.
 */

const PHONE = /^[+()\d\s.-]{6,30}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const isEmail = (v) => z.email().safeParse(v).success
const truthy = (v) => v === true || v === 'true' || v === 'on' || v === 'yes'

function readAnswer(field, raw) {
  if (field.type === 'checkbox') return { value: truthy(raw) }
  if (field.type === 'checkboxes') {
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((v) => cleanText(v))
    const allowed = new Set(field.options.map((o) => o.value))
    if (list.some((v) => !allowed.has(v))) return { error: 'Choose from the listed options.' }
    return { value: [...new Set(list)] }
  }
  const value = cleanText(typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '').slice(0, field.type === 'textarea' ? 2000 : 1000)
  if (!value) return { value: '' }
  if (CHOICE_TYPES.includes(field.type) && !field.options.some((o) => o.value === value)) return { error: 'Choose from the listed options.' }
  if (field.type === 'email' && !isEmail(value)) return { error: 'Enter a valid email address.' }
  if (field.type === 'tel' && !PHONE.test(value)) return { error: 'Enter a valid phone number.' }
  if (field.type === 'number' && !Number.isFinite(Number(value))) return { error: 'Enter a valid number.' }
  if (field.type === 'currency' && !(Number.isFinite(Number(value)) && Number(value) >= 0)) return { error: 'Enter a valid amount.' }
  if (field.type === 'date' && (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value)))) return { error: 'Enter a valid date.' }
  return { value: field.type === 'email' ? value.toLowerCase() : value }
}

/** Visitors type amounts in rupees; leads and currency custom fields store paise. */
const toMinor = (value) => Math.max(0, Math.round(Number(value) * 100))
const isEmpty = (field, value) => (field.type === 'checkbox' ? value !== true : Array.isArray(value) ? !value.length : value === '')

/** Human-readable answer for notes: option labels instead of values, Yes/No for tick boxes. */
function display(field, value) {
  if (field.type === 'checkbox') return value ? 'Yes' : 'No'
  const label = (v) => field.options.find((o) => o.value === v)?.label ?? v
  return Array.isArray(value) ? value.map(label).join(', ') : CHOICE_TYPES.includes(field.type) ? label(value) : value
}

/** @returns {{ ok: false, errors: Record<string, string> } | { ok: true, lead: object, customFields: object, answers: object }} */
export function mapSubmission(fields, input = {}) {
  const errors = {},
    answers = {}
  for (const field of fields) {
    if (STATIC_TYPES.includes(field.type)) continue
    const raw = field.type === 'hidden' ? (input[field.key] ?? field.defaultValue) : input[field.key]
    const { value, error } = readAnswer(field, raw)
    if (error) errors[field.key] = error
    else if (field.required && isEmpty(field, value)) errors[field.key] = `${field.label} is required.`
    else answers[field.key] = value
  }
  if (Object.keys(errors).length) return { ok: false, errors }

  const lead = {},
    customFields = {},
    notes = []
  for (const field of fields) {
    const value = answers[field.key]
    if (value === undefined || isEmpty(field, value)) continue
    if (field.key === 'email') lead.emails = [{ value, primary: true }]
    else if (field.key === 'phone') lead.phones = [{ raw: value, primary: true }]
    else if (field.key === 'budgetMinor') lead.budgetMinor = toMinor(value)
    else if (field.key.startsWith('cf.')) customFields[field.key.slice(3)] = field.type === 'currency' ? toMinor(value) : field.type === 'number' ? Number(value) : value
    else if (field.key.startsWith('q_')) notes.push(`${field.label}: ${display(field, value)}`)
    else lead[field.key] = typeof value === 'string' ? value : display(field, value)
  }
  const requirement = [lead.requirement, ...notes].filter(Boolean).join('\n')
  if (requirement) lead.requirement = requirement.slice(0, 2000)
  return { ok: true, lead, customFields, answers }
}
