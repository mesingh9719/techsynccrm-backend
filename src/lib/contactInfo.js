/**
 * Phone numbers and emails of leads, contacts and companies are only shown to roles with
 * `<resource>.contactInfo` ("See phone numbers and emails"). Without it they're stripped from
 * every response of that module and from exports; a name that is only a phone or email is
 * replaced too. Redacted objects carry `contactInfoHidden: true` so the app can say so.
 */

export const HIDDEN_NAME = 'Name hidden'

export function canSeeContactInfo(ctx, resource) {
  return ctx?.actorType === 'system' || Boolean(ctx?.permissions?.includes(`${resource}.contactInfo`))
}

const PERSON_KEYS = ['emails', 'phones', 'primaryEmail', 'primaryPhoneE164']
// Companies keep a single phone and email; `email` alone also appears on member objects, so only
// objects with a company phone field are treated as companies.
const COMPANY_KEYS = ['phoneE164', 'phoneRaw', 'phone', 'email']

function redactObject(obj) {
  const isPerson = PERSON_KEYS.some((k) => k in obj)
  const isCompany = 'phoneE164' in obj
  if (!isPerson && !isCompany) return false
  const secrets = new Set()
  for (const e of obj.emails ?? []) if (e?.value) secrets.add(String(e.value))
  for (const p of obj.phones ?? []) for (const v of [p?.raw, p?.e164]) if (v) secrets.add(String(v))
  for (const k of ['primaryEmail', 'primaryPhoneE164', ...(isCompany ? COMPANY_KEYS : [])]) if (obj[k]) secrets.add(String(obj[k]))
  if (isPerson) {
    if ('emails' in obj) obj.emails = []
    if ('phones' in obj) obj.phones = []
    if ('primaryEmail' in obj) obj.primaryEmail = null
    if ('primaryPhoneE164' in obj) obj.primaryPhoneE164 = null
  }
  if (isCompany) for (const k of COMPANY_KEYS) if (k in obj) obj[k] = null
  if (typeof obj.displayName === 'string' && (secrets.has(obj.displayName) || /@|^\+?[\d\s()-]{6,}$/.test(obj.displayName))) obj.displayName = HIDDEN_NAME
  obj.contactInfoHidden = true
  return true
}

/** Strips contact details from every lead/contact/company-shaped object in `value` (in place). */
export function redactContactInfo(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) redactContactInfo(item, seen)
    return value
  }
  redactObject(value)
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (child && typeof child === 'object' && !(child instanceof Date)) redactContactInfo(child, seen)
  }
  return value
}

/**
 * Router middleware: redacts JSON responses unless the member may see `resource` contact details.
 * Use after requireOrg: `leadRoutes.use(requireOrg, hideContactInfo('leads'))`.
 */
export function hideContactInfo(resource) {
  return (req, res, next) => {
    if (canSeeContactInfo(req.ctx, resource)) return next()
    // Edits can't change what the member can't see (the form would send them back empty).
    if (req.method === 'PATCH' && req.body && typeof req.body === 'object') {
      for (const key of [...PERSON_KEYS, ...COMPANY_KEYS]) delete req.body[key]
    }
    const json = res.json.bind(res)
    res.json = (body) => json(body && body.success !== false ? redactContactInfo(structuredClone(body)) : body)
    next()
  }
}
