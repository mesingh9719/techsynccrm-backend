-- CreateTable
CREATE TABLE "google_calendar_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "google_subject" TEXT NOT NULL,
    "project_number" TEXT NOT NULL,
    "provider_calendar_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "meet_supported" BOOLEAN NOT NULL DEFAULT false,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "google_calendar_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_calendar_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "calendar_link_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "lead_id" UUID,
    "request_id" UUID NOT NULL,
    "request_hash" TEXT NOT NULL,
    "connection_generation" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "time_zone" TEXT NOT NULL,
    "location" TEXT,
    "include_meet" BOOLEAN NOT NULL DEFAULT false,
    "attendees" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 1,
    "synced_revision" INTEGER NOT NULL DEFAULT 0,
    "etag" TEXT,
    "projection" JSONB,
    "meet_url" TEXT,
    "meet_status" TEXT NOT NULL DEFAULT 'none',
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(6),
    "lease_token" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "google_calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_sheets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "google_subject" TEXT NOT NULL,
    "project_number" TEXT NOT NULL,
    "connection_generation" INTEGER NOT NULL,
    "lead_id" UUID,
    "request_id" UUID NOT NULL,
    "request_hash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'blank',
    "source" JSONB NOT NULL,
    "provider_file_id" TEXT,
    "sheet_id" INTEGER NOT NULL,
    "create_attempted" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(6),
    "lease_token" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "google_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "google_calendar_links_organization_id_id_key" ON "google_calendar_links"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "google_calendar_links_organization_id_connection_id_google__key" ON "google_calendar_links"("organization_id", "connection_id", "google_subject");

-- CreateIndex
CREATE INDEX "google_calendar_events_organization_id_calendar_link_id_sta_idx" ON "google_calendar_events"("organization_id", "calendar_link_id", "start_at");

-- CreateIndex
CREATE INDEX "google_calendar_events_organization_id_lead_id_start_at_idx" ON "google_calendar_events"("organization_id", "lead_id", "start_at");

-- CreateIndex
CREATE INDEX "google_calendar_events_status_next_attempt_at_lease_until_idx" ON "google_calendar_events"("status", "next_attempt_at", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "google_calendar_events_organization_id_id_key" ON "google_calendar_events"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "google_calendar_events_organization_id_calendar_link_id_req_key" ON "google_calendar_events"("organization_id", "calendar_link_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "google_calendar_events_organization_id_task_id_key" ON "google_calendar_events"("organization_id", "task_id");

-- CreateIndex
CREATE INDEX "google_sheets_organization_id_connection_id_created_at_idx" ON "google_sheets"("organization_id", "connection_id", "created_at");

-- CreateIndex
CREATE INDEX "google_sheets_organization_id_lead_id_created_at_idx" ON "google_sheets"("organization_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "google_sheets_status_next_attempt_at_lease_until_idx" ON "google_sheets"("status", "next_attempt_at", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "google_sheets_organization_id_id_key" ON "google_sheets"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "google_sheets_organization_id_connection_id_request_id_key" ON "google_sheets"("organization_id", "connection_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_organization_id_id_key" ON "tasks"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "google_calendar_links" ADD CONSTRAINT "google_calendar_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_calendar_links" ADD CONSTRAINT "google_calendar_links_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "google_connections"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_calendar_events" ADD CONSTRAINT "google_calendar_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_calendar_events" ADD CONSTRAINT "google_calendar_events_organization_id_calendar_link_id_fkey" FOREIGN KEY ("organization_id", "calendar_link_id") REFERENCES "google_calendar_links"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_calendar_events" ADD CONSTRAINT "google_calendar_events_organization_id_task_id_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "tasks"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_calendar_events" ADD CONSTRAINT "google_calendar_events_organization_id_lead_id_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_sheets" ADD CONSTRAINT "google_sheets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_sheets" ADD CONSTRAINT "google_sheets_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "google_connections"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_sheets" ADD CONSTRAINT "google_sheets_organization_id_lead_id_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Persist only supported lifecycle states and valid resource bounds.
ALTER TABLE google_calendar_links ADD CONSTRAINT google_calendar_links_status_check CHECK (status IN ('pending','creating','ready','failed','unknown'));
ALTER TABLE google_calendar_events
 ADD CONSTRAINT google_calendar_events_status_check CHECK (status IN ('queued','ready','failed','paused','conflict','cancelled')),
 ADD CONSTRAINT google_calendar_events_meet_status_check CHECK (meet_status IN ('none','pending','ready','unavailable')),
 ADD CONSTRAINT google_calendar_events_bounds_check CHECK (end_at > start_at AND end_at - start_at <= INTERVAL '7 days' AND revision > 0 AND synced_revision >= 0 AND synced_revision <= revision AND connection_generation > 0 AND attempts >= 0 AND cardinality(attendees) <= 20);
ALTER TABLE google_sheets
 ADD CONSTRAINT google_sheets_status_check CHECK (status IN ('queued','ready','failed','paused','unknown')),
 ADD CONSTRAINT google_sheets_bounds_check CHECK (kind IN ('blank','leads') AND sheet_id > 0 AND row_count BETWEEN 0 AND 5000 AND attempts >= 0 AND connection_generation > 0);
