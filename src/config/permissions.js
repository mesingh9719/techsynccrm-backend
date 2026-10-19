/**
 * Role → permissions (M04). Permission strings are `<resource>.<action>` or, for record access,
 * `<resource>.<action>.<scope>` where scope is all | team | own.
 *
 *   permit('members.invite')        — route can only be used with that permission
 *   permit('leads.read')            — matches any scope (leads.read.all / .team / .own)
 *   recordScope(ctx, 'leads', 'update') → 'all' | 'team' | 'own' | null   (see lib/visibility.js)
 *
 * Custom roles (Business plan) arrive in M21; until then these fixed roles apply.
 */

/** CRM record types governed by owner-based visibility. */
export const RECORD_RESOURCES = ['leads', 'contacts', 'companies', 'deals', 'tasks']

/** Scope per action for each role. null = not allowed; true = allowed (no scope). */
const RECORD_ACCESS = {
  owner: { read: 'all', create: true, update: 'all', delete: 'all' },
  admin: { read: 'all', create: true, update: 'all', delete: 'all' },
  manager: { read: 'team', create: true, update: 'team', delete: 'team' },
  sales_rep: { read: 'own', create: true, update: 'own', delete: null },
  viewer: { read: 'all', create: null, update: null, delete: null },
}

/** Everything that isn't per-record access. */
const OTHER = {
  owner: [
    'records.assign.all',
    'records.import',
    'records.export.all',
    'reports.read.all',
    'settings.workspace.manage',
    'settings.pipelines.manage',
    'settings.customFields.manage',
    'settings.forms.manage',
    'settings.automation.manage',
    'settings.security.manage',
    'members.invite',
    'members.manage',
    'members.manage.admins',
    'settings.billing.manage',
    'organization.delete',
    'ownership.transfer',
  ],
  admin: [
    'records.assign.all',
    'records.import',
    'records.export.all',
    'reports.read.all',
    'settings.workspace.manage',
    'settings.pipelines.manage',
    'settings.customFields.manage',
    'settings.forms.manage',
    'settings.automation.manage',
    'settings.security.manage',
    'members.invite',
    'members.manage',
  ],
  manager: ['records.assign.team', 'records.export.team', 'reports.read.team'],
  sales_rep: ['records.claim', 'reports.read.own'],
  viewer: ['reports.read.all'],
}

function build(role) {
  const perms = [...OTHER[role]]
  for (const resource of RECORD_RESOURCES) {
    for (const [action, scope] of Object.entries(RECORD_ACCESS[role])) {
      if (scope === true) perms.push(`${resource}.${action}`)
      else if (scope) perms.push(`${resource}.${action}.${scope}`)
    }
  }
  return Object.freeze(perms)
}

export const ROLES = ['owner', 'admin', 'manager', 'sales_rep', 'viewer']

/** Roles that can be given by invitation or role change (owner only via transfer). */
export const ASSIGNABLE_ROLES = ['admin', 'manager', 'sales_rep', 'viewer']

const BY_ROLE = Object.freeze(Object.fromEntries(ROLES.map((role) => [role, build(role)])))

export function permissionsFor(role) {
  return BY_ROLE[role] ?? []
}

/** True if `permissions` grants `permission` — either exactly or with any scope suffix. */
export function hasPermission(permissions, permission) {
  return permissions.some((p) => p === permission || p.startsWith(`${permission}.`))
}

/** The scope a role has for an action on a record type: 'all' | 'team' | 'own' | null. */
export function scopeFor(permissions, resource, action) {
  for (const scope of ['all', 'team', 'own']) if (permissions.includes(`${resource}.${action}.${scope}`)) return scope
  return null
}
