-- Additive Gmail schema; rollback retains history.
SET lock_timeout = '5s';
-- CreateTable
CREATE TABLE "gmail_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "google_subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'connected',
    "credential_enc" TEXT,
    "wrapped_key" TEXT NOT NULL,
    "key_version" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "signature_html" TEXT NOT NULL DEFAULT '',
    "excluded_addresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excluded_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "consent_version" TEXT NOT NULL,
    "consent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sync_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletion_requested_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gmail_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gmail_oauth_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "state_hash" TEXT NOT NULL,
    "browser_hash" TEXT NOT NULL,
    "verifier_enc" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "return_to" TEXT NOT NULL,
    "backfill_days" INTEGER NOT NULL DEFAULT 0,
    "excluded_addresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excluded_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gmail_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_threads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "root_key" TEXT NOT NULL,
    "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_record_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "lead_id" UUID,
    "contact_id" UUID,

    CONSTRAINT "email_record_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "activity_id" UUID,
    "actor_id" UUID,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "content_enc" TEXT,
    "fingerprint" TEXT,
    "rfc_message_id" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "request_hash" TEXT,
    "generation" INTEGER NOT NULL,
    "attachment_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_mailbox_copies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "gmail_message_id" TEXT NOT NULL,
    "gmail_thread_id" TEXT NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_mailbox_copies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "owner_id" UUID,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body_html" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gmail_sync_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "history_id" TEXT,
    "watch_expires_at" TIMESTAMPTZ(6),
    "watch_renew_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6),
    "search_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(6),
    "lease_token" UUID,
    "refresh_lease_until" TIMESTAMPTZ(6),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "coverage_gap" BOOLEAN NOT NULL DEFAULT false,
    "pending_history_id" TEXT,
    "scan_state" JSONB,

    CONSTRAINT "gmail_sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_suppressions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "recipient_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gmail_accounts_organization_id_user_id_created_at_idx" ON "gmail_accounts"("organization_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "gmail_accounts_organization_id_status_idx" ON "gmail_accounts"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "gmail_accounts_organization_id_id_key" ON "gmail_accounts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "gmail_oauth_states_state_hash_key" ON "gmail_oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "gmail_oauth_states_organization_id_user_id_idx" ON "gmail_oauth_states"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "gmail_oauth_states_expires_at_idx" ON "gmail_oauth_states"("expires_at");

-- CreateIndex
CREATE INDEX "email_threads_organization_id_last_message_at_id_idx" ON "email_threads"("organization_id", "last_message_at" DESC, "id");

-- CreateIndex
CREATE UNIQUE INDEX "email_threads_organization_id_id_key" ON "email_threads"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "email_threads_organization_id_root_key_key" ON "email_threads"("organization_id", "root_key");

-- CreateIndex
CREATE INDEX "email_record_links_organization_id_lead_id_thread_id_idx" ON "email_record_links"("organization_id", "lead_id", "thread_id");

-- CreateIndex
CREATE INDEX "email_record_links_organization_id_contact_id_thread_id_idx" ON "email_record_links"("organization_id", "contact_id", "thread_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_record_links_organization_id_thread_id_lead_id_key" ON "email_record_links"("organization_id", "thread_id", "lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_record_links_organization_id_thread_id_contact_id_key" ON "email_record_links"("organization_id", "thread_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_activity_id_key" ON "email_messages"("activity_id");

-- CreateIndex
CREATE INDEX "email_messages_organization_id_thread_id_occurred_at_id_idx" ON "email_messages"("organization_id", "thread_id", "occurred_at", "id");

-- CreateIndex
CREATE INDEX "email_messages_organization_id_account_id_status_idx" ON "email_messages"("organization_id", "account_id", "status");

-- CreateIndex
CREATE INDEX "email_messages_status_next_attempt_at_idx" ON "email_messages"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "email_messages_organization_id_expires_at_idx" ON "email_messages"("organization_id", "expires_at");

-- CreateIndex
CREATE INDEX "email_messages_organization_id_rfc_message_id_idx" ON "email_messages"("organization_id", "rfc_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_organization_id_id_key" ON "email_messages"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_organization_id_fingerprint_key" ON "email_messages"("organization_id", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_organization_id_actor_id_idempotency_key_key" ON "email_messages"("organization_id", "actor_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "email_mailbox_copies_organization_id_account_id_gmail_threa_idx" ON "email_mailbox_copies"("organization_id", "account_id", "gmail_thread_id");

-- CreateIndex
CREATE INDEX "email_mailbox_copies_organization_id_message_id_idx" ON "email_mailbox_copies"("organization_id", "message_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_mailbox_copies_organization_id_account_id_gmail_messa_key" ON "email_mailbox_copies"("organization_id", "account_id", "gmail_message_id");

-- CreateIndex
CREATE INDEX "email_templates_organization_id_shared_owner_id_updated_at__idx" ON "email_templates"("organization_id", "shared", "owner_id", "updated_at" DESC, "id");

-- CreateIndex
CREATE INDEX "gmail_sync_states_organization_id_next_attempt_at_idx" ON "gmail_sync_states"("organization_id", "next_attempt_at");

-- CreateIndex
CREATE INDEX "gmail_sync_states_next_attempt_at_idx" ON "gmail_sync_states"("next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "gmail_sync_states_organization_id_account_id_key" ON "gmail_sync_states"("organization_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_suppressions_organization_id_recipient_key_key" ON "email_suppressions"("organization_id", "recipient_key");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_organization_id_id_key" ON "contacts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_organization_id_id_key" ON "leads"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "activities_organization_id_id_key" ON "activities"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "email_record_links" ADD CONSTRAINT "email_record_links_organization_id_thread_id_fkey" FOREIGN KEY ("organization_id", "thread_id") REFERENCES "email_threads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "gmail_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_organization_id_thread_id_fkey" FOREIGN KEY ("organization_id", "thread_id") REFERENCES "email_threads"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_mailbox_copies" ADD CONSTRAINT "email_mailbox_copies_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "gmail_accounts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_mailbox_copies" ADD CONSTRAINT "email_mailbox_copies_organization_id_message_id_fkey" FOREIGN KEY ("organization_id", "message_id") REFERENCES "email_messages"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gmail_sync_states" ADD CONSTRAINT "gmail_sync_states_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "gmail_accounts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "gmail_accounts" ADD CONSTRAINT "gmail_accounts_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "gmail_oauth_states" ADD CONSTRAINT "gmail_oauth_states_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "email_record_links" ADD CONSTRAINT "email_record_links_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "email_mailbox_copies" ADD CONSTRAINT "email_mailbox_copies_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "gmail_sync_states" ADD CONSTRAINT "gmail_sync_states_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX "gmail_accounts_active_subject_key" ON "gmail_accounts" ("google_subject") WHERE status IN ('connected','syncing','delayed','reconnect_required','paused');
CREATE UNIQUE INDEX "gmail_accounts_active_member_key" ON "gmail_accounts" (organization_id, user_id) WHERE status IN ('connected','syncing','delayed','reconnect_required','paused');
ALTER TABLE gmail_accounts ADD CONSTRAINT gmail_accounts_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE gmail_oauth_states ADD CONSTRAINT gmail_oauth_states_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE email_templates ADD CONSTRAINT email_templates_owner_fk FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE email_record_links ADD CONSTRAINT email_record_links_one_record CHECK ((lead_id IS NULL) <> (contact_id IS NULL));
ALTER TABLE email_record_links ADD CONSTRAINT email_record_links_lead_fk FOREIGN KEY (organization_id, lead_id) REFERENCES leads(organization_id,id) ON DELETE CASCADE;
ALTER TABLE email_record_links ADD CONSTRAINT email_record_links_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES contacts(organization_id,id) ON DELETE CASCADE;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_activity_fk FOREIGN KEY (organization_id, activity_id) REFERENCES activities(organization_id,id) ON DELETE SET NULL (activity_id);
ALTER TABLE gmail_accounts ADD CONSTRAINT gmail_accounts_status_check CHECK (status IN ('connected','syncing','delayed','reconnect_required','paused','disconnected','deleting'));
ALTER TABLE email_messages ADD CONSTRAINT email_messages_status_check CHECK (status IN ('queued','sending','provider_accepted','received','failed','cancelled','unknown','bounced','redacted'));
ALTER TABLE email_messages ADD CONSTRAINT email_messages_direction_check CHECK (direction IN ('inbound','outbound'));
RESET lock_timeout;
