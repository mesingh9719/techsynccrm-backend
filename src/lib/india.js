/**
 * India-specific reference data: GST state codes and GSTIN validation.
 * The same list lives in frontend/src/lib/india.ts — keep them in sync.
 */

/** GST state/UT codes (first two digits of a GSTIN), in code order. */
export const GST_STATE_LIST = [
  ['01', 'Jammu and Kashmir'],
  ['02', 'Himachal Pradesh'],
  ['03', 'Punjab'],
  ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'],
  ['06', 'Haryana'],
  ['07', 'Delhi'],
  ['08', 'Rajasthan'],
  ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'],
  ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'],
  ['13', 'Nagaland'],
  ['14', 'Manipur'],
  ['15', 'Mizoram'],
  ['16', 'Tripura'],
  ['17', 'Meghalaya'],
  ['18', 'Assam'],
  ['19', 'West Bengal'],
  ['20', 'Jharkhand'],
  ['21', 'Odisha'],
  ['22', 'Chhattisgarh'],
  ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['27', 'Maharashtra'],
  ['29', 'Karnataka'],
  ['30', 'Goa'],
  ['31', 'Lakshadweep'],
  ['32', 'Kerala'],
  ['33', 'Tamil Nadu'],
  ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'],
  ['37', 'Andhra Pradesh'],
  ['38', 'Ladakh'],
  ['97', 'Other Territory'],
]

/** code → name */
export const GST_STATES = Object.fromEntries(GST_STATE_LIST)

export const GST_STATE_CODES = GST_STATE_LIST.map(([code]) => code)

/** 15 chars: 2-digit state, 10-char PAN, entity number, "Z", checksum. */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

const CHECKSUM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Verifies the GSTIN's last character (mod-36 checksum used by the GST network). */
export function hasValidGstinChecksum(gstin) {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const value = CHECKSUM_CHARS.indexOf(gstin[i])
    const product = value * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  }
  return CHECKSUM_CHARS[(36 - (sum % 36)) % 36] === gstin[14]
}

/**
 * Field errors for a GSTIN against the chosen state, or null if fine.
 * @returns {Record<string, string> | null}
 */
export function gstinErrors(gstin, stateCode) {
  if (!gstin) return null
  if (!GSTIN_PATTERN.test(gstin) || !hasValidGstinChecksum(gstin)) return { gstin: 'Enter a valid 15-character GSTIN' }
  if (!stateCode) return { stateCode: 'Choose the state your GSTIN is registered in' }
  if (gstin.slice(0, 2) !== stateCode) {
    return { gstin: `This GSTIN is registered in ${GST_STATES[gstin.slice(0, 2)] ?? 'another state'}, not ${GST_STATES[stateCode] ?? 'the selected state'}` }
  }
  return null
}
