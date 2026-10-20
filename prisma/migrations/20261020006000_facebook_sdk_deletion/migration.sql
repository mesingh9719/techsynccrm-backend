BEGIN;
ALTER TABLE facebook_connections ADD COLUMN authorized_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE facebook_connections SET authorized_at = updated_at;
CREATE INDEX facebook_connections_facebook_user_id_idx ON facebook_connections(facebook_user_id);
ALTER TABLE facebook_oauth_states ADD COLUMN purpose TEXT NOT NULL DEFAULT 'redirect';
CREATE TABLE facebook_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_hash TEXT NOT NULL UNIQUE,
  confirmation_hash TEXT NOT NULL UNIQUE,
  subject_hash TEXT, subject_enc TEXT,
  cutoff_at TIMESTAMPTZ(6) NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_until TIMESTAMPTZ(6), last_error TEXT,
  completed_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX facebook_deletion_requests_subject_hash_status_idx ON facebook_deletion_requests(subject_hash, status);
CREATE INDEX facebook_deletion_requests_status_next_attempt_at_lease_until_idx ON facebook_deletion_requests(status, next_attempt_at, lease_until);
CREATE INDEX facebook_deletion_requests_completed_at_idx ON facebook_deletion_requests(completed_at);
COMMIT;
