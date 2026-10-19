-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserTokenType" ADD VALUE 'email_change';
ALTER TYPE "UserTokenType" ADD VALUE 'email_change_cancel';
ALTER TYPE "UserTokenType" ADD VALUE 'login_challenge';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "avatar_file_id" UUID,
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "failed_login_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failed_login_since" TIMESTAMPTZ(6),
ADD COLUMN     "locale" TEXT,
ADD COLUMN     "locked_until" TIMESTAMPTZ(6),
ADD COLUMN     "pending_email" TEXT,
ADD COLUMN     "privacy_version" TEXT,
ADD COLUMN     "terms_accepted_at" TIMESTAMPTZ(6),
ADD COLUMN     "terms_version" TEXT,
ADD COLUMN     "timezone" TEXT,
ADD COLUMN     "two_factor_enabled_at" TIMESTAMPTZ(6),
ADD COLUMN     "two_factor_last_step" BIGINT,
ADD COLUMN     "two_factor_pending_secret_enc" TEXT,
ADD COLUMN     "two_factor_secret_enc" TEXT;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "require_2fa" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
-- Existing tokens: walk each rotation chain back to its first token and use that id as the
-- session id, so a device's chain shows as one session. Added nullable, backfilled, then required.
ALTER TABLE "refresh_tokens" ADD COLUMN     "session_id" UUID;

WITH RECURSIVE chain AS (
    SELECT t."id", t."id" AS "root_id"
    FROM "refresh_tokens" t
    WHERE NOT EXISTS (SELECT 1 FROM "refresh_tokens" p WHERE p."replaced_by" = t."id")
    UNION ALL
    SELECT n."id", c."root_id"
    FROM chain c
    JOIN "refresh_tokens" cur ON cur."id" = c."id"
    JOIN "refresh_tokens" n ON n."id" = cur."replaced_by"
)
UPDATE "refresh_tokens" r SET "session_id" = chain."root_id" FROM chain WHERE r."id" = chain."id";

UPDATE "refresh_tokens" SET "session_id" = "id" WHERE "session_id" IS NULL;

ALTER TABLE "refresh_tokens" ALTER COLUMN "session_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "user_tokens" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "payload" JSONB;

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL,
    "team_ids" UUID[],
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_by_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "is_manager" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id","user_id")
);

-- CreateIndex
CREATE INDEX "recovery_codes_user_id_idx" ON "recovery_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_organization_id_email_idx" ON "invitations"("organization_id", "email");

-- CreateIndex
CREATE INDEX "invitations_organization_id_created_at_idx" ON "invitations"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "teams_organization_id_name_key" ON "teams"("organization_id", "name");

-- CreateIndex
CREATE INDEX "team_members_user_id_idx" ON "team_members"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
