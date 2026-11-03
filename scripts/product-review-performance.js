// Synthetic localhost-only benchmark. Never loads application .env; never reuse an application DB.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import express from 'express'
const target = new URL(process.env.QA_DATABASE_URL || 'postgresql://invalid/invalid')
assert(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/techsync_product_performance', 'Dedicated local techsync_product_performance required')
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: target.href, DATABASE_URL_UNPOOLED: target.href, JWT_ACCESS_SECRET: 'review-performance-only-012345678901234567890', DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SECRET_KEY: 'fixture', LOG_LEVEL: 'silent', FRONTEND_URL: 'http://127.0.0.1:5181' })
const { prisma } = await import('../src/db/prisma.js')
const { reportRoutes } = await import('../src/routes/report.routes.js')
const { errorHandler } = await import('../src/middlewares/errorHandler.js')
const { signAccessToken } = await import('../src/services/token.service.js')
const { ensureDefaultPipeline } = await import('../src/services/pipeline.service.js')
let server
try {
  let user, org
  if (process.argv.includes('--measure')) {
    user = await prisma.user.findUniqueOrThrow({ where: { email: 'report-perf@example.test' } })
    org = await prisma.organization.findUniqueOrThrow({ where: { slug: 'product-review-performance' } })
  } else {
  assert.equal(await prisma.organization.count(), 0, 'Benchmark seed requires an empty disposable database')
  user = await prisma.user.create({ data: { email: 'report-perf@example.test', fullName: 'Performance fixture', emailVerifiedAt: new Date() } })
  org = await prisma.organization.create({ data: { name: 'Synthetic performance', slug: 'product-review-performance', createdById: user.id, plan: 'business' } })
  await prisma.membership.create({ data: { organizationId: org.id, userId: user.id, role: 'owner' } })
  await prisma.$transaction(tx => ensureDefaultPipeline(tx, org.id))
  const pipeline = await prisma.pipeline.findFirst({ where: { organizationId: org.id }, include: { stages: true } }), source = await prisma.leadSource.create({ data: { organizationId: org.id, key: 'website', name: 'Website' } })
  await prisma.$executeRaw`INSERT INTO leads (id, organization_id, display_name, status, owner_id, source_id, created_at, updated_at, first_responded_at)
    SELECT gen_random_uuid(), ${org.id}::uuid, 'Synthetic enquiry ' || n,
      (CASE n % 5 WHEN 0 THEN 'lost' WHEN 1 THEN 'converted' WHEN 2 THEN 'qualified' WHEN 3 THEN 'contacted' ELSE 'new' END)::"LeadStatus",
      ${user.id}::uuid, ${source.id}::uuid, '2026-10-01T10:00:00Z'::timestamptz + (n % 30) * interval '1 day', now(),
      CASE WHEN n % 3 = 0 THEN NULL ELSE '2026-10-01T10:05:00Z'::timestamptz + (n % 30) * interval '1 day' END
    FROM generate_series(1,100000) n`
  await prisma.$executeRaw`INSERT INTO domain_events (organization_id, entity_type, entity_id, type, payload)
    SELECT organization_id, 'lead', id, 'lead.status_changed', '{"changes":{"status":["qualified","lost"]}}'::jsonb FROM leads WHERE organization_id = ${org.id}::uuid AND status = 'lost'`
  const won = pipeline.stages.find(s => s.type === 'won'), open = pipeline.stages.find(s => s.type === 'open')
  await prisma.$executeRaw`INSERT INTO deals (id, organization_id, title, pipeline_id, stage_id, status, owner_id, source_id, currency, value_minor, won_at, closed_at, created_at, updated_at)
    SELECT gen_random_uuid(), ${org.id}::uuid, 'Synthetic deal ' || n, ${pipeline.id}::uuid,
      CASE WHEN n % 2 = 0 THEN ${won.id}::uuid ELSE ${open.id}::uuid END,
      (CASE WHEN n % 2 = 0 THEN 'won' ELSE 'open' END)::"DealStatus", ${user.id}::uuid, ${source.id}::uuid, 'INR', n * 100,
      CASE WHEN n % 2 = 0 THEN '2026-10-02T10:00:00Z'::timestamptz ELSE NULL END,
      CASE WHEN n % 2 = 0 THEN '2026-10-02T10:00:00Z'::timestamptz ELSE NULL END, '2026-10-01T10:00:00Z', now()
    FROM generate_series(1,20000) n`
  await prisma.$executeRaw`INSERT INTO tasks (organization_id, title, assignee_id, entity_type, entity_id, due_at, updated_at)
    SELECT organization_id, 'Synthetic follow-up', ${user.id}::uuid, 'lead', id, '2026-10-02T10:00:00Z', now() FROM leads WHERE organization_id = ${org.id}::uuid LIMIT 20000`
  await prisma.$executeRaw`INSERT INTO activities (organization_id, entity_type, entity_id, type, actor_id, occurred_at)
    SELECT organization_id, 'lead', id, 'call'::"ActivityType", ${user.id}::uuid, '2026-10-02T10:00:00Z' FROM leads WHERE organization_id = ${org.id}::uuid LIMIT 30000`
  await prisma.$executeRaw`INSERT INTO activity_links (organization_id, activity_id, entity_type, entity_id, occurred_at)
    SELECT organization_id, id, entity_type, entity_id, occurred_at FROM activities WHERE organization_id = ${org.id}::uuid`
  await prisma.$executeRawUnsafe('ANALYZE leads, deals, tasks, activities, activity_links, domain_events')
  }
  const app = express(); app.use('/reports', reportRoutes); app.use(errorHandler)
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); })
  const token = signAccessToken(user, org.id).accessToken, results = []
  for (const endpoint of ['kpis', 'revenue-series', 'leads-by-source', 'funnel', 'leaderboard', 'first-response', 'follow-ups']) {
    const samples = []
    for (let n = 0; n < 20; n++) {
      const start = performance.now(), response = await fetch(`http://127.0.0.1:${server.address().port}/reports/${endpoint}?from=2026-10-01&to=2026-10-31`, { headers: { authorization: 'Bearer ' + token } })
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    results.push({ endpoint, samples: 20, medianMs: +samples[9].toFixed(1), p95Ms: +samples[18].toFixed(1), maxMs: +samples[19].toFixed(1) })
  }
  const plan = await prisma.$queryRaw`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT SUM(value_minor) FROM deals WHERE organization_id = ${org.id}::uuid AND deleted_at IS NULL AND status = 'won' AND won_at >= '2026-10-01'::timestamptz AND won_at < '2026-10-31'::timestamptz`
  const output = { dataset: { leads: 100000, deals: 20000, tasks: 20000, activities: 30000, events: 20000 }, environment: 'Disposable local Postgres 16; HTTP includes JWT/membership authorization; sequential warm requests, not production load', results, plan }
  await fs.writeFile('/tmp/product-review-performance.json', JSON.stringify(output, null, 2)); console.log(JSON.stringify(results))
} finally { if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }); await prisma.$disconnect() }
