# Deployment, compatibility and rollback

No remote migration, production data access, infrastructure provisioning, deployment or real provider message was performed. Tests used three newly created localhost databases on a new Postgres cluster, not a clone of customer data.

## User/data-visible changes

| Change | Existing-user effect | Data effect |
|---|---|---|
| Real reporting and dashboard report widgets | Workspace records replace generated samples; source/owner/date/currency filters apply; genuine empty/error states | Read-only aggregates; no record backfill |
| Reporting definitions | Junk/deleted excluded, currency separated, closure/cohort dates explicit, historical status events retained | Reads existing Lead/Deal/DomainEvent; no invented history |
| Report export | Export permission enforced on server, audit entry added; manager exports may exclude unassigned records | Append-only report.export audit row; CSV escaping at shared encoder |
| Source drilldown | Preserves owner/date and junk exclusion; No source works | Adds sourceId=none query support; existing IDs unchanged |
| Related record visibility | Restricted company chips and contact counts disappear for roles unable to read related records | No relationship deletion or reassignment |
| Google login | Migrated google_signin becomes available to Prisma; verified identity link uses atomic conditional updateMany | Schema enum parity only (SQL value already migrated); normal sign-in/link writes remain audited |
| Capture/settings | Live tenant API replaces browser-only persistence; failures cannot be reported as browser saves | Existing preview localStorage is retained but not uploaded, published or auto-converted |
| Derived caches | Successful CRM writes invalidate originating workspace report/dashboard queries; failed writes and duplicate checks do not | Browser cache only; no new server cache |
| Onboarding | Real add/import/pipeline actions replace sample lead; checklist reads actual import/pipeline facts | No demo lead insertion; old sample-viewed preference ignored and retained |
| Next-step copy | Actionable first-contact wording replaces unsubstantiated conversion multiplier | Text only |
| CSV safety | Formula-like text behind control characters is escaped consistently | Exported text only; no source record mutation |
| Test reliability | Digest fixture uses its own evaluation date; DB test files serialize to avoid concurrent-index snapshot waits | Test-only behavior; all original assertions and in-test concurrency checks retained |

## Dependencies and order

1. Review the existing Gmail/Templates staged work separately. Review commits intentionally exclude it. Working-tree verification included it, and template screenshots/tests do not mean those changes are committed by this program.
2. Use the intended environment's **direct** migration connection through the established release process. Verify existing migrations, including Google login ticket enum `20261023111000`, have been applied. Never rerun ad hoc schema changes or edit applied SQL.
3. Apply new `20261025130000_report_period_indexes` using `npm run db:migrate`. It creates two partial/covering indexes concurrently, outside a transaction, with a five-second lock timeout. Do not wrap it in BEGIN/COMMIT. It performs no data backfill/update.
4. On failure, check Prisma migration state and pg_index.indisvalid. IF NOT EXISTS does not repair an invalid concurrent index. Remove only the identified invalid new index concurrently, use the normal Prisma resolve/retry procedure and rerun; do not clear the migration ledger blindly.
5. Run `npm run db:generate` and backend build; release/restart API and existing worker through the normal deployment system. The enum schema addition does not create a second SQL enum migration.
6. Release the paired frontend after the backend. Public Vite flags in `.env.example` now document live adapters. VITE_CRM_REPORTS_API, VITE_CRM_CAPTURE_API and VITE_CRM_ASSIGNMENT_API default live when omitted; explicit false is a frontend stop switch. Rebuild/redeploy to change Vite build-time values. Disabled services show unavailable errors, never samples or browser saves. No new secret or paid service is needed.
7. Smoke-test login, role scope, exact source drilldown, date/currency totals, report export audit, form/settings persistence and phone daily actions on staging with synthetic data.

Flags control frontend rollout only; they do not disable provider ingestion or replace server authorization. If the old report flag was explicitly false, enable it only after the matching API is deployed. Do not automatically publish any old browser-only form/rule draft. Recover such drafts manually with the owner's review.

## Rollback

- Prefer disabling affected frontend adapters, or revert the relevant small commits. Keep unavailable/error behavior; do not silently resurrect fake reporting or local-only saves.
- Indexes are additive and safe to retain on code rollback. If removing them, use `prisma/rollbacks/20261025130000_report_period_indexes.sql` outside a transaction on the intended environment; local down/up/replay was verified. Do not drop customer records/history.
- Retain the existing Google SQL enum value; removing enum values risks tokens/clients and is not required to roll back the view.
- No data-changing backfill was introduced, so no customer data reversal is required. Keep report audit entries and historical outbox events.
- Keep inherited Gmail/Templates migrations and code coordinated according to their own release notes. Never revert their user-owned staged work as part of this review.
