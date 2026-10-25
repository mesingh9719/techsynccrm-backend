-- LOCAL VALIDATION ONLY. Production rollback: disable Workspace flags and roll back
-- compatible application code; retain grants, mappings and pending privacy cleanup.
-- Refuse to destroy connected credentials or a pending provider revocation.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM google_connections WHERE credential_enc IS NOT NULL)
 OR EXISTS(SELECT 1 FROM google_revocations) THEN
   RAISE EXCEPTION 'Detach connections and finish revocations before destructive schema rollback';
 END IF;
END $$;
DROP TABLE google_sync_logs, google_service_consents, google_workspace_oauth_states,
 google_workspace_settings, google_connections, google_revocations;
