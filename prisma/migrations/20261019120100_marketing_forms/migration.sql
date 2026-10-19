-- CreateEnum
CREATE TYPE "InboundStatus" AS ENUM ('new', 'in_progress', 'closed', 'spam');

-- CreateEnum
CREATE TYPE "NewsletterStatus" AS ENUM ('pending', 'confirmed', 'unsubscribed');

-- CreateTable
CREATE TABLE "contact_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "phone" TEXT,
    "topic" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "InboundStatus" NOT NULL DEFAULT 'new',
    "consent_text" TEXT NOT NULL,
    "consent_at" TIMESTAMPTZ(6) NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demo_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "confirmation_id" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "company_size" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "interests" TEXT[],
    "slot_start" TIMESTAMPTZ(6) NOT NULL,
    "notes" TEXT,
    "status" "InboundStatus" NOT NULL DEFAULT 'new',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_subscribers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "status" "NewsletterStatus" NOT NULL DEFAULT 'pending',
    "confirm_token_hash" TEXT,
    "confirm_expires_at" TIMESTAMPTZ(6),
    "confirm_sent_at" TIMESTAMPTZ(6),
    "unsubscribe_token" TEXT NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),
    "unsubscribed_at" TIMESTAMPTZ(6),
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "newsletter_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contact_requests_ticket_no_key" ON "contact_requests"("ticket_no");

-- CreateIndex
CREATE INDEX "contact_requests_status_created_at_idx" ON "contact_requests"("status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "demo_requests_confirmation_id_key" ON "demo_requests"("confirmation_id");

-- CreateIndex
CREATE INDEX "demo_requests_slot_start_idx" ON "demo_requests"("slot_start");

-- CreateIndex
CREATE INDEX "demo_requests_status_created_at_idx" ON "demo_requests"("status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscribers_email_key" ON "newsletter_subscribers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscribers_confirm_token_hash_key" ON "newsletter_subscribers"("confirm_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscribers_unsubscribe_token_key" ON "newsletter_subscribers"("unsubscribe_token");

-- CreateIndex
CREATE INDEX "newsletter_subscribers_status_created_at_idx" ON "newsletter_subscribers"("status", "created_at" DESC);
