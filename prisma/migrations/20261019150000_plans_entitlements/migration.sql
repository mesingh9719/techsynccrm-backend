-- M06 — Plans, trials & entitlements

-- AlterEnum
ALTER TYPE "Plan" ADD VALUE 'enterprise';

-- AlterTable: organizations
ALTER TABLE "organizations" ADD COLUMN     "trial_reminders_sent" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "seat_selection_required_at" TIMESTAMPTZ(6),
ADD COLUMN     "seat_suspended_resolved_at" TIMESTAMPTZ(6);

-- Workspaces created on Growth/Business before M06 never got a trial end (gap A3). Give them a
-- 14-day trial from creation, but always at least 7 more days from today so nobody is downgraded
-- without notice. Rounded to the end of that day in the workspace's time zone.
UPDATE "organizations"
SET "trial_ends_at" = (
    (date_trunc('day', GREATEST("created_at" + interval '14 days', now() + interval '7 days') AT TIME ZONE "timezone") + interval '1 day' - interval '1 millisecond')
    AT TIME ZONE "timezone"
)
WHERE "plan" IN ('growth', 'business') AND "trial_ends_at" IS NULL AND "deleted_at" IS NULL;

-- AlterTable: users — carry the signup plan of people who haven't created a workspace yet, then
-- drop the columns deprecated in M02.
ALTER TABLE "users" ADD COLUMN     "signup_plan" "Plan";

UPDATE "users" u
SET "signup_plan" = u."plan"
WHERE NOT EXISTS (SELECT 1 FROM "memberships" m WHERE m."user_id" = u."id");

ALTER TABLE "users" DROP COLUMN "company",
DROP COLUMN "industry",
DROP COLUMN "plan",
DROP COLUMN "team_size";

-- CreateTable
CREATE TABLE "organization_usage" (
    "organization_id" UUID NOT NULL,
    "users" INTEGER NOT NULL DEFAULT 0,
    "records" INTEGER NOT NULL DEFAULT 0,
    "pipelines" INTEGER NOT NULL DEFAULT 0,
    "storage_bytes" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_usage_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "plan_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "from_plan" "Plan",
    "to_plan" "Plan" NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_id" UUID,
    "meta" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_changes_pkey" PRIMARY KEY ("id")
);

-- History starts with each existing workspace's current plan.
INSERT INTO "plan_changes" ("organization_id", "from_plan", "to_plan", "reason", "actor_id", "created_at")
SELECT "id", NULL, "plan", 'signup', "created_by_id", "created_at" FROM "organizations";

-- CreateIndex
CREATE INDEX "plan_changes_organization_id_created_at_idx" ON "plan_changes"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "organizations_trial_ends_at_idx" ON "organizations"("trial_ends_at");

-- AddForeignKey
ALTER TABLE "organization_usage" ADD CONSTRAINT "organization_usage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_changes" ADD CONSTRAINT "plan_changes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
