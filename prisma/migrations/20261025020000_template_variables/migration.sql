ALTER TABLE "email_templates"
  ADD COLUMN "record_type" TEXT NOT NULL DEFAULT 'any',
  ADD COLUMN "variables" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "email_templates"
  ADD CONSTRAINT "email_templates_record_type_check" CHECK ("record_type" IN ('any', 'lead', 'contact')),
  ADD CONSTRAINT "email_templates_variables_array_check" CHECK (jsonb_typeof("variables") = 'array' AND jsonb_array_length("variables") <= 30);
