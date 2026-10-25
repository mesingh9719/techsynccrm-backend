# Campaigns and Pipeline completion

Both repositories use `fix/campaigns-pipeline-completion`. All investigation, migrations, browser sessions and volume measurements used disposable localhost PostgreSQL (`techsync_campaign_pipeline`, port 55439), API port 5057 and frontend port 5177. No remote database, real advertising operation, deployment or outgoing customer message was used. Existing Gmail/template work remains unstaged and outside these commits. The previous latency fixes are retained unchanged.

## Product understanding and decisions

Campaigns are marketing acquisition/tracking records with immutable tenant codes, UTM/provider identities, planning budget, recorded spend and visibility-scoped live lead/deal metrics. They are not email/WhatsApp sending jobs. Google Ads is manually tracked; Meta already supports metadata sync and real provider-confirmed enable/pause. A duplicate is a new local draft: planning fields remain, provider identity and spend do not.

Pipeline is a configurable **deal** pipeline. Leads retain their separate New/Contacted/Qualified/Converted/Lost/Junk lifecycle. Capture creates a lead; conversion can create a linked deal in the selected pipeline. Lead funnel labels are intentionally not replaced by deal stage definitions. Won and Lost are protected outcomes whose display names can change. Stage colors and stage archival have no existing schema/API/product contract and were not invented.

The user explicitly chose **enforce M22 local campaign transitions**. Both PATCH and status endpoints now enforce the same graph exposed by `GET /campaigns/options`; the editor/detail selector consume it. Same-status requests remain valid. Meta delivery retains provider controls and confirmation. Existing own/team/all campaign permissions and tenant-wide immutable code uniqueness remain authoritative; older M22 permission/code-reuse prose does not override newer implemented contracts. Campaign creation still accepts any existing initial status, preserving its request contract. Names may repeat; immutable tenant codes are the unique identifiers, so no new name-uniqueness constraint was introduced.

## Final flow map

Statuses describe the existing product scope. “Working” for a provider flow means local provider simulations; no live external ad switch was exercised.

| Flow | Steps/screens | API | Tables | Before → after / verification |
|---|---|---|---|---|
| Campaign create/edit | List → drawer → detail; source, permitted owner, date/budget, tracking | POST/PATCH `/campaigns`, GET `/:id` | campaigns, lead_sources, users, audit_logs, domain_events | Partially working → Working; browser create/edit, precise 1,234.56/10.51; API validation/foreign-owner tests |
| Lifecycle | Detail/editor → allowed status; bulk pause | GET `/campaigns/options`, POST `/:id/status`, PATCH `/:id` | campaigns, audit_logs, domain_events | Broken graph/incomplete controls → Working; all 36 transition pairs, stale version, browser complete/archive/restore |
| Duplicate | Detail → Duplicate → new draft/code | POST `/campaigns` | campaigns | Missing UI → Working; browser verifies new identity, null spend/provider IDs |
| Delete | Detail → confirm → list | DELETE `/campaigns/:id` | campaigns soft-delete; leads retained | Missing UI → Working; browser confirmation; API retains linked lead and summary |
| Discovery | Search, channel/status/owner/source/created dates, saved view, sort and page | GET `/campaigns` | campaigns, leads, deals | Partial → Working; whole filtered collection sorted before 25-row slicing; browser 28-record pagination |
| Manual attribution | Lead drawer/detail picker → link/change/clear | POST/PATCH `/leads`; GET `/leads?campaignId=` | leads.campaign_id, campaigns | Broken → Working; explicit tenant-validated ID/null, batched summary, captured UTM/source preserved, browser unlink |
| Capture attribution/assignment | Public hosted form → lead → configured owner; repeat enquiry | `/public/forms/:key[/submit]`, `/forms`, `/assignment-rules` | web_forms, web_form_submissions, leads/lookups, assignment_rules, domain_events | Existing working service → Verified real browser/API/DB; UTM attribution, specific-user rule, one lead/two submissions, first touch and owner preserved, invalid 400, foreign 404, closed 410 |
| Campaign metrics/drilldowns | List/detail/dashboard → leads or filtered pipeline | `/campaigns/:id[/leads]`, `/leads`, `/deals[/board]` | campaigns, leads, deals | Qualified count/refresh broken → Working; qualified includes converted, progressed contacted count, exact CPL, scoped currency revenue, ROAS zero shown |
| Meta sync/delivery | Account sync; provider status/readback; enable/pause confirmation | `/campaigns/sync/meta`, `/:id/meta-status`, `/:id/status` | campaigns, facebook_connections, audit/events | Existing → Preserved; provider tests pass, bulk action confirms real Meta pauses; live delivery not executed |
| Pipeline bootstrap/settings | New pipeline from template; name/default; stage name/probability/rotting/requirements/order | `/pipeline-templates`, `/pipelines`, `/:id/stages[/order]` | organizations, pipelines, pipeline_stages, audit/events | Partial/racy → Working; browser edits/reorder/create; simultaneous create/default/delete tests; system/last-open protections |
| Board/list/forecast | Pipeline, owner/campaign/source/stage/date/search; board/list/forecast | `/deals`, `/deals/board`, `/deals/forecast` | deals, stages, leads, contacts | Campaign/source silently ignored → Working; shared DB relation filters and URL controls; forecast stays open-deal-only; list cursor/board 50-card cap |
| Large stages | Board → Load more; list cursor | `/deals/board`, `/deals?stageId=&cursor=` | deals, stage/config relations | Existing paging/optimistic defects → Working; browser 75-card column without duplicates, API 1,105 distinct paginated deals; 100k-lead/20k-deal query measurements |
| Deal create/edit/conversion | New deal/editor; Lead Detail Convert → linked deal | POST/PATCH `/deals`, POST `/leads/:id/convert` | deals, leads, contacts, events/history | Working but incomplete invalidation → Working; real browser conversion retains leadId and refreshes connected sales caches |
| Moves/outcomes/reopen | Drag, arrow keys/select or detail stepper → requirements/Lost dialog → persist | POST `/deals/:id/move`, GET `/:id/history` | deals, stage_history, domain_events, activities | Failure lost dialog; incomplete optimistic totals → Working; actual drag/select; failed 503 and real stale 409 retain draft, retry uses new version; Won value, Lost reason/note, reopen tests |
| History/side effects | Move → history/event → timeline subscriber | `/deals/:id/history`, `/timeline` | deal_stage_history, domain_events, activities/activity_links | Existing → Verified; one history write under concurrent move; timeline handler delivered twice creates one activity; move updates lastActivityAt and stageEnteredAt |
| Delete stage/pipeline with deals | Settings → destination → move or block | DELETE `/pipelines/:id[/stages/:stageId]` | stages, deals including bin, stage_history, audit | Race/count gaps → Working; trashed-only counts surfaced; required-destination failure rolls back; Won/Lost history/outcomes preserved; 1,105-deal stage removal passes |
| Dashboard connections | Campaign summary/detail drilldown; dynamic deal stage summary → exact stage | `/campaigns`, `/deals/board`, lead/report queries | scoped campaigns/leads/deals | Partial refresh/drilldown → Working; shared invalidation, dashboard stage link includes stageId, desktop/mobile real data |
| Roles/tenants | Owner/admin/manager/rep/viewer; own/team/all actions | requireOrg + permit + visibility/versioned writes | memberships, teams, tenant keys | Existing protections → Preserved/extended; actual sessions on all five roles, foreign IDs rejected; new composite deal/lead tenant FK |

The independent lead lifecycle/qualification stepper remains intact. Capture deduplication merges repeat open enquiries and keeps first-touch attribution; it does not promise exactly-once HTTP submissions. Provider-event replay and import-resume handling remain their existing paths and regression coverage.

## Gaps resolved

| ID | Severity | Evidence before | Resolution |
|---|---|---|---|
| C1 | High | PATCH campaignId → 400 “Nothing to update” | Accept explicit tenant campaignId/null on lead create/update; return summary in one batch; preserve metadata |
| C2 | High | 3 converted leads, qualifiedCount=0 | Progressive funnel aggregation; existing aggregation query count unchanged; exact money/revenue tests |
| C3 | High | active → scheduled returned 200 | Approved local transition graph enforced on both mutation routes; authoritative options endpoint/UI |
| C4 | Medium | Detail only had pause/edit | Duplicate as draft with reset code/provider/spend; confirmed soft delete; complete/archive/restore controls |
| C5 | High | Picker rewrote original UTM/source; related views stayed stale | Explicit link editor and connected sales invalidation; unchanged UTM saves no longer override manual links; null remains visibly unlinked |
| C6 | Medium | Sorting applied after slicing; missing owner/source/date controls | Sort full filtered collection, clamp/reset page, add existing-pattern controls and backend filters |
| P1 | High | Campaign expected 23, got all 85; unknown source expected 0, got 85 | Shared tenant-scoped DB semi-join/source filters for board/list/forecast; supporting indexes/FK; no matching-ID materialization |
| P2 | High | Simulated failed move unmounted dialog and lost note | Keep dialog/draft mounted; roll back optimistic state; refresh stale deal version; retry succeeds |
| P3 | High | Two simultaneous new stages both position 4 | Serialize settings writes with tenant row lock; reread state in transaction; one default and one last open stage under concurrency |
| P4 | Medium | Stage-row refresh only invalidated pipeline config | Invalidate board/detail/history/dashboard/campaign queries; guard settings operations while saving; bin-inclusive counts guide deletion |
| P5 | Medium | Optimistic counts changed, weighted/status stale; extra pages could duplicate cards | Half-even weighted projection and outcome/timestamps; cancel in-flight board query; reset extra pages on new snapshot; ignore stale pagination responses |
| P6 | Medium | INR and Won/Lost display labels hard-coded | Record/workspace currency for board/list/forecast; returned stage names on detail/stepper; zero ROAS displayed |
| C7 | Medium | Legacy full-form save with identical JSON could undo explicit attribution | Semantic JSON equality before legacy attribution resolution; regression covers PostgreSQL JSONB key ordering |
| C8 | Low | Deleted campaign attribution still linked to a now-404 detail page | Keep the campaign summary, expose its deleted state, and label it without a dead link; real API/browser regression |
| D1 | Low | Dashboard stage drilldown omitted clicked stage | Preserve selected stageId in link |
| D2 | Low | Deleting an open detail triggered a timeline refetch for the removed record | Mark caches stale without refetch before navigation; final browser has no timeline 404 |

No stage color/archive, new outreach channel, Google connector, lead/deal model unification or automatic stage-created tasks were added. No such behavior exists to complete safely within the current contracts.

## Validation and evidence

Backend baseline: offline **286 passed / 131 skipped**; full disposable DB **408 passed / 7 failed / 2 skipped**. Offline final run: **286 passed / 144 skipped**. Final full DB run: **422 passed / 6 failed / 2 skipped**, 45 files. All six failures also occurred before this task: five `googleAuth.test.js` sign-in/completion cases and `m11.test.js:274` missing “Idle deals” digest section. The seventh baseline failure was the intermittent Gmail purge fixture (`gmail.test.js:337`); it passes in this final run. None of those tests were disabled or weakened.

New coverage: four campaign integration tests (all 36 status pairs plus metrics, filters, attribution, deletion and isolation); eight pipeline integration tests (settings concurrency, shared filters, outcome/requirements/history, bin/deletion and 1,105-deal paging/removal); one actual migration/rollback test; frontend half-even optimistic projection regression; two real local browser scripts. The existing Meta provider fixture gained the required transactional-event mock and assertions without removing its prior checks. The focused 1,105-deal removal run passes after the full suite; it adds assertions, not another test count.

Frontend: **3 test files pass**, TypeScript/build pass, lint exits 0 with nine warnings on existing guard/effect/chart/form code. No new dependency. Actual Chrome UI uses real login cookies/access refresh and the local API/DB. Browser assertions pass with no uncaught page errors. Intentional move failure 503 and real stale 409 are expected; rapid full-page QA navigations hit the existing 30/minute notification stream-ticket limit (429), outside the edited modules. It was not relaxed. All module mutations succeed; final delete navigation no longer generates timeline 404s.

Public capture browser verification passes with `VITE_CRM_CAPTURE_API=true` and `VITE_CRM_ASSIGNMENT_API=true` **only in the QA process**. It proves hosted UI → unauthenticated API → persisted attributed/assigned lead, not a mocked form. A fill duration over the existing 2-second anti-bot threshold is required. Production feature switches were not changed.

Screenshots/results: [frontend evidence](../../../frontend/docs/campaign-pipeline-completion/evidence/), [baseline API probes](evidence/baseline-probe.json), [capture result](evidence/public-capture.json), [volume measurements](evidence/volume-results.json), [EXPLAIN ANALYZE](evidence/filter-plan.json). Every record in these artifacts is synthetic. The initial browser failure probe recorded `moveDialogSurvivesFailure:false`; final script asserts note retention and successful retry. The initial simultaneous-default probe did not reproduce corruption; the stage-creation probe did reproduce duplicate position 4. Concurrency protections cover both invariants.

## Performance verification

Volume: **100,118 leads, 20,173 deals, 418 campaign rows** across synthetic QA/test data (counts include soft-deleted test records). Seed adds 50,000 leads, 10,000 deals and 100 campaigns per QA tenant. Each endpoint gets one warmup, 30 sequential measurements and 30 measurements in batches of 10 concurrent requests. Times include HTTP response consumption; no timings include real providers.

| Endpoint/work | Sequential p50 / p95 ms | Concurrency 10 p50 / p95 ms | Max SQL statements |
|---|---:|---:|---:|
| Campaign page, limit 100 | 23.85 / 32.07 | 86.49 / 113.96 | 8 |
| Campaign detail | 4.24 / 4.94 | 18.67 / 20.75 | 8 |
| Attributed leads, limit 50 | 8.11 / 10.42 | 48.09 / 55.35 | 11 |
| Unfiltered six-stage board | 38.30 / 43.37 | 366.89 / 418.42 | 34 |
| Campaign + source board | 13.91 / 18.28 | 95.10 / 97.19 | 34 |
| Campaign + source list/count | 10.35 / 13.18 | 49.68 / 52.35 | 12 |
| Campaign forecast | 15.00 / 17.29 | 57.78 / 92.79 | 6 |
| Lead create / update (sequential) | 10.87 / 15.37; 9.43 / 14.97 | — | Existing scoring path retained |

Filtered board and list both return exactly 100 deals. Representative tenant/campaign/source SQL plan uses `deals_organization_id_source_id_idx` and existing `leads_organization_id_campaign_id_idx`, executes in **5.658 ms**, and returns 100 rows. This is a synthetic local plan, not production latency. Earlier measurements with ignored filters have different results and are not presented as a performance comparison. Existing lead activity tenant predicates and auth dummy-hash optimization are unchanged; the earlier [latency report](../../performance/latency-20261024/REPORT.md) remains applicable to its own dataset.

Campaign list/pickers still use the existing all-pages client contract; filtering/sorting is now correct across that collection. Board query count scales with configured stage count, not total deal count. Forecast retains its existing in-memory aggregation of a selected, scoped projection. Large all-tenant boards at concurrency 10 still queue work; these measurements are a limit, not a claim of zero latency.

## Database and rollout

Three new **additive** migrations, already applied to QA:

1. `20261025090000_deal_lead_lookup`: concurrent `(organization_id, lead_id)` index.
2. `20261025090100_deal_source_lookup`: concurrent `(organization_id, source_id)` index.
3. `20261025090200_deal_lead_tenant_link`: composite deal → lead tenant FK, `NOT VALID`, short DDL transaction with 5-second lock timeout. It enforces new references without scanning/deleting/rewriting legacy rows.

The Prisma schema adds the relation and index definitions. No backfill, campaign rewrite, cascade delete, permission weakening or feature flag is introduced. Each concurrent index lives in its own migration so it runs outside an implicit multi-statement transaction. Do not wrap these migrations in an enclosing transaction. Test `sales-migrations.test.js` executes the actual SQL in an isolated local schema, keeps a legacy invalid link, rejects a new invalid link, rolls back indexes/FK, reapplies them and verifies row counts unchanged.

Deploy only reviewed commits; leave the unrelated pending Gmail/template migrations and schema changes with their owner. Generate the Prisma client from the release schema (`npm run db:generate`), apply committed migrations with `npm run db:migrate`, then deploy backend before frontend (the new editor needs `/campaigns/options` and explicit campaignId support). Run the existing build/check process and authenticated tenant smoke tests. Capture/assignment retain their existing opt-in frontend switches; set those only in an environment where their backend is ready. Reports keep their existing switch; no new switch is required for these fixes. Deploy the existing worker as usual for asynchronous timeline/notification delivery.

Audit legacy integrity before a separate FK validation:

```sql
SELECT d.id, d.organization_id, d.lead_id
FROM deals d
WHERE d.lead_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM leads l
    WHERE l.organization_id = d.organization_id AND l.id = d.lead_id
  );
```

Do not print production audit rows into public logs or silently “repair” them. If there are violations, leave the FK unvalidated and review their ownership. If clean, a separately scheduled `ALTER TABLE deals VALIDATE CONSTRAINT deals_organization_id_lead_id_fkey;` validates it without rewriting data. No production audit or validation was run here.

Rollback: roll back frontend/backend application commits together; additive indexes/FK can remain. If database rollback is needed, use a new forward repair migration to drop the added FK and run each `DROP INDEX CONCURRENTLY` separately:

```sql
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_organization_id_lead_id_fkey;
DROP INDEX CONCURRENTLY IF EXISTS deals_organization_id_lead_id_idx;
DROP INDEX CONCURRENTLY IF EXISTS deals_organization_id_source_id_idx;
```

No row rollback/backfill is required. If a concurrent build fails, inspect the index's `pg_index.indisvalid` and migration status; remove only the identified invalid new index concurrently before retrying the failed migration through the normal Prisma resolve/deploy procedure. The FK's lock timeout may require a quieter retry window; do not increase it blindly.

## QA checklist

| Area | Checked |
|---|---|
| Owner | Campaign UI lifecycle/copy/delete/attribution; actual drag, Lost recovery/stale retry, conversion/Won/reopen; settings changes |
| Admin | Actual campaign/deal create actions and pipeline settings available; API settings writes pass |
| Manager | Actual campaign/deal actions available, settings writes hidden/403; team fixtures and tenant boundaries covered |
| Sales rep | Actual create actions/own data; configuration hidden/403; own-scoped update/read remains backend-enforced |
| Viewer | Actual read pages, no campaign/deal create or settings controls; write/delete 403 |
| Isolation | Foreign campaign/source/owner/stage/lead references rejected by validation, scoping or FK; foreign form/deal/config 404 |
| Money | Integer minor units, half-even optimistic weighted totals, CPL/revenue currency scope, record/workspace currency display |
| States | Real empty campaign lead list; loading UI; injected move failure with rollback; real stale conflict; backend field validation; public invalid/closed form |
| Volume | 75-card browser column, 1,105-deal list/board/removal, 100k-lead/20k-deal query and plan evidence |
| Viewports | 1440×1000 desktop and 390×844 mobile: campaign list/detail, board, pipeline settings, Lead Detail, dashboard; no document overflow |
| Preservation | Original latency fixes, lead lifecycle and capture first touch, permission scopes, Meta confirmations, bin contents/history; unrelated user work left uncommitted |

## Limits and remaining work

No unresolved product decision remains for this scope. The M22 transition choice is implemented. Stage color/archive and extra messaging/provider infrastructure would need a new product request.

Live Meta permissions/delivery, real Facebook/Instagram webhook delivery and external Google Ads were not exercised; local provider simulations and capture tests cover the existing contracts. The existing outbox worker was not run against external services. Timeline idempotency is verified by delivering the real local event to the real timeline subscriber twice; existing notification/assignment/task regressions cover their established behavior. Stage changes do not create a new task/notification type because the app has no such existing rule. The existing notification digest failure remains open.

Very large configuration deletions still execute atomically and can hit the existing transaction timeout or wait for tenant configuration locks; 1,105 deals passed locally. Remote lock/contention behavior needs staging measurement before claiming a production throughput limit. Campaign all-page picker/list loading and JS forecast aggregation remain opportunities if tenants grow far beyond this dataset. Broad tag filtering and dashboard aggregation limits documented in the earlier latency report are unchanged.

Detailed changed-file inventory: [FILES.md](FILES.md). Reproduction: [QA.md](QA.md).
