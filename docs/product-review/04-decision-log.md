# Decision log

| ID | Decision and evidence | Recommended default / outcome | Blocks |
|---|---|---|---|
| D01 | Two repositories; root .git is an empty read-only placeholder | Same branch name in both; commit only our paths. Mirror final docs into backend/docs/product-review for version control. Preserve root requested docs. Adopted. | None |
| D02 | Backend is JavaScript despite requested stack description | Keep Express/Prisma conventions; no TypeScript migration. Adopted. | None |
| D03 | M15 requires cohort history, not current-status funnel | Use retained transactional domain events directly (D15); no new history table or invented backfill. Preserve both sides of each transition. | None |
| D04 | Reports/capture have browser preview switches | Production-facing defaults must use real API. Remove sample report runtime; preview-only authoring must never masquerade as saved server settings. | None |
| D05 | Multiple currencies in existing deals | Sum workspace currency only; no invented FX conversion. State this in reports. | None |
| D06 | Clinic/coaching customization | Use existing custom fields, templates, pipelines. No clinical charting or fee ledger added to core CRM. | None |
| D07 | New channel/provider spend | Keep click-to-WhatsApp/manual logs; external Business API, SMS, payments require separate provider selection/budget. No paid provisioning. | Provider rollout only |
| D08 | Pricing evidence varies by region/term and promotion | Research snapshot, not binding price; proposed packaging requires owner validation/customer interviews. | Charging only |
| D09 | Uncommitted Templates and Gmail work | Review/read/test as inherited; do not stage, overwrite or claim authorship. | None |

| D10 | Existing RBAC grants reports.read on every role and dashboard uses the same base metrics | Preserve these base metric permissions; no new paid tier/provider enabled. Scheduled/forecast features must use existing plan gates when built. Adopted for core reporting. | None |
| D11 | Manual lead merge lacks documented conflict/attribution/conversion policy | Recommend only live unconverted leads; select survivor; preserve all activity/files/tasks, original first touch and audit; validate owner/contact/campaign conflicts; soft-delete duplicates transactionally with recovery. Not implemented in this batch. | Merge feature only |
| D12 | Leaderboard intentionally selects active memberships; owner totals include historical revenue | Recommend including inactive owners' historical results with clear labels, after agreeing role/team visibility for removed members. Current behavior retained and documented. | Historical team reporting only |
| D13 | Digest test fixture mixed real Date.now with fixed 19 October 2026; deterministic new regression proved the production seven-day rule | Anchor the existing fixture's idle dates to its declared evaluation clock; retain every assertion. This corrects test data, not the product rule. Adopted; full suite passes. | None |
| D14 | Root .git is not functional; inherited changes became staged during work | Use temporary Git indexes for own logical commits, then preserve inherited staging. Mixed schema/routes committed only our enum/report changes. User Gmail/Templates files remain uncommitted. Adopted. | None |
| D15 | Existing M15 asks for a separate history table/backfill, but all current lead status changes already emit durable transactional DomainEvents and no event purge was found | Use these indexed retained events directly; history reads include both sides of transitions. No fabricated backfill or data-changing history migration. Any future event retention policy must first preserve funnel milestones. Adopted; regression and volume tested. | Future event purge only |

Funnel inference retained from the earlier v2 progress definition: qualified/converted progress includes earlier levels even when users skipped manual steps. It does not assert a real contact event or fabricate first-response timestamps; the response-time report measures those separately.
