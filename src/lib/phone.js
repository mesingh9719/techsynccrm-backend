import { parsePhoneNumberFromString } from 'libphonenumber-js/min'
import { isValidPhoneNumber as isValidMobileNumber } from 'libphonenumber-js/mobile'

/**
 * Normalises a phone number as typed ("098765 43210", "+91-98765-43210", "9876543210") to E.164
 * (+919876543210) for storage and de-duplication. The raw input is always kept.
 *
 * @param {string | null | undefined} raw
 * @param {string} [defaultCountry] ISO 3166 alpha-2, used when the number has no country code
 * @returns {{ e164: string | null, raw: string | null, valid: boolean }}
 */
export function normalizePhone(raw, defaultCountry = 'IN') {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return { e164: null, raw: null, valid: false }
  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry)
  if (!parsed || !parsed.isValid()) return { e164: null, raw: trimmed, valid: false }
  return { e164: parsed.number, raw: trimmed, valid: true }
}

/**
 * True when the number is a valid mobile (WhatsApp-capable) number; landlines are rejected.
 *
 * @param {string} raw
 * @param {string} [defaultCountry] ISO 3166 alpha-2, used when the number has no country code
 */
export function isMobilePhone(raw, defaultCountry = 'IN') {
  return isValidMobileNumber(raw.trim(), defaultCountry)
}
