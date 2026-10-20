import { prisma } from '../db/prisma.js'
import { buildPage, parseListQuery } from '../lib/pagination.js'
import { recordAudit } from '../lib/audit.js'
import { emit } from '../events/outbox.js'
import { ApiError } from '../utils/ApiError.js'

const requestModel = (type) => {
  if (!['contact', 'demo'].includes(type))
    throw ApiError.notFound('Enquiry not found')
  return type === 'contact' ? 'contactRequest' : 'demoRequest'
}
const requestKey = (type, id) => ({
  [type === 'contact' ? 'contactRequestId' : 'demoRequestId']: id,
})
const author = { select: { fullName: true } }
const clientSelect = {
  id: true,
  name: true,
  slug: true,
  industry: true,
  teamSize: true,
  plan: true,
  trialEndsAt: true,
  createdAt: true,
  memberships: {
    where: { role: 'owner', status: 'active', user: { deletedAt: null } },
    select: { user: { select: { fullName: true, email: true } } },
    take: 1,
  },
  _count: { select: { memberships: { where: { status: 'active' } } } },
}
const contains = (text) => ({ contains: text, mode: 'insensitive' })

export async function overview() {
  const open = { status: { in: ['new', 'in_progress'] } }
  const [clients, users, trials, contacts, demos, newContacts, newDemos] =
    await Promise.all([
      prisma.organization.count({ where: { deletedAt: null } }),
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.organization.count({
        where: { deletedAt: null, trialEndsAt: { gt: new Date() } },
      }),
      prisma.contactRequest.count({ where: open }),
      prisma.demoRequest.count({ where: open }),
      prisma.contactRequest.count({ where: { status: 'new' } }),
      prisma.demoRequest.count({ where: { status: 'new' } }),
    ])
  return {
    clients,
    users,
    trials,
    openQueries: contacts + demos,
    newQueries: newContacts + newDemos,
    contacts,
    demos,
  }
}

export async function listClients({ search, plan, ...query }) {
  const page = parseListQuery(query, {
    sortable: { createdAt: 'date', name: 'string' },
    defaultSort: '-createdAt',
  })
  const rows = await prisma.organization.findMany({
    where: {
      deletedAt: null,
      ...(plan && { plan }),
      ...(search && {
        OR: [
          { name: contains(search) },
          { slug: contains(search) },
          {
            memberships: {
              some: {
                status: 'active',
                user: { deletedAt: null, email: contains(search) },
              },
            },
          },
        ],
      }),
      ...page.cursorWhere,
    },
    select: clientSelect,
    orderBy: page.orderBy,
    take: page.take,
  })
  return buildPage(rows, page)
}

export async function clientDetail(id) {
  const org = await prisma.organization.findFirst({
    where: { id, deletedAt: null },
    select: {
      ...clientSelect,
      timezone: true,
      country: true,
      currency: true,
      require2fa: true,
      memberships: {
        select: {
          id: true,
          role: true,
          status: true,
          user: {
            select: {
              fullName: true,
              email: true,
              deletedAt: true,
              emailVerifiedAt: true,
              twoFactorEnabledAt: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
      usage: {
        select: {
          users: true,
          records: true,
          pipelines: true,
          storageBytes: true,
          updatedAt: true,
        },
      },
      planChanges: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        select: {
          id: true,
          fromPlan: true,
          toPlan: true,
          reason: true,
          createdAt: true,
        },
      },
    },
  })
  if (!org) throw ApiError.notFound('Client not found')
  return {
    ...org,
    usage: org.usage
      ? { ...org.usage, storageBytes: String(org.usage.storageBytes) }
      : null,
  }
}

export async function listQueries({ type, status, search, topic, ...query }) {
  const page = parseListQuery(query, {
    sortable: { createdAt: 'date' },
    defaultSort: '-createdAt',
  })
  const fields =
    type === 'contact'
      ? ['ticketNo', 'name', 'email', 'company', 'message']
      : ['confirmationId', 'firstName', 'lastName', 'email', 'company', 'notes']
  const rows = await prisma[requestModel(type)].findMany({
    where: {
      ...(status && { status }),
      ...(type === 'contact' && topic && { topic }),
      ...(search && { OR: fields.map((key) => ({ [key]: contains(search) })) }),
      ...page.cursorWhere,
    },
    select:
      type === 'contact'
        ? {
            id: true,
            ticketNo: true,
            name: true,
            email: true,
            company: true,
            topic: true,
            message: true,
            status: true,
            createdAt: true,
          }
        : {
            id: true,
            confirmationId: true,
            firstName: true,
            lastName: true,
            email: true,
            company: true,
            notes: true,
            slotStart: true,
            status: true,
            createdAt: true,
          },
    orderBy: page.orderBy,
    take: page.take,
  })
  return buildPage(rows, page)
}

export async function queryDetail(type, id) {
  const row = await prisma[requestModel(type)].findUnique({ where: { id } })
  if (!row) throw ApiError.notFound('Enquiry not found')
  // Attribution/IP metadata is deliberately omitted from the staff response.
  const { meta, consentText, consentAt, ...safe } = row
  const [messages, clients] = await Promise.all([
    prisma.inboundMessage.findMany({
      where: requestKey(type, id),
      include: { author },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    }),
    prisma.organization.findMany({
      where: {
        deletedAt: null,
        memberships: {
          some: {
            status: 'active',
            user: { email: row.email, deletedAt: null },
          },
        },
      },
      select: { id: true, name: true, plan: true },
      take: 20,
    }),
  ])
  return {
    ...safe,
    type,
    messages: messages.reverse(),
    historyTruncated: messages.length === 100,
    clients,
  }
}

async function lockRequest(tx, type, id) {
  requestModel(type)
  // Read the fields needed by the mutation while taking the lock in one round trip.
  const [row] = type === 'contact'
    ? await tx.$queryRaw`SELECT id, status::text AS status FROM contact_requests WHERE id = ${id}::uuid FOR UPDATE`
    : await tx.$queryRaw`SELECT id, status::text AS status FROM demo_requests WHERE id = ${id}::uuid FOR UPDATE`
  if (!row) throw ApiError.notFound('Enquiry not found')
  return row
}

export async function updateQueryStatus(ctx, type, id, status) {
  return prisma.$transaction(async (tx) => {
    const before = await lockRequest(tx, type, id)
    await tx[requestModel(type)].update({ where: { id }, data: { status } })
    await recordAudit(tx, ctx, {
      action: 'inbound.status_changed',
      entityType: `${type}_request`,
      entityId: id,
      changes: { status: [before.status, status] },
    })
    return { status }
  })
}

export async function addQueryMessage(ctx, type, id, { kind, body }) {
  return prisma.$transaction(async (tx) => {
    const row = await lockRequest(tx, type, id)
    if (kind === 'reply' && row.status === 'spam')
      throw ApiError.badRequest('Reopen this enquiry before replying to it.')
    const message = await tx.inboundMessage.create({
      data: {
        ...requestKey(type, id),
        authorId: ctx.userId,
        kind,
        body,
        deliveryStatus: kind === 'reply' ? 'pending' : null,
      },
      include: { author },
    })
    if (kind === 'reply') {
      await emit(tx, ctx, 'inbound.reply_requested', {
        entityType: 'inbound_message',
        entityId: message.id,
      })
      if (row.status === 'new')
        await tx[requestModel(type)].update({
          where: { id },
          data: { status: 'in_progress' },
        })
    }
    await recordAudit(tx, ctx, {
      action: `inbound.${kind}_added`,
      entityType: `${type}_request`,
      entityId: id,
      changes: { messageId: message.id },
    })
    return message
  })
}

export async function retryReply(ctx, type, id, messageId) {
  return prisma.$transaction(async (tx) => {
    await lockRequest(tx, type, id)
    await tx.$queryRaw`SELECT id FROM inbound_messages WHERE id = ${messageId}::uuid FOR UPDATE`
    const message = await tx.inboundMessage.findFirst({
      where: { id: messageId, ...requestKey(type, id), kind: 'reply' },
    })
    if (!message) throw ApiError.notFound('Reply not found')
    if (message.deliveryStatus !== 'failed')
      throw ApiError.conflict('Only failed replies can be retried.')
    await tx.inboundMessage.update({
      where: { id: messageId },
      data: { deliveryStatus: 'pending' },
    })
    await emit(tx, ctx, 'inbound.reply_requested', {
      entityType: 'inbound_message',
      entityId: messageId,
    })
    await recordAudit(tx, ctx, {
      action: 'inbound.reply_retried',
      entityType: `${type}_request`,
      entityId: id,
      changes: { messageId },
    })
    return { deliveryStatus: 'pending' }
  })
}
