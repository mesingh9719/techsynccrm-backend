import fs from 'node:fs'

/**
 * Supabase Postgres serves certificates signed by Supabase's own root CA, which is not in
 * Node's trust store. Download it from Project Settings → Database → SSL Configuration and
 * set DATABASE_SSL_CA to the PEM text or a path to the .crt file so TLS stays fully verified.
 *
 * Returns node-postgres options; spread them into Pool/Client/PgBoss/PrismaPg configs.
 * `sslmode` is dropped from the URL because node-postgres lets it override the `ssl` object.
 */
export function pgConnection(connectionString, ca = process.env.DATABASE_SSL_CA) {
  const url = new URL(connectionString)
  if (!ca) {
    // No CA configured (e.g. local Postgres): keep the URL's own TLS settings.
    return { connectionString: url.toString() }
  }
  url.searchParams.delete('sslmode')
  url.searchParams.delete('uselibpqcompat')
  // Hosting dashboards often store multi-line env values with literal "\n" escapes.
  const pem = ca.includes('-----BEGIN') ? ca.replaceAll('\\n', '\n') : fs.readFileSync(ca, 'utf8')
  return { connectionString: url.toString(), ssl: { ca: pem, rejectUnauthorized: true } }
}
