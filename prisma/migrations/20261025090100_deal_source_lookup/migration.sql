-- Outside a transaction: shared board/list source filter, tenant leading.
CREATE INDEX CONCURRENTLY "deals_organization_id_source_id_idx"
ON "deals" ("organization_id", "source_id");
-- Rollback separately: DROP INDEX CONCURRENTLY IF EXISTS "deals_organization_id_source_id_idx";
