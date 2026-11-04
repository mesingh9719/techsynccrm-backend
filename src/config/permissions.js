/**
 * Roles and permissions (RBAC). Permissions are grouped into MODULES for the roles screen: each
 * module has an on/off switch and plain actions, and record modules have one "which records"
 * choice (scope) that applies to all of their actions.
 *
 * Permission strings:
 *   `<module>.read.<scope>`        the module is on, and which records it covers (all | team | own)
 *   `<module>.<action>`            an action: list, view, contactInfo, call, create, status, …
 *   `<module>.<action>.<scope>`    actions that reach records: update, delete (scope = module scope)
 *
 *   permit('leads.list')            route needs that permission
 *   permit('leads.read')            matches any scope (leads.read.all / .team / .own)
 *   recordScope(ctx, 'leads', 'update') → 'all' | 'team' | 'own' | null   (see lib/visibility.js)
 *
 * Only scope suffixes match: `members.manage` does not match `members.manage.admins`.
 * Owner and Admin are locked to the defaults below; other roles (built-in or custom) are stored
 * in the `roles` table and validated with `rolePermissionProblems`.
 */

export const SCOPES = ['all', 'team', 'own']

/** CRM record types governed by owner-based visibility. */
export const RECORD_RESOURCES = ['leads', 'contacts', 'companies', 'deals', 'tasks', 'campaigns']

// ---------- Modules (the catalogue the roles screen is built from) ----------

const A = {
  list: (noun) => ({ key: 'list', label: `See the ${noun} list` }),
  view: (one) => ({ key: 'view', label: `Open ${one} details` }),
  contactInfo: () => ({ key: 'contactInfo', label: 'See phone numbers and emails', description: 'Hidden everywhere unless this is on.', requires: ['list'] }),
  call: (noun) => ({ key: 'call', label: `Call ${noun} and log calls`, requires: ['view', 'contactInfo'] }),
  create: (noun) => ({ key: 'create', label: `Add ${noun}` }),
  update: (one) => ({ key: 'update', label: `Edit ${one} details`, scoped: true, requires: ['view'] }),
  assign: () => ({ key: 'assign', label: 'Assign to someone', description: 'Within the records this role can see.', requires: ['list'] }),
  delete: () => ({ key: 'delete', label: 'Delete', scoped: true, requires: ['view'] }),
  import: (noun) => ({ key: 'import', label: `Import ${noun}` }),
  export: (noun) => ({ key: 'export', label: `Export ${noun}`, requires: ['list'] }),
}

/**
 * @typedef {{ key: string, label: string, description?: string, scoped?: boolean, scopes?: string[], requires?: string[], ownerOnly?: boolean, adminOnly?: boolean }} ModuleAction
 *   Record modules: `key` is the action (`list`) and the permission is `<module>.<key>`.
 *   Other modules: `key` is the whole permission string.
 *   `scoped`: granted as `<permission>.<scope>`. `requires`: other actions of the same module.
 *   `ownerOnly` / `adminOnly`: only the locked Owner (and Admin) roles hold it.
 * @typedef {{ key: string, label: string, description: string, records: boolean, scopes?: string[], access?: string, actions: ModuleAction[] }} Module
 *   `records`: a record module, switched on by `<key>.read.<scope>`. Other modules with `access`
 *   (reports) are scoped the same way; the rest are on when any action is.
 * @type {readonly Module[]}
 */
export const MODULES = Object.freeze([
  {
    key: 'leads',
    label: 'Leads',
    description: 'Enquiries from forms, ads, imports and calls.',
    records: true,
    actions: [
      A.list('leads'),
      A.view('lead'),
      A.contactInfo(),
      A.call('leads'),
      A.create('leads'),
      A.update('lead'),
      { key: 'status', label: 'Change status', requires: ['view'] },
      A.assign(),
      { key: 'claim', label: 'Claim unassigned leads', requires: ['list'] },
      { key: 'convert', label: 'Convert to a deal', requires: ['view'] },
      A.delete(),
      A.import('leads'),
      A.export('leads'),
    ],
  },
  {
    key: 'contacts',
    label: 'Contacts',
    description: 'People you sell to.',
    records: true,
    actions: [A.list('contacts'), A.view('contact'), A.contactInfo(), A.call('contacts'), A.create('contacts'), A.update('contact'), A.assign(), A.delete(), A.import('contacts'), A.export('contacts')],
  },
  {
    key: 'companies',
    label: 'Companies',
    description: 'Businesses and accounts.',
    records: true,
    actions: [A.list('companies'), A.view('company'), A.contactInfo(), A.create('companies'), A.update('company'), A.assign(), A.delete(), A.import('companies'), A.export('companies')],
  },
  {
    key: 'deals',
    label: 'Deals',
    description: 'Opportunities in your pipelines.',
    records: true,
    actions: [A.list('deals'), A.view('deal'), A.create('deals'), A.update('deal'), A.assign(), A.delete(), A.import('deals'), A.export('deals')],
  },
  {
    key: 'tasks',
    label: 'Tasks and follow-ups',
    description: 'To-dos, reminders and logged activity.',
    records: true,
    actions: [A.list('tasks'), A.view('task'), A.create('tasks'), A.update('task'), A.delete()],
  },
  {
    key: 'campaigns',
    label: 'Campaigns',
    description: 'Marketing campaigns and their results.',
    records: true,
    actions: [A.list('campaigns'), A.view('campaign'), A.create('campaigns'), A.update('campaign'), A.assign(), A.delete()],
  },
  {
    key: 'reports',
    label: 'Reports and targets',
    description: 'Dashboards, reports and sales targets.',
    records: false,
    access: 'reports.read',
    scopes: SCOPES,
    actions: [
      { key: 'reports.export', label: 'Export and schedule reports' },
      { key: 'targets.manage', label: 'Set sales targets', scoped: true, scopes: ['all', 'team'] },
    ],
  },
  {
    key: 'email',
    label: 'Email and Google',
    description: 'Mailboxes, templates and Google Workspace.',
    records: false,
    actions: [
      { key: 'email.connect', label: 'Connect their own mailbox' },
      { key: 'email.send', label: 'Send email from the CRM' },
      { key: 'email.templates.write.own', label: 'Write their own email templates' },
      { key: 'email.templates.manage', label: 'Manage shared email templates' },
      { key: 'google.connect.own', label: 'Connect their own Google account' },
      { key: 'email.connections.manage', label: 'Manage team mailboxes', description: 'Team email settings, reminders and disconnecting members.' },
      { key: 'google.connections.manage', label: 'Manage team Google connections' },
      { key: 'google.settings.manage', label: 'Manage Google Workspace settings' },
    ],
  },
  {
    key: 'files',
    label: 'Files',
    description: 'Attachments on records.',
    records: false,
    actions: [
      { key: 'files.upload', label: 'Upload and attach files' },
      { key: 'files.manage', label: 'Manage everyone’s files', description: 'Rename or delete files other members uploaded.' },
    ],
  },
  {
    key: 'settings',
    label: 'Workspace settings',
    description: 'How the CRM is set up for everyone.',
    records: false,
    actions: [
      { key: 'settings.workspace.manage', label: 'Workspace profile, lead sources and lists' },
      { key: 'settings.pipelines.manage', label: 'Pipelines and stages' },
      { key: 'settings.customFields.manage', label: 'Custom fields' },
      { key: 'settings.forms.manage', label: 'Web forms' },
      { key: 'settings.automation.manage', label: 'Automation and lead assignment rules' },
      { key: 'settings.security.manage', label: 'Security settings' },
      { key: 'settings.billing.manage', label: 'Plan and billing', ownerOnly: true },
    ],
  },
  {
    key: 'team',
    label: 'Team',
    description: 'Members, invitations and roles.',
    records: false,
    actions: [
      { key: 'members.invite', label: 'Invite members' },
      { key: 'members.manage', label: 'Manage members and teams', adminOnly: true },
      { key: 'roles.manage', label: 'Manage roles', adminOnly: true },
      { key: 'members.manage.admins', label: 'Manage admins', ownerOnly: true },
      { key: 'organization.delete', label: 'Delete the workspace', ownerOnly: true },
      { key: 'ownership.transfer', label: 'Transfer ownership', ownerOnly: true },
    ],
  },
])

/** The permission string (without scope) for an action of a module. */
export const actionPermission = (module, action) => (module.records ? `${module.key}.${action.key}` : action.key)

const accessPermission = (module) => (module.records ? `${module.key}.read` : module.access)

// ---------- Built-in roles ----------

export const ROLES = ['owner', 'admin', 'manager', 'sales_rep', 'viewer']

/** Roles that can be given by invitation or role change (owner only via transfer). */
export const ASSIGNABLE_ROLES = ['admin', 'manager', 'sales_rep', 'viewer']

/** Roles whose permissions can't be edited: they always use the code defaults. */
export const LOCKED_ROLES = ['owner', 'admin']

/** Names and one-line summaries of the system roles. */
export const ROLE_INFO = Object.freeze({
  owner: { name: 'Owner', description: 'Full control, including billing and deleting the workspace.' },
  admin: { name: 'Admin', description: 'Manages settings and the team; sees all records.' },
  manager: { name: 'Manager', description: 'Sees and edits records owned by the teams they manage.' },
  sales_rep: { name: 'Sales rep', description: 'Works their own records and can claim unassigned leads.' },
  viewer: { name: 'Viewer', description: 'Read-only access to all records and reports.' },
})

// Owners and admins assign leads rather than claiming them.
const ALL_ACTIONS = (a) => a !== 'claim'
/** Per role: record scope, which record actions, reports scope, and other permissions. */
const DEFAULTS = {
  owner: { scope: 'all', actions: ALL_ACTIONS, reports: 'all', other: () => true },
  admin: { scope: 'all', actions: ALL_ACTIONS, reports: 'all', other: (p) => !p.ownerOnly },
  manager: { scope: 'team', actions: (a) => !['import', 'claim'].includes(a), reports: 'team', other: (p) => ['targets.manage', 'reports.export'].includes(p.key) },
  sales_rep: { scope: 'own', actions: (a) => ['list', 'view', 'contactInfo', 'call', 'create', 'update', 'status', 'claim', 'convert'].includes(a), reports: 'own', other: () => false },
  viewer: { scope: 'all', actions: (a) => ['list', 'view', 'contactInfo'].includes(a), reports: 'all', other: () => false },
}
/** Working with records day to day; everyone but viewers. */
const CONTRIBUTOR = ['email.connect', 'email.send', 'email.templates.write.own', 'google.connect.own', 'files.upload']

function build(role) {
  const d = DEFAULTS[role]
  const perms = []
  for (const m of MODULES) {
    if (m.records) {
      perms.push(`${m.key}.read.${d.scope}`)
      for (const a of m.actions) if (d.actions(a.key)) perms.push(a.scoped ? `${m.key}.${a.key}.${d.scope}` : `${m.key}.${a.key}`)
    } else {
      if (m.access) perms.push(`${m.access}.${d.reports}`)
      for (const a of m.actions) {
        if (!(d.other(a) || (role !== 'viewer' && CONTRIBUTOR.includes(a.key)))) continue
        if (a.scoped) {
          const scope = a.scopes.includes(d.reports) ? d.reports : null
          if (scope) perms.push(`${a.key}.${scope}`)
        } else perms.push(a.key)
      }
    }
  }
  return Object.freeze([...new Set(perms)].sort())
}

const BY_ROLE = Object.freeze(Object.fromEntries(ROLES.map((role) => [role, build(role)])))

export function permissionsFor(role) {
  return BY_ROLE[role] ?? []
}

// ---------- Checks ----------

/** True if `permissions` grants `permission` — exactly or with a scope suffix (.all / .team / .own). */
export function hasPermission(permissions, permission) {
  return permissions.some((p) => p === permission || (p.startsWith(`${permission}.`) && SCOPES.includes(p.slice(permission.length + 1))))
}

/** The scope a role has for an action on a record type: 'all' | 'team' | 'own' | null. */
export function scopeFor(permissions, resource, action) {
  for (const scope of SCOPES) if (permissions.includes(`${resource}.${action}.${scope}`)) return scope
  return null
}

/** Whether any permission is team-scoped, i.e. the member needs the list of people they manage. */
export function usesTeamScope(permissions) {
  return permissions.some((p) => p.endsWith('.team'))
}

/** Whether the member may do `action` (import, export, assign…) on at least one record module. */
export function hasAnyRecordAction(permissions, action) {
  return RECORD_RESOURCES.some((r) => permissions.includes(`${r}.${action}`))
}

// ---------- Catalogue helpers ----------

const expandAction = (m, a) => {
  const base = actionPermission(m, a)
  if (!a.scoped) return [base]
  return (a.scopes ?? m.scopes ?? SCOPES).map((s) => `${base}.${s}`)
}

/** Every concrete permission string a role can hold. */
export const ALL_PERMISSIONS = Object.freeze([
  ...new Set(
    MODULES.flatMap((m) => [
      ...(accessPermission(m) ? (m.scopes ?? SCOPES).map((s) => `${accessPermission(m)}.${s}`) : []),
      ...m.actions.flatMap((a) => expandAction(m, a)),
    ]),
  ),
])

/** Permissions only the owner can hold. */
export const OWNER_ONLY_PERMISSIONS = Object.freeze(MODULES.flatMap((m) => m.actions.filter((a) => a.ownerOnly).flatMap((a) => expandAction(m, a))))

/** Permissions only the locked Owner and Admin roles hold (team and role management). */
export const ADMIN_ONLY_PERMISSIONS = Object.freeze(MODULES.flatMap((m) => m.actions.filter((a) => a.adminOnly).flatMap((a) => expandAction(m, a))))

/**
 * Stored role permissions made safe to use: unknown, owner-only and admin-only strings are
 * dropped, and only the widest scope per action is kept. Returns a frozen, sorted list.
 */
export function sanitizePermissions(permissions) {
  const allowed = new Set(ALL_PERMISSIONS.filter((p) => !OWNER_ONLY_PERMISSIONS.includes(p) && !ADMIN_ONLY_PERMISSIONS.includes(p)))
  const kept = [...new Set(permissions)].filter((p) => allowed.has(p))
  const widest = kept.filter((p) => {
    const scope = SCOPES.find((s) => p.endsWith(`.${s}`))
    if (!scope) return true
    const base = p.slice(0, -scope.length - 1)
    return !SCOPES.slice(0, SCOPES.indexOf(scope)).some((wider) => kept.includes(`${base}.${wider}`))
  })
  return Object.freeze(widest.sort())
}

const scopeRank = (scope) => (scope ? SCOPES.indexOf(scope) : Infinity)
const scopeOfBase = (permissions, base) => SCOPES.find((s) => permissions.includes(`${base}.${s}`)) ?? null

/**
 * Why a permission list can't be saved on an editable role, as `{ permission, message, kind }[]`
 * (empty when it's fine). `kind` is 'invalid' (not grantable at all) or 'combination'.
 *   - only catalogue strings; never owner-only or admin-only ones
 *   - a module's actions need the module switched on, and reach no further than its records
 *   - an action's `requires` must be on too (e.g. calling needs details and phone numbers)
 */
export function rolePermissionProblems(permissions) {
  const problems = []
  const known = new Set(ALL_PERMISSIONS)
  for (const p of new Set(permissions)) {
    if (!known.has(p)) problems.push({ permission: p, message: 'This permission doesn’t exist.', kind: 'invalid' })
    else if (OWNER_ONLY_PERMISSIONS.includes(p)) problems.push({ permission: p, message: 'Only the workspace owner can have this.', kind: 'invalid' })
    else if (ADMIN_ONLY_PERMISSIONS.includes(p)) problems.push({ permission: p, message: 'Only owners and admins can have this.', kind: 'invalid' })
  }
  if (problems.length) return problems

  for (const m of MODULES) {
    const access = accessPermission(m)
    const moduleScope = access ? scopeOfBase(permissions, access) : null
    const held = (a) => {
      const base = actionPermission(m, a)
      return a.scoped ? scopeOfBase(permissions, base) : permissions.includes(base) ? true : null
    }
    for (const a of m.actions) {
      const value = held(a)
      if (!value) continue
      const permission = a.scoped ? `${actionPermission(m, a)}.${value}` : actionPermission(m, a)
      if (access && !moduleScope) {
        problems.push({ permission, message: `Turn on ${m.label} first.`, kind: 'combination' })
        continue
      }
      if (a.scoped && scopeRank(value) < scopeRank(moduleScope)) problems.push({ permission, message: `“${a.label}” can’t reach more records than ${m.label} covers.`, kind: 'combination' })
      for (const req of a.requires ?? []) {
        const needed = m.actions.find((x) => x.key === req)
        if (needed && !held(needed)) problems.push({ permission, message: `“${a.label}” needs “${needed.label}”.`, kind: 'combination' })
      }
    }
  }
  return problems
}
