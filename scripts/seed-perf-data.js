// DEV ONLY: synthetic data; requires an EMPTY local techsync_perf database. Never reads .env.
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
  SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SECRET_KEY: 'fixture-only',
  PERFORMANCE_METRICS: 'true', RATE_LIMIT_MAX: '100000',
  AUTH_RATE_LIMIT_MAX: '100000',
})
const { prisma } = await import('../src/db/prisma.js')
const { ensureLeadDefaults } = await import('../src/services/leadSetup.service.js')
const { ensureDefaultPipeline } = await import('../src/services/pipeline.service.js')
const { signAccessToken } = await import('../src/services/token.service.js')
const fixturePath = '/tmp/techsync-performance-fixture.json'
try {
    assert.equal(await prisma.organization.count(), 0, 'Seed requires an empty disposable database')
    const fixtures = []
    for (let tenant = 0; tenant < 5; tenant++) {
      const users = await Promise.all(Array.from({ length: 20 }, (_, i) => ['owner', 'admin', 'manager', 'sales_rep', 'viewer'][i] ?? 'sales_rep').map((role, i) => prisma.user.create({ data: {
        fullName: `Fixture ${tenant} ${role}`, email: `fixture-${tenant}-${role}-${i}@example.test`,
        passwordHash: 'cannot-login', emailVerifiedAt: new Date(),
      } })))
      const org = await prisma.organization.create({ data: { name: `Performance ${tenant}`, slug: `perf-${tenant}`, plan: 'business', createdById: users[0].id } })
      await prisma.membership.createMany({ data: users.map((u, i) => ({ organizationId: org.id, userId: u.id, role: ['owner', 'admin', 'manager', 'sales_rep', 'viewer'][i] ?? 'sales_rep', joinedAt: new Date() })) })
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
      await prisma.$executeRawUnsafe(`INSERT INTO activities (organization_id,type,entity_type,entity_id,body,occurred_at)
        SELECT organization_id, CASE WHEN n=1 THEN 'note' ELSE 'call' END::"ActivityType", 'lead', id,
          repeat('Synthetic timeline content. ', 8), created_at + n * interval '1 hour'
        FROM leads CROSS JOIN generate_series(1,3) n WHERE organization_id=$1::uuid`, org.id)
      await prisma.$executeRawUnsafe(`INSERT INTO activity_links (activity_id,organization_id,entity_type,entity_id,occurred_at)
        SELECT id,organization_id,entity_type,entity_id,occurred_at FROM activities WHERE organization_id=$1::uuid`, org.id)
      await prisma.$executeRawUnsafe(`INSERT INTO tasks (organization_id,title,entity_type,entity_id,assignee_id,status,due_at,created_at,updated_at)
        SELECT organization_id,'Synthetic follow up ' || n,'lead',id,$2::uuid,
          CASE WHEN n=3 THEN 'completed' ELSE 'open' END::"TaskStatus",
          '2026-10-24'::timestamptz + (n-2) * interval '1 day',created_at,updated_at
        FROM leads CROSS JOIN generate_series(1,3) n WHERE organization_id=$1::uuid`, org.id, users[3].id)
      fixtures.push({ orgId: org.id, users: users.map(({ id, email }) => ({ id, email })), tagId: tag.id, pipelineId: pipeline.id })
    }
    await prisma.$executeRawUnsafe('ANALYZE')
    await fs.writeFile(fixturePath, JSON.stringify(fixtures))
    console.log(JSON.stringify({ leads: await prisma.lead.count(), deals: await prisma.deal.count(), tenants: fixtures.length, users: await prisma.user.count(), activities: await prisma.activity.count(), tasks: await prisma.task.count() }))
} finally { await prisma.$disconnect() }
