# TechSync CRM product review

Started 25 October 2026 (Asia/Kolkata). Scope: ten existing modules, acquisition → lead → follow-up → conversion → reporting, through market, product, architecture, UX, UI and QA/security lenses. Program is in progress. A verified implementation batch is complete; the ten-module market-readiness program is not complete. See the scorecard and remaining High gaps. No module is certified ready merely because its page renders.

## Sources and boundaries

Authoritative runtime: `backend/` and `frontend/`; Express JavaScript, Prisma 7 + pg, React 19 + TypeScript + Tailwind 4 + TanStack Query/Table. Preserve these conventions. `techsync-crm-v2/` is an older separate copy; root docs include outdated “nothing implemented” statements. M15/M22 and current tests define intended behavior. Prior performance, Lead Detail, Gmail, Campaign/Pipeline work is retained.

Baseline commits: backend `349cca6`, frontend `2dcea3e`; branches `review/market-readiness-20261025`. Inherited uncommitted edits are recorded in evidence and excluded from review commits. Test data is synthetic on localhost 55441. No deployment or external message sending is authorized by this program.

## Status

| Module | Status | Current release assessment |
|---|---|---|
| dashboard | Auditing | Nearly ready; full drilldown/accessibility matrix pending |
| leads | Fixing | Not ready; manual merge and exhaustive journeys pending |
| campaigns | Auditing | Nearly ready; retained M22/capture tests pass |
| pipeline | Auditing | Nearly ready; full keyboard/touch sweep pending |
| tasks-follow-ups | Fixing | Nearly ready; phone/recurrence/reminder rules tested |
| contacts-companies | Fixing | Nearly ready; related visibility fixed |
| templates | Auditing | Not ready; inherited work separately verified but uncommitted |
| integrations | Fixing | Not ready; website flow verified, other connectors missing |
| reports | Fixing | Not ready; real core reports delivered, schedules/targets pending |
| settings | Fixing | Not ready; auth/setup fixed, platform gaps remain |

## Documents

- [Market research](01-market-research.md)
- [System map](SYSTEM-MAP.md) and [schema inventory](SCHEMA-INVENTORY.md)
- [Role/tenant coverage](ROLE-TENANT-MATRIX.md)
- [Review commits](COMMITS.md)
- [Module audits](02-module-audits/)
- [Gap register](03-gap-register.md)
- [Decision log](04-decision-log.md)
- [Roadmap and batches](05-roadmap.md)
- [QA results](QA.md)
- [Scorecard](SCORECARD.md)
- [Deployment and rollback](DEPLOYMENT.md)
- [Demo](DEMO.md)
- [Resume checkpoint](PROGRESS.md)

Evidence labels: **Verified** = executed here with retained output; **Code reviewed** = inspected implementation only; **Historical** = prior report, not rerun; **Pending** = untested. Flow status Partial includes code evidence awaiting execution. Estimates S/M/L are relative, not delivery commitments.
