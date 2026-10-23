-- Operator-only rollback. Export new settings/audit records first and stop API/worker writes.
-- This intentionally refuses rollback when legacy global uniqueness cannot be restored,
-- or when the old deployment cannot decrypt a local-key envelope.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM email_token_revocations) THEN
    RAISE EXCEPTION 'Drain encrypted Google revocations before rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM gmail_accounts WHERE key_version LIKE 'local:%') THEN
    RAISE EXCEPTION 'Rewrap local email keys with the legacy KMS before rolling back code';
  END IF;
  IF EXISTS (SELECT google_subject FROM gmail_accounts WHERE status IN ('connected','syncing','delayed','reconnect_required','paused') GROUP BY google_subject HAVING count(*) > 1)
     OR EXISTS (SELECT email FROM gmail_accounts WHERE status IN ('connected','syncing','delayed','reconnect_required','paused') GROUP BY email HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Resolve cross-tenant duplicate active mailboxes before restoring legacy indexes';
  END IF;
END $$;
DROP INDEX gmail_accounts_active_subject_key;
DROP INDEX gmail_accounts_active_email_key;
CREATE UNIQUE INDEX gmail_accounts_active_subject_key ON gmail_accounts(google_subject) WHERE status IN ('connected','syncing','delayed','reconnect_required','paused');
CREATE UNIQUE INDEX gmail_accounts_active_email_key ON gmail_accounts(email) WHERE status IN ('connected','syncing','delayed','reconnect_required','paused');
DROP INDEX gmail_accounts_organization_id_email_idx;
ALTER TABLE gmail_accounts DROP COLUMN connected_at, DROP COLUMN disconnected_at, DROP COLUMN display_name, DROP COLUMN last_error_at, DROP COLUMN last_used_at;
ALTER TABLE gmail_oauth_states DROP COLUMN used_at;
DROP TABLE email_token_revocations, email_audit_logs, tenant_email_settings;
DROP TYPE "EmailAuditAction", "EmailVisibility";
COMMIT;
