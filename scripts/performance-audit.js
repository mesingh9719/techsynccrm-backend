// Never loads .env. Only an explicitly supplied local, disposable database is accepted.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

const url = new URL(process.env.PERF_DATABASE_URL || 'postgresql://invalid/invalid')
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/techsync_perf') {
  throw new Error('PERF_DATABASE_URL must point at a disposable local database named techsync_perf')
}
Object.assign(process.env, {
  DATABASE_URL: url.href, DATABASE_URL_UNPOOLED: url.href, NODE_ENV: 'test', LOG_LEVEL: 'silent',
  JWT_ACCESS_SECRET: 'performance-fixture-only-secret-01234567890123456789',
  DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  AWS_ACCESS_KEY_ID: 'fixture-only', AWS_SECRET_ACCESS_KEY: 'fixture-only', AWS_REGION: 'us-east-1',
  AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9',
  PERFORMANCE_METRICS: 'true', RATE_LIMIT_MAX: '100000',
  AUTH_RATE_LIMIT_MAX: '100000',
})
const { prisma } = await import('../src/db/prisma.js')
const { ensureLeadDefaults } = await import('../src/services/leadSetup.service.js')
const { ensureDefaultPipeline } = await import('../src/services/pipeline.service.js')
const { signAccessToken } = await import('../src/services/token.service.js')
const fixturePath = '/tmp/techsync-performance-fixture.json'
const mode = process.argv[2]
let server
try {
  if (mode === 'seed') {
    assert.equal(await prisma.organization.count(), 0, 'Seed requires an empty disposable database')
    const fixtures = []
    for (let tenant = 0; tenant < 4; tenant++) {
      const users = await Promise.all(['owner', 'admin', 'manager', 'sales_rep', 'viewer'].map((role) => prisma.user.create({ data: {
        fullName: `Fixture ${tenant} ${role}`, email: `fixture-${tenant}-${role}@example.test`,
        passwordHash: 'cannot-login', emailVerifiedAt: new Date(),
      } })))
      const org = await prisma.organization.create({ data: { name: `Performance ${tenant}`, slug: `perf-${tenant}`, plan: 'business', createdById: users[0].id } })
      await prisma.membership.createMany({ data: users.map((u, i) => ({ organizationId: org.id, userId: u.id, role: ['owner', 'admin', 'manager', 'sales_rep', 'viewer'][i], joinedAt: new Date() })) })
      await prisma.user.updateMany({ where: { id: { in: users.map((u) => u.id) } }, data: { lastActiveOrganizationId: org.id } })
      const team = await prisma.team.create({ data: { organizationId: org.id, name: 'Fixture team' } })
      await prisma.teamMember.createMany({ data: [{ teamId: team.id, userId: users[2].id, isManager: true }, { teamId: team.id, userId: users[3].id }] })
      await prisma.$transaction(async (tx) => { await ensureLeadDefaults(tx, org.id); await ensureDefaultPipeline(tx, org.id) })
      const pipeline = await prisma.pipeline.findFirst({ where: { organizationId: org.id }, include: { stages: { orderBy: { position: 'asc' } } } })
      const source = await prisma.leadSource.findFirst({ where: { organizationId: org.id } })
      const tag = await prisma.tag.create({ data: { organizationId: org.id, name: 'Fixture tag' } })
      await prisma.customFieldDefinition.create({ data: { organizationId: org.id, entityType: 'lead', key: 'segment', label: 'Segment', type: 'text' } })
      const company = await prisma.company.create({ data: { organizationId: org.id, name: 'Fixture company', ownerId: users[3].id } })
      const contact = await prisma.contact.create({ data: { organizationId: org.id, displayName: 'Fixture contact', ownerId: users[3].id } })
      const reason = await prisma.lostReason.findFirst({ where: { organizationId: org.id, entityType: 'lead' } })
      await prisma.$executeRawUnsafe(`INSERT INTO leads (organization_id, display_name, status, owner_id, source_id, custom_fields, created_at, updated_at, deleted_at)
        SELECT $1::uuid, 'Synthetic lead ' || n, (ARRAY['new','contacted','qualified','lost','junk','converted'])[1+n%6]::"LeadStatus",
          CASE WHEN n%3=0 THEN NULL ELSE $2::uuid END, $3::uuid, '{"segment":"retail"}'::jsonb,
          '2026-10-22'::timestamptz - n * interval '1 minute', '2026-10-22'::timestamptz,
          CASE WHEN n%20=0 THEN '2026-10-21'::timestamptz ELSE NULL END FROM generate_series(1,25000) n`, org.id, users[3].id, source.id)
      await prisma.$executeRawUnsafe(`INSERT INTO record_tags (organization_id, entity_type, entity_id, tag_id)
        SELECT organization_id, 'lead', id, $2::uuid FROM leads WHERE organization_id=$1::uuid`, org.id, tag.id)
      for (const stage of pipeline.stages) {
        await prisma.$executeRawUnsafe(`INSERT INTO deals (organization_id, title, pipeline_id, stage_id, status, value_minor, currency, probability_override, owner_id, company_id, source_id, lost_reason_id, position, closed_at, created_at, updated_at)
          SELECT $1::uuid, 'Synthetic deal ' || n, $2::uuid, $3::uuid, $4::"DealStatus", n*103+1, 'INR',
            CASE WHEN n%4=0 THEN 33 ELSE NULL END, $5::uuid, $6::uuid, $7::uuid, $8::uuid, n,
            CASE WHEN $4='open' THEN NULL WHEN n%5=0 THEN now()-interval '40 days' ELSE now() END,
            '2026-10-22'::timestamptz, '2026-10-22'::timestamptz FROM generate_series(1,500) n`,
          org.id, pipeline.id, stage.id, stage.type === 'open' ? 'open' : stage.type, users[3].id, company.id, source.id, reason?.id ?? null)
      }
      await prisma.$executeRawUnsafe(`INSERT INTO deal_contacts (organization_id,deal_id,contact_id,is_primary)
        SELECT organization_id,id,$2::uuid,true FROM deals WHERE organization_id=$1::uuid`, org.id, contact.id)
      await prisma.$executeRawUnsafe(`INSERT INTO record_tags (organization_id,entity_type,entity_id,tag_id)
        SELECT organization_id,'deal',id,$2::uuid FROM deals WHERE organization_id=$1::uuid`, org.id, tag.id)
      fixtures.push({ orgId: org.id, users: users.map(({ id, email }) => ({ id, email })), tagId: tag.id, pipelineId: pipeline.id })
    }
    await prisma.$executeRawUnsafe('ANALYZE')
    await fs.writeFile(fixturePath, JSON.stringify(fixtures))
    console.log(JSON.stringify({ leads: await prisma.lead.count(), deals: await prisma.deal.count(), tenants: fixtures.length }))
  } else if (['baseline', 'after', 'verify', 'contracts-before', 'contracts-after', 'auth', 'board-check'].includes(mode)) {
    const fixtures = JSON.parse(await fs.readFile(fixturePath, 'utf8'))
    const f = fixtures[0]
    const { default: app } = await import('../src/app.js')
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    const base = `http://127.0.0.1:${server.address().port}/api`
    const token = (fixture = f, index = 0) => signAccessToken(fixture.users[index], fixture.orgId).accessToken
    const request = async (path, accessToken = token()) => {
      const started = performance.now()
      const response = await fetch(base + path, { headers: { authorization: `Bearer ${accessToken}`, 'accept-encoding': 'identity' } })
      const body = await response.text()
      return { ms: performance.now() - started, status: response.status, bytes: Buffer.byteLength(body), timing: response.headers.get('server-timing'), body: JSON.parse(body) }
    }
    const paths = mode === 'board-check' ? ['/deals/board'] : [
      '/auth/me', '/organizations/current', '/organizations/current/checklist',
      '/leads?limit=1&counts=true', '/leads?limit=50&count=true&counts=true',
      `/leads?limit=50&count=true&counts=true&status=new&tag=${f.tagId}&cf.segment=retail`,
      '/leads?limit=50&q=Synthetic%20lead%202', '/deals/board', '/deals/forecast', '/tasks/summary',
    ]
    if (mode === 'auth') {
      const bcrypt = (await import('bcryptjs')).default
      await prisma.user.update({ where: { id: f.users[0].id }, data: { passwordHash: await bcrypt.hash('fixture-password-only', 12) } })
      let cookie
      const results = []
      for (const path of ['/auth/login', '/auth/refresh']) {
        const samples = []
        for (let i = 0; i < 33; i++) {
          const started = performance.now()
          const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
            body: JSON.stringify(path.endsWith('login') ? { email: f.users[0].email, password: 'fixture-password-only', remember: false } : {}) })
          const bytes = Buffer.byteLength(await response.text())
          assert.equal(response.status, 200)
          cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie
          if (i >= 3) samples.push({ ms: performance.now()-started, bytes, timing: response.headers.get('server-timing') })
        }
        const times = samples.map((s) => s.ms).sort((a,b) => a-b)
        results.push({ path, p50: times[14], p95: times[28], queries: Number(/queries;desc="(\d+)"/.exec(samples[0].timing)[1]),
          bytes: samples[0].bytes, dbMsFirstSample: Number(/db;dur=([\d.]+)/.exec(samples[0].timing)[1]), unchangedAuthCode: true })
      }
      await fs.writeFile('/tmp/techsync-auth-metrics.json', JSON.stringify(results, null, 2))
      console.log(JSON.stringify(results, null, 2))
    } else if (mode.startsWith('contracts-')) {
      const contracts = {}
      for (let role = 0; role < 5; role++) {
        for (const path of [
          '/leads?limit=5&count=true&counts=true', '/leads?limit=5&counts=true&status=new,qualified',
          '/leads?limit=5&counts=true&deleted=true', '/leads?limit=5&counts=true&q=absent-value',
          `/leads?limit=5&counts=true&tag=${f.tagId}&cf.segment=retail&ownerId=none`,
          '/deals/board', '/deals/board?q=absent-value',
        ]) {
          const response = await request(path, token(f, role))
          assert.equal(response.status, 200)
          contracts[`${role}:${path}`] = response.body
        }
      }
      const page1 = await request('/leads?limit=100&count=true&counts=true&scoreMin=1')
      assert.equal(page1.body.data.items.length, 0)
      assert.equal(page1.body.data.nextCursor, null)
      contracts.empty = page1.body
      const first = await request('/leads?limit=5&count=true&counts=true')
      contracts.next = (await request(`/leads?limit=5&count=true&counts=true&cursor=${first.body.data.nextCursor}`)).body
      const foreign = await request(`/leads/${first.body.data.items[0].id}`, token(fixtures[1]))
      assert.equal(foreign.status, 404)
      // Membership and role revocations must take effect on the very next request.
      await prisma.membership.update({ where: { organizationId_userId: { organizationId: f.orgId, userId: f.users[3].id } }, data: { status: 'deactivated' } })
      try { assert.equal((await request('/deals/board', token(f, 3))).status, 403) }
      finally { await prisma.membership.update({ where: { organizationId_userId: { organizationId: f.orgId, userId: f.users[3].id } }, data: { status: 'active' } }) }
      await fs.writeFile(`/tmp/techsync-${mode}.json`, JSON.stringify(contracts, null, 2))
      if (mode === 'contracts-after') assert.deepEqual(contracts, JSON.parse(await fs.readFile('/tmp/techsync-contracts-before.json', 'utf8')))
      console.log(JSON.stringify({ mode, contracts: Object.keys(contracts).length, foreignTenant: '404', revocation: '403', parity: mode === 'contracts-after' }))
    } else {
    const results = [], responses = {}, queries = []
    let captured
    prisma.$on('query', (e) => { if (captured) queries.push({ endpoint: captured, query: e.query, params: e.params, duration: e.duration }) })
    for (const path of paths) {
      captured = path
      const first = await request(path)
      captured = null
      assert.equal(first.status, 200, JSON.stringify({ path, response: first.body }))
      responses[path] = first.body
      for (let i = 0; i < 3; i++) await request(path)
      const samples = []
      const sampleCount = mode === 'board-check' ? 100 : 30
      for (let i = 0; i < sampleCount; i++) samples.push(await request(path))
      const times = samples.map((s) => s.ms).sort((a, b) => a-b)
      const counts = samples.map((s) => Number(/queries;desc="(\d+)"/.exec(s.timing)?.[1]))
      assert(counts.every(Number.isFinite), 'Missing query instrumentation')
      assert(counts.every((n) => n > 0), 'Query events lost request context')
      results.push({ path, p50: times[Math.ceil(sampleCount*0.5)-1], p95: times[Math.ceil(sampleCount*0.95)-1], queries: counts[0], bytes: samples[0].bytes })
    }
    const concurrent = await Promise.all(Array.from({ length: 16 }, (_, i) => request('/deals/board', token(fixtures[i%4]))))
    assert(concurrent.every((r) => r.status === 200))
    for (const r of concurrent) assert.equal(r.body.data.stages.reduce((n, s) => n+s.count, 0), responses['/deals/board'].data.stages.reduce((n, s) => n+s.count, 0))
    await fs.writeFile(`/tmp/techsync-${mode}-responses.json`, JSON.stringify(responses, null, 2))
    await fs.writeFile(`/tmp/techsync-${mode}-queries.json`, JSON.stringify(queries, null, 2))
    await fs.writeFile(`/tmp/techsync-${mode}-metrics.json`, JSON.stringify(results, null, 2))
    if (mode !== 'baseline') {
      const original = JSON.parse(await fs.readFile('/tmp/techsync-baseline-responses.json', 'utf8'))
      for (const [path, response] of Object.entries(responses)) assert.deepEqual(response, original[path])
    }
    console.log(JSON.stringify({ mode, results, concurrent: concurrent.length, responseParity: mode !== 'baseline' }, null, 2))
    }
  } else throw new Error('Use seed, baseline, after, verify, contracts-before, contracts-after, auth or board-check')
} finally {
  if (server) await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
}
