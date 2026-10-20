BEGIN;
CREATE TABLE facebook_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  connected_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
  facebook_user_id TEXT NOT NULL, name TEXT NOT NULL,
  token_enc TEXT NOT NULL, token_expires_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, organization_id)
);
CREATE INDEX facebook_connections_connected_by_id_idx ON facebook_connections(connected_by_id);
CREATE TABLE facebook_oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE, browser_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX facebook_oauth_states_expires_at_idx ON facebook_oauth_states(expires_at);
CREATE INDEX facebook_oauth_states_organization_id_user_id_idx ON facebook_oauth_states(organization_id, user_id);
CREATE INDEX facebook_oauth_states_user_id_idx ON facebook_oauth_states(user_id);
CREATE TABLE facebook_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL,
  facebook_page_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  token_enc TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, organization_id),
  FOREIGN KEY(connection_id, organization_id) REFERENCES facebook_connections(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX facebook_pages_organization_id_idx ON facebook_pages(organization_id);
CREATE INDEX facebook_pages_connection_id_organization_id_idx ON facebook_pages(connection_id, organization_id);
CREATE TABLE facebook_forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  page_id UUID NOT NULL, facebook_form_id TEXT NOT NULL, name TEXT NOT NULL,
  mapping JSONB NOT NULL DEFAULT '{}', enabled BOOLEAN NOT NULL DEFAULT FALSE,
  default_owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  dedupe BOOLEAN NOT NULL DEFAULT TRUE,
  sync_status TEXT NOT NULL DEFAULT 'idle', sync_after TEXT, sync_lease_until TIMESTAMPTZ(6),
  last_synced_at TIMESTAMPTZ(6), last_error TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(page_id, facebook_form_id),
  FOREIGN KEY(page_id, organization_id) REFERENCES facebook_pages(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX facebook_forms_organization_id_page_id_idx ON facebook_forms(organization_id, page_id);
CREATE INDEX facebook_forms_default_owner_id_idx ON facebook_forms(default_owner_id);
CREATE INDEX facebook_forms_sync_status_sync_lease_until_idx ON facebook_forms(sync_status, sync_lease_until);
CREATE INDEX facebook_forms_page_id_organization_id_idx ON facebook_forms(page_id, organization_id);
CREATE TABLE facebook_lead_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  page_id UUID NOT NULL, facebook_lead_id TEXT NOT NULL, facebook_form_id TEXT NOT NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending', outcome TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB NOT NULL DEFAULT '{}', last_error TEXT, processed_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(page_id, facebook_lead_id),
  FOREIGN KEY(page_id, organization_id) REFERENCES facebook_pages(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX facebook_lead_deliveries_organization_id_created_at_idx ON facebook_lead_deliveries(organization_id, created_at DESC);
CREATE INDEX facebook_lead_deliveries_status_next_attempt_at_idx ON facebook_lead_deliveries(status, next_attempt_at);
CREATE INDEX facebook_lead_deliveries_page_id_organization_id_idx ON facebook_lead_deliveries(page_id, organization_id);
CREATE INDEX facebook_lead_deliveries_lead_id_idx ON facebook_lead_deliveries(lead_id);
COMMIT;
