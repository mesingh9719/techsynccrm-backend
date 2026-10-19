-- AlterTable
ALTER TABLE "users" ADD COLUMN     "digest_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "quiet_hours" JSONB;

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "entity_type" TEXT,
    "entity_id" UUID,
    "url" TEXT,
    "actor_id" UUID,
    "group_count" INTEGER NOT NULL DEFAULT 1,
    "source_event_id" UUID,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "context" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMPTZ(6),
    "emailed_at" TIMESTAMPTZ(6),
    "email_pending_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("organization_id","user_id","type")
);

-- CreateTable
CREATE TABLE "notification_receipts" (
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_receipts_pkey" PRIMARY KEY ("organization_id","user_id","source_event_id")
);

-- CreateTable
CREATE TABLE "notification_email_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "notification_ids" UUID[],
    "available_at" TIMESTAMPTZ(6) NOT NULL,
    "claimed_until" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_email_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_stream_tickets" (
    "token_hash" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_stream_tickets_pkey" PRIMARY KEY ("token_hash")
);

-- CreateIndex
CREATE INDEX "notifications_organization_id_user_id_in_app_read_at_create_idx" ON "notifications"("organization_id", "user_id", "in_app", "read_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_email_pending_at_idx" ON "notifications"("email_pending_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_organization_id_user_id_source_event_id_key" ON "notifications"("organization_id", "user_id", "source_event_id");

-- CreateIndex
CREATE INDEX "notification_receipts_created_at_idx" ON "notification_receipts"("created_at");

-- CreateIndex
CREATE INDEX "notification_email_batches_organization_id_user_id_kind_sen_idx" ON "notification_email_batches"("organization_id", "user_id", "kind", "sent_at");

-- CreateIndex
CREATE INDEX "notification_email_batches_sent_at_available_at_idx" ON "notification_email_batches"("sent_at", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_email_batches_organization_id_user_id_kind_key_key" ON "notification_email_batches"("organization_id", "user_id", "kind", "key");

-- CreateIndex
CREATE INDEX "notification_stream_tickets_organization_id_user_id_idx" ON "notification_stream_tickets"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "notification_stream_tickets_expires_at_idx" ON "notification_stream_tickets"("expires_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_receipts" ADD CONSTRAINT "notification_receipts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_receipts" ADD CONSTRAINT "notification_receipts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_email_batches" ADD CONSTRAINT "notification_email_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_email_batches" ADD CONSTRAINT "notification_email_batches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_stream_tickets" ADD CONSTRAINT "notification_stream_tickets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_stream_tickets" ADD CONSTRAINT "notification_stream_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
