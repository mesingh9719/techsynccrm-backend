BEGIN;
ALTER TABLE files ADD COLUMN expires_at TIMESTAMPTZ(6);
CREATE TABLE import_jobs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 entity_type TEXT NOT NULL, file_id UUID NOT NULL REFERENCES files(id), sheet_name TEXT, header_row INTEGER NOT NULL DEFAULT 1,
 mapping JSONB NOT NULL DEFAULT '{}', options JSONB NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft',
 total_rows INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL DEFAULT 0,
 updated INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
 last_error TEXT, error_file_id UUID REFERENCES files(id) ON DELETE SET NULL, created_by_id UUID NOT NULL,
 started_at TIMESTAMPTZ(6), finished_at TIMESTAMPTZ(6), created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX import_jobs_organization_id_created_at_idx ON import_jobs(organization_id, created_at DESC);
CREATE TABLE import_records (
 import_id UUID NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE, organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 row_index INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id UUID, action TEXT NOT NULL, error TEXT,
 record_updated_at TIMESTAMPTZ(6), PRIMARY KEY(import_id, row_index)
);
CREATE INDEX import_records_organization_id_entity_type_entity_id_idx ON import_records(organization_id, entity_type, entity_id);
CREATE TABLE import_mappings (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 entity_type TEXT NOT NULL, name TEXT NOT NULL, headers_hash TEXT NOT NULL, mapping JSONB NOT NULL
);
CREATE UNIQUE INDEX import_mappings_organization_id_entity_type_headers_hash_key ON import_mappings(organization_id, entity_type, headers_hash);
CREATE TABLE export_jobs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 entity_type TEXT NOT NULL, filters JSONB NOT NULL DEFAULT '{}', columns JSONB NOT NULL DEFAULT '[]', format TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', row_count INTEGER NOT NULL DEFAULT 0, file_id UUID REFERENCES files(id) ON DELETE SET NULL,
 last_error TEXT, created_by_id UUID NOT NULL, created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMPTZ(6)
);
CREATE INDEX export_jobs_organization_id_created_at_idx ON export_jobs(organization_id, created_at DESC);
ALTER TABLE leads ADD COLUMN import_id UUID;
ALTER TABLE contacts ADD COLUMN import_id UUID;
ALTER TABLE companies ADD COLUMN import_id UUID;
ALTER TABLE deals ADD COLUMN import_id UUID;
CREATE INDEX leads_organization_id_import_id_idx ON leads(organization_id, import_id);
CREATE INDEX contacts_organization_id_import_id_idx ON contacts(organization_id, import_id);
CREATE INDEX companies_organization_id_import_id_idx ON companies(organization_id, import_id);
CREATE INDEX deals_organization_id_import_id_idx ON deals(organization_id, import_id);
COMMIT;
