// DEV ONLY. Compare response contracts using the same local synthetic database.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
const url = new URL(process.env.PERF_DATABASE_URL || 'postgresql://invalid/invalid')
if (!['localhost','127.0.0.1'].includes(url.hostname) || url.pathname !== '/techsync_perf') throw new Error('Disposable local techsync_perf required')
Object.assign(process.env, { DATABASE_URL: url.href, DATABASE_URL_UNPOOLED: url.href, NODE_ENV: 'test', LOG_LEVEL: 'silent', JWT_ACCESS_SECRET: 'performance-fixture-only-secret-01234567890123456789', DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', AWS_ACCESS_KEY_ID: 'fixture-only', AWS_SECRET_ACCESS_KEY: 'fixture-only', AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9', PERFORMANCE_METRICS: 'true', RATE_LIMIT_MAX: '100000', AUTH_RATE_LIMIT_MAX: '100000' })
const label = process.argv[2] || 'before'
assert(/^[a-z0-9-]+$/.test(label))
const source = process.env.PERF_SOURCE_ROOT ? pathToFileURL(`${process.env.PERF_SOURCE_ROOT}/`) : new URL('../', import.meta.url)
const { default: app } = await import(new URL('src/app.js', source))
const { prisma } = await import(new URL('src/db/prisma.js', source))
const { signAccessToken } = await import(new URL('src/services/token.service.js', source))
const { default: jwt } = await import('jsonwebtoken')
const fixtures = JSON.parse(await fs.readFile('/tmp/techsync-performance-fixture.json', 'utf8'))
const f = fixtures[0]
let server, empty
try {
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}/api`
  const token = (role=0, org=f.orgId) => signAccessToken(f.users[role], org).accessToken
  const request = async (path, role=0, org=f.orgId, bearer=token(role,org)) => {
    const r = await fetch(base+path, { headers: { authorization: `Bearer ${bearer}` } })
    return { status: r.status, body: await r.json() }
  }
  const contracts = {}
  for (let role = 0; role < 5; role++) {
    for (const query of [
      'limit=5&count=true&counts=true', 'limit=5&counts=true&status=new,qualified,qualified',
      'limit=5&counts=true&deleted=true', 'limit=5&counts=true&q=absent-value',
      `limit=5&counts=true&tag=${f.tagId}&cf.segment=retail&ownerId=none`,
      'limit=5&counts=true&q=%25_%27', 'limit=5&counts=true&createdFrom=2026-10-15&createdTo=2026-10-22',
    ]) {
      const r = await request(`/leads?${query}`, role)
      assert.equal(r.status, 200)
      contracts[`${role}:${query}`] = r
    }
    for (const sort of ['createdAt','-createdAt','displayName','-displayName','score','-score','updatedAt','-updatedAt']) {
      const first = await request(`/leads?limit=3&sort=${sort}&counts=true`, role)
      assert.equal(first.status,200)
      const next = await request(`/leads?limit=3&sort=${sort}&counts=true&cursor=${first.body.data.nextCursor}`, role)
      assert.equal(next.status,200)
      assert(!next.body.data.items.some(row => first.body.data.items.some(previous=>previous.id===row.id)))
      contracts[`${role}:${sort}:first`] = first
      contracts[`${role}:${sort}:next`] = next
    }
    contracts[`${role}:board`] = await request('/deals/board', role)
  }
  const lead = contracts['0:limit=5&count=true&counts=true'].body.data.items[0]
  const detail = await request(`/leads/${lead.id}`)
  assert.equal(detail.status,200); contracts.detail = detail
  const foreign = await request(`/leads/${lead.id}`,0,fixtures[1].orgId)
  assert.equal(foreign.status,403) // token user is not a member of the other workspace
  const foreignToken = signAccessToken(fixtures[1].users[0],fixtures[1].orgId).accessToken
  assert.equal((await request(`/leads/${lead.id}`,0,f.orgId,foreignToken)).status,404)
  const where = { organizationId_userId: { organizationId:f.orgId, userId:f.users[3].id } }
  await prisma.membership.update({ where, data:{ status:'deactivated' } })
  try { assert.equal((await request('/leads',3)).status,403) }
  finally { await prisma.membership.update({ where, data:{ status:'active' } }) }
  await prisma.membership.update({ where, data:{ role:'viewer' } })
  try { assert.equal((await request('/leads?count=true',3)).body.data.total, contracts['0:limit=5&count=true&counts=true'].body.data.total) }
  finally { await prisma.membership.update({ where, data:{ role:'sales_rep' } }) }
  const expired = jwt.sign({ email:f.users[0].email, org:f.orgId }, process.env.JWT_ACCESS_SECRET, { subject:f.users[0].id, issuer:'techsync-crm-api', audience:'techsync-crm', expiresIn:-1 })
  assert.equal((await request('/leads',0,f.orgId,expired)).body.error.code,'TOKEN_EXPIRED')
  empty = await prisma.organization.create({ data:{ name:'Empty contract fixture',slug:`empty-${crypto.randomUUID()}`,createdById:f.users[0].id } })
  await prisma.membership.create({ data:{ organizationId:empty.id,userId:f.users[0].id,role:'owner' } })
  const result = await request('/leads?counts=true&count=true',0,empty.id)
  assert.equal(result.status,200);assert.equal(result.body.data.total,0);contracts.empty=result
  const concurrent = await Promise.all(fixtures.map(tenant => request('/leads?limit=5&counts=true',0,tenant.orgId,signAccessToken(tenant.users[0],tenant.orgId).accessToken)))
  assert(concurrent.every(r=>r.status===200))
  await fs.writeFile(`/tmp/techsync-latency-contracts-${label}.json`,JSON.stringify(contracts,null,2))
  if(label!=='before') assert.deepEqual(contracts,JSON.parse(await fs.readFile('/tmp/techsync-latency-contracts-before.json','utf8')))
  console.log(JSON.stringify({label,contracts:Object.keys(contracts).length,parity:label!=='before',roles:5,tenants:5,revocation:true,roleChange:true,expiredToken:true,emptyTenant:true}))
} finally {
  if(empty) await prisma.organization.delete({where:{id:empty.id}})
  if(server) await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})
  await prisma.$disconnect()
}
