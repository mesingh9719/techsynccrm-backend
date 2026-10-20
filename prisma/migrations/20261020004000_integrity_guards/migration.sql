BEGIN;
-- Prisma list fields are non-nullable. Older hand-written migrations omitted NOT NULL.
UPDATE users SET goals = '{}' WHERE goals IS NULL;
ALTER TABLE users ALTER COLUMN goals SET NOT NULL;
UPDATE organizations SET trial_reminders_sent = '{}' WHERE trial_reminders_sent IS NULL;
ALTER TABLE organizations ALTER COLUMN trial_reminders_sent SET NOT NULL;
UPDATE invitations SET team_ids = '{}' WHERE team_ids IS NULL;
ALTER TABLE invitations ALTER COLUMN team_ids SET NOT NULL;
UPDATE demo_requests SET interests = '{}' WHERE interests IS NULL;
ALTER TABLE demo_requests ALTER COLUMN interests SET NOT NULL;
UPDATE pipeline_stages SET required_fields = '{}' WHERE required_fields IS NULL;
ALTER TABLE pipeline_stages ALTER COLUMN required_fields SET NOT NULL;
UPDATE notification_email_batches SET notification_ids = '{}' WHERE notification_ids IS NULL;
ALTER TABLE notification_email_batches ALTER COLUMN notification_ids SET NOT NULL;
-- Membership writes still enforce ownership rules; this index is defense against a racing writer.
CREATE UNIQUE INDEX memberships_one_active_owner_idx ON memberships(organization_id) WHERE role = 'owner' AND status = 'active';
ALTER TABLE export_jobs ADD COLUMN started_at TIMESTAMPTZ(6);
COMMIT;
