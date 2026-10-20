import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import pg from 'pg'
import { withStrictSsl } from '../src/db/connectionString.js'

/** Read-only deployment check: migrate status alone cannot detect edited migrations or missing columns. */
const source = await fs.readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8')
const primitives = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes'])
const enums = new Set([...source.matchAll(/^enum (\w+) \{/gm)].map((m) => m[1]))
const expected = []
for (const model of source.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
  const table = model[2].match(/@@map\("([^"]+)"\)/)?.[1] ?? model[1]
  for (const line of model[2].split('\n')) {
    const field = line.match(/^\s*(\w+)\s+(\w+)(\?|\[\])?(?:\s+(.*))?$/)
    if (!field || !primitives.has(field[2]) && !enums.has(field[2])) continue
    const column = field[4]?.match(/@map\("([^"]+)"\)/)?.[1] ?? field[1]
    expected.push({ table, column, nullable: field[3] === '?' })
  }
}
const direct = process.env.DATABASE_URL_UNPOOLED
if (!direct) throw new Error('DATABASE_URL_UNPOOLED is required for schema verification')
const client = new pg.Client({ connectionString: withStrictSsl(direct), connectionTimeoutMillis: 10000 })
try {
  await client.connect()
  const identity = (await client.query('SELECT current_database() AS database, current_schema() AS schema')).rows[0]
  const columns = (await client.query('SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = current_schema()')).rows
  const found = new Map(columns.map((c) => [`${c.table_name}.${c.column_name}`, c]))
  if (process.argv.includes('--preflight')) {
    const uploader = columns.some((c) => c.table_name === 'files' && c.column_name === 'uploaded_by_id') ? 'uploaded_by_id' : 'user_id'
    const orphanFiles = Number((await client.query(`SELECT count(*) AS count FROM files f WHERE f.organization_id IS NULL AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = f.${uploader} AND m.status = 'active')`)).rows[0].count)
    const duplicateOwners = Number((await client.query("SELECT count(*) AS count FROM (SELECT organization_id FROM memberships WHERE role = 'owner' AND status = 'active' GROUP BY organization_id HAVING count(*) > 1) d")).rows[0].count)
    console.log(JSON.stringify({ ...identity, unassignableLegacyFiles: orphanFiles, workspacesWithMultipleOwners: duplicateOwners }, null, 2))
    if (orphanFiles || duplicateOwners) process.exitCode = 1
  }

  const problems = []
  for (const e of expected) {
    const c = found.get(`${e.table}.${e.column}`)
    if (!c) problems.push(`Missing column ${e.table}.${e.column}`)
    else if ((c.is_nullable === 'YES') !== e.nullable) problems.push(`Nullability differs: ${e.table}.${e.column}`)
  }
  const applied = (await client.query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations')).rows
  const migrationRoot = new URL('../prisma/migrations/', import.meta.url)
  const local = (await fs.readdir(migrationRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  for (const name of local) {
    const rows = applied.filter((r) => r.migration_name === name && !r.rolled_back_at)
    const latest = rows.find((r) => r.finished_at)
    if (!latest) { problems.push(`Migration not applied: ${name}`); continue }
    const hash = crypto.createHash('sha256').update(await fs.readFile(new URL(`${name}/migration.sql`, migrationRoot))).digest('hex')
    if (hash !== latest.checksum) problems.push(`Applied migration was edited: ${name}`)
    if (rows.some((r) => !r.finished_at)) problems.push(`Unresolved failed migration: ${name}`)
  }
  for (const r of applied.filter((r) => r.finished_at && !r.rolled_back_at && !local.includes(r.migration_name))) problems.push(`Applied migration missing locally: ${r.migration_name}`)
  console.log(JSON.stringify({ ...identity, expectedColumns: expected.length, migrations: local.length, problems }, null, 2))
  if (problems.length) process.exitCode = 1
} finally { await client.end() }
