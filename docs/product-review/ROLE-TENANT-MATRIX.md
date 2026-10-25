# Role and tenant verification matrix

Actual roles: owner, admin, manager, sales_rep, viewer. Permission definitions in backend/src/config/permissions.js; row access in visibility.js and requireOrg. This table separates policy from executed coverage. It is not certification of every route.

| Surface | Owner/admin | Manager | Sales rep | Viewer | Executed evidence |
|---|---|---|---|---|---|
| Lead/contact/company/deal/campaign read | Workspace | Managed team + own; selected unassigned record types readable | Own; unassigned leads/contacts/companies readable | Workspace | Existing sales/performance/product tests; new related visibility; desktop/phone real UI |
| Record create/update | Create/all update | Create/team update | Create/own update | Denied | Existing campaign/pipeline five-role tests; new phone rep actions; product/qualification API tests |
| Record delete | All | Team | Denied | Denied | Existing task delete service/HTTP/bulk regression and sales suites; every delete permutation still not exhaustively inventoried |
| Reports read | Workspace | Managed team/own, plus readable unassigned leads | Own + readable unassigned leads | Workspace | All five roles on seven new report endpoints; foreign source zero results; forbidden owner filter; correctness fixtures |
| Reports export | Workspace | Team-owned only | Denied | Denied | Direct API and service rejection; authorized audit row; real browser download; unassigned excluded for team export |
| Pipeline/field/form/assignment configuration | Allowed by existing settings permissions | Denied | Denied | Denied | Existing sales/capture tests; real public form setup via owner; full settings matrix pending |
| Templates | Personal; owner/admin manage shared | Personal writes; shared read | Personal writes; shared read | Read shared only | Inherited template API tests; optional inherited browser results recorded separately |
| Gmail | Own mailbox; admin management as existing | Own mailbox | Own mailbox | Cannot connect/send | Inherited OAuth/send/sync/replay/role tests with mocked Google; actual Google delivery pending |
| Availability | Own periods | Own periods | Own periods | Own periods under existing routes | Existing assignment tests; new live adapter contract; full UI role matrix pending |
| Organization delete | Owner only | Denied | Denied | Denied | Route/validator inspection; no production deletion; complete destructive-action matrix pending |

## Tenant evidence

- New report tests use two synthetic tenants and five roles. Foreign source IDs never reveal foreign record data; unsupported owner scope is 403. Reports have no record-ID update routes.
- New related-record tests reject foreign parent IDs even for owners and hide restricted company chips/contact counts on both list and detail.
- Existing campaign/pipeline/qualification/product/templates/Gmail suites exercise foreign IDs, references and permission denials. These all run in the final local suite; inspect individual cases before claiming coverage of a particular endpoint.
- Real public capture test verifies foreign form 404, closed form 410, invalid input 400, repeated submission dedupe, first-touch attribution and configured owner.
- Frontend phone rep sees write actions within own scope; viewer and manager full UI traversal is still pending for several modules.

[evidence/route-inventory.json](evidence/route-inventory.json) lists 280 regex-discovered declarations. Default and nested router mounts need manual resolution; dynamic handlers and middleware can add behavior. Add one explicit coverage row per final method/path/action/role before closing PR-012. Do not infer every route is safe from this inventory or from UI visibility.
