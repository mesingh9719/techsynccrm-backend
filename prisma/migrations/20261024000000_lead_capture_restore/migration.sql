-- Lead capture (M14) tables and columns.
--
-- Production already has these: they were created by 20261021000000_lead_capture,
-- 20261021010000_lead_latest_enquiry and 20261021020000_lead_source_catalog, which are not in this
-- repository. Every statement is guarded, so on production this migration changes nothing and on a
-- new database it recreates the same definitions (columns, keys, CHECKs and indexes copied from
-- production on 2026-10-24). lead_source_catalog rows are not seeded here.

CREATE TABLE IF NOT EXISTS "web_forms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "source_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "views" INTEGER NOT NULL DEFAULT 0,
    "submissions" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "web_forms_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "web_forms_key_check" CHECK ("key" ~ '^[A-Za-z0-9_-]{22}$'),
    CONSTRAINT "web_forms_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "web_forms_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "lead_sources"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "web_forms_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX IF NOT EXISTS "web_forms_key_key" ON "web_forms"("key");
CREATE UNIQUE INDEX IF NOT EXISTS "web_forms_id_organization_id_key" ON "web_forms"("id", "organization_id");
CREATE INDEX IF NOT EXISTS "web_forms_organization_id_idx" ON "web_forms"("organization_id") WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "web_forms_source_id_idx" ON "web_forms"("source_id");
CREATE INDEX IF NOT EXISTS "web_forms_created_by_id_idx" ON "web_forms"("created_by_id");

CREATE TABLE IF NOT EXISTS "web_form_submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "lead_id" UUID,
    "outcome" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "web_form_submissions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "web_form_submissions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "web_form_submissions_form_id_organization_id_fkey" FOREIGN KEY ("form_id", "organization_id") REFERENCES "web_forms"("id", "organization_id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "web_form_submissions_form_id_created_at_idx" ON "web_form_submissions"("form_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "web_form_submissions_lead_id_idx" ON "web_form_submissions"("lead_id");
CREATE INDEX IF NOT EXISTS "web_form_submissions_organization_id_form_id_idx" ON "web_form_submissions"("organization_id", "form_id");

CREATE TABLE IF NOT EXISTS "assignment_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "strategy" TEXT NOT NULL DEFAULT 'round_robin',
    "member_ids" UUID[] NOT NULL DEFAULT '{}'::UUID[],
    "outside_hours" TEXT NOT NULL DEFAULT 'assign_anyway',
    "only_working_hours" BOOLEAN NOT NULL DEFAULT true,
    "daily_cap" INTEGER,
    "last_assigned_index" INTEGER NOT NULL DEFAULT -1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assignment_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assignment_rules_strategy_check" CHECK ("strategy" IN ('round_robin', 'load_balanced', 'specific_user')),
    CONSTRAINT "assignment_rules_outside_hours_check" CHECK ("outside_hours" IN ('assign_anyway', 'hold_until_open', 'fallback')),
    CONSTRAINT "assignment_rules_daily_cap_check" CHECK ("daily_cap" IS NULL OR "daily_cap" >= 1),
    CONSTRAINT "assignment_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "assignment_rules_organization_id_position_idx" ON "assignment_rules"("organization_id", "position");

CREATE TABLE IF NOT EXISTS "working_hours" (
    "organization_id" UUID NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "days" SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6}'::SMALLINT[],
    "start_time" TEXT NOT NULL DEFAULT '10:00',
    "end_time" TEXT NOT NULL DEFAULT '19:00',
    "fallback_owner_id" UUID,
    "first_response_sla_minutes" INTEGER,
    "sla_auto_reassign" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "working_hours_pkey" PRIMARY KEY ("organization_id"),
    CONSTRAINT "working_hours_start_time_check" CHECK ("start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    CONSTRAINT "working_hours_end_time_check" CHECK ("end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    CONSTRAINT "working_hours_first_response_sla_minutes_check" CHECK ("first_response_sla_minutes" IS NULL OR ("first_response_sla_minutes" >= 1 AND "first_response_sla_minutes" <= 1440)),
    CONSTRAINT "working_hours_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "working_hours_fallback_owner_id_fkey" FOREIGN KEY ("fallback_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "working_hours_fallback_owner_id_idx" ON "working_hours"("fallback_owner_id");

CREATE TABLE IF NOT EXISTS "out_of_office" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "out_of_office_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "out_of_office_check" CHECK ("ends_at" > "starts_at"),
    CONSTRAINT "out_of_office_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "out_of_office_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "out_of_office_organization_id_user_id_ends_at_idx" ON "out_of_office"("organization_id", "user_id", "ends_at");
CREATE INDEX IF NOT EXISTS "out_of_office_user_id_idx" ON "out_of_office"("user_id");

CREATE TABLE IF NOT EXISTS "lead_source_catalog" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "description" TEXT NOT NULL DEFAULT '',
    "default_score_weight" INTEGER NOT NULL DEFAULT 5,
    "allow_web_form" BOOLEAN NOT NULL DEFAULT false,
    "default_enabled" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lead_source_catalog_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "lead_source_catalog_key_check" CHECK ("key" ~ '^[a-z0-9_]{2,40}$'),
    CONSTRAINT "lead_source_catalog_default_score_weight_check" CHECK ("default_score_weight" >= 0 AND "default_score_weight" <= 20)
);
CREATE UNIQUE INDEX IF NOT EXISTS "lead_source_catalog_name_key" ON "lead_source_catalog"("name");

ALTER TABLE "leads"
    ADD COLUMN IF NOT EXISTS "web_form_id" UUID,
    ADD COLUMN IF NOT EXISTS "assignment_rule_id" UUID,
    ADD COLUMN IF NOT EXISTS "assignment_held_at" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "sla_reminded_at" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "sla_escalated_at" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "latest_source_id" UUID,
    ADD COLUMN IF NOT EXISTS "latest_web_form_id" UUID,
    ADD COLUMN IF NOT EXISTS "latest_enquiry_at" TIMESTAMPTZ(6);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_web_form_id_fkey') THEN
    ALTER TABLE "leads" ADD CONSTRAINT "leads_web_form_id_fkey" FOREIGN KEY ("web_form_id") REFERENCES "web_forms"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "leads_web_form_id_idx" ON "leads"("web_form_id");
CREATE INDEX IF NOT EXISTS "leads_assignment_held_idx" ON "leads"("organization_id", "assignment_held_at") WHERE "assignment_held_at" IS NOT NULL AND "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "leads_sla_pending_idx" ON "leads"("organization_id", "created_at") WHERE "status" = 'new' AND "first_responded_at" IS NULL AND "owner_id" IS NOT NULL AND "deleted_at" IS NULL;

ALTER TABLE "campaigns"
    ADD COLUMN IF NOT EXISTS "impressions" INTEGER,
    ADD COLUMN IF NOT EXISTS "clicks" INTEGER,
    ADD COLUMN IF NOT EXISTS "synced_at" TIMESTAMPTZ(6);
