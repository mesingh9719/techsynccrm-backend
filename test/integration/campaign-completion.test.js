import crypto from 'node:crypto'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('../../src/config/env.js',()=>({env:{NODE_ENV:'test',DATABASE_URL:process.env.TEST_DATABASE_URL||'postgresql://unused@localhost/unused',DB_POOL_MAX:10,PERFORMANCE_METRICS:true,SLOW_QUERY_MS:10000,JWT_ACCESS_SECRET:'campaign-completion-only-012345678901234567890',JWT_ISSUER:'test',JWT_AUDIENCE:'test',JWT_ACCESS_EXPIRES_IN:'15m',FRONTEND_URL:'https://example.test',DATA_ENCRYPTION_KEY:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='}}))
vi.mock('../../src/email/mailer.js',()=>({sendEmail:vi.fn(),queueEmail:vi.fn()}))
vi.mock('../../src/jobs/queue.js',()=>({enqueue:vi.fn()}))
import {prisma} from '../../src/db/prisma.js'
import {campaignRoutes} from '../../src/routes/campaign.routes.js'
import {leadRoutes} from '../../src/routes/lead.routes.js'
import {errorHandler} from '../../src/middlewares/errorHandler.js'
import {requestPerformance} from '../../src/lib/performance.js'
import {signAccessToken} from '../../src/services/token.service.js'
import {campaignTransitions} from '../../src/config/campaigns.js'
import {ensureLeadDefaults} from '../../src/services/leadSetup.service.js'
import {ensureDefaultPipeline} from '../../src/services/pipeline.service.js'
import {createLeadFromCapture} from '../../src/services/lead.service.js'
import {permissionsFor} from '../../src/config/permissions.js'
let users,org,other,server,base,pipeline,source
const roles=['owner','admin','manager','sales_rep','viewer'],uuid=()=>crypto.randomUUID()
const token=(role=0,tenant=org.id)=>signAccessToken(users[role],tenant).accessToken
const request=async(path,{method='GET',body,role=0,tenant,ifMatch}={})=>{const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${token(role,tenant)}`,'content-type':'application/json',...(ifMatch&&{'if-match':ifMatch})},...(body&&{body:JSON.stringify(body)})});return{status:r.status,body:r.status===204?null:await r.json(),timing:r.headers.get('server-timing')}}
const input=(fields={})=>({name:'Completion campaign',code:`completion-${uuid()}`,type:'website',objective:'lead_generation',status:'active',startDate:'2026-10-01',...fields})
const create=async(fields={})=>{const r=await request('/campaigns',{method:'POST',body:input(fields)});expect(r.status).toBe(201);return r.body.data.campaign}
describe.skipIf(!process.env.TEST_DATABASE_URL)('campaign completion: real tenant API and DB',()=>{
 beforeAll(async()=>{
  const target=new URL(process.env.TEST_DATABASE_URL);if(!['localhost','127.0.0.1','[::1]'].includes(target.hostname)&&process.env.TEST_DATABASE_DISPOSABLE!=='true')throw new Error('Disposable DB required')
  users=await Promise.all(roles.map(role=>prisma.user.create({data:{email:`${role}-${uuid()}@example.test`,fullName:role,emailVerifiedAt:new Date()}})))
  org=await prisma.organization.create({data:{name:'Campaign completion',slug:`completion-${uuid()}`,plan:'business',createdById:users[0].id}})
  other=await prisma.organization.create({data:{name:'Foreign completion',slug:`foreign-${uuid()}`,plan:'business',createdById:users[0].id}})
  await prisma.membership.createMany({data:users.map((u,i)=>({organizationId:org.id,userId:u.id,role:roles[i]}))});await prisma.membership.create({data:{organizationId:other.id,userId:users[0].id,role:'owner'}})
  const team=await prisma.team.create({data:{organizationId:org.id,name:'Managed'}});await prisma.teamMember.createMany({data:[{teamId:team.id,userId:users[2].id,isManager:true},{teamId:team.id,userId:users[3].id}]})
  await prisma.$transaction(async tx=>{await ensureLeadDefaults(tx,org.id);await ensureDefaultPipeline(tx,org.id)})
  source=await prisma.leadSource.findFirst({where:{organizationId:org.id}});pipeline=await prisma.pipeline.findFirst({where:{organizationId:org.id},include:{stages:true}})
  const app=express();app.use(express.json(),requestPerformance);app.use('/campaigns',campaignRoutes);app.use('/leads',leadRoutes);app.use(errorHandler)
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});base=`http://127.0.0.1:${server.address().port}`
 })
 afterAll(async()=>{if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});if(org)await prisma.organization.deleteMany({where:{id:{in:[org.id,other.id]}}});if(users)await prisma.user.deleteMany({where:{id:{in:users.map(u=>u.id)}}});await prisma.$disconnect()})
 it('exposes one transition source and enforces all local transitions on status and PATCH routes',async()=>{
  expect((await request('/campaigns/options')).body.data.transitions).toEqual(campaignTransitions)
  const c=await create()
  for(const from of Object.keys(campaignTransitions))for(const to of Object.keys(campaignTransitions)){
   await prisma.campaign.update({where:{id:c.id},data:{status:from}})
   const result=await request(`/campaigns/${c.id}/status`,{method:'POST',body:{status:to}})
   expect(result.status,`${from} → ${to}`).toBe(from===to||campaignTransitions[from].includes(to)?200:400)
   if(result.status===400)expect(result.body.error.code).toBe('INVALID_TRANSITION')
  }
  await prisma.campaign.update({where:{id:c.id},data:{status:'active'}})
  expect((await request(`/campaigns/${c.id}`,{method:'PATCH',body:{status:'draft'}})).body.error.code).toBe('INVALID_TRANSITION')
  const fresh=(await request(`/campaigns/${c.id}`)).body.data.campaign
  await request(`/campaigns/${c.id}/status`,{method:'POST',body:{status:'paused'},ifMatch:fresh.updatedAt})
  expect((await request(`/campaigns/${c.id}/status`,{method:'POST',body:{status:'completed'},ifMatch:fresh.updatedAt})).status).toBe(409)
 },30000)
 it('links, changes and clears a campaign without changing original capture metadata; rejects foreign IDs',async()=>{
  const a=await create(),b=await create(),foreign=await prisma.campaign.create({data:{...input(),startDate:new Date('2026-10-01'),organizationId:other.id,currency:'INR'}})
  const utm={utm_campaign:a.code,utm_source:'original-site',utm_medium:'original-medium'}
  const created=await request('/leads',{method:'POST',body:{firstName:'Explicit campaign',emails:[{value:`${uuid()}@example.test`}],utm,sourceDetail:'Original capture',campaignId:b.id}})
  expect(created.status).toBe(201);const lead=created.body.data.lead
  expect(lead).toMatchObject({campaignId:b.id,campaign:{id:b.id,name:b.name,code:b.code},utm,sourceDetail:'Original capture'})
  const unchanged=await request(`/leads/${lead.id}`,{method:'PATCH',body:{firstName:'Updated name',utm,sourceDetail:'Original capture'}})
  expect(unchanged.body.data.lead.campaignId).toBe(b.id)
  const linked=await request(`/leads/${lead.id}`,{method:'PATCH',body:{campaignId:a.id},ifMatch:unchanged.body.data.lead.updatedAt})
  expect(linked.body.data.lead).toMatchObject({campaignId:a.id,utm,sourceDetail:'Original capture'})
  const captured=await createLeadFromCapture({orgId:org.id,userId:null,actorType:'system',plan:'business',country:'IN',currency:'INR',permissions:permissionsFor('owner')},{firstName:'Repeat',emails:lead.emails,utm:{utm_campaign:b.code}})
  expect(captured.outcome).toBe('merged_into_open');expect(captured.lead.campaignId).toBe(a.id)
  expect((await request(`/leads/${lead.id}`,{method:'PATCH',body:{campaignId:foreign.id}})).status).toBe(400)
  const cleared=await request(`/leads/${lead.id}`,{method:'PATCH',body:{campaignId:null}})
  expect(cleared.body.data.lead).toMatchObject({campaignId:null,campaign:null,utm,sourceDetail:'Original capture'})
  expect((await request('/leads?campaignId=none&count=true')).body.data.items.some(l=>l.id===lead.id)).toBe(true)
  expect((await request(`/leads?campaignId=${a.id},${b.id},none&count=true`)).status).toBe(200)
 },30000)
 it('counts progressive funnel metrics, exact CPL and tenant/currency-scoped won revenue in bounded queries',async()=>{
  const c=await create({actualSpendMinor:1051,sourceId:source.id})
  const leads=await prisma.lead.createManyAndReturn({data:['new','contacted','qualified','converted','lost','junk'].map(status=>({organizationId:org.id,displayName:status,campaignId:c.id,status,ownerId:users[0].id,firstRespondedAt:status==='lost'?new Date():null}))})
  await prisma.deal.createMany({data:[['INR',12345],['USD',99000]].map(([currency,value])=>({organizationId:org.id,pipelineId:pipeline.id,stageId:pipeline.stages.find(s=>s.type==='won').id,status:'won',title:'Won',leadId:leads[0].id,ownerId:users[0].id,valueMinor:BigInt(value),currency}))})
  const result=await request(`/campaigns/${c.id}`)
  expect(result.body.data.campaign.metrics).toMatchObject({leadsCount:6,contactedCount:4,qualifiedCount:2,convertedCount:1,costPerLeadMinor:175,dealsWonCount:1,revenueWonMinor:12345,conversionRate:16.7})
  expect(Number(/queries;desc="(\d+)"/.exec(result.timing)[1])).toBeLessThanOrEqual(10)
  expect((await request(`/campaigns/${c.id}/leads?count=true`)).body.data.total).toBe(6)
  expect((await request(`/campaigns/${c.id}`,{role:4})).body.data.campaign.metrics).toEqual(result.body.data.campaign.metrics)
 })
 it('filters by owner/source/date, paginates stable sorts, and preserves linked leads on soft delete',async()=>{
  const c=await create({ownerId:users[3].id,sourceId:source.id,name:'Needle campaign'})
  const lead=(await request('/leads',{method:'POST',body:{firstName:'Keep attribution',campaignId:c.id}})).body.data.lead
  const list=await request(`/campaigns?ownerId=${users[3].id}&sourceId=${source.id}&q=Needle&createdFrom=2020-01-01&createdTo=2030-01-01&sort=name`)
  expect(list.body.data.items.map(c=>c.id)).toEqual([c.id])
  expect((await request(`/campaigns/${c.id}`,{role:3})).status).toBe(200)
  expect((await request(`/campaigns/${c.id}`,{tenant:other.id})).status).toBe(404)
  expect((await request(`/campaigns/${c.id}`,{method:'PATCH',role:4,body:{name:'Forbidden'}})).status).toBe(403)
  expect((await request(`/campaigns/${c.id}`,{method:'DELETE',role:4})).status).toBe(403)
  expect((await request(`/campaigns/${c.id}`,{method:'DELETE'})).status).toBe(204)
  expect((await request(`/leads/${lead.id}`)).body.data.lead).toMatchObject({campaignId:c.id,campaign:{id:c.id,name:c.name}})
  expect((await request(`/campaigns/${c.id}`)).status).toBe(404)
  expect(await prisma.domainEvent.count({where:{organizationId:org.id,entityId:c.id,type:'campaign.deleted'}})).toBe(1)
 })
})
