import { describe, expect, it, vi } from 'vitest'
import { ALL_PERMISSIONS, MODULES, OWNER_ONLY_PERMISSIONS, RECORD_RESOURCES, ROLES, hasPermission, permissionsFor, rolePermissionProblems, usesTeamScope } from '../../src/config/permissions.js'
import { canAccessRecord, managedMembers } from '../../src/lib/visibility.js'
import before from '../fixtures/role-permissions.before.json' with { type: 'json' }

/**
 * The module model keeps every built-in role's access: record CRUD strings are unchanged, and the
 * old workspace-wide records.* permissions became per-module actions.
 */
const CRUD = /^(read|create|update|delete)(\.|$)/
const isRecordCrud = (p) => RECORD_RESOURCES.some((r) => p.startsWith(`${r}.`) && CRUD.test(p.slice(r.length + 1)))
const isRecordPermission = (p) => RECORD_RESOURCES.some((r) => p.startsWith(`${r}.`)) || p.startsWith('records.')
const PHASE0_ADDED = { owner: ['roles.manage', 'files.upload', 'files.manage'], admin: ['roles.manage', 'files.upload', 'files.manage'], manager: ['files.upload'], sales_rep: ['files.upload'], viewer: [] }

describe('role permissions', () => {
  it.each(ROLES)('%s keeps its record access and other permissions', (role) => {
    const now = permissionsFor(role)
    expect(now.filter(isRecordCrud).sort()).toEqual(before[role].filter(isRecordCrud).sort())
    // Exporting reports used to ride on records.export; it's its own permission now.
    const reportsExport = before[role].some((p) => p.startsWith('records.export')) ? ['reports.export'] : []
    const otherBefore = before[role].filter((p) => !isRecordPermission(p))
    expect(now.filter((p) => !isRecordPermission(p)).sort()).toEqual([...otherBefore, ...PHASE0_ADDED[role], ...reportsExport].sort())
  })

  it.each(ROLES)('%s gets per-module actions matching the old records.* permissions', (role) => {
    const old = before[role]
    const now = permissionsFor(role)
    const had = (action) => old.some((p) => p.startsWith(`records.${action}`))
    for (const m of MODULES.filter((x) => x.records)) {
      const read = old.some((p) => p.startsWith(`${m.key}.read.`))
      for (const a of m.actions) {
        const holds = now.some((p) => p === `${m.key}.${a.key}` || p.startsWith(`${m.key}.${a.key}.`))
        if (['list', 'view', 'contactInfo'].includes(a.key)) expect(holds, `${role} ${m.key}.${a.key}`).toBe(read)
        if (['assign', 'export', 'import'].includes(a.key)) expect(holds, `${role} ${m.key}.${a.key}`).toBe(had(a.key))
      }
    }
    expect(now.includes('leads.claim')).toBe(old.includes('records.claim'))
  })

  it('lists every granted permission in the catalogue, once', () => {
    for (const role of ROLES) expect(permissionsFor(role).filter((p) => !ALL_PERMISSIONS.includes(p))).toEqual([])
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length)
  })

  it('grants owner-only permissions to the owner alone', () => {
    expect(OWNER_ONLY_PERMISSIONS.length).toBeGreaterThan(0)
    for (const role of ROLES.filter((r) => r !== 'owner')) for (const p of OWNER_ONLY_PERMISSIONS) expect(hasPermission(permissionsFor(role), p)).toBe(false)
    for (const p of OWNER_ONLY_PERMISSIONS) expect(hasPermission(permissionsFor('owner'), p)).toBe(true)
  })

  it('keeps role-tied checks as before', () => {
    const can = (role, p) => hasPermission(permissionsFor(role), p)
    expect(ROLES.filter((r) => can(r, 'email.connections.manage'))).toEqual(['owner', 'admin'])
    expect(ROLES.filter((r) => can(r, 'files.manage'))).toEqual(['owner', 'admin'])
    expect(ROLES.filter((r) => can(r, 'files.upload'))).toEqual(['owner', 'admin', 'manager', 'sales_rep'])
    expect(ROLES.filter((r) => can(r, 'leads.import'))).toEqual(['owner', 'admin'])
    expect(ROLES.filter((r) => can(r, 'leads.claim') || can(r, 'leads.assign'))).toEqual(['owner', 'admin', 'manager', 'sales_rep'])
    expect(ROLES.filter((r) => can(r, 'leads.call'))).toEqual(['owner', 'admin', 'manager', 'sales_rep'])
  })

  it('accepts every editable default as a valid role', () => {
    for (const role of ['manager', 'sales_rep', 'viewer']) expect(rolePermissionProblems(permissionsFor(role))).toEqual([])
  })
})

describe('hasPermission', () => {
  it('matches exact strings and scope suffixes only', () => {
    expect(hasPermission(['leads.read.team'], 'leads.read')).toBe(true)
    expect(hasPermission(['leads.update.all'], 'leads.update')).toBe(true)
    expect(hasPermission(['members.manage.admins'], 'members.manage')).toBe(false)
    expect(hasPermission(['email.templates.write.own'], 'email.templates.write.own')).toBe(true)
    expect(hasPermission(['email.templates.write.own'], 'email.templates')).toBe(false)
    expect(hasPermission(['leads.readers'], 'leads.read')).toBe(false)
  })
})

describe('team scope', () => {
  it('only the manager role needs the managed-members lookup', () => {
    expect(ROLES.filter((r) => usesTeamScope(permissionsFor(r)))).toEqual(['manager'])
  })

  it('skips the lookup without a team scope', async () => {
    const db = { teamMember: { findMany: vi.fn() } }
    expect(await managedMembers(db, 'org', 'me', permissionsFor('sales_rep'))).toEqual({ teamIds: [], managedUserIds: [] })
    expect(db.teamMember.findMany).not.toHaveBeenCalled()
  })

  it('returns distinct teams and members, without the member themself', async () => {
    const rows = [{ teamId: 't1', userId: 'me' }, { teamId: 't1', userId: 'a' }, { teamId: 't2', userId: 'a' }, { teamId: 't2', userId: 'b' }]
    const db = { teamMember: { findMany: vi.fn().mockResolvedValue(rows) } }
    const result = await managedMembers(db, 'org', 'me', permissionsFor('manager'))
    expect(result).toEqual({ teamIds: ['t1', 't2'], managedUserIds: ['a', 'b'] })
    const ctx = { userId: 'me', permissions: permissionsFor('manager'), ...result }
    expect(canAccessRecord(ctx, 'leads', 'update', 'me')).toBe(true)
    expect(canAccessRecord(ctx, 'leads', 'update', 'b')).toBe(true)
    expect(canAccessRecord(ctx, 'leads', 'update', 'stranger')).toBe(false)
  })
})
