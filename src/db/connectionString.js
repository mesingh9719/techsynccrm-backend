/**
 * Neon connection strings use `sslmode=require`. node-postgres currently treats that as
 * full certificate verification but will switch to weaker libpq semantics in its next major.
 * Pin `verify-full` explicitly (Neon serves valid certificates) to keep strict TLS.
 */
export function withStrictSsl(connectionString) {
  const url = new URL(connectionString)
  if (!url.searchParams.has('uselibpqcompat')) url.searchParams.set('sslmode', 'verify-full')
  return url.toString()
}
