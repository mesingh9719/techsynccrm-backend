-- Keep this migration outside a transaction: PostgreSQL concurrent builds allow writes.
-- The deal list defaults to newest first (created_at DESC, id DESC) for one organization and
-- excludes deleted deals. Contacts, companies and leads already have an equivalent index; deals
-- otherwise sort every live deal in the workspace to return one page.
CREATE INDEX CONCURRENTLY "deals_live_created_idx"
ON "deals" ("organization_id", "created_at" DESC, "id" DESC) WHERE "deleted_at" IS NULL;

-- Rollback (separately, outside a transaction):
-- DROP INDEX CONCURRENTLY IF EXISTS "deals_live_created_idx";
