-- RBAC (M21): editable role permissions and custom roles.
-- System rows (system_key = manager | sales_rep | viewer) override the code defaults and are created
-- only when an admin first edits that role; owner and admin always use the code defaults.
-- Purely additive: no existing rows change.
CREATE TABLE roles (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  system_key "MemberRole",
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 60),
  description text CHECK (length(description) <= 200),
  color text CHECK (length(color) <= 20),
  permissions text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  created_by_id uuid,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  archived_at timestamptz(6),
  CONSTRAINT roles_pkey PRIMARY KEY (id),
  CONSTRAINT roles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- Owner and admin can't be edited, so they're never stored.
  CONSTRAINT roles_system_key_editable CHECK (system_key IS NULL OR system_key NOT IN ('owner', 'admin'))
);
CREATE UNIQUE INDEX roles_organization_id_system_key_key ON roles (organization_id, system_key);
-- "Ops lead" and "ops lead" are the same role; archived roles free their name.
CREATE UNIQUE INDEX roles_organization_id_name_active_key ON roles (organization_id, lower(name)) WHERE archived_at IS NULL;

ALTER TABLE memberships ADD COLUMN role_id uuid;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX memberships_role_id_idx ON memberships (role_id);

ALTER TABLE invitations ADD COLUMN role_id uuid;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE organizations ADD COLUMN roles_version integer NOT NULL DEFAULT 0;
