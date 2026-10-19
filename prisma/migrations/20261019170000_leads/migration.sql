-- M08 — Leads

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('new', 'contacted', 'qualified', 'converted', 'lost', 'junk');

-- CreateTable
CREATE TABLE "lead_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "score_weight" INTEGER NOT NULL DEFAULT 5,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lead_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lost_reasons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lost_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "display_name" TEXT NOT NULL,
    "emails" JSONB NOT NULL DEFAULT '[]',
    "phones" JSONB NOT NULL DEFAULT '[]',
    "primary_email" TEXT,
    "primary_phone_e164" TEXT,
    "company_name" TEXT,
    "requirement" TEXT,
    "budget_minor" BIGINT,
    "city" TEXT,
    "state_code" TEXT,
    "pincode" TEXT,
    "source_id" UUID,
    "source_detail" TEXT,
    "utm" JSONB,
    "status" "LeadStatus" NOT NULL DEFAULT 'new',
    "lost_reason_id" UUID,
    "lost_note" TEXT,
    "junk_reason" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "score_breakdown" JSONB,
    "owner_id" UUID,
    "assigned_at" TIMESTAMPTZ(6),
    "first_responded_at" TIMESTAMPTZ(6),
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enquiry_count" INTEGER NOT NULL DEFAULT 1,
    "contact_id" UUID,
    "is_existing_customer" BOOLEAN NOT NULL DEFAULT false,
    "previous_lead_id" UUID,
    "converted_at" TIMESTAMPTZ(6),
    "converted_by_id" UUID,
    "converted_contact_id" UUID,
    "converted_company_id" UUID,
    "converted_deal_id" UUID,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_phones" (
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "e164" TEXT NOT NULL,

    CONSTRAINT "lead_phones_pkey" PRIMARY KEY ("lead_id","e164")
);

-- CreateTable
CREATE TABLE "lead_emails" (
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "email" TEXT NOT NULL,

    CONSTRAINT "lead_emails_pkey" PRIMARY KEY ("lead_id","email")
);

-- CreateTable
CREATE TABLE "saved_views" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "columns" JSONB NOT NULL DEFAULT '[]',
    "is_shared" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_sources_organization_id_name_key" ON "lead_sources"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "lead_sources_organization_id_key_key" ON "lead_sources"("organization_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "lost_reasons_organization_id_entity_type_name_key" ON "lost_reasons"("organization_id", "entity_type", "name");

-- CreateIndex
CREATE INDEX "leads_organization_id_status_created_at_idx" ON "leads"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "leads_organization_id_owner_id_status_idx" ON "leads"("organization_id", "owner_id", "status");

-- CreateIndex
CREATE INDEX "leads_organization_id_primary_phone_e164_idx" ON "leads"("organization_id", "primary_phone_e164");

-- CreateIndex
CREATE INDEX "leads_organization_id_primary_email_idx" ON "leads"("organization_id", "primary_email");

-- CreateIndex
CREATE INDEX "leads_organization_id_source_id_idx" ON "leads"("organization_id", "source_id");

-- CreateIndex
CREATE INDEX "lead_phones_organization_id_e164_idx" ON "lead_phones"("organization_id", "e164");

-- CreateIndex
CREATE INDEX "lead_emails_organization_id_email_idx" ON "lead_emails"("organization_id", "email");

-- CreateIndex
CREATE INDEX "saved_views_organization_id_entity_type_idx" ON "saved_views"("organization_id", "entity_type");

-- AddForeignKey
ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_reasons" ADD CONSTRAINT "lost_reasons_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "lead_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_lost_reason_id_fkey" FOREIGN KEY ("lost_reason_id") REFERENCES "lost_reasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_phones" ADD CONSTRAINT "lead_phones_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_emails" ADD CONSTRAINT "lead_emails_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------- Search & filtering ----------

CREATE INDEX "leads_display_name_trgm_idx" ON "leads" USING GIN ("display_name" gin_trgm_ops) WHERE "deleted_at" IS NULL;
CREATE INDEX "leads_company_name_trgm_idx" ON "leads" USING GIN ("company_name" gin_trgm_ops) WHERE "deleted_at" IS NULL;
CREATE INDEX "leads_custom_fields_idx" ON "leads" USING GIN ("custom_fields" jsonb_path_ops);
CREATE INDEX "leads_live_created_idx" ON "leads" ("organization_id", "created_at" DESC) WHERE "deleted_at" IS NULL;

-- ---------- Defaults for existing workspaces ----------
-- New workspaces get the same rows from services/leadSetup.service.js (keep the two lists in step).

INSERT INTO "lead_sources" ("id", "organization_id", "name", "key", "is_system", "score_weight", "position", "updated_at")
SELECT gen_random_uuid(), o."id", s."name", s."key", s."is_system", s."weight", s."position", now()
FROM "organizations" o
CROSS JOIN (VALUES
    ('Website', 'website', true, 15, 0),
    ('WhatsApp', 'whatsapp', true, 15, 1),
    ('IndiaMART', 'indiamart', true, 15, 2),
    ('JustDial', 'justdial', true, 10, 3),
    ('TradeIndia', 'tradeindia', true, 5, 4),
    ('Facebook Lead Ads', 'facebook_lead_ads', true, 5, 5),
    ('Google Ads', 'google_ads', true, 10, 6),
    ('99acres', 'acres99', true, 5, 7),
    ('MagicBricks', 'magicbricks', true, 5, 8),
    ('Referral', 'referral', false, 20, 9),
    ('Walk-in', 'walk_in', false, 5, 10),
    ('Phone call', 'phone_call', false, 5, 11),
    ('Email', 'email', true, 5, 12),
    ('Other', 'other', false, 5, 13)
) AS s("name", "key", "is_system", "weight", "position")
ON CONFLICT DO NOTHING;

INSERT INTO "lost_reasons" ("id", "organization_id", "entity_type", "name", "position", "updated_at")
SELECT gen_random_uuid(), o."id", 'lead', r."name", r."position", now()
FROM "organizations" o
CROSS JOIN (VALUES ('Budget', 0), ('Timing', 1), ('Competitor', 2), ('No response', 3), ('Not a fit', 4), ('Other', 5)) AS r("name", "position")
ON CONFLICT DO NOTHING;
