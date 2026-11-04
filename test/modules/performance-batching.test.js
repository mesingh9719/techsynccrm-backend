import { beforeEach, describe, expect, it, vi } from 'vitest'

const { db } = vi.hoisted(() => ({
  db: {
    membership: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
    teamMember: { findMany: vi.fn() },
    role: { findMany: vi.fn() },
    notification: { findMany: vi.fn() },
    task: { findMany: vi.fn() },
    deal: { findMany: vi.fn() },
    mention: { findMany: vi.fn() },
    lead: { findMany: vi.fn() },
    contact: { findMany: vi.fn() },
    company: { findMany: vi.fn() },
  },
}))
vi.mock('../../src/db/prisma.js', () => ({ prisma: db, DB_NULL: 'DB_NULL', UNIQUE_VIOLATION: 'P2002' }))
vi.mock('../../src/middlewares/auth.js', () => ({ requireAuth: vi.fn() }))

import { permissionsFor } from '../../src/config/permissions.js'
import { emitMany } from '../../src/events/outbox.js'
import { loadOrgContext } from '../../src/middlewares/org.js'
import { readableNotifications, unreadCount } from '../../src/services/notification.service.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

beforeEach(() => vi.clearAllMocks())

describe('emitMany', () => {
  it('writes one outbox row per record in a single insert', async () => {
    const tx = { domainEvent: { createMany: vi.fn().mockResolvedValue({ count: 2 }) } }
    await emitMany(tx, { orgId: ORG, userId: ME }, 'lead.assigned', 'lead', ['l1', 'l2'], (id) => ({ changes: { ownerId: [id, ME] }, bulk: true }))
    expect(tx.domainEvent.createMany).toHaveBeenCalledExactlyOnceWith({
      data: ['l1', 'l2'].map((entityId) => ({ organizationId: ORG, actorId: ME, type: 'lead.assigned', entityType: 'lead', entityId, payload: { changes: { ownerId: [entityId, ME] }, bulk: true } })),
    })
  })
  it('skips empty batches and rejects badly named events', async () => {
    const tx = { domainEvent: { createMany: vi.fn() } }
    await expect(emitMany(tx, null, 'lead.deleted', 'lead', [])).resolves.toEqual({ count: 0 })
    expect(tx.domainEvent.createMany).not.toHaveBeenCalled()
    await expect(emitMany(tx, null, 'LeadDeleted', 'lead', ['x'])).rejects.toThrow(/Invalid event type/)
  })
})

describe('loadOrgContext', () => {
  const org = { id: ORG, plan: 'growth', timezone: 'Asia/Kolkata', currency: 'INR', country: 'IN', locale: 'en-IN', fiscalYearStartMonth: 4, require2fa: false, trialEndsAt: null, seatSelectionRequiredAt: null, deletedAt: null }
  const user = { email: 'me@example.com', emailVerifiedAt: new Date(), twoFactorEnabledAt: null, deletedAt: null }
  const req = () => ({ user: { id: ME, orgId: ORG, sid: 's1' }, ip: '127.0.0.1', get: () => 'vitest' })

  it('loads membership, user and workspace in parallel and builds req.ctx', async () => {
    const order = []
    const defer = (name, value) => () => {
      order.push(`start:${name}`)
      return Promise.resolve().then(() => {
        order.push(`end:${name}`)
        return value
      })
    }
    db.membership.findUnique.mockImplementation(defer('membership', { role: 'admin', status: 'active' }))
    db.user.findUnique.mockImplementation(defer('user', user))
    db.organization.findUnique.mockImplementation(defer('organization', org))
    const r = req()
    const res = { set: vi.fn() }
    const next = vi.fn()
    await loadOrgContext(r, res, next)
    expect(next).toHaveBeenCalledWith()
    expect(res.set).toHaveBeenCalledWith('X-Access-Version', expect.stringMatching(/^[A-Za-z0-9_-]{12}$/))
    expect(db.role.findMany).not.toHaveBeenCalled()
    expect(order.slice(0, 3)).toEqual(['start:membership', 'start:user', 'start:organization'])
    expect(r.ctx).toMatchObject({ userId: ME, orgId: ORG, role: 'admin', email: user.email, plan: 'growth', timezone: 'Asia/Kolkata', teamIds: [], managedUserIds: [] })
    expect(db.teamMember.findMany).not.toHaveBeenCalled()
  })
  it.each([
    ['no membership', null, user, org, 'ORG_REQUIRED'],
    ['deleted user', { role: 'admin', status: 'active' }, { ...user, deletedAt: new Date() }, org, 'ORG_REQUIRED'],
    ['unverified email', { role: 'admin', status: 'active' }, { ...user, emailVerifiedAt: null }, org, 'EMAIL_NOT_VERIFIED'],
    ['inactive membership', { role: 'admin', status: 'deactivated' }, user, org, 'ORG_REQUIRED'],
    ['deleted workspace', { role: 'admin', status: 'active' }, user, { ...org, deletedAt: new Date() }, 'ORG_REQUIRED'],
  ])('rejects %s', async (_label, membership, u, o, code) => {
    db.membership.findUnique.mockResolvedValue(membership)
    db.user.findUnique.mockResolvedValue(u)
    db.organization.findUnique.mockResolvedValue(o)
    const next = vi.fn()
    await loadOrgContext(req(), { set: vi.fn() }, next)
    expect(next.mock.calls[0][0]).toMatchObject({ code })
  })
  it('uses an edited system role once the workspace has role changes, cached per version', async () => {
    const otherOrg = '22222222-2222-4222-8222-222222222222'
    db.membership.findUnique.mockResolvedValue({ role: 'sales_rep', roleId: null, status: 'active' })
    db.user.findUnique.mockResolvedValue(user)
    db.organization.findUnique.mockResolvedValue({ ...org, id: otherOrg, rolesVersion: 3 })
    db.role.findMany.mockResolvedValue([{ id: 'r1', systemKey: 'sales_rep', permissions: ['leads.read.own', 'leads.read.all', 'leads.create', 'bogus.permission', 'organization.delete'], archivedAt: null }])
    for (let i = 0; i < 2; i++) {
      const r = { ...req(), user: { id: ME, orgId: otherOrg } }
      await loadOrgContext(r, { set: vi.fn() }, vi.fn())
      expect(r.ctx.permissions).toEqual(['leads.create', 'leads.read.all'])
    }
    expect(db.role.findMany).toHaveBeenCalledTimes(1)
  })
})

describe('notification access checks are batched per page', () => {
  const ctx = { orgId: ORG, userId: ME, role: 'admin', permissions: permissionsFor('admin'), managedUserIds: [], timezone: 'Asia/Kolkata', user: { id: ME }, organization: { id: ORG, name: 'Acme' } }
  const old = new Date(Date.now() - 30 * 86400000)
  const rows = [
    { id: 'n1', type: 'lead_assigned', entityType: 'lead', entityId: 'l1', context: {} },
    { id: 'n2', type: 'task_assigned', entityType: 'task', entityId: 't1', context: {} },
    { id: 'n3', type: 'task_assigned', entityType: 'task', entityId: 't2', context: {} },
    { id: 'n4', type: 'mention', entityType: 'lead', entityId: 'l1', context: { activityId: 'a1' } },
    { id: 'n5', type: 'mention', entityType: 'lead', entityId: 'l1', context: { activityId: 'a2' } },
    { id: 'n6', type: 'deal_rotting', entityType: 'deal', entityId: 'd1', context: {} },
    { id: 'n7', type: 'deal_rotting', entityType: 'deal', entityId: 'd2', context: {} },
  ]
  beforeEach(() => {
    db.task.findMany.mockResolvedValue([
      { id: 't1', title: 'Hidden record', entityType: 'lead', entityId: 'l2', assigneeId: ME, status: 'open', dueAt: null, remindAt: null },
      { id: 't2', title: 'Standalone', entityType: null, entityId: null, assigneeId: ME, status: 'open', dueAt: null, remindAt: null },
    ])
    db.mention.findMany.mockResolvedValue([{ activityId: 'a1' }])
    db.lead.findMany.mockResolvedValue([{ id: 'l1', ownerId: ME, displayName: 'Lead one' }])
    db.deal.findMany.mockImplementation(({ select }) =>
      Promise.resolve(
        select.stage
          ? [
              { id: 'd1', status: 'open', lastActivityAt: old, stageEnteredAt: old, stage: { rottingDays: 7 } },
              { id: 'd2', status: 'open', lastActivityAt: new Date(), stageEnteredAt: old, stage: { rottingDays: 7 } },
            ]
          : [{ id: 'd1', ownerId: ME, title: 'Deal one' }, { id: 'd2', ownerId: ME, title: 'Deal two' }],
      ),
    )
  })

  it('applies the same per-notification rules from prefetched sets, without per-row queries', async () => {
    const out = await readableNotifications(ctx, rows)
    expect(out.map((r) => r.id)).toEqual(['n1', 'n3', 'n4', 'n6'])
    expect(db.task.findMany).toHaveBeenCalledOnce()
    expect(db.mention.findMany).toHaveBeenCalledOnce()
    expect(db.mention.findMany.mock.calls[0][0].where).toMatchObject({ organizationId: ORG, userId: ME, activityId: { in: ['a1', 'a2'] } })
    expect(db.lead.findMany).toHaveBeenCalledOnce()
    expect(db.lead.findMany.mock.calls[0][0].where.AND[0].id).toEqual({ in: ['l1', 'l2'] })
    expect(db.deal.findMany).toHaveBeenCalledTimes(2)
  })
  it('skips prefetch queries that a page does not need', async () => {
    await readableNotifications(ctx, [rows[0]])
    expect(db.task.findMany).not.toHaveBeenCalled()
    expect(db.mention.findMany).not.toHaveBeenCalled()
    expect(db.deal.findMany).not.toHaveBeenCalled()
  })
  it('loads the recipient context once while counting several pages', async () => {
    db.membership.findUnique.mockResolvedValue({
      role: 'admin',
      status: 'active',
      user: { id: ME, emailVerifiedAt: new Date(), deletedAt: null, timezone: null },
      organization: { id: ORG, name: 'Acme', timezone: 'Asia/Kolkata', plan: 'growth', require2fa: false, deletedAt: null, seatSelectionRequiredAt: null },
    })
    const id = (n) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`
    const page = (n, from) => Array.from({ length: n }, (_, i) => ({ id: id(from + i), type: 'system', entityType: null, entityId: null, context: {}, createdAt: new Date(Date.UTC(2026, 0, 1) - (from + i) * 1000) }))
    const all = page(2500, 0)
    // Honours the id-ascending keyset, like the real query.
    db.notification.findMany.mockImplementation(({ where, take, orderBy }) => {
      expect(where).toMatchObject({ organizationId: ORG, userId: ME, inApp: true, readAt: null })
      expect(orderBy).toEqual({ id: 'asc' })
      const after = where.id?.gt
      return Promise.resolve(all.filter((n) => !after || n.id > after).slice(0, take))
    })
    await expect(unreadCount({ orgId: ORG, userId: ME })).resolves.toBe(2500)
    expect(db.membership.findUnique).toHaveBeenCalledOnce()
    // 2,500 unread rows: three batched scans, not 25 API-sized pages.
    expect(db.notification.findMany).toHaveBeenCalledTimes(3)
  })
})
