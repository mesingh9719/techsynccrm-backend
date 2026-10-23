const sensitive = /^(?:authorization|cookie|set-cookie|state|code|codeVerifier|verifierEnc|nonce|.*token.*|.*secret.*|wrappedKey|credentialEnc)$/i
/** Scrub structured fields at every nesting depth before Pino serializers/redaction. */
export function redactEmailSecrets(value, depth = 0) {
  if (depth > 12) return '[redacted]'
  if (value instanceof Error) {
    const clean = (text) => String(text).replace(/(Bearer\s+)[\w.~+\/-]+=*/gi, '$1[redacted]').replace(/([?&](?:code|state|access_token|refresh_token)=)[^&\s]+/gi, '$1[redacted]')
    // SDK errors often carry request/response objects containing credentials.
    return { type: value.name, message: clean(value.message), stack: clean(value.stack || '') }
  }
  if (!value || typeof value !== 'object' || value instanceof Date) return value
  if (Array.isArray(value)) return value.map((item) => redactEmailSecrets(item, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sensitive.test(key) ? '[redacted]' : redactEmailSecrets(entry, depth + 1)]))
}
