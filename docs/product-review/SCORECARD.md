# Market-readiness scorecard

25 October 2026. **Overall: Not ready for a broad market-ready release.** This is a verified core implementation batch plus a wider audit, not completion of the entire ten-module program. Nearly ready is not approval to ship. No module is rated Ready while its required action/edge-case coverage remains incomplete.

| Module | Rating | Release criteria met in evidence | What still prevents Ready |
|---|---|---|---|
| Dashboard | Nearly ready | Real role-scoped lists/KPIs, report widgets, mobile layout, existing latency tests; current-state labels explicit | Full number/drilldown cross-check matrix, keyboard/contrast and all owner/team/filter combinations |
| Leads | Not ready | Guided detail preserved, real contact/note/task/conversion journey, phone workflow, source drilldown, existing import/qualification tests | Manual lead merge absent; full signup→storage-backed import and every bulk/recycle/UI role path not rerun |
| Campaigns | Nearly ready | M22 lifecycle/attribution/budget/currency tests, public form campaign capture, desktop/mobile UI | Live ad-provider/spend sync absent; complete role/device/edge-case UI sweep remains |
| Pipeline | Nearly ready | Existing move/status/concurrency/migration regressions, board/list pages and forecast rules retained | New full keyboard/drag/touch and every stage-rule/filter/device permutation not rerun |
| Tasks and follow-ups | Nearly ready | Today/overdue CRUD/recurrence/concurrent completion regressions, phone add/complete, scoped compliance reports, deterministic digest rule | Actual reminder worker/delivery and full calendar UX absent; physical-device verification pending |
| Contacts and Companies | Nearly ready | Transactional conversion, scoped related names/counts, list/detail tenant regressions, mobile renders | Every merge/import/export/ownership edge path and module-specific phone edits not rerun |
| Templates | Not ready | Inherited API/render/variable tests and real list page; both optional inherited browser cases pass in QA | Inherited code/migrations remain separate uncommitted release dependency; live provider/template approval absent |
| Integrations | Not ready | Website capture/assignment/dedupe/tenant path; existing Meta/Gmail security/retry tests; live adapters | Google Ads/Instagram DM/generic connector missing, unified health partial, actual OAuth/provider delivery pending |
| Reports | Not ready | Seven real scoped aggregate reports, accurate IST/currency fixtures, history funnel, authorized audited CSV, volume p95 <500ms locally | M15 scheduled summaries/targets absent; inactive-member historical leaderboard decision and exhaustive drilldowns/report set pending |
| Settings | Not ready | Existing role/security/org APIs, Google login fixed, live hours/assignment boundary, real onboarding actions | Billing/API-key platform/audit viewer incomplete; full invite/deactivate/session/2FA/account deletion matrix not manually rerun |

Release gate for every module: all Blocker/High gaps closed, table stakes complete, every declared user flow executed, tenant/role matrix complete, accurate shared numbers, usable daily phone actions, accessible basics, deterministic regression and deployment/rollback evidence. [Gap register](03-gap-register.md) and [roadmap](05-roadmap.md) distinguish missing implementation from unverified behavior.
