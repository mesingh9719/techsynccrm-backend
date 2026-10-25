-- Additive integrity guard. NOT VALID avoids scanning or rewriting legacy data, while
-- enforcing the tenant link for new references. No lead or deal is deleted/backfilled.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "deals" ADD CONSTRAINT "deals_organization_id_lead_id_fkey"
FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads" ("organization_id", "id")
ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
COMMIT;
-- After a separate legacy-data audit, validate without blocking ordinary DML:
-- ALTER TABLE "deals" VALIDATE CONSTRAINT "deals_organization_id_lead_id_fkey";
-- Rollback in a new forward migration:
-- ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "deals_organization_id_lead_id_fkey";
