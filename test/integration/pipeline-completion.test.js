import crypto from 'node:crypto'
import express from 'express'
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest'
vi.mock('../../src/config/env.js',()=>({env:{NODE_ENV:'test',DATABASE_URL:process.env.TEST_DATABASE_URL||'postgresql://unused@localhost/unused',DB_POOL_MAX:10,PERFORMANCE_METRICS:true,SLOW_QUERY_MS:10000,JWT_ACCESS_SECRET:'pipeline-completion-only-012345678901234567890',JWT_ISSUER:'test',JWT_AUDIENCE:'test',JWT_ACCESS_EXPIRES_IN:'15m',FRONTEND_URL:'https://example.test',DATA_ENCRYPTION_KEY:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='}}))
vi.mock('../../src/email/mailer.js',()=>({sendEmail:vi.fn(),queueEmail:vi.fn()}))
vi.mock('../../src/jobs/queue.js',()=>({enqueue:vi.fn()}))
import {prisma} from '../../src/db/prisma.js'
import {pipelineRoutes,dealRoutes} from '../../src/routes/deal.routes.js'
import {errorHandler} from '../../src/middlewares/errorHandler.js'
import {requestPerformance} from '../../src/lib/performance.js'
import {signAccessToken} from '../../src/services/token.service.js'
import {ensureLeadDefaults} from '../../src/services/leadSetup.service.js'
import {ensureDefaultPipeline} from '../../src/services/pipeline.service.js'
import '../../src/events/subscribers/timeline.js'
import {subscribersFor} from '../../src/events/registry.js'
let users,org,other,server,base,pipeline,source,reason
const roles=['owner','admin','manager','sales_rep','viewer'],uuid=()=>crypto.randomUUID()
const request=async(path,{method='GET',body,role=0,tenant=org.id,ifMatch}={})=>{const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${signAccessToken(users[role],tenant).accessToken}`,'content-type':'application/json',...(ifMatch&&{'if-match':ifMatch})},...(body&&{body:JSON.stringify(body)})});return{status:r.status,body:r.status===204?null:await r.json(),timing:r.headers.get('server-timing')}}
const createPipeline=async name=>{const r=await request('/pipelines',{method:'POST',body:{name}});expect(r.status).toBe(201);return r.body.data.pipeline}
const getPipeline=async id=>(await request('/pipelines')).body.data.pipelines.find(p=>p.id===id)
const createDeal=async(p,fields={})=>{const r=await request('/deals',{method:'POST',body:{title:'QA transition',pipelineId:p.id,stageId:p.stages[0].id,valueMinor:1051,...fields}});expect(r.status,JSON.stringify(r.body)).toBe(201);return r.body.data.deal}
describe.skipIf(!process.env.TEST_DATABASE_URL)('pipeline completion: real tenant routes, state and history',()=>{
 beforeAll(async()=>{
  const target=new URL(process.env.TEST_DATABASE_URL);if(!['localhost','127.0.0.1','[::1]'].includes(target.hostname)&&process.env.TEST_DATABASE_DISPOSABLE!=='true')throw new Error('Disposable DB required')
  users=await Promise.all(roles.map(role=>prisma.user.create({data:{email:`${role}-${uuid()}@example.test`,fullName:role,emailVerifiedAt:new Date()}})))
  org=await prisma.organization.create({data:{name:'Pipeline completion',slug:`pipe-${uuid()}`,plan:'business',createdById:users[0].id}});other=await prisma.organization.create({data:{name:'Other pipeline',slug:`other-${uuid()}`,plan:'business',createdById:users[0].id}})
  await prisma.membership.createMany({data:users.map((u,i)=>({organizationId:org.id,userId:u.id,role:roles[i]}))});await prisma.membership.create({data:{organizationId:other.id,userId:users[0].id,role:'owner'}})
  const team=await prisma.team.create({data:{organizationId:org.id,name:'Managed'}});await prisma.teamMember.createMany({data:[{teamId:team.id,userId:users[2].id,isManager:true},{teamId:team.id,userId:users[3].id}]})
  await prisma.$transaction(async tx=>{await ensureLeadDefaults(tx,org.id);await ensureDefaultPipeline(tx,org.id);await ensureDefaultPipeline(tx,other.id)})
  pipeline=await prisma.pipeline.findFirst({where:{organizationId:org.id},include:{stages:{orderBy:{position:'asc'}}}});source=await prisma.leadSource.findFirst({where:{organizationId:org.id}});reason=await prisma.lostReason.findFirst({where:{organizationId:org.id,entityType:'deal'}})
  const app=express();app.use(express.json(),requestPerformance);app.use('/pipelines',pipelineRoutes);app.use('/deals',dealRoutes);app.use(errorHandler)
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});base=`http://127.0.0.1:${server.address().port}`
 })
 afterAll(async()=>{if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});if(org)await prisma.organization.deleteMany({where:{id:{in:[org.id,other.id]}}});if(users)await prisma.user.deleteMany({where:{id:{in:users.map(u=>u.id)}}});await prisma.$disconnect()})
 it('serializes simultaneous stage creation, reorders once, and protects system/last-open stages',async()=>{
  const p=await createPipeline('Concurrent stages')
  const results=await Promise.all(['A','B'].map(name=>request(`/pipelines/${p.id}/stages`,{method:'POST',body:{name}})))
  expect(results.map(r=>r.status)).toEqual([201,201]);let fresh=await getPipeline(p.id)
  expect(fresh.stages.map(s=>s.position)).toEqual(fresh.stages.map((_,i)=>i));expect(fresh.stages.slice(-2).map(s=>s.type)).toEqual(['won','lost'])
  const ids=fresh.stages.filter(s=>s.type==='open').map(s=>s.id).reverse()
  expect((await request(`/pipelines/${p.id}/stages/order`,{method:'PATCH',body:{stageIds:ids}})).status).toBe(200)
  fresh=await getPipeline(p.id);expect(fresh.stages.filter(s=>s.type==='open').map(s=>s.id)).toEqual(ids)
  expect((await request(`/pipelines/${p.id}/stages/order`,{method:'PATCH',body:{stageIds:[...ids.slice(1),ids[1]]}})).status).toBe(400)
  const won=fresh.stages.find(s=>s.type==='won')
  expect((await request(`/pipelines/${p.id}/stages/${won.id}`,{method:'DELETE',body:{}})).body.error.code).toBe('STAGE_SYSTEM')
  expect((await request(`/pipelines/${p.id}/stages/${won.id}`,{method:'PATCH',body:{probability:50}})).status).toBe(400)
  expect((await request(`/pipelines/${p.id}/stages/${won.id}`,{method:'PATCH',body:{name:'Enrolled'}})).body.data.pipeline.stages.find(s=>s.id===won.id).name).toBe('Enrolled')
 })
 it('keeps a last open stage when two administrators delete the final pair concurrently',async()=>{
  const p=await createPipeline('Last open concurrency'),open=p.stages.filter(s=>s.type==='open')
  for(const stage of open.slice(2))expect((await request(`/pipelines/${p.id}/stages/${stage.id}`,{method:'DELETE',body:{}})).status).toBe(200)
  const results=await Promise.all(open.slice(0,2).map(stage=>request(`/pipelines/${p.id}/stages/${stage.id}`,{method:'DELETE',body:{}})))
  expect(results.map(result=>result.status).sort()).toEqual([200,409])
  expect((await getPipeline(p.id)).stages.filter(stage=>stage.type==='open')).toHaveLength(1)
 })
 it('keeps exactly one default under simultaneous settings writes and restricts management by role',async()=>{
  const a=await createPipeline('Default A'),b=await createPipeline('Default B')
  for(let n=0;n<3;n++){
   await Promise.all([a,b].map(p=>request(`/pipelines/${p.id}`,{method:'PATCH',body:{isDefault:true}})))
   expect((await request('/pipelines')).body.data.pipelines.filter(p=>p.isDefault)).toHaveLength(1)
  }
  for(const role of [2,3,4])expect((await request(`/pipelines/${a.id}/stages`,{method:'POST',role,body:{name:'Forbidden'}})).status).toBe(403)
  expect((await request(`/pipelines/${a.id}/stages`,{method:'POST',role:1,body:{name:'Admin stage'}})).status).toBe(201)
  expect((await request(`/pipelines/${a.id}`,{method:'PATCH',tenant:other.id,body:{name:'Foreign'}})).status).toBe(404)
 })
 it('uses tenant-scoped DB campaign/source filters identically on board and list and rejects foreign lead links',async()=>{
  const p=await createPipeline('Filter pipeline'),campaign=await prisma.campaign.create({data:{organizationId:org.id,name:'Filter campaign',code:`filter-${uuid()}`,type:'website',objective:'lead_generation',status:'active',startDate:new Date('2026-10-01'),currency:'INR'}})
  const lead=await prisma.lead.create({data:{organizationId:org.id,displayName:'Attributed',campaignId:campaign.id}}),foreignLead=await prisma.lead.create({data:{organizationId:other.id,displayName:'Foreign'}})
  const deal=await createDeal(p,{sourceId:source.id});await prisma.deal.update({where:{id:deal.id},data:{leadId:lead.id}});await createDeal(p)
  const query=`pipelineId=${p.id}&campaignId=${campaign.id}&sourceId=${source.id}`
  const list=await request(`/deals?${query}&count=true`),board=await request(`/deals/board?${query}`)
  expect(list.body.data.total).toBe(1);expect(list.body.data.items[0].id).toBe(deal.id);expect(board.body.data.stages.reduce((n,s)=>n+s.count,0)).toBe(1)
  expect((await request(`/deals/forecast?${query}`)).body.data.totals.count).toBe(1)
  expect((await request(`/deals/forecast?pipelineId=${p.id}&sourceId=${uuid()}`)).body.data.totals.count).toBe(0)
  expect((await request(`/deals/board?pipelineId=${p.id}&sourceId=${uuid()}`)).body.data.stages.reduce((n,s)=>n+s.count,0)).toBe(0)
  expect((await request(`/deals?pipelineId=${p.id}&campaignId=${uuid()}&count=true`)).body.data.total).toBe(0)
  expect((await request(`/deals/${deal.id}`,{tenant:other.id})).status).toBe(404)
  await expect(prisma.deal.update({where:{id:deal.id},data:{leadId:foreignLead.id}})).rejects.toMatchObject({code:'P2003'})
 })
 it('moves once under concurrent edits, validates requirements/outcomes, reopens, and logs history/timeline idempotently',async()=>{
  const p=await createPipeline('Transitions'),d=await createDeal(p),open=p.stages.filter(s=>s.type==='open'),won=p.stages.find(s=>s.type==='won'),lost=p.stages.find(s=>s.type==='lost')
  const outcomes=await Promise.all(open.slice(1,3).map(s=>request(`/deals/${d.id}/move`,{method:'POST',ifMatch:d.updatedAt,body:{stageId:s.id}})))
  expect(outcomes.map(r=>r.status).sort()).toEqual([200,409]);expect(await prisma.dealStageHistory.count({where:{organizationId:org.id,dealId:d.id}})).toBe(2)
  await request(`/pipelines/${p.id}/stages/${won.id}`,{method:'PATCH',body:{requiredFields:['expectedCloseDate']}})
  expect((await request(`/deals/${d.id}/move`,{method:'POST',body:{stageId:won.id}})).body.error.code).toBe('STAGE_REQUIREMENTS')
  const win=await request(`/deals/${d.id}/move`,{method:'POST',body:{stageId:won.id,fields:{expectedCloseDate:'2026-11-15'}}})
  expect(win.body.data.deal.status).toBe('won');expect(win.body.data.deal.closedAt).toBeTruthy()
  expect((await request(`/deals/${d.id}/move`,{method:'POST',body:{stageId:lost.id}})).status).toBe(400)
  const lose=await request(`/deals/${d.id}/move`,{method:'POST',body:{stageId:lost.id,lostReasonId:reason.id,lostNote:'Budget'}})
  expect(lose.body.data.deal).toMatchObject({status:'lost',lostReasonId:reason.id,lostNote:'Budget'})
  const reopened=await request(`/deals/${d.id}/move`,{method:'POST',body:{stageId:open[0].id}})
  expect(reopened.body.data.deal).toMatchObject({status:'open',closedAt:null,lostReasonId:null,wonAt:null,lostAt:null})
  const event=await prisma.domainEvent.findFirst({where:{organizationId:org.id,entityId:d.id,type:'deal.stage_changed'},orderBy:{createdAt:'desc'}})
  const timeline=subscribersFor(event.type).find(s=>s.name==='timeline');await timeline.handler(event);await timeline.handler(event)
  expect(await prisma.activity.count({where:{organizationId:org.id,sourceEventId:event.id}})).toBe(1)
  expect((await request(`/deals/${d.id}/history`)).body.data.history[0].secondsInPrevStage).toBeGreaterThanOrEqual(0)
 },30000)
 it('preserves trashed deals on stage deletion and rolls back moves that fail destination requirements',async()=>{
  const p=await createPipeline('Delete stages'),d=await createDeal(p),from=p.stages[0],to=p.stages[1]
  await request(`/deals/${d.id}`,{method:'DELETE'})
  const fresh=await getPipeline(p.id);expect(fresh.stages.find(s=>s.id===from.id)).toMatchObject({dealCount:0,totalDealCount:1})
  expect((await request(`/pipelines/${p.id}/stages/${from.id}`,{method:'DELETE',body:{}})).status).toBe(409)
  await request(`/pipelines/${p.id}/stages/${to.id}`,{method:'PATCH',body:{requiredFields:['expectedCloseDate']}})
  expect((await request(`/pipelines/${p.id}/stages/${from.id}`,{method:'DELETE',body:{moveDealsToStageId:to.id}})).status).toBe(422)
  expect((await prisma.deal.findUnique({where:{id:d.id}})).stageId).toBe(from.id)
  await prisma.deal.update({where:{id:d.id},data:{expectedCloseDate:new Date('2026-11-15')}})
  expect((await request(`/pipelines/${p.id}/stages/${from.id}`,{method:'DELETE',body:{moveDealsToStageId:to.id}})).status).toBe(200)
  expect(await prisma.deal.findUnique({where:{id:d.id}})).toMatchObject({stageId:to.id,deletedAt:expect.any(Date)})
 })
 it('moves all outcomes when deleting a non-default pipeline, retaining history and loss details',async()=>{
  const from=await createPipeline('Delete pipeline'),to=await createPipeline('Destination pipeline')
  const records=[]
  for(const status of ['open','won','lost'])records.push(await createDeal(from,{stageId:from.stages.find(s=>s.type===status).id,...(status==='lost'?{lostReasonId:reason.id,lostNote:'Original loss'}:{})}))
  expect((await request(`/pipelines/${from.id}`,{method:'DELETE',body:{moveDealsToStageId:to.stages[0].id}})).status).toBe(204)
  for(const d of records){const row=await prisma.deal.findUnique({where:{id:d.id}});expect(row.pipelineId).toBe(to.id);expect(row.status).toBe(d.status);if(d.status==='lost')expect(row.lostNote).toBe('Original loss');expect(await prisma.dealStageHistory.count({where:{dealId:d.id}})).toBe(2)}
 },30000)
 it('bounds board queries for thousands of deals and paginates without missing or duplicate cards',async()=>{
  const p=await createPipeline('Volume pipeline'),stage=p.stages[0]
  await prisma.deal.createMany({data:Array.from({length:1105},(_,i)=>({organizationId:org.id,pipelineId:p.id,stageId:stage.id,title:`Volume ${i}`,ownerId:users[0].id,valueMinor:1051n,currency:'INR',position:i}))})
  const board=await request(`/deals/board?pipelineId=${p.id}`),col=board.body.data.stages.find(s=>s.id===stage.id)
  expect(col).toMatchObject({count:1105,totalMinor:1105*1051,hasMore:true});expect(col.deals).toHaveLength(50);expect(Number(/queries;desc="(\d+)"/.exec(board.timing)[1])).toBeLessThanOrEqual(40)
  const ids=[];let cursor
  do{const page=await request(`/deals?pipelineId=${p.id}&stageId=${stage.id}&limit=100&sort=position${cursor?'&cursor='+cursor:''}`);expect(page.status).toBe(200);ids.push(...page.body.data.items.map(d=>d.id));cursor=page.body.data.nextCursor}while(cursor)
  expect(ids).toHaveLength(1105);expect(new Set(ids).size).toBe(1105)
 },30000)
})
