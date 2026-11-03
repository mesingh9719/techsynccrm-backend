// DEV ONLY. Never reads .env; refuses nonlocal databases. See seed-perf-data.js.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const url = new URL(process.env.PERF_DATABASE_URL || 'postgresql://invalid/invalid')
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/techsync_perf') throw new Error('Disposable local techsync_perf required')
Object.assign(process.env, {
  DATABASE_URL: url.href, DATABASE_URL_UNPOOLED: url.href, NODE_ENV: 'test', LOG_LEVEL: 'silent',
  JWT_ACCESS_SECRET: 'performance-fixture-only-secret-01234567890123456789', DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SECRET_KEY: 'fixture-only',
  PERFORMANCE_METRICS: 'true', RATE_LIMIT_MAX: '100000', AUTH_RATE_LIMIT_MAX: '100000',
})
const label = process.argv[2] || 'before'
assert(/^[a-z0-9-]+$/.test(label))
const mode = process.argv[3] || 'warm'
const sampleCount = Number(process.env.PERF_SAMPLES || 30)
assert(Number.isSafeInteger(sampleCount) && sampleCount >= 30)
const output = new URL('../performance/latency-20261024/', import.meta.url)
await fs.mkdir(output, { recursive: true })
if (mode === 'cold') {
  const samples = []
  for (let i = 0; i < 30; i++) {
    const { stdout } = await promisify(execFile)(process.execPath, [import.meta.filename, label, 'cold-one'], { env: process.env })
    samples.push(JSON.parse(stdout))
  }
  await fs.writeFile(new URL(`${label}-cold.json`, output), JSON.stringify(samples, null, 2))
  const times = samples.map(s => s.totalMs).sort((a,b) => a-b)
  console.log(JSON.stringify({ mode, n: samples.length, p50: times[14], p95: times[28] }))
  process.exit(0)
}
const boot = performance.now()
const { default: app } = await import('../src/app.js')
const bootMs = performance.now() - boot
const { prisma } = await import('../src/db/prisma.js')
const { signAccessToken } = await import('../src/services/token.service.js')
const fixtures = JSON.parse(await fs.readFile('/tmp/techsync-performance-fixture.json', 'utf8'))
const f = fixtures[0]
const token = signAccessToken(f.users[0], f.orgId).accessToken
let server
try {
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); s.on('error', e => { throw e }) })
  const base = `http://127.0.0.1:${server.address().port}/api`
  let captured
  const queries = []
  prisma.$on('query', e => { if (captured) queries.push({ endpoint: captured, query: e.query, params: e.params, duration: e.duration }) })
  const request = async (path, method = 'GET', body, bearer = token) => {
    const started = performance.now()
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${bearer}`, 'accept-encoding': 'identity', 'content-type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) })
    const text = await response.text(), timing = response.headers.get('server-timing')
    assert(response.ok, `${method} ${path}: ${response.status} ${text}`)
    return { ms: performance.now()-started, status: response.status, bytes: Buffer.byteLength(text), queries: Number(/queries;desc="(\d+)"/.exec(timing)?.[1]), dbMs: Number(/db;dur=([\d.]+)/.exec(timing)?.[1]), authMs: Number(/auth;dur=([\d.]+)/.exec(timing)?.[1]), body: text ? JSON.parse(text) : null }
  }
  if (mode === 'cold-one') {
    const r = await request('/auth/me')
    console.log(JSON.stringify({ bootMs, requestMs: r.ms, totalMs: bootMs+r.ms, queries: r.queries }))
  } else {
    let lead = await prisma.lead.findFirst({ where: { organizationId: f.orgId, deletedAt: null }, orderBy: { createdAt: 'desc' } })
    const leaked = await prisma.lead.findMany({ where: { organizationId: f.orgId, firstName: { in: ['Performance write fixture', 'Performance update fixture'] } }, select: { id: true } })
    await prisma.domainEvent.deleteMany({ where: { entityId: { in: leaked.map(r => r.id) } } })
    await prisma.lead.deleteMany({ where: { id: { in: leaked.map(r => r.id) } } })
    lead = await prisma.lead.findFirst({ where: { organizationId: f.orgId, deletedAt: null }, orderBy: { createdAt: 'desc' } })
    if (!lead.firstName) lead = await prisma.lead.update({ where: { id: lead.id }, data: { firstName: lead.displayName, updatedAt: lead.updatedAt } })
    const bcrypt = (await import('bcryptjs')).default
    await prisma.user.update({ where: { id: f.users[0].id }, data: { passwordHash: await bcrypt.hash('fixture-password-only', 12) } })
    const cases = [
      ['/auth/me'], ['/auth/login', 'POST', { email: f.users[0].email, password: 'fixture-password-only', remember: false }],
      ['/leads?limit=1&counts=true'], ['/leads?limit=1&counts=true&createdFrom=2026-10-15&createdTo=2026-10-22'],
      ['/leads?limit=50&count=true&counts=true'], [`/leads?limit=50&count=true&counts=true&status=new&tag=${f.tagId}&cf.segment=retail`],
      ['/leads?limit=50&q=Synthetic%20lead%202'], ['/leads?limit=50&q=%25_%27'],
      [`/leads/${lead.id}`], ['/deals/board'], ['/tasks/summary'],
      ['/leads', 'POST', { firstName: 'Performance write fixture' }],
      [`/leads/${lead.id}`, 'PATCH', { requirement: 'Performance update fixture' }],
    ]
    const metrics = [], contracts = {}, raw = []
    for (const args of cases.filter(([path]) => !process.env.PERF_ONLY || path === process.env.PERF_ONLY)) {
      const [path, method = 'GET'] = args
      console.error(`${label}: ${method} ${path}`)
      const key = `${method} ${path}`
      const targets = method === 'PATCH' ? await prisma.lead.createManyAndReturn({ data: Array.from({ length: 10 }, () => ({ organizationId: f.orgId, firstName: 'Performance update fixture', displayName: 'Performance update fixture', ownerId: f.users[0].id })) }) : []
      let sequence = 0
      const run = () => request(...(targets.length ? [`/leads/${targets[sequence++ % targets.length].id}`, ...args.slice(1)] : args))
      captured = key
      const first = await run()
      captured = null
      if (method === 'GET') contracts[key] = first.body
      for (let i = 0; i < 3; i++) await run()
      for (const concurrency of [1, 10]) {
        const samples = []
        for (let i = 0; i < sampleCount; i += concurrency) samples.push(...await Promise.all(Array.from({ length: Math.min(concurrency, sampleCount-i) }, () => run())))
        const times = samples.map(s => s.ms).sort((a,b) => a-b)
        assert(samples.every(s => Number.isFinite(s.queries) && s.queries > 0))
        metrics.push({ endpoint: key, concurrency, n: samples.length, p50: times[Math.ceil(sampleCount*.5)-1], p95: times[Math.ceil(sampleCount*.95)-1], queries: samples[0].queries, bytes: samples[0].bytes, dbP50: samples.map(s=>s.dbMs).sort((a,b)=>a-b)[Math.ceil(sampleCount*.5)-1], authP50: samples.map(s=>s.authMs).sort((a,b)=>a-b)[Math.ceil(sampleCount*.5)-1] })
        raw.push({ endpoint: key, concurrency, samples: samples.map(({body, ...s}) => s) })
      }
    }
    // Remove writes and their outbox rows, preserving the stable read-only fixture for parity.
    const written = await prisma.lead.findMany({ where: { organizationId: f.orgId, firstName: { in: ['Performance write fixture', 'Performance update fixture'] } }, select: { id: true } })
    await prisma.domainEvent.deleteMany({ where: { entityId: { in: written.map(r=>r.id) } } })
    await prisma.lead.deleteMany({ where: { id: { in: written.map(r=>r.id) } } })
    await fs.writeFile(new URL(`${label}-metrics.json`, output), JSON.stringify(metrics, null, 2))
    await fs.writeFile(new URL(`${label}-samples.json`, output), JSON.stringify(raw, null, 2))
    await fs.writeFile(`/tmp/techsync-${label}-queries.json`, JSON.stringify(queries))
    await fs.writeFile(`/tmp/techsync-latency-${label}-contracts.json`, JSON.stringify(contracts))
    if (label !== 'before') {
      const original = JSON.parse(await fs.readFile('/tmp/techsync-latency-before-contracts.json', 'utf8'))
      for (const [key, value] of Object.entries(contracts)) assert.deepEqual(value, original[key])
    }
    console.log(JSON.stringify({ label, metrics, parity: label !== 'before', memory: process.memoryUsage() }, null, 2))
  }
} finally {
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  await prisma.$disconnect()
}
