/**
 * Money is stored and computed as BigInt minor units (paise for INR) — never floats.
 * JSON responses carry `valueMinor` as a Number (safe below 9×10^15) plus an ISO currency code.
 */

const MINOR_DIGITS = { INR: 2, USD: 2 }
const digitsFor = (currency) => MINOR_DIGITS[currency] ?? 2

/** Divides two BigInts rounding half to even (banker's rounding). */
export function divideHalfEven(numerator, denominator) {
  if (denominator === 0n) throw new RangeError('Division by zero')
  const negative = numerator < 0n !== denominator < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = denominator < 0n ? -denominator : denominator
  let q = n / d
  const r = n % d
  const twice = r * 2n
  if (twice > d || (twice === d && q % 2n === 1n)) q += 1n
  return negative ? -q : q
}

/**
 * Parses a major-unit amount into minor units. Accepts numbers or strings with currency symbols
 * and Indian/Western digit grouping: "₹1,85,000.50" → 18500050n. Extra decimals round half-even.
 */
export function toMinor(major, currency = 'INR') {
  const digits = digitsFor(currency)
  const text = typeof major === 'number' ? major.toFixed(Math.max(digits, 6)) : String(major)
  const cleaned = text.replace(/[₹$,\s]|Rs\.?|INR|USD/gi, '')
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(cleaned)
  if (!m || (!m[2] && !m[3])) throw new RangeError(`Not a valid amount: ${major}`)
  const [, sign, whole = '', fraction = ''] = m
  const scale = 10n ** BigInt(fraction.length)
  const exact = BigInt(whole || '0') * scale + BigInt(fraction || '0')
  const minor = divideHalfEven(exact * 10n ** BigInt(digits), scale)
  return sign ? -minor : minor
}

/** Minor units → plain decimal string in major units: 18500050n → "185000.50". */
export function fromMinor(minor, currency = 'INR') {
  const digits = digitsFor(currency)
  const value = BigInt(minor)
  const negative = value < 0n
  const abs = negative ? -value : value
  const scale = 10n ** BigInt(digits)
  const fraction = String(abs % scale).padStart(digits, '0')
  return `${negative ? '-' : ''}${abs / scale}${digits ? `.${fraction}` : ''}`
}

/** Display format: 18500050n → "₹1,85,000.50" (en-IN grouping for INR). */
export function formatMoney(minor, currency = 'INR', locale = currency === 'INR' ? 'en-IN' : 'en-US') {
  const digits = digitsFor(currency)
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(
    fromMinor(minor, currency),
  )
}

export function addMinor(...values) {
  return values.reduce((sum, v) => sum + BigInt(v), 0n)
}

/** `basisPoints` of `minor` (1800 bp = 18 %), rounded half-even. */
export function percentOf(minor, basisPoints) {
  return divideHalfEven(BigInt(minor) * BigInt(basisPoints), 10_000n)
}

/** BigInt → Number for JSON. Throws instead of silently losing precision. */
export function minorToJson(minor) {
  const n = Number(minor)
  if (!Number.isSafeInteger(n)) throw new RangeError('Amount exceeds safe integer range')
  return n
}
