import fs from 'node:fs/promises'
import pg from 'pg'
import crypto from 'node:crypto'

const url = new URL(process.env.PERF_DATABASE_URL || 'postgresql://invalid/invalid')
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/techsync_perf') throw new Error('Disposable local techsync_perf required')
const mode = process.argv[2] || 'baseline'
if (!['baseline', 'after'].includes(mode)) throw new Error('Use baseline or after')
const queries = JSON.parse(await fs.readFile(`/tmp/techsync-${mode}-queries.json`, 'utf8'))
const client = new pg.Client({ connectionString: url.href })
await client.connect()
try {
  await client.query('BEGIN READ ONLY')
  await client.query("SET LOCAL statement_timeout = '20s'")
  const seen = new Set(), results = []
  for (const q of queries) {
    const key = crypto.createHash('sha256').update(q.query).digest('hex')
    if (seen.has(key) || !/^SELECT\s/i.test(q.query)) continue
    seen.add(key)
    const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.query}`, JSON.parse(q.params))
    results.push({ endpoint: q.endpoint, sqlHash: key, sqlBytes: Buffer.byteLength(q.query), parameterCount: JSON.parse(q.params).length, plan: rows[0]['QUERY PLAN'] })
  }
  await fs.writeFile(`/tmp/techsync-${mode}-plans.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results.map((r) => ({ endpoint: r.endpoint, sqlBytes: r.sqlBytes, parameters: r.parameterCount, executionMs: r.plan[0]['Execution Time'], node: r.plan[0].Plan['Node Type'] })), null, 2))
  await client.query('ROLLBACK')
} finally { await client.end() }
