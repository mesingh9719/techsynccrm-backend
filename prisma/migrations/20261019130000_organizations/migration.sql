-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('owner', 'admin', 'manager', 'sales_rep', 'viewer');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('active', 'invited', 'deactivated');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_active_organization_id" UUID;

-- AlterTable
ALTER TABLE "files" ADD COLUMN     "organization_id" UUID;

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "industry" TEXT,
    "team_size" TEXT,
    "logo_file_id" UUID,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "country" CHAR(2) NOT NULL DEFAULT 'IN',
    "state_code" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "locale" TEXT NOT NULL DEFAULT 'en-IN',
    "fiscal_year_start_month" INTEGER NOT NULL DEFAULT 4,
    "gstin" TEXT,
    "legal_name" TEXT,
    "address" JSONB,
    "plan" "Plan" NOT NULL DEFAULT 'starter',
    "trial_ends_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'sales_rep',
    "status" "MemberStatus" NOT NULL DEFAULT 'active',
    "title" TEXT,
    "joined_at" TIMESTAMPTZ(6),
    "deactivated_at" TIMESTAMPTZ(6),
    "dismissed_checklist_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "memberships_user_id_status_idx" ON "memberships"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_organization_id_user_id_key" ON "memberships"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "files_organization_id_idx" ON "files"("organization_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_last_active_organization_id_fkey" FOREIGN KEY ("last_active_organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Data backfill: every user who finished onboarding gets a workspace built from
-- their company details, an owner membership, and their files moved into it.
-- Slugs get a short id suffix so they are unique without a lookup.
-- ---------------------------------------------------------------------------
WITH source AS (
    SELECT
        u.id AS user_id,
        COALESCE(NULLIF(trim(u.company), ''), u.full_name || '''s workspace') AS name,
        COALESCE(
            NULLIF(trim(both '-' from left(lower(regexp_replace(COALESCE(NULLIF(trim(u.company), ''), u.full_name), '[^a-zA-Z0-9]+', '-', 'g')), 30)), ''),
            'workspace'
        ) || '-' || left(replace(u.id::text, '-', ''), 6) AS slug,
        u.industry,
        u.team_size,
        u.plan,
        u.onboarding_completed_at
    FROM "users" u
    WHERE u.onboarding_completed_at IS NOT NULL
), new_orgs AS (
    INSERT INTO "organizations" ("id", "name", "slug", "industry", "team_size", "plan", "created_by_id", "created_at", "updated_at")
    SELECT gen_random_uuid(), s.name, s.slug, s.industry, s.team_size, s.plan, s.user_id, s.onboarding_completed_at, CURRENT_TIMESTAMP
    FROM source s
    RETURNING "id", "created_by_id"
), new_members AS (
    INSERT INTO "memberships" ("organization_id", "user_id", "role", "status", "joined_at", "updated_at")
    SELECT o."id", o."created_by_id", 'owner', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM new_orgs o
    RETURNING "organization_id", "user_id"
)
UPDATE "users" u
SET "last_active_organization_id" = m."organization_id"
FROM new_members m
WHERE u."id" = m."user_id";

UPDATE "files" f
SET "organization_id" = u."last_active_organization_id"
FROM "users" u
WHERE f."user_id" = u."id"
  AND f."organization_id" IS NULL
  AND u."last_active_organization_id" IS NOT NULL;
