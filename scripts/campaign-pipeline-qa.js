// DEV ONLY. Never loads .env. Synthetic fixtures in an explicitly disposable localhost DB.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const url = new URL(process.env.QA_DATABASE_URL || 'postgresql://invalid/invalid')
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/techsync_campaign_pipeline') throw new Error('Local disposable techsync_campaign_pipeline required')
Object.assign(process.env, { DATABASE_URL: url.href, DATABASE_URL_UNPOOLED: url.href, NODE_ENV: 'test', LOG_LEVEL: 'silent', JWT_ACCESS_SECRET: 'campaign-pipeline-qa-only-012345678901234567890', DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', AWS_ACCESS_KEY_ID: 'fixture-only', AWS_SECRET_ACCESS_KEY: 'fixture-only', AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9', FRONTEND_URL: 'http://127.0.0.1:5177', CORS_ORIGINS: 'http://127.0.0.1:5177', PERFORMANCE_METRICS: 'true', RATE_LIMIT_MAX: '100000', AUTH_RATE_LIMIT_MAX: '100000', EMAIL_DELIVERY: 'queue' })
const { prisma } = await import('../src/db/prisma.js')
const mode = process.argv[2]
const fixturePath = '/tmp/techsync-campaign-pipeline-fixture.json'
if (mode === 'seed') {
  try {
    assert.equal(await prisma.organization.count(), 0, 'Seed requires empty local database')
    const bcrypt = (await import('bcryptjs')).default
    const { consentFields } = await import('../src/services/auth.service.js')
    const { ensureLeadDefaults } = await import('../src/services/leadSetup.service.js')
    const { ensureDefaultPipeline } = await import('../src/services/pipeline.service.js')
    const passwordHash = await bcrypt.hash('FixturePassword123!', 12)
    const roles = ['owner','admin','manager','sales_rep','viewer']
    const fixtures = []
    for (let tenant = 0; tenant < 2; tenant++) {
      const users = await Promise.all(roles.map(role => prisma.user.create({ data: { fullName: `QA ${tenant} ${role}`, email:`qa-${tenant}-${role}@example.test`, passwordHash, emailVerifiedAt:new Date(), onboardingCompletedAt:new Date(), ...consentFields() } })))
      const org = await prisma.organization.create({ data:{ name:`QA Workspace ${tenant}`,slug:`campaign-pipeline-qa-${tenant}`,plan:'business',createdById:users[0].id } })
      await prisma.membership.createMany({ data:users.map((u,i)=>({organizationId:org.id,userId:u.id,role:roles[i],joinedAt:new Date()})) })
      await prisma.user.updateMany({where:{id:{in:users.map(u=>u.id)}},data:{lastActiveOrganizationId:org.id}})
      const team=await prisma.team.create({data:{organizationId:org.id,name:'QA Sales'}})
      await prisma.teamMember.createMany({data:[{teamId:team.id,userId:users[2].id,isManager:true},{teamId:team.id,userId:users[3].id}]})
      await prisma.$transaction(async tx=>{await ensureLeadDefaults(tx,org.id);await ensureDefaultPipeline(tx,org.id,'healthcare')})
      const pipeline=await prisma.pipeline.findFirst({where:{organizationId:org.id},include:{stages:{orderBy:{position:'asc'}}}})
      const source=await prisma.leadSource.findFirst({where:{organizationId:org.id,key:'website'}}) ?? await prisma.leadSource.findFirst({where:{organizationId:org.id}})
      const campaigns=[]
      for(let n=0;n<3;n++) campaigns.push(await prisma.campaign.create({data:{organizationId:org.id,name:`QA ${['Website launch','Referral follow-up','Archived tracking'][n]}`,code:`qa-${tenant}-${n}`,type:'website',objective:'lead_generation',status:['active','paused','archived'][n],startDate:new Date('2026-10-01'),currency:'INR',ownerId:users[n===1?3:0].id,createdById:users[0].id,sourceId:source.id,budgetMinor:100000n,actualSpendMinor:1051n,landingUrl:'https://example.test/enquire',utm:{utm_campaign:`qa-${tenant}-${n}`,utm_source:'website',utm_medium:'organic'}}}))
      const leads=[]
      for(let n=0;n<24;n++) leads.push(await prisma.lead.create({data:{organizationId:org.id,firstName:`QA Lead ${n}`,displayName:`QA Lead ${n}`,ownerId:users[n%2?3:0].id,status:['new','contacted','qualified','converted','lost','junk'][n%6],campaignId:n<18?campaigns[n%3].id:null,sourceId:source.id,firstRespondedAt:n%2?new Date():null,utm:n<18?{utm_campaign:campaigns[n%3].code}: {},createdAt:new Date(Date.UTC(2026,9,24,8,n))}}))
      const deals=[]
      for(let n=0;n<85;n++) {
        const stage=pipeline.stages[n<75?0:1+n%Math.max(1,pipeline.stages.length-1)]
        deals.push(await prisma.deal.create({data:{organizationId:org.id,title:`QA Deal ${n}`,pipelineId:pipeline.id,stageId:stage.id,status:stage.type,valueMinor:BigInt((n+1)*1051),currency:'INR',ownerId:users[n%2?3:0].id,leadId:leads[n%leads.length].id,sourceId:source.id,position:n,expectedCloseDate:new Date('2026-11-15'),closedAt:stage.type==='open'?null:new Date()}}))
      }
      fixtures.push({orgId:org.id,users:users.map(({id,email})=>({id,email})),pipelineId:pipeline.id,stages:pipeline.stages,campaigns:campaigns.map(({id,code,name,updatedAt})=>({id,code,name,updatedAt})),leadIds:leads.map(l=>l.id),dealIds:deals.map(d=>d.id),sourceId:source.id})
    }
    await fs.writeFile(fixturePath,JSON.stringify(fixtures,null,2))
    console.log(JSON.stringify({tenants:2,users:10,leads:48,deals:170,campaigns:6,fixturePath}))
  } finally { await prisma.$disconnect() }
} else if(mode==='serve') {
  const {default:app}=await import('../src/app.js')
  const server=app.listen(5057,'127.0.0.1',()=>console.log('QA API http://127.0.0.1:5057 (synthetic local data only)'))
  const shutdown=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();process.exit(0)}
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown)
} else {await prisma.$disconnect();throw new Error('Use seed or serve')}
