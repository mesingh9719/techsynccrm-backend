BEGIN;
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  code VARCHAR(80) NOT NULL,
  type VARCHAR(20) NOT NULL,
  objective VARCHAR(30) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  start_date DATE NOT NULL,
  end_date DATE,
  budget_minor BIGINT,
  actual_spend_minor BIGINT,
  currency CHAR(3) NOT NULL,
  source_id UUID,
  owner_id UUID,
  external_account_id VARCHAR(100),
  external_campaign_id VARCHAR(100),
  external_platform VARCHAR(20),
  landing_url VARCHAR(2000),
  target_audience VARCHAR(2000),
  description VARCHAR(10000),
  utm JSONB NOT NULL DEFAULT '{}',
  created_by_id UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL,
  deleted_at TIMESTAMPTZ(6),
  CONSTRAINT campaigns_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT campaigns_organization_id_code_key UNIQUE (organization_id, code),
  CONSTRAINT campaigns_organization_id_external_platform_external_campaign_key UNIQUE (organization_id, external_platform, external_campaign_id),
  CONSTRAINT campaigns_code_check CHECK (code ~ '^[a-z0-9]+([-_][a-z0-9]+)*$'),
  CONSTRAINT campaigns_type_check CHECK (type IN ('meta_ads','google_ads','email','sms','website','referral','offline','other')),
  CONSTRAINT campaigns_objective_check CHECK (objective IN ('lead_generation','brand_awareness','conversion','retargeting','event','retention')),
  CONSTRAINT campaigns_status_check CHECK (status IN ('draft','scheduled','active','paused','completed','archived')),
  CONSTRAINT campaigns_dates_check CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT campaigns_budget_check CHECK (budget_minor IS NULL OR budget_minor BETWEEN 0 AND 9007199254740991),
  CONSTRAINT campaigns_spend_check CHECK (actual_spend_minor IS NULL OR actual_spend_minor BETWEEN 0 AND 9007199254740991),
  CONSTRAINT campaigns_currency_check CHECK (currency IN ('INR','USD')),
  CONSTRAINT campaigns_platform_check CHECK (external_platform IS NULL OR external_platform IN ('facebook','google'))
);
CREATE INDEX campaigns_organization_id_owner_id_status_idx ON campaigns(organization_id, owner_id, status);
CREATE INDEX campaigns_organization_id_created_at_idx ON campaigns(organization_id, created_at DESC);
ALTER TABLE leads ADD COLUMN campaign_id UUID;
CREATE INDEX leads_organization_id_campaign_id_idx ON leads(organization_id, campaign_id);
ALTER TABLE leads ADD CONSTRAINT leads_organization_id_campaign_id_fkey
  FOREIGN KEY (organization_id, campaign_id) REFERENCES campaigns(organization_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION;
COMMIT;
