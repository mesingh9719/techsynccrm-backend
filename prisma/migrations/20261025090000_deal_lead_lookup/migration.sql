-- Outside a transaction: supports tenant-scoped deal/lead campaign semi-joins and FK checks.
CREATE INDEX CONCURRENTLY "deals_organization_id_lead_id_idx"
ON "deals" ("organization_id", "lead_id");
-- Rollback separately: DROP INDEX CONCURRENTLY IF EXISTS "deals_organization_id_lead_id_idx";
