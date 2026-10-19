/**
 * Development seed: `npm run db:seed`. Idempotent — safe to run repeatedly.
 * Creates a verified, onboarded demo user. Later modules add their own sample data here.
 *
 * Refuses to run against a production Neon branch unless `--force` is passed.
 */
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db/prisma.js'
import { createOrganizationTx, withSlugRetry } from '../src/services/organization.service.js'

const DEMO_EMAIL = process.env.SEED_EMAIL ?? 'demo@techsync.local'
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'Demo12345'

function guardProduction() {
  const branch = process.env.NEON_BRANCH ?? ''
  const isProd = process.env.NODE_ENV === 'production' || /^(main|production)$/i.test(branch)
  if (isProd && !process.argv.includes('--force')) {
    console.error(`[seed] Refusing to seed: this looks like production (NEON_BRANCH="${branch}", NODE_ENV="${process.env.NODE_ENV}").`)
    console.error('[seed] Point DATABASE_URL at a development branch, or pass --force if you really mean it.')
    process.exit(1)
  }
}

async function seedDemoUser() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12)
  const now = new Date()
  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: {
      fullName: 'Demo User',
      email: DEMO_EMAIL,
      passwordHash,
      emailVerifiedAt: now,
      jobRole: 'Founder',
      phone: '+91 98450 12345',
      goals: ['capture_leads', 'manage_pipeline'],
      onboardingCompletedAt: now,
    },
    select: { id: true, email: true },
  })
  console.log(`[seed] demo user: ${user.email} / ${DEMO_PASSWORD}`)
  return user
}

async function seedWorkspace(user) {
  const existing = await prisma.membership.findFirst({ where: { userId: user.id, status: 'active' }, select: { organizationId: true } })
  if (existing) return
  const org = await withSlugRetry((tx) =>
    createOrganizationTx(tx, { userId: user.id }, { company: 'Saffron Retail', industry: 'Retail & distribution', teamSize: '11–50' }, { plan: 'growth' }),
  )
  await prisma.organization.update({
    where: { id: org.id },
    data: { stateCode: '29', legalName: 'Saffron Retail Pvt. Ltd.', address: { line1: '12 MG Road', line2: null, city: 'Bengaluru', pincode: '560001' } },
  })
  console.log(`[seed] workspace: ${org.name} (${org.slug})`)
}

// ---------- CRM sample data (M07, M08) ----------

const FIRST = ['Ritika', 'Arjun', 'Priya', 'Rahul', 'Ananya', 'Vikram', 'Sneha', 'Karan', 'Meera', 'Rohan', 'Divya', 'Aditya', 'Kavya', 'Siddharth', 'Neha', 'Imran', 'Pooja', 'Manish', 'Lakshmi', 'Harpreet']
const LAST = ['Sharma', 'Iyer', 'Patel', 'Reddy', 'Gupta', 'Nair', 'Singh', 'Mehta', 'Rao', 'Khan', 'Joshi', 'Banerjee', 'Kulkarni', 'Menon', 'Chopra']
const COMPANIES = [
  ['Saffron Retail', 'saffronretail.in', 'Retail & distribution', 'Bengaluru', '29'],
  ['Northwind Steel', 'northwindsteel.co.in', 'Manufacturing', 'Pune', '27'],
  ['Kaveri Textiles', 'kaveritextiles.com', 'Manufacturing', 'Coimbatore', '33'],
  ['Brightpath Academy', 'brightpath.edu.in', 'Education', 'Hyderabad', '36'],
  ['Lotus Realty', 'lotusrealty.in', 'Real estate', 'Gurugram', '06'],
  ['Medicare Plus Clinics', 'medicareplus.in', 'Healthcare', 'Chennai', '33'],
  ['Indus Logistics', 'induslogistics.in', 'Retail & distribution', 'Ahmedabad', '24'],
  ['Pinnacle Consulting', 'pinnacleconsult.in', 'Professional services', 'Mumbai', '27'],
  ['GreenLeaf Organics', 'greenleaforganics.in', 'Retail & distribution', 'Jaipur', '08'],
  ['Shakti Electricals', 'shaktielectricals.com', 'Manufacturing', 'Kolkata', '19'],
]
const REQUIREMENTS = ['50 units of industrial fans', 'CRM for a 12-person sales team', 'Bulk order of cotton fabric', 'Office space, 2,000 sq ft', 'Annual maintenance contract', 'School management software', 'Solar panels for factory roof', 'Packaging material, monthly', 'Franchise enquiry', 'Corporate gifting for Diwali']

const pick = (list, i) => list[i % list.length]
const mobile = (i) => `+91 9${String(800000000 + i * 7919).slice(0, 9)}`

async function seedCrm(user) {
  const membership = await prisma.membership.findFirst({ where: { userId: user.id, status: 'active' }, select: { organizationId: true, role: true, organization: { select: { timezone: true } } } })
  if (!membership) return
  const orgId = membership.organizationId
  if (await prisma.contact.count({ where: { organizationId: orgId } })) return console.log('[seed] CRM data already present')

  const { permissionsFor } = await import('../src/config/permissions.js')
  const ctx = {
    userId: user.id,
    orgId,
    role: membership.role,
    permissions: permissionsFor(membership.role),
    managedUserIds: [],
    plan: 'growth',
    country: 'IN',
    timezone: membership.organization.timezone,
    actorType: 'user',
  }
  const { createCompany } = await import('../src/services/company.service.js')
  const { createContact } = await import('../src/services/contact.service.js')
  const { createLead, changeStatus } = await import('../src/services/lead.service.js')
  const { createTag } = await import('../src/services/tag.service.js')

  const tags = []
  for (const [name, color] of [['VIP', 'amber'], ['Distributor', 'violet'], ['Follow up', 'sky'], ['Price sensitive', 'red']]) tags.push(await createTag(ctx, { name, color }))

  const companies = []
  for (const [name, domain, industry, city, stateCode] of COMPANIES) {
    companies.push(
      await createCompany(ctx, { name, domain, industry, size: '11–50', phone: mobile(companies.length + 900), billingAddress: { line1: null, line2: null, city, stateCode, pincode: null, country: 'IN' } }, { allowDuplicate: true }),
    )
  }

  for (let i = 0; i < 30; i++) {
    const firstName = pick(FIRST, i)
    const lastName = pick(LAST, i * 3 + 1)
    const company = companies[i % companies.length]
    await createContact(
      ctx,
      {
        firstName,
        lastName,
        title: pick(['Owner', 'Purchase head', 'Operations manager', 'Director', 'Accounts'], i),
        emails: [{ value: `${firstName}.${lastName}${i}@${company.domain}`.toLowerCase(), primary: true }],
        phones: [{ raw: mobile(i), primary: true, whatsapp: i % 2 === 0 }],
        lifecycleStage: i % 5 === 0 ? 'customer' : 'lead',
        companies: [{ companyId: company.id, isPrimary: true }],
        tagIds: i % 4 === 0 ? [tags[i % tags.length].id] : [],
        whatsappOptIn: i % 2 === 0,
      },
      { allowDuplicate: true },
    )
  }

  const sources = await prisma.leadSource.findMany({ where: { organizationId: orgId }, select: { id: true } })
  const reasons = await prisma.lostReason.findMany({ where: { organizationId: orgId, entityType: 'lead' }, select: { id: true } })
  const plan = ['new', 'new', 'new', 'contacted', 'contacted', 'qualified', 'lost', 'junk']
  for (let i = 0; i < 60; i++) {
    const firstName = pick(FIRST, i + 7)
    const lead = await createLead(
      ctx,
      {
        firstName,
        lastName: pick(LAST, i * 2 + 5),
        phones: [{ raw: mobile(100 + i), primary: true }],
        emails: i % 3 === 0 ? [] : [{ value: `${firstName.toLowerCase()}${i}@example.in`, primary: true }],
        companyName: i % 4 === 0 ? null : `${pick(LAST, i)} ${pick(['Traders', 'Enterprises', 'Industries', 'Associates'], i)}`,
        requirement: pick(REQUIREMENTS, i),
        budgetMinor: i % 3 === 0 ? null : (5 + (i % 20)) * 10_000 * 100,
        city: pick(['Bengaluru', 'Mumbai', 'Delhi', 'Pune', 'Chennai', 'Hyderabad'], i),
        sourceId: pick(sources, i).id,
        ownerId: i % 5 === 0 ? null : user.id,
        tagIds: i % 6 === 0 ? [tags[2].id] : [],
      },
      { allowDuplicate: true },
    )
    const target = pick(plan, i)
    if (target === 'contacted') await changeStatus(ctx, lead.id, { status: 'contacted' })
    if (target === 'qualified') await changeStatus(ctx, lead.id, { status: 'qualified' })
    if (target === 'lost') await changeStatus(ctx, lead.id, { status: 'lost', lostReasonId: pick(reasons, i).id })
    if (target === 'junk') await changeStatus(ctx, lead.id, { status: 'junk', junkReason: 'spam' })
  }
  console.log('[seed] CRM: 10 companies, 30 contacts, 60 leads')
}

// ---------- Deals, activities & tasks (M09, M10) ----------

async function demoContext(user) {
  const membership = await prisma.membership.findFirst({
    where: { userId: user.id, status: 'active' },
    select: { organizationId: true, role: true, organization: { select: { timezone: true, plan: true, currency: true } } },
  })
  if (!membership) return null
  const { permissionsFor } = await import('../src/config/permissions.js')
  return {
    userId: user.id,
    orgId: membership.organizationId,
    role: membership.role,
    permissions: permissionsFor(membership.role),
    managedUserIds: [],
    plan: membership.organization.plan,
    currency: membership.organization.currency,
    country: 'IN',
    timezone: membership.organization.timezone,
    fiscalYearStartMonth: 4,
    actorType: 'user',
  }
}

const DEAL_TITLES = ['Annual supply contract', 'Pilot order', 'Showroom fit-out', 'AMC renewal', 'Bulk order — Diwali', 'New branch rollout', 'Software licences', 'Packaging tender']

async function seedDeals(user) {
  const ctx = await demoContext(user)
  if (!ctx) return
  if (await prisma.deal.count({ where: { organizationId: ctx.orgId } })) return console.log('[seed] deals already present')
  const { createDeal, moveDeal } = await import('../src/services/deal.service.js')
  const pipeline = await prisma.pipeline.findFirst({ where: { organizationId: ctx.orgId, isDefault: true }, select: { stages: { orderBy: { position: 'asc' }, select: { id: true, type: true } } } })
  if (!pipeline) return console.log('[seed] no pipeline — run the migrations first')
  const open = pipeline.stages.filter((s) => s.type === 'open')
  const won = pipeline.stages.find((s) => s.type === 'won')
  const lost = pipeline.stages.find((s) => s.type === 'lost')
  const companies = await prisma.company.findMany({ where: { organizationId: ctx.orgId, deletedAt: null }, select: { id: true, name: true }, take: 10 })
  const contacts = await prisma.contactCompany.findMany({ where: { organizationId: ctx.orgId }, select: { contactId: true, companyId: true } })
  const lostReasons = await prisma.lostReason.findMany({ where: { organizationId: ctx.orgId, entityType: 'deal' }, select: { id: true } })
  const today = new Date()
  for (let i = 0; i < 40; i++) {
    const company = companies[i % companies.length]
    const contact = contacts.find((c) => c.companyId === company.id)
    const close = new Date(today.getTime() + ((i % 9) - 2) * 15 * 86_400_000)
    const deal = await createDeal(ctx, {
      title: `${company.name} — ${pick(DEAL_TITLES, i)}`,
      stageId: open[i % open.length].id,
      valueMinor: (2 + ((i * 7) % 40)) * 25_000 * 100,
      expectedCloseDate: close.toISOString().slice(0, 10),
      companyId: company.id,
      contacts: contact ? [{ contactId: contact.contactId, isPrimary: true, role: 'Decision maker' }] : [],
    })
    if (i % 8 === 6 && won) await moveDeal(ctx, deal.id, { stageId: won.id })
    if (i % 8 === 7 && lost) await moveDeal(ctx, deal.id, { stageId: lost.id, lostReasonId: pick(lostReasons, i).id })
    // Some deals look idle so the board shows rotting badges.
    if (i % 5 === 0) await prisma.deal.update({ where: { id: deal.id }, data: { lastActivityAt: new Date(today.getTime() - 12 * 86_400_000), stageEnteredAt: new Date(today.getTime() - 12 * 86_400_000) } })
  }
  console.log('[seed] deals: 40 across the default pipeline')
}

async function seedWork(user) {
  const ctx = await demoContext(user)
  if (!ctx) return
  if (await prisma.task.count({ where: { organizationId: ctx.orgId } })) return console.log('[seed] tasks already present')
  const { logActivity } = await import('../src/services/activity.service.js')
  const { createTask } = await import('../src/services/task.service.js')
  const leads = await prisma.lead.findMany({ where: { organizationId: ctx.orgId, status: { in: ['new', 'contacted', 'qualified'] } }, select: { id: true, displayName: true }, take: 12 })
  const deals = await prisma.deal.findMany({ where: { organizationId: ctx.orgId, status: 'open' }, select: { id: true, title: true }, take: 8 })
  for (const [i, lead] of leads.entries()) {
    if (i % 3 === 0) await logActivity(ctx, { type: 'call', entityType: 'lead', entityId: lead.id, direction: 'outbound', outcome: pick(['connected', 'no_answer', 'callback_requested'], i), durationSeconds: 120 + i * 30, body: 'Discussed requirement and timelines.' })
    if (i % 4 === 1) await logActivity(ctx, { type: 'note', entityType: 'lead', entityId: lead.id, body: '**Interested** in a demo next week. Prefers WhatsApp.' })
  }
  for (const [i, deal] of deals.entries()) {
    await logActivity(ctx, { type: i % 2 ? 'meeting' : 'site_visit', entityType: 'deal', entityId: deal.id, subject: i % 2 ? 'Requirement walkthrough' : 'Site visit', occurredAt: new Date(Date.now() - (i + 1) * 86_400_000).toISOString(), body: 'Met the purchase team; sending revised quote.' })
  }
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const tasks = [
    ...leads.slice(0, 5).map((l, i) => ({ title: `Call ${l.displayName}`, type: 'call', entityType: 'lead', entityId: l.id, dueDate: day(i - 2) })),
    ...deals.slice(0, 4).map((d, i) => ({ title: `Send revised quote — ${d.title}`, type: 'email', entityType: 'deal', entityId: d.id, dueAt: new Date(Date.now() + (i + 1) * 3 * 3600_000).toISOString(), priority: i === 0 ? 'high' : 'normal' })),
    { title: 'Weekly pipeline review', type: 'meeting', dueDate: day(1), recurrence: { freq: 'weekly', byWeekday: [1] } },
  ]
  for (const t of tasks) await createTask(ctx, t)
  console.log(`[seed] activities and ${tasks.length} tasks`)
}

// M11: a visible inbox example without sending notification email.
async function seedNotifications(user) {
  const ctx = await demoContext(user)
  if (!ctx || await prisma.notification.count({ where: { organizationId: ctx.orgId, userId: user.id } })) return
  const { emit } = await import('../src/events/outbox.js')
  const { handleNotificationEvent } = await import('../src/services/notification.service.js')
  const saved = await prisma.$transaction((tx) => emit(tx, { orgId: ctx.orgId, userId: null }, 'notification.announced', { entityType: 'organization', entityId: ctx.orgId }, { title: 'Your notification inbox is ready', body: 'Assignments, mentions and task reminders will appear here. Choose your email and digest preferences in Settings.' }))
  await handleNotificationEvent(await prisma.domainEvent.findUniqueOrThrow({ where: { id: saved.id } }))
  console.log('[seed] notification inbox example created')
}

async function main() {
  guardProduction()
  const user = await seedDemoUser()
  await seedWorkspace(user)
  await seedCrm(user)
  await seedDeals(user)
  await seedWork(user)
  await seedNotifications(user)
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
