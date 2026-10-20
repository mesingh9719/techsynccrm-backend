-- M10 — Activities, tasks & timeline

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('note', 'call', 'meeting', 'site_visit', 'whatsapp', 'email', 'sms', 'system');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('open', 'completed', 'cancelled');

-- CreateTable
CREATE TABLE "activities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "type" "ActivityType" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "end_at" TIMESTAMPTZ(6),
    "direction" TEXT,
    "outcome" TEXT,
    "duration_seconds" INTEGER,
    "location" JSONB,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "actor_id" UUID,
    "source_event_id" UUID,
    "edited_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_links" (
    "activity_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "activity_links_pkey" PRIMARY KEY ("activity_id","entity_type","entity_id")
);

-- CreateTable
CREATE TABLE "activity_participants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "user_id" UUID,
    "contact_id" UUID,

    CONSTRAINT "activity_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'todo',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" "TaskStatus" NOT NULL DEFAULT 'open',
    "due_at" TIMESTAMPTZ(6),
    "all_day" BOOLEAN NOT NULL DEFAULT false,
    "reminder_offset_minutes" INTEGER DEFAULT 15,
    "reminder_job_id" TEXT,
    "recurrence" JSONB,
    "series_id" UUID,
    "entity_type" TEXT,
    "entity_id" UUID,
    "assignee_id" UUID NOT NULL,
    "created_by_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_id" UUID,
    "overdue_notified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "activities_source_event_id_key" ON "activities"("source_event_id");

-- CreateIndex
CREATE INDEX "activities_organization_id_entity_type_entity_id_occurred_a_idx" ON "activities"("organization_id", "entity_type", "entity_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "activity_links_organization_id_entity_type_entity_id_occurr_idx" ON "activity_links"("organization_id", "entity_type", "entity_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "activity_participants_activity_id_idx" ON "activity_participants"("activity_id");

-- CreateIndex
CREATE INDEX "activity_participants_organization_id_contact_id_idx" ON "activity_participants"("organization_id", "contact_id");

-- CreateIndex
CREATE INDEX "mentions_organization_id_user_id_created_at_idx" ON "mentions"("organization_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mentions_activity_id_user_id_key" ON "mentions"("activity_id", "user_id");

-- CreateIndex
CREATE INDEX "tasks_organization_id_assignee_id_status_due_at_idx" ON "tasks"("organization_id", "assignee_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "tasks_organization_id_entity_type_entity_id_idx" ON "tasks"("organization_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "tasks_status_due_at_idx" ON "tasks"("status", "due_at");

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_links" ADD CONSTRAINT "activity_links_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_participants" ADD CONSTRAINT "activity_participants_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------- Indexes not expressible in Prisma ----------

-- "My tasks" views and the overdue scan only look at live open tasks.
CREATE INDEX "tasks_open_due_idx" ON "tasks" ("organization_id", "assignee_id", "due_at") WHERE "status" = 'open' AND "deleted_at" IS NULL;
CREATE INDEX "tasks_overdue_scan_idx" ON "tasks" ("due_at") WHERE "status" = 'open' AND "deleted_at" IS NULL AND "overdue_notified_at" IS NULL;
