# Changed-file inventory

Only task-owned changes are listed. Existing pending Gmail/template/navigation/router work is excluded.

## backend

| File | Purpose |
|---|---|
| `docs/campaign-pipeline-completion/FILES.md` | One-line changed-file inventory. |
| `docs/campaign-pipeline-completion/PLAN.md` | Pre-implementation product understanding, flow map, evidence/gaps and ordered plan. |
| `docs/campaign-pipeline-completion/QA.md` | Safe local reproduction commands and verification order. |
| `docs/campaign-pipeline-completion/REPORT.md` | Completion findings, verification and deployment/rollback documentation. |
| `docs/campaign-pipeline-completion/evidence/baseline-browser.jsonl` | Sanitized local baseline, browser, capture, volume or query-plan evidence. |
| `docs/campaign-pipeline-completion/evidence/baseline-probe.json` | Sanitized local baseline, browser, capture, volume or query-plan evidence. |
| `docs/campaign-pipeline-completion/evidence/filter-plan.json` | Sanitized local baseline, browser, capture, volume or query-plan evidence. |
| `docs/campaign-pipeline-completion/evidence/public-capture.json` | Sanitized local baseline, browser, capture, volume or query-plan evidence. |
| `docs/campaign-pipeline-completion/evidence/validation-results.json` | Sanitized local baseline, browser, capture, volume or query-plan evidence. |
| `docs/campaign-pipeline-completion/evidence/volume-results.json` | Sanitized local baseline, browser, capture, volume or query-plan evidence. |
| `prisma/migrations/20261025090000_deal_lead_lookup/migration.sql` | Concurrent tenant/lead lookup index. |
| `prisma/migrations/20261025090100_deal_source_lookup/migration.sql` | Concurrent tenant/source lookup index. |
| `prisma/migrations/20261025090200_deal_lead_tenant_link/migration.sql` | Additive composite tenant FK without scanning legacy rows; rollback documented. |
| `prisma/schema.prisma` | Add tenant-safe deal→lead relation and supporting index definitions; unrelated pending template fields excluded from commit. |
| `scripts/campaign-pipeline-qa.js` | Guarded synthetic local seed/API runtime; never loads production .env. |
| `scripts/campaign-pipeline-volume.js` | Guarded synthetic volume seed, HTTP/query-count measurements and EXPLAIN evidence. |
| `src/config/campaigns.js` | Canonical local campaign enums and approved M22 transition graph. |
| `src/controllers/campaign.controller.js` | Expose authenticated lifecycle options. |
| `src/lib/campaignAttribution.js` | Validate live tenant campaign IDs and explicit unlink. |
| `src/routes/campaign.routes.js` | Register options route before dynamic campaign ID. |
| `src/services/campaign.service.js` | Enforce lifecycle, scoped list filters/progressive metrics and transactional campaign events. |
| `src/services/deal.service.js` | Shared campaign/source/list/board/forecast filters, scoped history lookup and move activity timestamp. |
| `src/services/lead.service.js` | Persist explicit attribution, preserve unchanged capture metadata and batch readable campaign/deletion summaries. |
| `src/services/pipeline.service.js` | Serialize settings, validate fresh stage state, preserve bin/outcome/history on deletion and expose total counts. |
| `src/validators/campaign.validators.js` | Canonical campaign enums and owner/source/date/sort filters. |
| `src/validators/deal.validators.js` | Campaign/source/stage/date/rotting filters for consistent views. |
| `src/validators/lead.validators.js` | Optional campaign ID/null and validated list filters. |
| `test/integration/campaign-completion.test.js` | Lifecycle matrix, explicit attribution, unchanged JSON, metrics/filters/delete and isolation. |
| `test/integration/pipeline-completion.test.js` | Settings/move concurrency, filters, required/outcome rules, bin/deletion, history and 1,105-deal paging/removal. |
| `test/integration/sales-migrations.test.js` | Execute actual concurrent indexes/NOT VALID FK and reversible rollback/reapply with legacy rows. |
| `test/modules/campaign-meta.test.js` | Extend existing provider fixture with transactional event mock and event assertions. |

## frontend

| File | Purpose |
|---|---|
| `docs/campaign-pipeline-completion/README.md` | Completion findings, verification and deployment/rollback documentation. |
| `docs/campaign-pipeline-completion/evidence/browser-results.json` | Sanitized local baseline, browser, capture, volume or query-plan evidence. |
| `docs/campaign-pipeline-completion/evidence/campaign-detail-desktop.png` | Synthetic desktop/mobile QA screenshot: campaign-detail-desktop. |
| `docs/campaign-pipeline-completion/evidence/campaign-detail-mobile.png` | Synthetic desktop/mobile QA screenshot: campaign-detail-mobile. |
| `docs/campaign-pipeline-completion/evidence/campaigns-desktop.png` | Synthetic desktop/mobile QA screenshot: campaigns-desktop. |
| `docs/campaign-pipeline-completion/evidence/campaigns-mobile.png` | Synthetic desktop/mobile QA screenshot: campaigns-mobile. |
| `docs/campaign-pipeline-completion/evidence/dashboard-desktop.png` | Synthetic desktop/mobile QA screenshot: dashboard-desktop. |
| `docs/campaign-pipeline-completion/evidence/dashboard-mobile.png` | Synthetic desktop/mobile QA screenshot: dashboard-mobile. |
| `docs/campaign-pipeline-completion/evidence/lead-desktop.png` | Synthetic desktop/mobile QA screenshot: lead-desktop. |
| `docs/campaign-pipeline-completion/evidence/lead-mobile.png` | Synthetic desktop/mobile QA screenshot: lead-mobile. |
| `docs/campaign-pipeline-completion/evidence/pipeline-desktop.png` | Synthetic desktop/mobile QA screenshot: pipeline-desktop. |
| `docs/campaign-pipeline-completion/evidence/pipeline-mobile.png` | Synthetic desktop/mobile QA screenshot: pipeline-mobile. |
| `docs/campaign-pipeline-completion/evidence/pipeline-settings-desktop.png` | Synthetic desktop/mobile QA screenshot: pipeline-settings-desktop. |
| `docs/campaign-pipeline-completion/evidence/pipeline-settings-mobile.png` | Synthetic desktop/mobile QA screenshot: pipeline-settings-mobile. |
| `docs/campaign-pipeline-completion/evidence/public-capture.json` | Sanitized local baseline, browser, capture, volume or query-plan evidence. |
| `src/components/product/PipelineBoard.tsx` | Use record currency on cards and accessible labels. |
| `src/components/product/types.ts` | Optional record currency on presentational board deals. |
| `src/features/campaigns/CampaignDetailPage.tsx` | Allowed lifecycle, duplicate, confirmed delete, pipeline drilldown, zero ROAS and accessible tracking copy. |
| `src/features/campaigns/CampaignFormDrawer.tsx` | Source/owner fields, lifecycle options and copy-as-draft identity/spend reset. |
| `src/features/campaigns/CampaignPicker.tsx` | Select by persisted ID, keep current archived campaign and protect busy dialog. |
| `src/features/campaigns/CampaignsPage.tsx` | Owner/source/date filters, collection-wide sort/page reset and graph-aware confirmed bulk pause. |
| `src/features/campaigns/api.ts` | Fetch authoritative lifecycle options. |
| `src/features/campaigns/useCampaigns.ts` | Options query and connected sales invalidation/stale recovery. |
| `src/features/crm/invalidateSales.ts` | Focused cross-module invalidation with optional deferred refetch for deletion navigation. |
| `src/features/crm/types.ts` | Bin-inclusive configuration counts and campaign deletion summary flag. |
| `src/features/dashboard/DashboardPage.tsx` | Preserve clicked dynamic deal stage in pipeline drilldown. |
| `src/features/deals/DealDetailPage.tsx` | Shared invalidation, dynamic outcome names, busy stepper and deletion navigation without stale refetch. |
| `src/features/deals/DealFormDrawer.tsx` | Refresh campaign/dashboard/pipeline/history after deal writes. |
| `src/features/deals/DealsPage.tsx` | Shared filters/forecast, exact optimistic board projection, guarded paging and currency display. |
| `src/features/deals/MoveDealDialog.tsx` | Keep failed submissions mounted, guard close while busy and retry failed lost-reason lookup. |
| `src/features/deals/api.ts` | Shared forecast filter contract. |
| `src/features/deals/projectDealMove.ts` | Pure immutable projection of count/value/half-even weighted totals and moved status/timestamps. |
| `src/features/deals/useDealMover.tsx` | Preserve drafts on failures, refresh stale versions, prevent duplicate sends and invalidate affected views. |
| `src/features/leads/ConvertDialog.tsx` | Refresh connected sales data when conversion creates a linked deal. |
| `src/features/leads/LeadFormDrawer.tsx` | Save explicit campaign link without rewriting UTM/source. |
| `src/features/leads/api.ts` | Expose optional campaign ID/null input. |
| `src/features/leads/detail/ProfileCard.tsx` | Authoritative campaign display/link/unlink; label retained deleted campaigns without dead links. |
| `src/features/leads/detail/useLeadDetail.ts` | Refresh related campaign/pipeline/dashboard data after lead edits/actions. |
| `src/features/pipelines/PipelinesSettings.tsx` | Shared invalidation, busy guards, template failure state and bin-inclusive deletion guidance. |
| `src/lib/format.ts` | Compact currency-aware board/list formatting. |
| `test/campaign-capture.browser.mjs` | Unauthenticated hosted form to assignment/attribution/dedupe and deleted-campaign Lead Detail verification. |
| `test/campaign-pipeline.browser.mjs` | Real local Chrome journeys, failures/concurrency, drag/select, conversion, pagination, roles and mobile. |
| `test/campaign-pipeline.test.mjs` | Execute actual optimistic projection helper with half-even money and nonmutating outcomes. |
