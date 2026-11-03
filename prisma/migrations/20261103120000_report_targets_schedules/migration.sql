-- M15: monthly sales targets and emailed report schedules. Additive only.
CREATE TABLE sales_targets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  metric varchar(20) NOT NULL CHECK (metric IN ('revenue', 'deals_won')),
  amount bigint NOT NULL CHECK (amount >= 0),
  created_by_id uuid,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL,
  CONSTRAINT sales_targets_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX sales_targets_organization_id_user_id_month_metric_key ON sales_targets (organization_id, user_id, month, metric);
CREATE INDEX sales_targets_organization_id_month_idx ON sales_targets (organization_id, month);
ALTER TABLE sales_targets ADD CONSTRAINT sales_targets_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE sales_targets ADD CONSTRAINT sales_targets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE report_schedules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  frequency varchar(10) NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  filters jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  last_period_key varchar(10),
  last_sent_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL,
  CONSTRAINT report_schedules_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX report_schedules_organization_id_user_id_frequency_key ON report_schedules (organization_id, user_id, frequency);
CREATE INDEX report_schedules_enabled_frequency_idx ON report_schedules (enabled, frequency);
ALTER TABLE report_schedules ADD CONSTRAINT report_schedules_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE report_schedules ADD CONSTRAINT report_schedules_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE;

-- Open-pipeline and lost-reason reports.
CREATE INDEX IF NOT EXISTS deals_report_open_stage_idx ON deals (organization_id, stage_id) INCLUDE (value_minor, owner_id, source_id, expected_close_date) WHERE deleted_at IS NULL AND status = 'open';
CREATE INDEX IF NOT EXISTS deals_report_lost_period_idx ON deals (organization_id, closed_at) INCLUDE (value_minor, owner_id, source_id, lost_reason_id) WHERE deleted_at IS NULL AND status = 'lost';
