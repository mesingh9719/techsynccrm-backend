# Master gap register

Priority = severity first (Blocker > High > Medium > Low), then user/business impact ÷ effort (S=1, M=2, L=3). Evidence links refer to workspace code paths. Open means unimplemented or unverified; it does not prove every associated flow is broken.

| ID | Module | Type | Description / evidence | User and business impact | Severity | Effort | Status |
|---|---|---|---|---|---|---|---|
| PR-001 | Reports | Broken flow | frontend/src/features/reports/api.ts generates 180 sample facts; backend/src/routes/index.js has no reports mount | Owners cannot trust results; blocks real reporting/demo | Blocker | M | Fixed; real API + browser |
| PR-002 | Reports/Dashboard | Architecture | Missing M15 history-based cohort funnel; old v2 uses current status | Regressed/lost leads erase reached stages | High | M | Fixed; retained transactional history + regression |
| PR-003 | Reports | Security | Export only downloads displayed data, no server export route/audit | Export authorization/audit cannot be asserted server-side | High | M | Fixed; server permission/audit + browser CSV |
| PR-004 | Reports | Performance | The missing active implementation and v2 reference read deals into JS and ignore from/to range | Large tenants slow; chart contradicts selected period | High | M | Fixed; aggregate queries, online indexes, volume measured |
| PR-005 | Reports | UX | Source drilldown drops owner filter and source none is not accepted by lead list | Clicking counts opens different results/errors | High | S | Fixed; exact source/owner/cohort links + tests |
| PR-006 | Integrations/Settings | Broken flow | capture/api.ts captureLive and assignmentLive default false; localStorage write paths | Settings appear saved without server ingestion/assignment | High | M | Fixed; live adapters + tested rollout stops |
| PR-007 | Dashboard | Functional | KPIs/funnel largely current-status lead counts; pipeline/campaign widgets all-time | Cohort and current state need clear labels; compare to reports | Medium | M | Reviewed: existing current-status/all-time labels are explicit; no new defect reproduced |
| PR-008 | Reports | Functional | Missing scheduled reports/targets/response and follow-up compliance reports from M15 | Managers cannot receive promised summaries | High | L | Open |
| PR-009 | Integrations | Functional | Google Ads, Instagram DMs, generic webhook cards are setup guides, no connector | Acquisition promise exceeds available ingestion | High | L | Open; provider scope decision |
| PR-010 | Settings | Functional | billing route ComingSoon (M16) | Cannot sell self-service paid subscriptions | High | L | Open; pricing/provider decision |
| PR-011 | Templates | Architecture | Uncommitted template library/variables migrations and UI | Release must include inherited dependency migration/review | High | M | Inherited work passes API tests; separate release dependency remains |
| PR-012 | Cross-cutting | Security | Complete per-endpoint role/tenant matrix not yet executed | Cannot certify isolation across ten modules | High | L | Auditing |
| PR-013 | Tasks/notifications | Broken flow | Historical sales report records notification digest test failure | Follow-up summary reliability unconfirmed | High | S | Fixed test-clock defect; original assertions retained; deterministic threshold regression added |
| PR-014 | Contacts/Companies | Security | Original present() related contact counts/company chips omitted related-record visibility | Restricted names/counts disclosed across ownership scopes | High | S | Fixed; tenant and ownership predicates, list/detail tests |
| PR-015 | All | UX | Mobile, keyboard, error/empty states not yet rerun across ten modules | Daily phone workflow readiness unproven | High | L | Partial: all screens + phone daily journey pass; full accessibility/device matrix pending |
| PR-016 | Settings | Functional | Audit log stored but no tenant viewer route in active app | Owners cannot inspect sensitive changes | Medium | M | Open |
| PR-017 | All | Functional | Vertical starter configuration and regional-language UI incomplete | More setup/training for clinic/coaching buyers | Medium | M | Partial: real onboarding/import/pipeline actions fixed; vertical packs/localization pending |
| PR-018 | Settings/Auth | Broken flow | UserTokenType lacked migrated google_signin; nullable unique identity selector rejected by Prisma | Google signup/login/linking failed; five baseline regressions | High | S | Fixed; schema parity and atomic updateMany, 11 auth tests pass |
| PR-019 | Leads | Functional | No manual /leads/merge route or UI; capture repeat dedupe is a different flow | Duplicate cleanup needs a defined conflict/link/attribution policy | High | L | Open; D11 records recommended safe semantics |
| PR-020 | Tasks | Functional | Task list views exist; full calendar UI not found | Teams expecting calendar planning cannot use that view | Medium | M | Open |
| PR-021 | Templates | UX | Card dates use browser locale/timezone in inherited TemplatesPage | Date labels may differ from workspace | Low | S | Open; belongs to inherited template review |
| PR-022 | Integrations | UX | Provider-specific status/history exists; no unified failed-delivery/health workbench | Troubleshooting requires connector-specific screens | Medium | M | Open |
| PR-023 | Reports | Architecture | Leaderboard lists active memberships only while aggregate revenue can include inactive owners | Historical total may exceed visible team rows | Medium | M | Open; D12 records intended-scope question |
| PR-024 | Reports/Dashboard | UX | Plain API forms did not invalidate derived report/dashboard caches | Numbers could stay stale after a successful task/record write | High | S | Fixed; originating-tenant successful-write subscription; tests cover failures/switches |
| PR-025 | Lead Detail | UX | Next-step copy asserted an unsupported conversion multiplier | Overpromises a measured outcome without evidence | Low | S | Fixed; factual actionable guidance |
| PR-026 | Shared tests | Architecture | Concurrent index migration waits on other test-file transactions and can exceed existing 5s assertion budget | Non-deterministic full regression failure | Medium | S | Fixed runner isolation for TEST_DATABASE_URL; tests and in-test race coverage retained |

| PR-027 | Reports/exports | Security | Frontend CSV formula guard did not account for leading NUL/control characters as fully as the backend encoder | Spreadsheet interpretation can bypass formula-prefix guard | High | S | Fixed; shared encoder aligned and control-character regression assertions pass |

## Coverage boundary

This register is evidence-driven, not a claim that all possible issues were discovered. The route inventory contains 280 declarations including public, staff, nested routers and out-of-scope modules. Every endpoint/role/action permutation is not yet individually certified. PR-012 remains open for that exhaustive matrix. See module audits for action-level Partial states.
