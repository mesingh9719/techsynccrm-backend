-- M07 — Companies, contacts, tags & custom fields

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "industry" TEXT,
    "size" TEXT,
    "gstin" TEXT,
    "phone_e164" TEXT,
    "phone_raw" TEXT,
    "email" TEXT,
    "website" TEXT,
    "billing_address" JSONB,
    "shipping_address" JSONB,
    "owner_id" UUID,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "merged_into_id" UUID,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "display_name" TEXT NOT NULL,
    "title" TEXT,
    "emails" JSONB NOT NULL DEFAULT '[]',
    "phones" JSONB NOT NULL DEFAULT '[]',
    "primary_email" TEXT,
    "primary_phone_e164" TEXT,
    "lifecycle_stage" TEXT NOT NULL DEFAULT 'lead',
    "whatsapp_opt_in_at" TIMESTAMPTZ(6),
    "email_opt_in_at" TIMESTAMPTZ(6),
    "opt_out_at" TIMESTAMPTZ(6),
    "consent_source" TEXT,
    "source" TEXT,
    "owner_id" UUID,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "merged_into_id" UUID,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_phones" (
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "e164" TEXT NOT NULL,

    CONSTRAINT "contact_phones_pkey" PRIMARY KEY ("contact_id","e164")
);

-- CreateTable
CREATE TABLE "contact_emails" (
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "email" TEXT NOT NULL,

    CONSTRAINT "contact_emails_pkey" PRIMARY KEY ("contact_id","email")
);

-- CreateTable
CREATE TABLE "contact_companies" (
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "role" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_companies_pkey" PRIMARY KEY ("contact_id","company_id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'zinc',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_tags" (
    "organization_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_tags_pkey" PRIMARY KEY ("tag_id","entity_type","entity_id")
);

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "companies_organization_id_owner_id_idx" ON "companies"("organization_id", "owner_id");

-- CreateIndex
CREATE INDEX "companies_organization_id_domain_idx" ON "companies"("organization_id", "domain");

-- CreateIndex
CREATE INDEX "companies_organization_id_gstin_idx" ON "companies"("organization_id", "gstin");

-- CreateIndex
CREATE INDEX "companies_organization_id_created_at_idx" ON "companies"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "contacts_organization_id_owner_id_idx" ON "contacts"("organization_id", "owner_id");

-- CreateIndex
CREATE INDEX "contacts_organization_id_primary_phone_e164_idx" ON "contacts"("organization_id", "primary_phone_e164");

-- CreateIndex
CREATE INDEX "contacts_organization_id_primary_email_idx" ON "contacts"("organization_id", "primary_email");

-- CreateIndex
CREATE INDEX "contacts_organization_id_created_at_idx" ON "contacts"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "contact_phones_organization_id_e164_idx" ON "contact_phones"("organization_id", "e164");

-- CreateIndex
CREATE INDEX "contact_emails_organization_id_email_idx" ON "contact_emails"("organization_id", "email");

-- CreateIndex
CREATE INDEX "contact_companies_organization_id_company_id_idx" ON "contact_companies"("organization_id", "company_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_organization_id_name_key" ON "tags"("organization_id", "name");

-- CreateIndex
CREATE INDEX "record_tags_organization_id_entity_type_entity_id_idx" ON "record_tags"("organization_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "custom_field_definitions_organization_id_entity_type_positi_idx" ON "custom_field_definitions"("organization_id", "entity_type", "position");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_organization_id_entity_type_key_key" ON "custom_field_definitions"("organization_id", "entity_type", "key");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_phones" ADD CONSTRAINT "contact_phones_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_emails" ADD CONSTRAINT "contact_emails_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_companies" ADD CONSTRAINT "contact_companies_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_companies" ADD CONSTRAINT "contact_companies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_tags" ADD CONSTRAINT "record_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------- Search & filtering (raw SQL, not expressible in Prisma) ----------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ILIKE '%…%' search on names
CREATE INDEX "contacts_display_name_trgm_idx" ON "contacts" USING GIN ("display_name" gin_trgm_ops) WHERE "deleted_at" IS NULL;
CREATE INDEX "companies_name_trgm_idx" ON "companies" USING GIN ("name" gin_trgm_ops) WHERE "deleted_at" IS NULL;
CREATE INDEX "contact_emails_email_trgm_idx" ON "contact_emails" USING GIN ("email" gin_trgm_ops);

-- Custom field filters (custom_fields @> / ->>)
CREATE INDEX "contacts_custom_fields_idx" ON "contacts" USING GIN ("custom_fields" jsonb_path_ops);
CREATE INDEX "companies_custom_fields_idx" ON "companies" USING GIN ("custom_fields" jsonb_path_ops);

-- Default list order, live rows only
CREATE INDEX "contacts_live_created_idx" ON "contacts" ("organization_id", "created_at" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "companies_live_created_idx" ON "companies" ("organization_id", "created_at" DESC) WHERE "deleted_at" IS NULL;
