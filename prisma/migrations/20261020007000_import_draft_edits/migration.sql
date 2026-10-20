ALTER TABLE import_jobs
  ADD COLUMN analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN edits JSONB NOT NULL DEFAULT '{"cells":{},"deletedRows":[],"addedRows":[]}'::jsonb,
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN has_header BOOLEAN NOT NULL DEFAULT TRUE;
