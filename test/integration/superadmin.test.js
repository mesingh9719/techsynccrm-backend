import crypto from 'node:crypto'
import express from 'express'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const { sendEmail, staffEmail, customerEmail } = vi.hoisted(() => {
  const suffix = globalThis.crypto.randomUUID()
  return {
    sendEmail: vi.fn(),
    staffEmail: `staff-${suffix}@superadmin.example.test`,
    customerEmail: `client-${suffix}@superadmin.example.test`,
  }
})
vi.mock('../../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    isProduction: false,
    DATABASE_URL:
      process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused',
    DATABASE_URL_UNPOOLED:
      process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused',
    DB_POOL_MAX: 5,
    INTERNAL_STAFF_EMAILS: [staffEmail],
    SUPPORT_INBOX: 'support@example.test',
    FRONTEND_URL: 'https://crm.example.test',
    JWT_ACCESS_SECRET: 'test-only-not-a-real-secret-01234567890123456789',
    JWT_ISSUER: 'test',
    JWT_AUDIENCE: 'test',
    JWT_ACCESS_EXPIRES_IN: '15m',
  },
}))
vi.mock('../../src/email/mailer.js', () => ({
  sendEmail,
  queueEmail: sendEmail,
}))
vi.mock('../../src/storage/files.js', () => ({ storage: {} }))

import { prisma } from '../../src/db/prisma.js'
import router from '../../src/routes/superadmin.routes.js'
import { errorHandler } from '../../src/middlewares/errorHandler.js'
import { signAccessToken } from '../../src/services/token.service.js'
import { deliverInboundReply } from '../../src/services/inboundDelivery.service.js'
import {
  queryMessageSchema,
  queryListSchema,
} from '../../src/validators/superadmin.validators.js'

const id = () => crypto.randomUUID()
let extraContactIds = []
async function cleanup() {
  const contactIds = [contact?.id, ...extraContactIds].filter(Boolean)
  if (staff) {
    await prisma.domainEvent.deleteMany({ where: { actorId: staff.id } })
    await prisma.auditLog.deleteMany({ where: { actorUserId: staff.id } })
  }
  if (contactIds.length)
    await prisma.contactRequest.deleteMany({
      where: { id: { in: contactIds } },
    })
  if (demo) await prisma.demoRequest.deleteMany({ where: { id: demo.id } })
  if (org) await prisma.organization.deleteMany({ where: { id: org.id } })
  const userIds = [staff?.id, customer?.id].filter(Boolean)
  if (userIds.length)
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  staff = customer = org = contact = demo = undefined
  extraContactIds = []
}
let staff,
  customer,
  org,
  contact,
  demo,
  token,
  customerToken,
  session,
  server,
  base
const request = async (path, method = 'GET', body, accessToken = token) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(accessToken && { authorization: `Bearer ${accessToken}` }),
      'content-type': 'application/json',
    },
    ...(body && { body: JSON.stringify(body) }),
  })
  return { status: response.status, ...(await response.json()) }
}

describe('superadmin validation', () => {
  it('rejects whitespace, unknown kinds, arbitrary recipients and oversized messages', () => {
    for (const input of [
      { kind: 'reply', body: ' ' },
      { kind: 'public', body: 'hello' },
      { kind: 'reply', body: 'hi', to: 'attacker@example.test' },
      { kind: 'note', body: 'x'.repeat(10001) },
    ])
      expect(queryMessageSchema.safeParse(input).success).toBe(false)
  })
  it('bounds lists and validates request types and statuses', () => {
    expect(queryListSchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(queryListSchema.safeParse({ type: 'user' }).success).toBe(false)
    expect(queryListSchema.safeParse({ status: 'deleted' }).success).toBe(false)
    expect(queryListSchema.parse({})).toMatchObject({
      type: 'contact',
      limit: 50,
    })
  })
})

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'superadmin API with isolated PostgreSQL',
  () => {
    beforeAll(async () => {
      const app = express()
      app.use(express.json())
      app.use('/api/superadmin', router)
      app.use(errorHandler)
      await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve)
      })
      base = `http://127.0.0.1:${server.address().port}/api/superadmin`
    })
    beforeEach(async () => {
      sendEmail.mockReset()
      sendEmail.mockResolvedValue({ messageId: 'test-message' })
      await cleanup()
      staff = await prisma.user.create({
        data: {
          fullName: 'Staff Member',
          email: staffEmail,
          passwordHash: 'unused',
          emailVerifiedAt: new Date(),
        },
      })
      customer = await prisma.user.create({
        data: {
          fullName: 'Client Owner',
          email: customerEmail,
          passwordHash: 'unused',
          emailVerifiedAt: new Date(),
        },
      })
      session = id()
      await prisma.refreshToken.create({
        data: {
          userId: staff.id,
          sessionId: session,
          tokenHash: id(),
          expiresAt: new Date(Date.now() + 3600000),
        },
      })
      token = signAccessToken(staff, null, session).accessToken
      customerToken = signAccessToken(customer, null, id()).accessToken
      org = await prisma.organization.create({
        data: {
          name: 'Superadmin Test Client',
          slug: `test-${id()}`,
          createdById: customer.id,
          plan: 'growth',
          trialEndsAt: new Date(Date.now() + 86400000),
          memberships: {
            create: { userId: customer.id, role: 'owner', status: 'active' },
          },
          usage: { create: { storageBytes: 123n } },
        },
      })
      contact = await prisma.contactRequest.create({
        data: {
          ticketNo: `TS-${id()}`,
          name: customer.fullName,
          email: customer.email,
          company: org.name,
          topic: 'support',
          message: 'Please help with setting up our workspace.',
          consentText: 'consented',
          consentAt: new Date(),
          meta: { ip: 'sensitive' },
        },
      })
      demo = await prisma.demoRequest.create({
        data: {
          confirmationId: id(),
          firstName: 'Client',
          lastName: 'Owner',
          email: customer.email,
          phone: '1234567890',
          company: org.name,
          companySize: '1–10',
          role: 'Owner',
          interests: [],
          slotStart: new Date(),
          notes: 'Show us the pipeline.',
        },
      })
    })
    afterAll(async () => {
      await new Promise((resolve) => server?.close(resolve))
      await cleanup()
      await prisma.$disconnect()
    })

    it('blocks unauthenticated and regular client accounts on every endpoint family', async () => {
      for (const path of [
        '/me',
        '/overview',
        '/clients',
        `/clients/${org.id}`,
        '/queries',
        `/queries/contact/${contact.id}`,
      ]) {
        expect((await request(path, 'GET', undefined, null)).status).toBe(401)
        expect(
          (await request(path, 'GET', undefined, customerToken)).status,
        ).toBe(404)
      }
      expect(
        (
          await request(
            `/queries/contact/${contact.id}/messages`,
            'POST',
            { kind: 'note', body: 'test' },
            customerToken,
          )
        ).status,
      ).toBe(404)
      expect(
        (
          await request(
            `/clients/${org.id}/plan`,
            'POST',
            { plan: 'business' },
            customerToken,
          )
        ).status,
      ).toBe(404)
    })
    it('rechecks staff email and session revocation against the database', async () => {
      await prisma.user.update({
        where: { id: staff.id },
        data: { email: 'former-staff@example.test' },
      })
      expect((await request('/me')).status).toBe(404)
      await prisma.user.update({
        where: { id: staff.id },
        data: { email: staff.email },
      })
      await prisma.refreshToken.updateMany({
        where: { userId: staff.id },
        data: { revokedAt: new Date() },
      })
      expect((await request('/me')).status).toBe(401)
    })
    it('requires staff email verification', async () => {
      await prisma.user.update({
        where: { id: staff.id },
        data: { emailVerifiedAt: null },
      })
      expect((await request('/overview')).status).toBe(403)
    })
    it('returns real overview counts and safe, searchable client details', async () => {
      const overview = (await request('/overview')).data
      expect(overview.clients).toBeGreaterThanOrEqual(1)
      expect(overview.users).toBeGreaterThanOrEqual(2)
      expect(overview.openQueries).toBeGreaterThanOrEqual(2)
      const search = encodeURIComponent(customerEmail)
      const clients = await request(`/clients?search=${search}&limit=1`)
      expect(clients.data.items[0].id).toBe(org.id)
      expect(
        (await request(`/clients?plan=starter&search=${search}`)).data.items,
      ).toEqual([])
      const detail = await request(`/clients/${org.id}`)
      expect(detail.data.usage.storageBytes).toBe('123')
      expect(JSON.stringify(detail)).not.toContain('passwordHash')
    })
    it('paginates and searches enquiries, handles demo requests and rejects invalid IDs', async () => {
      const second = await prisma.contactRequest.create({
        data: {
          ticketNo: id(),
          name: 'Another Client',
          email: customerEmail,
          topic: 'sales',
          message: 'A sales question',
          consentText: 'yes',
          consentAt: new Date(),
        },
      })
      extraContactIds.push(second.id)
      const search = encodeURIComponent(customerEmail)
      const first = await request(
        `/queries?type=contact&search=${search}&limit=1`,
      )
      const next = await request(
        `/queries?type=contact&search=${search}&limit=1&cursor=${first.data.nextCursor}`,
      )
      expect(new Set([first.data.items[0].id, next.data.items[0].id])).toEqual(
        new Set([contact.id, second.id]),
      )
      expect(
        (await request(`/queries?type=demo&search=${search}`)).data.items[0].id,
      ).toBe(demo.id)
      expect(
        (await request(`/queries?type=contact&topic=support&search=${search}`))
          .data.items,
      ).toHaveLength(1)
      expect((await request('/queries/contact/not-a-uuid')).status).toBe(400)
      expect((await request(`/queries/contact/${id()}`)).status).toBe(404)
    })
    it('links enquiries to client workspaces without exposing submission metadata', async () => {
      const detail = (await request(`/queries/contact/${contact.id}`)).data
      expect(detail.clients[0].id).toBe(org.id)
      expect(detail.meta).toBeUndefined()
      expect(detail.consentText).toBeUndefined()
    })
    it('persists private notes with audit history and never sends them as email', async () => {
      const result = await request(
        `/queries/contact/${contact.id}/messages`,
        'POST',
        { kind: 'note', body: 'Private escalation details' },
      )
      expect(result.status).toBe(201)
      expect(result.data.deliveryStatus).toBeNull()
      expect(
        (await request(`/queries/contact/${contact.id}`)).data.messages[0].body,
      ).toBe('Private escalation details')
      expect(
        await prisma.domainEvent.count({ where: { actorId: staff.id } }),
      ).toBe(0)
      expect(
        await prisma.auditLog.count({
          where: { action: 'inbound.note_added', actorUserId: staff.id },
        }),
      ).toBe(1)
      expect(sendEmail).not.toHaveBeenCalled()
    })
    it('saves replies and their outbox event atomically, advances status and delivers once', async () => {
      const result = await request(
        `/queries/contact/${contact.id}/messages`,
        'POST',
        { kind: 'reply', body: 'Hello <script>client</script> & team' },
      )
      expect(result.data.deliveryStatus).toBe('pending')
      expect(sendEmail).not.toHaveBeenCalled()
      expect(
        (await request(`/queries/contact/${contact.id}`)).data.status,
      ).toBe('in_progress')
      const event = await prisma.domainEvent.findFirstOrThrow({
        where: { type: 'inbound.reply_requested', actorId: staff.id },
      })
      await Promise.all([
        deliverInboundReply(event),
        deliverInboundReply(event),
      ])
      expect(sendEmail).toHaveBeenCalledTimes(1)
      expect(sendEmail.mock.calls[0][0].to).toBe(customer.email)
      expect(sendEmail.mock.calls[0][0].html).toContain('&lt;script&gt;')
      expect(
        (
          await prisma.inboundMessage.findUnique({
            where: { id: result.data.id },
          })
        ).deliveryStatus,
      ).toBe('sent')
    })
    it('records SMTP failures and supports scoped retries without duplicate delivery', async () => {
      const result = await request(
        `/queries/demo/${demo.id}/messages`,
        'POST',
        { kind: 'reply', body: 'Your demo details' },
      )
      const event = await prisma.domainEvent.findFirstOrThrow({
        where: { type: 'inbound.reply_requested', actorId: staff.id },
      })
      sendEmail.mockRejectedValueOnce(new Error('SMTP unavailable'))
      await expect(deliverInboundReply(event)).rejects.toThrow(
        'SMTP unavailable',
      )
      expect(
        (
          await prisma.inboundMessage.findUnique({
            where: { id: result.data.id },
          })
        ).deliveryStatus,
      ).toBe('failed')
      expect(
        (
          await request(
            `/queries/contact/${contact.id}/messages/${result.data.id}/retry`,
            'POST',
          )
        ).status,
      ).toBe(404)
      expect(
        (
          await request(
            `/queries/demo/${demo.id}/messages/${result.data.id}/retry`,
            'POST',
          )
        ).status,
      ).toBe(202)
      await deliverInboundReply(event)
      expect(sendEmail).toHaveBeenCalledTimes(2)
      expect(
        (
          await request(
            `/queries/demo/${demo.id}/messages/${result.data.id}/retry`,
            'POST',
          )
        ).status,
      ).toBe(409)
    })
    it('audits status transitions and prevents replies to spam', async () => {
      expect(
        (
          await request(`/queries/contact/${contact.id}`, 'PATCH', {
            status: 'spam',
          })
        ).status,
      ).toBe(200)
      expect(
        (
          await request(`/queries/contact/${contact.id}/messages`, 'POST', {
            kind: 'reply',
            body: 'Hello',
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await request(`/queries/contact/${contact.id}`, 'PATCH', {
            status: 'closed',
          })
        ).status,
      ).toBe(200)
      expect(
        await prisma.auditLog.count({
          where: { action: 'inbound.status_changed', actorUserId: staff.id },
        }),
      ).toBe(2)
    })
    it('manages client plans and trials using existing audited services', async () => {
      const trial = await request(`/clients/${org.id}/extend-trial`, 'POST', {
        days: 7,
      })
      expect(trial.status).toBe(200)
      expect(new Date(trial.data.trialEndsAt) > org.trialEndsAt).toBe(true)
      expect(
        (await request(`/clients/${org.id}/extend-trial`, 'POST', { days: 15 }))
          .status,
      ).toBe(400)
      expect(
        (await request(`/clients/${org.id}/plan`, 'POST', { plan: 'business' }))
          .status,
      ).toBe(200)
      expect(
        (await prisma.organization.findUnique({ where: { id: org.id } })).plan,
      ).toBe('business')
      expect(
        await prisma.planChange.count({
          where: { organizationId: org.id, reason: 'staff' },
        }),
      ).toBe(1)
    })
    it('enforces request foreign keys and exactly one conversation parent', async () => {
      await expect(
        prisma.inboundMessage.create({
          data: { kind: 'note', body: 'Orphan' },
        }),
      ).rejects.toThrow()
      await expect(
        prisma.inboundMessage.create({
          data: {
            contactRequestId: contact.id,
            demoRequestId: demo.id,
            kind: 'note',
            body: 'Ambiguous',
          },
        }),
      ).rejects.toThrow()
      await expect(
        prisma.inboundMessage.create({
          data: {
            contactRequestId: id(),
            kind: 'note',
            body: 'Missing parent',
          },
        }),
      ).rejects.toThrow()
    })
  },
)
