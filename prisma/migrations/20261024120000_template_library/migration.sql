-- Preserve all existing email templates and their ownership/content.
ALTER TABLE "email_templates"
  ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'email',
  ADD COLUMN "category" TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN "body_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "archived_at" TIMESTAMPTZ(6);

-- Search visible message text rather than matching HTML formatting tags.
UPDATE "email_templates" SET "body_text" = replace(replace(replace(replace(replace(
  regexp_replace("body_html", '<[^>]+>', ' ', 'g'),
  '&nbsp;', ' '), '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"');

ALTER TABLE "email_templates"
  ADD CONSTRAINT "email_templates_channel_check" CHECK ("channel" IN ('email', 'whatsapp', 'sms')),
  ADD CONSTRAINT "email_templates_category_check" CHECK ("category" IN ('general', 'introduction', 'follow_up', 'meeting', 'proposal', 'customer_care'));

CREATE INDEX "email_templates_library_idx"
  ON "email_templates" ("organization_id", "channel", "archived_at", "updated_at" DESC, "id");
