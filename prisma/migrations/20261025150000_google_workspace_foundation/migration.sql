-- Additive Workspace foundation. Gmail storage and callbacks remain unchanged.
CREATE TABLE google_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, google_subject text NOT NULL, email text NOT NULL,
 project_number text NOT NULL, client_fingerprint text NOT NULL, grant_hash text NOT NULL,
 status text NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','reconnect_required','disconnected')),
 generation integer NOT NULL DEFAULT 1 CHECK(generation > 0), granted_scopes text[] NOT NULL DEFAULT '{}',
 credential_enc text, wrapped_key text, key_version text, refresh_lease_until timestamptz, refresh_lease_token uuid,
 last_success_at timestamptz, last_error text, next_check_at timestamptz NOT NULL DEFAULT now(), disconnected_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,user_id),
 CHECK ((credential_enc IS NULL AND wrapped_key IS NULL AND key_version IS NULL) OR (credential_enc IS NOT NULL AND wrapped_key IS NOT NULL AND key_version IS NOT NULL)),
 CHECK (status <> 'disconnected' OR credential_enc IS NULL)
);
CREATE INDEX google_connections_organization_id_status_next_check_at_idx ON google_connections(organization_id,status,next_check_at);
CREATE INDEX google_connections_status_next_check_at_idx ON google_connections(status,next_check_at);
CREATE INDEX google_connections_grant_hash_idx ON google_connections(grant_hash);
CREATE INDEX google_connections_user_id_idx ON google_connections(user_id);
CREATE TABLE google_service_consents (
 organization_id uuid NOT NULL, connection_id uuid NOT NULL, service text NOT NULL CHECK(service IN ('calendar','drive','sheets')),
 enabled boolean NOT NULL DEFAULT false, consent_version text NOT NULL, consent_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,connection_id,service),
 FOREIGN KEY(organization_id,connection_id) REFERENCES google_connections(organization_id,id) ON DELETE CASCADE
);
CREATE TABLE google_workspace_oauth_states (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_id uuid NOT NULL,
 state_hash text NOT NULL UNIQUE, browser_hash text NOT NULL, verifier_enc text NOT NULL, nonce text NOT NULL,
 service text NOT NULL CHECK(service IN ('calendar','drive','sheets')), consent_version text NOT NULL,
 expected_generation integer NOT NULL, client_fingerprint text NOT NULL, return_to text NOT NULL,
 expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_workspace_oauth_states_organization_id_user_id_idx ON google_workspace_oauth_states(organization_id,user_id);
CREATE INDEX google_workspace_oauth_states_expires_at_idx ON google_workspace_oauth_states(expires_at);
CREATE TABLE google_workspace_settings (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
 calendar_enabled boolean NOT NULL DEFAULT false, drive_enabled boolean NOT NULL DEFAULT false,
 sheets_enabled boolean NOT NULL DEFAULT false, exports_enabled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE google_sync_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 connection_id uuid, actor_user_id uuid, action text NOT NULL, service text CHECK(service IN ('calendar','drive','sheets')),
 status text NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,connection_id) REFERENCES google_connections(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX google_sync_logs_organization_id_created_at_id_idx ON google_sync_logs(organization_id,created_at,id);
CREATE INDEX google_sync_logs_organization_id_connection_id_created_at_idx ON google_sync_logs(organization_id,connection_id,created_at);
CREATE INDEX google_sync_logs_created_at_idx ON google_sync_logs(created_at);
-- Deliberately no operational tenant/user FK: encrypted revocation survives their deletion.
CREATE TABLE google_revocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, connection_id uuid NOT NULL,
 grant_hash text NOT NULL UNIQUE, credential_enc text NOT NULL, wrapped_key text NOT NULL, key_version text NOT NULL,
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_token uuid,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_revocations_organization_id_next_attempt_at_idx ON google_revocations(organization_id,next_attempt_at);
CREATE INDEX google_revocations_next_attempt_at_lease_until_idx ON google_revocations(next_attempt_at,lease_until);
CREATE INDEX google_revocations_expires_at_idx ON google_revocations(expires_at);
