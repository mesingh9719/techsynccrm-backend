-- Optional performance-only rollback; outside a transaction. Keep all CRM records/history.
DROP INDEX CONCURRENTLY IF EXISTS activities_report_period_idx;
DROP INDEX CONCURRENTLY IF EXISTS deals_report_won_period_idx;
