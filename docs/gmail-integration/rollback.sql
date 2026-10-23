-- REVIEW ONLY. Never run on a database containing Gmail data.
-- Prefer feature-flag rollback retaining these additive tables.
-- This empty-data schema rollback requires deploying pre-Gmail API/worker code first.
-- It does not modify or remove existing leads, contacts, activities or their unique indexes.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM gmail_accounts UNION ALL SELECT 1 FROM gmail_oauth_states
    UNION ALL SELECT 1 FROM email_threads UNION ALL SELECT 1 FROM email_record_links
    UNION ALL SELECT 1 FROM email_messages UNION ALL SELECT 1 FROM email_mailbox_copies
    UNION ALL SELECT 1 FROM email_templates UNION ALL SELECT 1 FROM gmail_sync_states
    UNION ALL SELECT 1 FROM email_suppressions
  ) THEN
    RAISE EXCEPTION 'Gmail data exists. Abort schema rollback; use disabled flags and retain history.';
  END IF;
END; $$;
DROP TABLE email_mailbox_copies;
DROP TABLE email_record_links;
DROP TABLE email_messages;
DROP TABLE gmail_sync_states;
DROP TABLE gmail_oauth_states;
DROP TABLE email_templates;
DROP TABLE email_suppressions;
DROP TABLE email_threads;
DROP TABLE gmail_accounts;
COMMIT;
-- Prisma migration history is intentionally unchanged. Re-enabling the feature after this
-- exceptional rollback requires a reviewed forward migration, not editing applied migration rows.
