BEGIN;
SET LOCAL lock_timeout = '5s';
-- CreateEnum
CREATE TYPE "EmailVisibility" AS ENUM ('OWNER_ONLY', 'LEAD_ACCESS');

-- CreateEnum
CREATE TYPE "EmailAuditAction" AS ENUM ('CONNECTED', 'DISCONNECTED', 'DISCONNECTED_BY_ADMIN', 'NEEDS_RECONNECT', 'REMINDER_SENT', 'SETTINGS_UPDATED');

-- AlterTable
ALTER TABLE "gmail_accounts" ADD COLUMN     "connected_at" TIMESTAMPTZ(6),
ADD COLUMN     "disconnected_at" TIMESTAMPTZ(6),
ADD COLUMN     "display_name" TEXT,
ADD COLUMN     "last_error_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_used_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "gmail_oauth_states" ADD COLUMN     "used_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "tenant_email_settings" (
    "organization_id" UUID NOT NULL,
    "email_enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_visibility" "EmailVisibility" NOT NULL DEFAULT 'LEAD_ACCESS',
    "default_signature_html" TEXT NOT NULL DEFAULT '',
    "allow_employee_custom_signature" BOOLEAN NOT NULL DEFAULT true,
    "require_connected_email_to_send" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_email_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "email_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "target_user_id" UUID,
    "action" "EmailAuditAction" NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_token_revocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "credential_enc" TEXT NOT NULL,
    "wrapped_key" TEXT NOT NULL,
    "key_version" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_token_revocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_audit_logs_organization_id_created_at_idx" ON "email_audit_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "email_audit_logs_organization_id_target_user_id_action_crea_idx" ON "email_audit_logs"("organization_id", "target_user_id", "action", "created_at");

-- CreateIndex
CREATE INDEX "email_token_revocations_organization_id_next_attempt_at_idx" ON "email_token_revocations"("organization_id", "next_attempt_at");

-- CreateIndex
CREATE INDEX "gmail_accounts_organization_id_email_idx" ON "gmail_accounts"("organization_id", "email");

-- AddForeignKey
ALTER TABLE "tenant_email_settings" ADD CONSTRAINT "tenant_email_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_audit_logs" ADD CONSTRAINT "email_audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_audit_logs" ADD CONSTRAINT "email_audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_audit_logs" ADD CONSTRAINT "email_audit_logs_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_token_revocations" ADD CONSTRAINT "email_token_revocations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Old migrations enforced cross-customer uniqueness. Replace it atomically.
DROP INDEX gmail_accounts_active_subject_key;
DROP INDEX gmail_accounts_active_email_key;
CREATE UNIQUE INDEX gmail_accounts_active_subject_key ON gmail_accounts(organization_id, google_subject)
  WHERE status IN ('connected','syncing','delayed','reconnect_required','paused');
CREATE UNIQUE INDEX gmail_accounts_active_email_key ON gmail_accounts(organization_id, lower(email))
  WHERE status IN ('connected','syncing','delayed','reconnect_required','paused');
UPDATE gmail_accounts SET connected_at = consent_at WHERE status IN ('connected','syncing','delayed','reconnect_required','paused');
COMMIT;
