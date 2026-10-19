-- M09 — Pipelines & deals

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('open', 'won', 'lost');

-- CreateEnum
CREATE TYPE "StageType" AS ENUM ('open', 'won', 'lost');

-- CreateTable
CREATE TABLE "pipelines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "template_key" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_stages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "StageType" NOT NULL DEFAULT 'open',
    "position" INTEGER NOT NULL DEFAULT 0,
    "probability" INTEGER NOT NULL DEFAULT 0,
    "rotting_days" INTEGER,
    "required_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "status" "DealStatus" NOT NULL DEFAULT 'open',
    "value_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "probability_override" INTEGER,
    "expected_close_date" DATE,
    "company_id" UUID,
    "lead_id" UUID,
    "source_id" UUID,
    "owner_id" UUID,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stage_entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotting_notified_at" TIMESTAMPTZ(6),
    "won_at" TIMESTAMPTZ(6),
    "lost_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "lost_reason_id" UUID,
    "lost_note" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_contacts" (
    "organization_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "role" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_contacts_pkey" PRIMARY KEY ("deal_id","contact_id")
);

-- CreateTable
CREATE TABLE "deal_stage_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "from_stage_id" UUID,
    "to_stage_id" UUID NOT NULL,
    "from_pipeline_id" UUID,
    "to_pipeline_id" UUID NOT NULL,
    "moved_by_id" UUID,
    "moved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seconds_in_prev_stage" INTEGER,

    CONSTRAINT "deal_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pipelines_organization_id_position_idx" ON "pipelines"("organization_id", "position");

-- CreateIndex
CREATE INDEX "pipeline_stages_pipeline_id_position_idx" ON "pipeline_stages"("pipeline_id", "position");

-- CreateIndex
CREATE INDEX "pipeline_stages_organization_id_idx" ON "pipeline_stages"("organization_id");

-- CreateIndex
CREATE INDEX "deals_organization_id_pipeline_id_stage_id_idx" ON "deals"("organization_id", "pipeline_id", "stage_id");

-- CreateIndex
CREATE INDEX "deals_organization_id_owner_id_status_idx" ON "deals"("organization_id", "owner_id", "status");

-- CreateIndex
CREATE INDEX "deals_organization_id_status_closed_at_idx" ON "deals"("organization_id", "status", "closed_at");

-- CreateIndex
CREATE INDEX "deals_organization_id_company_id_idx" ON "deals"("organization_id", "company_id");

-- CreateIndex
CREATE INDEX "deal_contacts_organization_id_contact_id_idx" ON "deal_contacts"("organization_id", "contact_id");

-- CreateIndex
CREATE INDEX "deal_stage_history_organization_id_to_stage_id_moved_at_idx" ON "deal_stage_history"("organization_id", "to_stage_id", "moved_at");

-- CreateIndex
CREATE INDEX "deal_stage_history_deal_id_moved_at_idx" ON "deal_stage_history"("deal_id", "moved_at");

-- AddForeignKey
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "pipeline_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_contacts" ADD CONSTRAINT "deal_contacts_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------- Indexes not expressible in Prisma ----------

CREATE INDEX "deals_title_trgm_idx" ON "deals" USING GIN ("title" gin_trgm_ops) WHERE "deleted_at" IS NULL;
CREATE INDEX "deals_custom_fields_idx" ON "deals" USING GIN ("custom_fields" jsonb_path_ops);
CREATE INDEX "deals_board_idx" ON "deals" ("organization_id", "stage_id", "position") WHERE "deleted_at" IS NULL;
-- One default pipeline per workspace
CREATE UNIQUE INDEX "pipelines_one_default_idx" ON "pipelines" ("organization_id") WHERE "is_default" AND "archived_at" IS NULL;

-- ---------- Default pipeline for existing workspaces ----------
-- New workspaces get an industry template from services/pipeline.service.js. Keep the stages
-- below in step with PIPELINE_TEMPLATES.default (config/pipelineTemplates.js).

WITH created AS (
    INSERT INTO "pipelines" ("id", "organization_id", "name", "is_default", "position", "template_key", "updated_at")
    SELECT gen_random_uuid(), o."id", 'Sales pipeline', true, 0, 'default', now()
    FROM "organizations" o
    WHERE NOT EXISTS (SELECT 1 FROM "pipelines" p WHERE p."organization_id" = o."id")
    RETURNING "id", "organization_id"
)
INSERT INTO "pipeline_stages" ("id", "organization_id", "pipeline_id", "name", "type", "position", "probability", "rotting_days", "updated_at")
SELECT gen_random_uuid(), c."organization_id", c."id", s."name", s."type"::"StageType", s."position", s."probability", s."rotting_days", now()
FROM created c
CROSS JOIN (VALUES
    ('New', 'open', 0, 10, 7),
    ('Qualified', 'open', 1, 30, 7),
    ('Proposal sent', 'open', 2, 60, 7),
    ('Negotiation', 'open', 3, 80, 7),
    ('Won', 'won', 4, 100, NULL),
    ('Lost', 'lost', 5, 0, NULL)
) AS s("name", "type", "position", "probability", "rotting_days");

-- Deal lost reasons, alongside the lead ones from M08.
INSERT INTO "lost_reasons" ("id", "organization_id", "entity_type", "name", "position", "updated_at")
SELECT gen_random_uuid(), o."id", 'deal', r."name", r."position", now()
FROM "organizations" o
CROSS JOIN (VALUES ('Price', 0), ('Competitor', 1), ('No budget', 2), ('No decision', 3), ('Timing', 4), ('Other', 5)) AS r("name", "position")
ON CONFLICT DO NOTHING;
