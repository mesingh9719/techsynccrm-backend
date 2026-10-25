# Changed file inventory

Only review commits relative to the initial branch tips. Inherited staged files are intentionally absent. User/data effects and rollout/rollback are in [DEPLOYMENT.md](DEPLOYMENT.md).

## backend

```text
A	prisma/migrations/20261025130000_report_period_indexes/migration.sql
A	prisma/rollbacks/20261025130000_report_period_indexes.sql
M	prisma/schema.prisma
A	scripts/product-review-performance.js
A	scripts/product-review-qa.js
M	src/routes/index.js
A	src/routes/report.routes.js
M	src/services/company.service.js
M	src/services/contact.service.js
M	src/services/googleAuth.service.js
M	src/services/lead.service.js
M	src/services/organization.service.js
A	src/services/report.service.js
A	src/validators/report.validators.js
M	test/integration/m11.test.js
A	test/integration/product-review.test.js
A	test/integration/related-visibility.test.js
M	vitest.config.js
```

## frontend

```text
M	.env.example
M	src/features/capture/api.ts
M	src/features/dashboard/DashboardReportWidget.tsx
M	src/features/leads/LeadsPage.tsx
M	src/features/leads/detail/insights.ts
M	src/features/onboarding/SetupPage.tsx
M	src/features/onboarding/useSetupProgress.ts
A	src/features/reports/FollowUpReport.tsx
M	src/features/reports/ReportsPage.tsx
M	src/features/reports/api.ts
M	src/lib/downloadCsv.ts
M	src/lib/queryClient.ts
M	src/services/http.ts
M	test/behavior.test.mjs
M	test/campaign-capture.browser.mjs
A	test/fixtures/capturePreview.ts
A	test/fixtures/reportPreview.ts
A	test/product-review-mobile.browser.mjs
A	test/product-review.browser.mjs
```
