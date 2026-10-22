-- Keep this migration outside a transaction: PostgreSQL concurrent builds allow writes.
-- Status tabs exclude deleted leads and group by status for one organization. Cover those
-- columns without visiting heap rows or indexing deleted leads.
CREATE INDEX CONCURRENTLY "leads_live_status_idx"
ON "leads" ("organization_id", "status") WHERE "deleted_at" IS NULL;

-- Rollback (separately, outside a transaction):
-- DROP INDEX CONCURRENTLY IF EXISTS "leads_live_status_idx";
