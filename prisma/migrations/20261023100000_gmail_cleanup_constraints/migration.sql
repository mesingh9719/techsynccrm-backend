-- Forward migration: workspace deletion must remove mail content without FK-order dependencies.
SET lock_timeout = '5s';
ALTER TABLE email_messages DROP CONSTRAINT email_messages_organization_id_account_id_fkey;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_organization_id_account_id_fkey FOREIGN KEY (organization_id, account_id) REFERENCES gmail_accounts(organization_id, id) ON DELETE CASCADE ON UPDATE CASCADE;
-- Pub/Sub routing must resolve at most one active mailbox globally.
CREATE UNIQUE INDEX gmail_accounts_active_email_key ON gmail_accounts(email) WHERE status IN ('connected','syncing','delayed','reconnect_required','paused');
RESET lock_timeout;
