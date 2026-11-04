import { beforeEach, describe, expect, it, vi } from 'vitest'

const { db } = vi.hoisted(() => ({
  db: {
    role: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    membership: { groupBy: vi.fn(), findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
    invitation: { updateMany: vi.fn() },
    organization: { update: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('../../src/db/prisma.js', () => ({ prisma: db, DB_NULL: 'DB_NULL', UNIQUE_VIOLATION: 'P2002' }))

import { permissionsFor, rolePermissionProblems, sanitizePermissions } from '../../src/config/permissions.js'
import { createRole, deleteRole, getCatalogue, listRoles, myRole, previewRole, resetSystemRole, resolveRoleChoice, updateRole } from '../../src/services/role.service.js'
import { accessVersion, clearPermissionCache, memberPermissions, resolvePermissions, summaryAccess } from '../../src/services/roleAccess.service.js'
import { redactContactInfo } from '../../src/lib/contactInfo.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const C1 = '44444444-4444-4444-8444-444444444444'
const CALLER = ['leads.read.own', 'leads.list', 'leads.view', 'leads.contactInfo', 'leads.call']
const CUSTOM = { id: C1, systemKey: null, name: 'Calling agent', description: 'Calls leads', color: 'violet', permissions: CALLER, version: 2, updatedAt: new Date(), archivedAt: null }
const REP_OVERRIDE = { id: 'r1', systemKey: 'sales_rep', name: 'Sales rep', description: null, color: null, permissions: ['leads.read.team', 'leads.list'], version: 4, updatedAt: new Date(), archivedAt: null }
const admin = { orgId: ORG, userId: 'u1', role: 'admin', roleId: null, plan: 'starter', permissions: permissionsFor('admin') }

beforeEach(() => {
  vi.clearAllMocks()
  clearPermissionCache()
  db.$transaction.mockImplementation((fn) => fn(db))
  db.role.findMany.mockResolvedValue([])
  db.membership.groupBy.mockResolvedValue([])
})

describe('rolePermissionProblems', () => {
  it('accepts the examples and every editable default', () => {
    for (const role of ['manager', 'sales_rep', 'viewer']) expect(rolePermissionProblems(permissionsFor(role))).toEqual([])
    expect(rolePermissionProblems(CALLER)).toEqual([])
    expect(rolePermissionProblems(['leads.read.all', 'leads.list'])).toEqual([])
  })
  it('rejects owner/admin-only strings, and actions without their module or requirements', () => {
    expect(rolePermissionProblems(['roles.manage', 'settings.billing.manage', 'nope']).map((p) => p.kind)).toEqual(['invalid', 'invalid', 'invalid'])
    expect(rolePermissionProblems(['leads.list']).map((p) => p.message)).toEqual(['Turn on Leads first.'])
    expect(rolePermissionProblems(['leads.read.own', 'leads.call']).map((p) => p.message)).toEqual(['“Call leads and log calls” needs “Open lead details”.', '“Call leads and log calls” needs “See phone numbers and emails”.'])
    expect(rolePermissionProblems(['leads.read.own', 'leads.list', 'leads.view', 'leads.update.all'])[0].message).toMatch(/can’t reach more records/)
  })
})

describe('resolvePermissions', () => {
  it('applies stored roles on every plan, never to owner or admin', () => {
    expect(resolvePermissions({ role: 'admin', systemOverride: { permissions: [] } })).toBe(permissionsFor('admin'))
    expect(resolvePermissions({ role: 'sales_rep', systemOverride: REP_OVERRIDE })).toEqual(['leads.list', 'leads.read.team'])
    expect(resolvePermissions({ role: 'sales_rep', customRole: CUSTOM, systemOverride: REP_OVERRIDE })).toEqual(sanitizePermissions(CALLER))
    expect(resolvePermissions({ role: 'sales_rep', customRole: { ...CUSTOM, archivedAt: new Date() }, systemOverride: REP_OVERRIDE })).toEqual(['leads.list', 'leads.read.team'])
  })
})

describe('memberPermissions', () => {
  it('skips the database until a workspace has role changes', async () => {
    expect(await memberPermissions(db, { orgId: ORG, role: 'manager', rolesVersion: 0 })).toBe(permissionsFor('manager'))
    expect(db.role.findMany).not.toHaveBeenCalled()
  })
  it('re-reads after the roles version changes', async () => {
    db.role.findMany.mockResolvedValue([REP_OVERRIDE])
    await memberPermissions(db, { orgId: ORG, role: 'sales_rep', rolesVersion: 1 })
    await memberPermissions(db, { orgId: ORG, role: 'sales_rep', rolesVersion: 1 })
    expect(db.role.findMany).toHaveBeenCalledTimes(1)
    db.role.findMany.mockResolvedValue([])
    expect(await memberPermissions(db, { orgId: ORG, role: 'sales_rep', rolesVersion: 2 })).toBe(permissionsFor('sales_rep'))
  })
})

describe('summaryAccess', () => {
  it('names the custom role and fingerprints the permissions', () => {
    const access = summaryAccess({ plan: 'starter', roles: [] }, { role: 'sales_rep', roleId: C1, customRole: CUSTOM })
    expect(access).toMatchObject({ role: 'sales_rep', roleId: C1, roleName: 'Calling agent', permissions: sanitizePermissions(CALLER) })
    expect(access.accessVersion).toBe(accessVersion([...CALLER].reverse()))
  })
})

describe('reading roles', () => {
  it('lists built-in and custom roles with member counts on any plan', async () => {
    db.role.findMany.mockResolvedValue([REP_OVERRIDE, CUSTOM])
    db.membership.groupBy.mockResolvedValue([
      { role: 'owner', roleId: null, _count: { _all: 1 } },
      { role: 'sales_rep', roleId: null, _count: { _all: 3 } },
      { role: 'sales_rep', roleId: C1, _count: { _all: 2 } },
    ])
    const { roles, canManage } = await listRoles(admin)
    expect(canManage).toBe(true)
    expect(roles.map((r) => r.id)).toEqual(['owner', 'admin', 'manager', 'sales_rep', 'viewer', C1])
    const byId = Object.fromEntries(roles.map((r) => [r.id, r]))
    expect(byId.owner).toMatchObject({ locked: true, editable: false, memberCount: 1 })
    expect(byId.sales_rep).toMatchObject({ customised: true, editable: true, memberCount: 3, version: 4 })
    expect(byId[C1]).toMatchObject({ system: false, name: 'Calling agent', memberCount: 2, editable: true })
  })
  it('is read-only without roles.manage, and serves the catalogue', async () => {
    const { roles } = await listRoles({ ...admin, role: 'sales_rep', permissions: permissionsFor('sales_rep') })
    expect(roles.every((r) => !r.editable)).toBe(true)
    expect(getCatalogue().modules.map((m) => m.key)).toContain('leads')
    db.role.findFirst.mockResolvedValue({ name: 'Calling agent', description: 'Calls leads', archivedAt: null })
    expect(await myRole({ ...admin, role: 'sales_rep', roleId: C1, permissions: CALLER })).toMatchObject({ roleId: C1, name: 'Calling agent' })
  })
  it('resolves a role choice to what memberships store', async () => {
    expect(await resolveRoleChoice(db, ORG, 'viewer')).toEqual({ role: 'viewer', roleId: null, name: 'Viewer' })
    db.role.findFirst.mockResolvedValueOnce({ id: C1, name: 'Calling agent' })
    expect(await resolveRoleChoice(db, ORG, C1)).toEqual({ role: 'sales_rep', roleId: C1, name: 'Calling agent' })
    db.role.findFirst.mockResolvedValueOnce(null)
    await expect(resolveRoleChoice(db, ORG, C1)).rejects.toMatchObject({ statusCode: 400 })
    await expect(resolveRoleChoice(db, ORG, 'owner')).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('custom roles', () => {
  it('creates a role from a copy, bumps the roles version and audits it', async () => {
    db.role.findFirst.mockResolvedValue(null)
    db.role.count.mockResolvedValue(0)
    db.role.findUnique.mockResolvedValue(null)
    db.role.create.mockResolvedValue({ id: C1 })
    await createRole(admin, { name: 'Calling agent', copyFrom: 'viewer' })
    expect(db.role.create.mock.calls[0][0].data).toMatchObject({ name: 'Calling agent', permissions: [...permissionsFor('viewer')] })
    expect(db.organization.update).toHaveBeenCalledWith({ where: { id: ORG }, data: { rolesVersion: { increment: 1 } } })
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'role.create', entityId: C1 })
  })
  it('refuses a taken or built-in name', async () => {
    await expect(createRole(admin, { name: 'viewer', permissions: [] })).rejects.toMatchObject({ statusCode: 409 })
    db.role.findFirst.mockResolvedValue({ id: 'x' })
    await expect(createRole(admin, { name: 'Calling agent', permissions: [] })).rejects.toMatchObject({ statusCode: 409 })
  })
  it('renames and edits with a version check', async () => {
    db.role.findFirst.mockResolvedValueOnce({ ...CUSTOM }).mockResolvedValueOnce(null)
    db.role.updateMany.mockResolvedValue({ count: 1 })
    await updateRole(admin, C1, { name: 'Lead caller', permissions: [...CALLER, 'leads.status'], expectedVersion: 2 })
    expect(db.role.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: C1, version: 2 }, data: { name: 'Lead caller' } })
    db.role.findFirst.mockResolvedValueOnce({ ...CUSTOM })
    await expect(updateRole(admin, C1, { permissions: CALLER, expectedVersion: 1 })).rejects.toMatchObject({ code: 'STALE_UPDATE' })
  })
  it('deletes a role, moving its members and invitations in one go', async () => {
    db.role.findFirst.mockResolvedValue({ ...CUSTOM })
    db.membership.updateMany.mockResolvedValue({ count: 2 })
    db.invitation.updateMany.mockResolvedValue({ count: 1 })
    await deleteRole(admin, C1, { reassignTo: 'viewer' })
    expect(db.membership.updateMany).toHaveBeenCalledWith({ where: { organizationId: ORG, roleId: C1 }, data: { role: 'viewer', roleId: null } })
    expect(db.role.update.mock.calls[0][0].data).toHaveProperty('archivedAt')
    expect(db.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ members: 2, invitations: 1, movedTo: 'Viewer' })
    await expect(deleteRole(admin, 'viewer', { reassignTo: 'manager' })).rejects.toMatchObject({ code: 'ROLE_LOCKED' })
  })
  it('stops members editing their own role', async () => {
    db.role.findFirst.mockResolvedValue({ ...CUSTOM })
    await expect(updateRole({ ...admin, role: 'sales_rep', roleId: C1, permissions: [...permissionsFor('manager'), 'roles.manage'] }, C1, { permissions: CALLER, expectedVersion: 2 })).rejects.toMatchObject({ code: 'OWN_ROLE' })
  })
})

describe('built-in roles', () => {
  it('creates the override on first edit and removes it when saved back to defaults', async () => {
    db.role.findUnique.mockResolvedValueOnce(null)
    db.role.create.mockResolvedValue({ id: 'r1' })
    await updateRole(admin, 'sales_rep', { permissions: [...permissionsFor('sales_rep')].filter((p) => p !== 'leads.call'), expectedVersion: 0 })
    expect(db.role.create.mock.calls[0][0].data).toMatchObject({ systemKey: 'sales_rep' })
    expect(db.auditLog.create.mock.calls[0][0].data.changes.removed).toEqual(['leads.call'])
    db.role.findUnique.mockResolvedValueOnce({ ...REP_OVERRIDE })
    db.role.deleteMany.mockResolvedValue({ count: 1 })
    await updateRole(admin, 'sales_rep', { permissions: [...permissionsFor('sales_rep')], expectedVersion: 4 })
    expect(db.role.deleteMany).toHaveBeenCalledWith({ where: { id: 'r1', version: 4 } })
  })
  it('refuses locked roles and invalid sets; resets', async () => {
    await expect(updateRole(admin, 'admin', { permissions: [], expectedVersion: 0 })).rejects.toMatchObject({ code: 'ROLE_LOCKED' })
    await expect(updateRole(admin, 'viewer', { permissions: ['roles.manage'], expectedVersion: 0 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    db.role.findUnique.mockResolvedValue({ ...REP_OVERRIDE })
    db.role.deleteMany.mockResolvedValue({ count: 1 })
    await resetSystemRole(admin, 'sales_rep', { expectedVersion: 4 })
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'role.reset' })
  })
  it('previews changes and who is affected', async () => {
    db.role.findFirst.mockResolvedValue({ ...CUSTOM })
    db.membership.findMany.mockResolvedValue([{ userId: 'm1', user: { fullName: 'Asha' } }])
    db.membership.count.mockResolvedValue(3)
    const preview = await previewRole(admin, { roleId: C1, permissions: [...CALLER, 'leads.status'] })
    expect(preview).toMatchObject({ problems: [], changes: { added: ['leads.status'], removed: [] }, affected: { count: 3 } })
  })
})

describe('contact info redaction', () => {
  it('strips phones and emails, and names that are only a phone or email', () => {
    const body = { success: true, data: { items: [
      { displayName: 'Asha Rao', emails: [{ value: 'a@x.in' }], phones: [{ raw: '98450 12345', e164: '+919845012345' }], primaryEmail: 'a@x.in', primaryPhoneE164: '+919845012345', owner: { fullName: 'Rep', email: 'rep@x.in' } },
      { displayName: '+919845012345', phones: [{ e164: '+919845012345' }], emails: [] },
      { name: 'Acme', phoneE164: '+914412345678', phoneRaw: '044 1234 5678', email: 'hi@acme.in', website: 'acme.in' },
    ] } }
    redactContactInfo(body)
    const [lead, nameless, company] = body.data.items
    expect(lead).toMatchObject({ displayName: 'Asha Rao', emails: [], phones: [], primaryEmail: null, primaryPhoneE164: null, contactInfoHidden: true, owner: { email: 'rep@x.in' } })
    expect(nameless.displayName).toBe('Name hidden')
    expect(company).toMatchObject({ phoneE164: null, phoneRaw: null, email: null, website: 'acme.in' })
  })
})
