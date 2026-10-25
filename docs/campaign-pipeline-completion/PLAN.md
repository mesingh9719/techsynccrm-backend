# Campaigns and Pipeline: discovery, initial gaps and implementation plan

Branch in both repositories: fix/campaigns-pipeline-completion. Retain the preceding latency commits and all unrelated pending Gmail/template changes. Runtime evidence comes only from localhost:5057/5177 and disposable PostgreSQL at localhost:55439/techsync_campaign_pipeline. Baseline offline backend 286 passed/131 skipped; full DB suite 408 passed/7 existing failures/2 skipped; frontend tests/build pass.

## Inferred product definitions

Campaigns tracks marketing acquisition and first-touch attribution: immutable tenant tracking codes, UTM/provider identities, recorded budget/spend and live visibility-scoped lead/revenue metrics. Meta metadata import and verified enable/pause controls exist; Google Ads is manual tracking, and email/SMS are marketing channel classifications, not outreach senders. Current implementation and newer campaigns-backend.md define own/team/all campaign permissions; the older M22 permissions paragraph is stale.

Pipeline means configurable **deal** stages, not Lead.status. A lead can convert into a contact and optional linked deal. Each pipeline has ordered open stages plus protected Won/Lost outcomes, stage requirements, stage history, money/forecast, board/list and stage settings. Lead lifecycle/funnel remains separate; dynamic deal stages must not be substituted into lead statuses. Colors and stage archival are absent from the existing model/spec and will not be invented.

Product decision: user explicitly chose to enforce the M22 local campaign transition graph. Meta provider controls retain their existing rules and confirmation. No new provider connector or campaign outreach workflow is implied.

## Flow map (initial status)

| Module / flow | Screens / steps | API | Tables | Initial status |
|---|---|---|---|---|
| Campaign create/edit/tracking | Campaigns → drawer → tracking URL/detail | POST/PATCH /campaigns, GET /campaigns/:id | campaigns, audit_logs | Working basic flow; incomplete owner/source controls |
| Campaign lifecycle | Detail/editor status, bulk pause | POST /campaigns/:id/status, PATCH /campaigns/:id | campaigns, audit_logs | Broken transition enforcement; incomplete complete/archive/restore actions |
| Campaign duplicate/delete | Campaign detail actions | POST /campaigns, DELETE /campaigns/:id | campaigns; existing leads remain | Missing UI actions; delete API exists |
| Campaign discovery | List search/status/type, sort/page, dashboard card | GET /campaigns | campaigns, leads, deals | Works basic filters; owner/source/date and page-wide sorting need verification |
| Attribution | Lead detail picker, manual lead input, UTM capture | POST/PATCH /leads, public forms/capture | leads.campaign_id, campaigns, domain_events | Explicit campaignId rejected; picker rewrites original metadata; no returned campaign summary |
| Campaign metrics / drilldown | List/detail/dashboard → attributed lead list | GET /campaigns/:id[/leads], /leads?campaignId= | leads, campaigns, deals | Qualified excludes converted; exact lead-count visibility works |
| Meta integration | Sync accounts/pages, enable/pause/readback | POST /campaigns/sync/meta, /:id/status; GET /:id/meta-status | campaigns, facebook_connections | Existing provider simulation tests; live activation intentionally excluded |
| Pipeline bootstrap / settings | Settings → template create; stage name/probability/requirements/order/default/delete | /pipelines, /pipeline-templates, /pipelines/:id/stages[/order] | pipelines, pipeline_stages, deals, history, audit | Basic working; reproduced concurrent stage duplicate positions; settings cache propagation incomplete |
| Board/list/forecast | Pipeline selector, board/list/forecast, filters, load more | GET /deals[/board|/forecast] | deals, stages, contacts, leads | Campaign/source filters ignored; first 50 and cursor continuation exist |
| Deal create/edit / lead conversion | New deal, detail editor; lead convert → deal | POST/PATCH /deals, POST /leads/:id/convert | deals, leads, contacts, events | Existing implementation; verify required fields and linkage |
| Deal move / outcomes / reopen | Drag, keyboard/select, detail stepper, required/lost dialog | POST /deals/:id/move, GET /:id/history | deals, stage_history, domain_events, activities | API locks/history exist; dialog failure loses draft; cross-module invalidation incomplete |
| Stage/pipeline deletion with deals | Settings confirm destination, validate requirements, retain history | DELETE /pipelines/:id[/stages/:stageId] | pipeline_stages, deals, stage_history, audit | Existing move/block behavior; count reads/races and deleted-deal-only stages need verification |
| Permissions / isolation | Owner/admin/manager/rep/viewer across all screens | requireOrg + permit + service visibility | memberships, teams; tenant keys | Existing protections; explicit regression coverage required |

## Gap report before fixes

| ID | Flow | Evidence | Severity | Proposed fix | Effort |
|---|---|---|---|---|---|
| C1 | Explicit attribution | Real PATCH /leads/:id with campaignId returns 400 Nothing to update | High | Accept optional validated tenant campaignId, explicit null unlink, return bounded summary; preserve raw UTM | M |
| C2 | Campaign metrics | Fixture has 3 converted leads, qualifiedCount=0 instead of documented qualified+converted=3 | High | Aggregate documented progressive counts without extra per-row queries | S |
| C3 | Lifecycle | Real active→scheduled returns 200, documented invalid move should 400 | High | Enforce user-approved graph on status endpoint and PATCH; expose options to UI; retain Meta controls | M |
| C4 | Duplicate/delete | Browser detail has Pause/Edit only; delete API has no action | Medium | Add copy-as-draft/reset identity/spend and confirmed soft delete; retain attribution | M |
| C5 | Attribution refresh | ProfileCard rewrites sourceDetail/UTM; campaign mutations omit lead caches; lead status/deal wins omit campaign/dashboard caches | High | Direct campaign link editor plus focused shared sales-cache invalidation | M |
| C6 | Lists/settings | Client loads all pages then sorts sliced page; campaign owner/source/date and UI controls absent | Medium | Consistent filtered/sorted pages and owner/source/date controls using existing API patterns | M |
| P1 | Campaign/source deal filters | Expected 23 campaign deals, API returns all 85; unknown source board returns 85 instead of 0 | High | Tenant-scoped DB relation filter, shared list/board filters, URL and UI controls, supporting index | M |
| P2 | Move failure | useDealMover clears pending dialog before await; runtime error-recovery probe in progress | High | Keep draft/dialog mounted through errors; refresh stale state without silent loss | S |
| P3 | Stage creation race | Two concurrent real requests create Race A/B both at position 4 | High | Serialize settings writes per tenant, read stage state within transaction, protect order/default/deletion invariants | M |
| P4 | Settings propagation | StageRow refresh only invalidates pipelines; board/detail/dashboard use other keys | Medium | Invalidate affected sales and history queries after settings writes; busy states | S |
| P5 | Board interaction | Optimistic move changes totals/count but not weighted totals/status, extra loaded pages can duplicate moved card | Medium | Consistent optimistic projection, bounded extra-page state, rollback and refresh | M |
| P6 | Currency/system labels | Board/forecast hard-code INR; detail closed badge says Won/Lost after system stage rename | Medium | Use existing workspace currency formatter and API stage name | S |

## Implementation order

1. Add baseline fixtures/runtime evidence, focused tests and this plan before application edits.
2. Fix C1/C2/C3 and campaign event/invalidation connections; add lifecycle options and explicit attribution tests.
3. Fix P1 with a tenant-scoped deal→lead relation and safe additive indexes/NOT VALID FK if needed. Do not rewrite attribution or materialize all matching lead IDs in Node.
4. Fix P3 with transactions/serialization, preserve stage deletion requirements/outcomes/history; test simultaneous writes and foreign stages.
5. Complete C4/C6 and P2/P4/P5/P6 in the existing design system. Add actual browser regression flows, failure recovery, keyboard/touch controls and desktop/mobile screenshots.
6. Verify every mapped flow and permissions on the real local API/DB, full existing suites and build/lint; test changed query shapes on synthetic volume with EXPLAIN and query counts; publish final flow status, remaining scope limits, migration/rollback details.

No production data cleanup, destructive migration, dependency or external ad operation is authorized or needed. Any new required constraint will avoid destructive backfills; legacy violations must be reported, never silently repaired. The existing seven unrelated integration failures remain baseline failures and must not be hidden.
