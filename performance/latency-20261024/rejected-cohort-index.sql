-- REJECTED EXPERIMENT. Not a deployment migration. Synthetic/local tests only.
-- Serial latency/buffers improved, but concurrent p95 did not improve consistently.
-- Run outside a surrounding transaction. Supports dashboard date-cohort counts and
-- the existing createdAt/id keyset ordering, without indexing soft-deleted leads.
-- INCLUDE keeps status available for index-only aggregation; UUID is the tie-breaker.
CREATE INDEX CONCURRENTLY "leads_live_created_cover_idx"
ON "leads" ("organization_id", "created_at" DESC, "id" DESC)
INCLUDE ("status") WHERE "deleted_at" IS NULL;

-- Rollback: ship a new forward migration, outside a transaction:
-- DROP INDEX CONCURRENTLY IF EXISTS "leads_live_created_cover_idx";
-- Keep existing leads_live_created_idx: removal requires its own usage/lock audit.
