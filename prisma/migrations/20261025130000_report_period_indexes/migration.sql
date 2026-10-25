-- PR-004: additive online indexes. CONCURRENTLY must run outside a transaction.
SET lock_timeout = '5s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS deals_report_won_period_idx
  ON deals (organization_id, won_at)
  INCLUDE (value_minor, owner_id, source_id)
  WHERE deleted_at IS NULL AND status = 'won';
CREATE INDEX CONCURRENTLY IF NOT EXISTS activities_report_period_idx
  ON activities (organization_id, occurred_at)
  INCLUDE (actor_id, type)
  WHERE deleted_at IS NULL;
RESET lock_timeout;
