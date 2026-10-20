-- M10 originally deployed a per-task queue job id. Move scheduling to the durable scan without
-- rewriting applied history or removing the legacy column. Safe on both old and repaired schemas.
BEGIN;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "remind_at" TIMESTAMPTZ(6);
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "reminder_sent_at" TIMESTAMPTZ(6);

-- Existing future open tasks retain their reminders. Past-due legacy tasks are not newly mailed
-- during deployment. New scan-based reminders already in the database are left untouched.
UPDATE "tasks"
SET "remind_at" = GREATEST(CURRENT_TIMESTAMP, "due_at" - "reminder_offset_minutes" * INTERVAL '1 minute')
WHERE "status" = 'open' AND "deleted_at" IS NULL AND "due_at" > CURRENT_TIMESTAMP
  AND "reminder_offset_minutes" IS NOT NULL AND "reminder_offset_minutes" >= 0
  AND "remind_at" IS NULL AND "reminder_sent_at" IS NULL;

CREATE INDEX IF NOT EXISTS "tasks_remind_scan_idx" ON "tasks" ("remind_at")
WHERE "status" = 'open' AND "deleted_at" IS NULL AND "reminder_sent_at" IS NULL;
COMMIT;
