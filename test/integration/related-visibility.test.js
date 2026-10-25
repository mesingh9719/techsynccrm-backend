import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('../../src/config/env.js', () => ({ env: { NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused', DB_POOL_MAX: 5 } }))
import { prisma } from '../../src/db/prisma.js'
import { permissionsFor } from '../../src/config/permissions.js'
import { getContact, listContacts } from '../../src/services/contact.service.js'
import { getCompany, listCompanies } from '../../src/services/company.service.js'
let owner, rep, org, foreign, contact, company, context
const uuid = () => crypto.randomUUID()
describe.skipIf(!process.env.TEST_DATABASE_URL)('related records obey parent and related visibility', () => {
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.TEST_DATABASE_URL).hostname)) throw new Error('Disposable localhost required')
    ;[owner, rep] = await Promise.all([0, 1].map(i => prisma.user.create({ data: { email: `visibility-${i}-${uuid()}@example.test`, fullName: 'Visibility' } })))
    ;[org, foreign] = await Promise.all([0, 1].map(i => prisma.organization.create({ data: { name: 'Visibility ' + i, slug: uuid(), createdById: owner.id } })))
    const hiddenCompany = await prisma.company.create({ data: { organizationId: org.id, name: 'Restricted', ownerId: owner.id } })
    contact = await prisma.contact.create({ data: { organizationId: org.id, displayName: 'Visible', ownerId: rep.id } })
    await prisma.contactCompany.create({ data: { organizationId: org.id, companyId: hiddenCompany.id, contactId: contact.id } })
    const hiddenContact = await prisma.contact.create({ data: { organizationId: org.id, displayName: 'Restricted', ownerId: owner.id } })
    company = await prisma.company.create({ data: { organizationId: org.id, name: 'Visible', ownerId: rep.id } })
    await prisma.contactCompany.create({ data: { organizationId: org.id, companyId: company.id, contactId: hiddenContact.id } })
    context = { orgId: org.id, userId: rep.id, permissions: permissionsFor('sales_rep') }
  })
  afterAll(async () => {
    if (org) await prisma.organization.deleteMany({ where: { id: { in: [org.id, foreign.id] } } })
    if (owner) await prisma.user.deleteMany({ where: { id: { in: [owner.id, rep.id] } } })
    await prisma.$disconnect()
  })
  it('does not disclose a restricted company in contact list or detail', async () => {
    expect((await getContact(context, contact.id)).companies).toEqual([])
    expect((await listContacts(context, { limit: 50 })).items[0].companies).toEqual([])
    expect((await getContact({ ...context, permissions: permissionsFor('owner') }, contact.id)).companies).toHaveLength(1)
  })
  it('does not disclose restricted contact counts in company list or detail', async () => {
    expect((await getCompany(context, company.id)).contactCount).toBe(0)
    expect((await listCompanies(context, { limit: 50 })).items[0].contactCount).toBe(0)
    expect((await getCompany({ ...context, permissions: permissionsFor('owner') }, company.id)).contactCount).toBe(1)
  })
  it('rejects a foreign parent even for an owner', async () => {
    const other = { ...context, orgId: foreign.id, permissions: permissionsFor('owner') }
    await expect(getContact(other, contact.id)).rejects.toMatchObject({ statusCode: 404 })
    await expect(getCompany(other, company.id)).rejects.toMatchObject({ statusCode: 404 })
  })
})
