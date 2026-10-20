BEGIN;
-- Keep existing object keys and IDs. Prefer the original uploader's active workspace; fall back
-- only to a workspace they actually belong to. Unassignable legacy files stop migration safely.
UPDATE files f SET organization_id = COALESCE(
  (SELECT m.organization_id FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.user_id = f.user_id AND m.status = 'active'
    ORDER BY (m.organization_id = u.last_active_organization_id) DESC, m.created_at LIMIT 1)
) WHERE f.organization_id IS NULL;
ALTER TABLE files ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE files RENAME COLUMN user_id TO uploaded_by_id;
ALTER TABLE files ADD COLUMN status TEXT NOT NULL DEFAULT 'ready',
  ADD COLUMN sha256 TEXT, ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'not_scanned',
  ADD COLUMN thumbnail_key TEXT, ADD COLUMN thumbnail_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN deleted_at TIMESTAMPTZ(6);
CREATE TABLE file_links (
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL, entity_id UUID NOT NULL, created_by_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TIMESTAMPTZ(6),
  PRIMARY KEY(file_id, entity_type, entity_id)
);
CREATE INDEX file_links_organization_id_entity_type_entity_id_idx ON file_links(organization_id, entity_type, entity_id);
COMMIT;
