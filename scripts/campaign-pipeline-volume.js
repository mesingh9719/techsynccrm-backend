// Synthetic volume/performance verification; never reads .env or accepts a remote database.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import pg from 'pg'
const url = new URL(process.env.QA_DATABASE_URL || 'postgresql://invalid/invalid')
assert(['localhost','127.0.0.1'].includes(url.hostname) && url.pathname === '/techsync_campaign_pipeline', 'Dedicated local QA DB required')
const base = process.env.QA_API || 'http://127.0.0.1:5057/api'
assert(['localhost','127.0.0.1'].includes(new URL(base).hostname), 'Local QA API required')
const fixtures = JSON.parse(await fs.readFile('/tmp/techsync-campaign-pipeline-fixture.json','utf8'))
const db = new pg.Client({connectionString:url.href}); await db.connect()
const output = process.env.QA_OUTPUT || '/tmp/campaign-pipeline-volume'; await fs.mkdir(output,{recursive:true})
try {
 if(process.argv.includes('--seed')) {
  for(const f of fixtures) {
   await db.query(`INSERT INTO campaigns (id,organization_id,name,code,type,objective,status,start_date,currency,owner_id,source_id,actual_spend_minor,updated_at)
    SELECT md5($1 || '-volume-campaign-' || n)::uuid,$1::uuid,'Volume campaign '||n,'qa-volume-'||n,'website','lead_generation','active','2026-10-01','INR',$2::uuid,$3::uuid,1051,NOW() FROM generate_series(1,100) n ON CONFLICT (id) DO NOTHING`,[f.orgId,f.users[0].id,f.sourceId])
   await db.query(`INSERT INTO leads (id,organization_id,display_name,campaign_id,owner_id,source_id,status,updated_at)
    SELECT md5($1 || '-volume-lead-' || n)::uuid,$1::uuid,'Volume lead '||n,md5($1 || '-volume-campaign-' || (1+n%100))::uuid,$2::uuid,$3::uuid,(ARRAY['new','contacted','qualified','converted','lost','junk'])[1+n%6]::"LeadStatus",NOW() FROM generate_series(1,50000) n ON CONFLICT (id) DO NOTHING`,[f.orgId,f.users[0].id,f.sourceId])
   await db.query(`INSERT INTO deals (id,organization_id,title,pipeline_id,stage_id,status,currency,value_minor,lead_id,source_id,owner_id,position,expected_close_date,closed_at,updated_at)
    SELECT md5($1 || '-volume-deal-' || n)::uuid,$1::uuid,'Volume deal '||n,$2::uuid,CASE WHEN n%10=0 THEN $4::uuid ELSE $3::uuid END,CASE WHEN n%10=0 THEN 'won' ELSE 'open' END::"DealStatus",'INR',1051*n,md5($1 || '-volume-lead-' || n)::uuid,$5::uuid,$6::uuid,10000+n,'2026-11-15',CASE WHEN n%10=0 THEN NOW() ELSE NULL END,NOW() FROM generate_series(1,10000) n ON CONFLICT (id) DO NOTHING`,[f.orgId,f.pipelineId,f.stages[0].id,f.stages.find(stage=>stage.type==='won').id,f.sourceId,f.users[0].id])
  }
  for(const table of ['campaigns','leads','deals']) await db.query(`ANALYZE ${table}`)
 }
 const f=fixtures[0], sampleCampaign=(await db.query(`SELECT id FROM campaigns WHERE organization_id=$1 AND code='qa-volume-2'`,[f.orgId])).rows[0]
 assert(sampleCampaign,'Run --seed once first')
 const login=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:f.users[0].email,password:'FixturePassword123!'})});assert(login.ok);const token=(await login.json()).data.accessToken
 async function request(path,method='GET',body) {
  const start=performance.now();const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body&&{body:JSON.stringify(body)})});const text=await response.text();assert(response.ok,`${path}: ${response.status} ${text}`)
  return {ms:performance.now()-start,bytes:Buffer.byteLength(text),queries:Number(/queries;desc="(\d+)"/.exec(response.headers.get('server-timing'))?.[1]??0),data:JSON.parse(text).data}
 }
 const endpoints={campaigns:'/campaigns?limit=100',campaignDetail:'/campaigns/'+sampleCampaign.id,campaignLeads:'/campaigns/'+sampleCampaign.id+'/leads?limit=50',board:'/deals/board?pipelineId='+f.pipelineId,filteredBoard:`/deals/board?pipelineId=${f.pipelineId}&campaignId=${sampleCampaign.id}&sourceId=${f.sourceId}`,filteredList:`/deals?pipelineId=${f.pipelineId}&campaignId=${sampleCampaign.id}&sourceId=${f.sourceId}&count=true`,filteredForecast:`/deals/forecast?pipelineId=${f.pipelineId}&campaignId=${sampleCampaign.id}`}
 const results={}
 const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]
 for(const [name,path] of Object.entries(endpoints)) {
  await request(path)
  const sequential=[];for(let n=0;n<30;n++)sequential.push(await request(path))
  const concurrent=[];for(let n=0;n<3;n++)concurrent.push(...await Promise.all(Array.from({length:10},()=>request(path))))
  results[name]={sequential:{p50:percentile(sequential.map(x=>x.ms),.5),p95:percentile(sequential.map(x=>x.ms),.95)},concurrency10:{p50:percentile(concurrent.map(x=>x.ms),.5),p95:percentile(concurrent.map(x=>x.ms),.95)},maxQueries:Math.max(...sequential.map(x=>x.queries)),bytes:sequential[0].bytes}
 }
 const board=(await request(endpoints.filteredBoard)).data,list=(await request(endpoints.filteredList)).data
 assert.equal(board.stages.reduce((n,s)=>n+s.count,0),list.total)
 const leadCreate=[],leadUpdate=[]
 for(let n=0;n<30;n++){
  const created=await request('/leads','POST',{firstName:'Volume write regression',campaignId:sampleCampaign.id});leadCreate.push(created.ms)
  const updated=await request('/leads/'+created.data.lead.id,'PATCH',{firstName:'Volume write updated'});leadUpdate.push(updated.ms)
 }
 results.leadCreate={p50:percentile(leadCreate,.5),p95:percentile(leadCreate,.95)};results.leadUpdate={p50:percentile(leadUpdate,.5),p95:percentile(leadUpdate,.95)}
 const plan=await db.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT d.id FROM deals d WHERE d.organization_id=$1 AND d.deleted_at IS NULL AND d.source_id=$3 AND EXISTS (SELECT 1 FROM leads l WHERE l.id=d.lead_id AND l.organization_id=d.organization_id AND l.organization_id=$1 AND l.campaign_id=$2 AND l.deleted_at IS NULL)`,[f.orgId,sampleCampaign.id,f.sourceId])
 await fs.writeFile(output+'/filter-plan.json',JSON.stringify(plan.rows[0]['QUERY PLAN'],null,2))
 const counts=await db.query(`SELECT (SELECT COUNT(*)::int FROM campaigns) campaigns,(SELECT COUNT(*)::int FROM leads) leads,(SELECT COUNT(*)::int FROM deals) deals`)
 await fs.writeFile(output+'/results.json',JSON.stringify({counts:counts.rows[0],results,filterResultCount:list.total},null,2));console.log(JSON.stringify({counts:counts.rows[0],results,filterResultCount:list.total},null,2))
} finally {await db.end()}
