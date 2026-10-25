# Review commits

Both repositories use review/market-readiness-20261025. User-owned staged Gmail/Templates work is excluded. Root requested docs are mirrored into backend/docs/product-review for version control. Final documentation commits can be found with git log after this code manifest.

## backend

3666432 test(notifications): PR-013 anchor digest fixtures and isolate database test files
2f8e753 test(review): PR-012 PR-015 add isolated browser fixtures and report benchmark
ad772c8 fix(setup): PR-017 link onboarding imports to the lead entity
c7f0a29 feat(reports): PR-001 PR-002 PR-003 PR-004 PR-005 serve real scoped analytics
3b824b6 fix(auth): PR-018 restore Google login enum and atomic identity linking
b4d4128 fix(crm): PR-014 scope related company names and contact counts

## frontend

85dfd20 fix(exports): PR-027 neutralize formulas behind control characters
995b455 fix(filters): PR-005 label unassigned lead sources consistently
d2fac09 fix(rollout): PR-006 keep report and settings stop switches free of previews
2abddcc test(review): PR-012 PR-015 verify real data and phone follow-up journeys
c8809ba fix(leads): PR-025 use factual next-step guidance
97a6a61 fix(onboarding): PR-017 replace sample progress with real workspace actions
49ece94 feat(crm): PR-001 PR-005 PR-006 PR-024 use real reports and settings with fresh caches
