# API endpoint inventory

Generated from root router mounts and route declarations on 22 October 2026. Risk labels are static triage unless marked measured. Unknown does not mean fast. Middleware order and permission gates are retained in the linked route source. All paths below are existing routes.

| Method | Path | Performance risk | Declaration |
|---|---|---|---|
| POST | /api/activities | unknown (not load-tested) | src/routes/activity.routes.js:32 |
| DELETE | /api/activities/:id | unknown (not load-tested) | src/routes/activity.routes.js:34 |
| PATCH | /api/activities/:id | unknown (not load-tested) | src/routes/activity.routes.js:33 |
| POST | /api/activities/:id/pin | unknown (not load-tested) | src/routes/activity.routes.js:35 |
| POST | /api/auth/accept-invitation | unknown (not load-tested) | src/routes/auth.routes.js:62 |
| POST | /api/auth/accept-terms | unknown (not load-tested) | src/routes/auth.routes.js:56 |
| POST | /api/auth/cancel-email-change | unknown (not load-tested) | src/routes/auth.routes.js:58 |
| POST | /api/auth/confirm-email-change | unknown (not load-tested) | src/routes/auth.routes.js:57 |
| POST | /api/auth/forgot-password | unknown (not load-tested) | src/routes/auth.routes.js:53 |
| POST | /api/auth/login | CPU password hashing / unknown external delivery | src/routes/auth.routes.js:43 |
| POST | /api/auth/login/2fa | CPU password hashing / unknown external delivery | src/routes/auth.routes.js:44 |
| POST | /api/auth/logout | unknown (not load-tested) | src/routes/auth.routes.js:46 |
| POST | /api/auth/logout-all | unknown (not load-tested) | src/routes/auth.routes.js:47 |
| GET | /api/auth/me | unknown (not load-tested) | src/routes/auth.routes.js:48 |
| POST | /api/auth/refresh | unknown (not load-tested) | src/routes/auth.routes.js:45 |
| POST | /api/auth/resend-verification | unknown (not load-tested) | src/routes/auth.routes.js:52 |
| POST | /api/auth/reset-password | unknown (not load-tested) | src/routes/auth.routes.js:54 |
| POST | /api/auth/signup | unknown (not load-tested) | src/routes/auth.routes.js:42 |
| POST | /api/auth/signup-with-invite | unknown (not load-tested) | src/routes/auth.routes.js:61 |
| POST | /api/auth/switch-organization | unknown (not load-tested) | src/routes/auth.routes.js:49 |
| POST | /api/auth/verify-email | unknown (not load-tested) | src/routes/auth.routes.js:51 |
| GET | /api/campaigns | chatty / payload (static review) | src/routes/campaign.routes.js:18 |
| POST | /api/campaigns | unknown (not load-tested) | src/routes/campaign.routes.js:19 |
| DELETE | /api/campaigns/:id | unknown (not load-tested) | src/routes/campaign.routes.js:37 |
| GET | /api/campaigns/:id | chatty / payload (static review) | src/routes/campaign.routes.js:26 |
| PATCH | /api/campaigns/:id | unknown (not load-tested) | src/routes/campaign.routes.js:35 |
| GET | /api/campaigns/:id/meta-status | chatty / payload (static review) | src/routes/campaign.routes.js:27 |
| POST | /api/campaigns/:id/status | unknown (not load-tested) | src/routes/campaign.routes.js:36 |
| GET | /api/companies | chatty / payload (static review) | src/routes/crm.routes.js:60 |
| POST | /api/companies | unknown (not load-tested) | src/routes/crm.routes.js:61 |
| DELETE | /api/companies/:id | unknown (not load-tested) | src/routes/crm.routes.js:68 |
| GET | /api/companies/:id | chatty / payload (static review) | src/routes/crm.routes.js:65 |
| PATCH | /api/companies/:id | unknown (not load-tested) | src/routes/crm.routes.js:67 |
| GET | /api/companies/:id/contacts | chatty / payload (static review) | src/routes/crm.routes.js:66 |
| POST | /api/companies/:id/restore | unknown (not load-tested) | src/routes/crm.routes.js:69 |
| POST | /api/companies/bulk | unknown (not load-tested) | src/routes/crm.routes.js:64 |
| POST | /api/companies/check-duplicates | unknown (not load-tested) | src/routes/crm.routes.js:62 |
| POST | /api/companies/merge | unknown (not load-tested) | src/routes/crm.routes.js:63 |
| GET | /api/contacts | chatty / payload (static review) | src/routes/crm.routes.js:48 |
| POST | /api/contacts | unknown (not load-tested) | src/routes/crm.routes.js:49 |
| DELETE | /api/contacts/:id | unknown (not load-tested) | src/routes/crm.routes.js:55 |
| GET | /api/contacts/:id | chatty / payload (static review) | src/routes/crm.routes.js:53 |
| PATCH | /api/contacts/:id | unknown (not load-tested) | src/routes/crm.routes.js:54 |
| POST | /api/contacts/:id/restore | unknown (not load-tested) | src/routes/crm.routes.js:56 |
| POST | /api/contacts/bulk | unknown (not load-tested) | src/routes/crm.routes.js:52 |
| POST | /api/contacts/check-duplicates | unknown (not load-tested) | src/routes/crm.routes.js:50 |
| POST | /api/contacts/merge | unknown (not load-tested) | src/routes/crm.routes.js:51 |
| GET | /api/custom-fields | unknown (not load-tested) | src/routes/crm.routes.js:81 |
| POST | /api/custom-fields | unknown (not load-tested) | src/routes/crm.routes.js:82 |
| DELETE | /api/custom-fields/:id | unknown (not load-tested) | src/routes/crm.routes.js:85 |
| PATCH | /api/custom-fields/:id | unknown (not load-tested) | src/routes/crm.routes.js:84 |
| PATCH | /api/custom-fields/order | unknown (not load-tested) | src/routes/crm.routes.js:83 |
| GET | /api/deals | unknown (not load-tested) | src/routes/deal.routes.js:51 |
| POST | /api/deals | unknown (not load-tested) | src/routes/deal.routes.js:54 |
| DELETE | /api/deals/:id | unknown (not load-tested) | src/routes/deal.routes.js:62 |
| GET | /api/deals/:id | unknown (not load-tested) | src/routes/deal.routes.js:56 |
| PATCH | /api/deals/:id | unknown (not load-tested) | src/routes/deal.routes.js:58 |
| POST | /api/deals/:id/contacts | unknown (not load-tested) | src/routes/deal.routes.js:60 |
| DELETE | /api/deals/:id/contacts/:contactId | unknown (not load-tested) | src/routes/deal.routes.js:61 |
| GET | /api/deals/:id/history | unknown (not load-tested) | src/routes/deal.routes.js:57 |
| POST | /api/deals/:id/move | unknown (not load-tested) | src/routes/deal.routes.js:59 |
| POST | /api/deals/:id/restore | unknown (not load-tested) | src/routes/deal.routes.js:63 |
| GET | /api/deals/board | chatty / heavy payload (measured) | src/routes/deal.routes.js:52 |
| POST | /api/deals/bulk | unknown (not load-tested) | src/routes/deal.routes.js:55 |
| GET | /api/deals/forecast | heavy aggregation (measured) | src/routes/deal.routes.js:53 |
| GET | /api/docs.json | heavy payload / development only | src/routes/index.js |
| GET | /api/exports | heavy payload / worker-backed | src/routes/transfer.routes.js:25 |
| POST | /api/exports | heavy payload / worker-backed | src/routes/transfer.routes.js:26 |
| GET | /api/exports/:id | heavy payload / worker-backed | src/routes/transfer.routes.js:27 |
| GET | /api/files | unknown (not load-tested) | src/routes/file.routes.js:14 |
| POST | /api/files | unknown (not load-tested) | src/routes/file.routes.js:13 |
| DELETE | /api/files/:id | unknown (not load-tested) | src/routes/file.routes.js:20 |
| GET | /api/files/:id | unknown (not load-tested) | src/routes/file.routes.js:19 |
| POST | /api/files/:id/complete | unknown (not load-tested) | src/routes/file.routes.js:15 |
| POST | /api/files/:id/links | unknown (not load-tested) | src/routes/file.routes.js:17 |
| DELETE | /api/files/:id/links/:entityType/:entityId | unknown (not load-tested) | src/routes/file.routes.js:18 |
| POST | /api/files/:id/restore | unknown (not load-tested) | src/routes/file.routes.js:16 |
| POST | /api/files/upload-intent | unknown (not load-tested) | src/routes/file.routes.js:12 |
| GET | /api/health | unknown / DB + worker heartbeat | src/routes/index.js |
| GET | /api/imports | heavy payload / worker-backed | src/routes/transfer.routes.js:10 |
| POST | /api/imports | heavy payload / worker-backed | src/routes/transfer.routes.js:11 |
| GET | /api/imports/:id | heavy payload / worker-backed | src/routes/transfer.routes.js:16 |
| PATCH | /api/imports/:id | heavy payload / worker-backed | src/routes/transfer.routes.js:17 |
| GET | /api/imports/:id/attention | heavy payload / worker-backed | src/routes/transfer.routes.js:15 |
| GET | /api/imports/:id/attention-data | heavy payload / worker-backed | src/routes/transfer.routes.js:14 |
| POST | /api/imports/:id/cancel | heavy payload / worker-backed | src/routes/transfer.routes.js:20 |
| GET | /api/imports/:id/dataset | heavy payload / worker-backed | src/routes/transfer.routes.js:12 |
| GET | /api/imports/:id/errors | heavy payload / worker-backed | src/routes/transfer.routes.js:22 |
| GET | /api/imports/:id/preview | heavy payload / worker-backed | src/routes/transfer.routes.js:13 |
| POST | /api/imports/:id/preview | heavy payload / worker-backed | src/routes/transfer.routes.js:18 |
| POST | /api/imports/:id/start | heavy payload / worker-backed | src/routes/transfer.routes.js:19 |
| POST | /api/imports/:id/undo | heavy payload / worker-backed | src/routes/transfer.routes.js:21 |
| DELETE | /api/integrations/facebook | unknown / external-service or worker-backed | src/routes/facebook.routes.js:20 |
| GET | /api/integrations/facebook | unknown / external-service or worker-backed | src/routes/facebook.routes.js:16 |
| GET | /api/integrations/facebook/ad-accounts | unknown / external-service or worker-backed | src/routes/facebook.routes.js:27 |
| GET | /api/integrations/facebook/callback | unknown / external-service or worker-backed | src/routes/facebook.routes.js:10 |
| GET | /api/integrations/facebook/campaigns | unknown / external-service or worker-backed | src/routes/facebook.routes.js:28 |
| POST | /api/integrations/facebook/connect | unknown / external-service or worker-backed | src/routes/facebook.routes.js:17 |
| POST | /api/integrations/facebook/data-deletion | unknown / external-service or worker-backed | src/routes/facebook.routes.js:12 |
| GET | /api/integrations/facebook/data-deletion/status/:code | unknown / external-service or worker-backed | src/routes/facebook.routes.js:13 |
| POST | /api/integrations/facebook/deauthorize | unknown / external-service or worker-backed | src/routes/facebook.routes.js:11 |
| GET | /api/integrations/facebook/deliveries | unknown / external-service or worker-backed | src/routes/facebook.routes.js:29 |
| POST | /api/integrations/facebook/deliveries/:id/retry | unknown / external-service or worker-backed | src/routes/facebook.routes.js:30 |
| POST | /api/integrations/facebook/forms/:id/sync | unknown / external-service or worker-backed | src/routes/facebook.routes.js:26 |
| GET | /api/integrations/facebook/pages | unknown / external-service or worker-backed | src/routes/facebook.routes.js:21 |
| POST | /api/integrations/facebook/pages | unknown / external-service or worker-backed | src/routes/facebook.routes.js:22 |
| DELETE | /api/integrations/facebook/pages/:pageId | unknown / external-service or worker-backed | src/routes/facebook.routes.js:23 |
| GET | /api/integrations/facebook/pages/:pageId/forms | unknown / external-service or worker-backed | src/routes/facebook.routes.js:24 |
| PUT | /api/integrations/facebook/pages/:pageId/forms/:formId | unknown / external-service or worker-backed | src/routes/facebook.routes.js:25 |
| POST | /api/integrations/facebook/sdk/challenge | unknown / external-service or worker-backed | src/routes/facebook.routes.js:18 |
| POST | /api/integrations/facebook/sdk/connect | unknown / external-service or worker-backed | src/routes/facebook.routes.js:19 |
| GET | /api/internal/inbound | unknown (not load-tested) | src/routes/internal.routes.js:14 |
| POST | /api/internal/organizations/:id/extend-trial | unknown (not load-tested) | src/routes/internal.routes.js:17 |
| POST | /api/internal/organizations/:id/plan | unknown (not load-tested) | src/routes/internal.routes.js:18 |
| GET | /api/invitations | unknown (not load-tested) | src/routes/team.routes.js:29 |
| POST | /api/invitations | unknown (not load-tested) | src/routes/team.routes.js:30 |
| DELETE | /api/invitations/:id | unknown (not load-tested) | src/routes/team.routes.js:32 |
| POST | /api/invitations/:id/resend | unknown (not load-tested) | src/routes/team.routes.js:31 |
| GET | /api/lead-sources | unknown (not load-tested) | src/routes/lead.routes.js:52 |
| POST | /api/lead-sources | unknown (not load-tested) | src/routes/lead.routes.js:53 |
| DELETE | /api/lead-sources/:id | unknown (not load-tested) | src/routes/lead.routes.js:55 |
| PATCH | /api/lead-sources/:id | unknown (not load-tested) | src/routes/lead.routes.js:54 |
| GET | /api/leads | unknown (not load-tested) | src/routes/lead.routes.js:35 |
| POST | /api/leads | unknown (not load-tested) | src/routes/lead.routes.js:36 |
| DELETE | /api/leads/:id | unknown (not load-tested) | src/routes/lead.routes.js:41 |
| GET | /api/leads/:id | unknown (not load-tested) | src/routes/lead.routes.js:39 |
| PATCH | /api/leads/:id | unknown (not load-tested) | src/routes/lead.routes.js:40 |
| POST | /api/leads/:id/assign | unknown (not load-tested) | src/routes/lead.routes.js:45 |
| POST | /api/leads/:id/claim | unknown (not load-tested) | src/routes/lead.routes.js:44 |
| GET | /api/leads/:id/conversion | unknown (not load-tested) | src/routes/lead.routes.js:46 |
| POST | /api/leads/:id/convert | unknown (not load-tested) | src/routes/lead.routes.js:47 |
| POST | /api/leads/:id/restore | unknown (not load-tested) | src/routes/lead.routes.js:42 |
| POST | /api/leads/:id/status | unknown (not load-tested) | src/routes/lead.routes.js:43 |
| POST | /api/leads/bulk | unknown (not load-tested) | src/routes/lead.routes.js:38 |
| POST | /api/leads/check-duplicates | unknown (not load-tested) | src/routes/lead.routes.js:37 |
| GET | /api/lost-reasons | unknown (not load-tested) | src/routes/lead.routes.js:59 |
| POST | /api/lost-reasons | unknown (not load-tested) | src/routes/lead.routes.js:60 |
| PATCH | /api/lost-reasons/:id | unknown (not load-tested) | src/routes/lead.routes.js:61 |
| GET | /api/members | chatty / payload (static review) | src/routes/team.routes.js:21 |
| PATCH | /api/members/:userId | unknown (not load-tested) | src/routes/team.routes.js:23 |
| POST | /api/members/:userId/deactivate | unknown (not load-tested) | src/routes/team.routes.js:24 |
| POST | /api/members/:userId/reactivate | unknown (not load-tested) | src/routes/team.routes.js:25 |
| GET | /api/members/options | chatty / payload (static review) | src/routes/team.routes.js:22 |
| GET | /api/meta/plans | unknown (not load-tested) | src/routes/meta.routes.js:7 |
| GET | /api/notifications | chatty / access rechecks | src/routes/notification.routes.js:16 |
| POST | /api/notifications/:id/read | chatty / access rechecks | src/routes/notification.routes.js:20 |
| POST | /api/notifications/read-all | chatty / access rechecks | src/routes/notification.routes.js:18 |
| GET | /api/notifications/stream | chatty / access rechecks | src/routes/notification.routes.js:11 |
| POST | /api/notifications/stream-ticket | chatty / access rechecks | src/routes/notification.routes.js:19 |
| GET | /api/notifications/unread-count | chatty / access rechecks | src/routes/notification.routes.js:17 |
| GET | /api/organizations | unknown (not load-tested) | src/routes/organization.routes.js:20 |
| POST | /api/organizations | unknown (not load-tested) | src/routes/organization.routes.js:21 |
| DELETE | /api/organizations/current | unknown (not load-tested) | src/routes/organization.routes.js:26 |
| GET | /api/organizations/current | unknown (not load-tested) | src/routes/organization.routes.js:23 |
| PATCH | /api/organizations/current | unknown (not load-tested) | src/routes/organization.routes.js:25 |
| GET | /api/organizations/current/checklist | unknown (not load-tested) | src/routes/organization.routes.js:33 |
| POST | /api/organizations/current/checklist/dismiss | unknown (not load-tested) | src/routes/organization.routes.js:34 |
| POST | /api/organizations/current/seat-selection | unknown (not load-tested) | src/routes/organization.routes.js:31 |
| GET | /api/organizations/current/storage | unknown (not load-tested) | src/routes/organization.routes.js:24 |
| POST | /api/organizations/current/transfer-ownership | unknown (not load-tested) | src/routes/organization.routes.js:27 |
| POST | /api/organizations/current/upgrade-request | unknown (not load-tested) | src/routes/organization.routes.js:30 |
| GET | /api/pipeline-templates | unknown (not load-tested) | src/routes/deal.routes.js:47 |
| GET | /api/pipelines | unknown (not load-tested) | src/routes/deal.routes.js:36 |
| POST | /api/pipelines | unknown (not load-tested) | src/routes/deal.routes.js:37 |
| DELETE | /api/pipelines/:id | unknown (not load-tested) | src/routes/deal.routes.js:39 |
| PATCH | /api/pipelines/:id | unknown (not load-tested) | src/routes/deal.routes.js:38 |
| POST | /api/pipelines/:id/stages | unknown (not load-tested) | src/routes/deal.routes.js:40 |
| DELETE | /api/pipelines/:id/stages/:stageId | unknown (not load-tested) | src/routes/deal.routes.js:43 |
| PATCH | /api/pipelines/:id/stages/:stageId | unknown (not load-tested) | src/routes/deal.routes.js:42 |
| PATCH | /api/pipelines/:id/stages/order | unknown (not load-tested) | src/routes/deal.routes.js:41 |
| POST | /api/public/contact | unknown (not load-tested) | src/routes/public.routes.js:23 |
| POST | /api/public/demo-requests | unknown (not load-tested) | src/routes/public.routes.js:26 |
| GET | /api/public/demo-slots | unknown (not load-tested) | src/routes/public.routes.js:25 |
| GET | /api/public/invitations/:token | unknown (not load-tested) | src/routes/public.routes.js:33 |
| POST | /api/public/newsletter | unknown (not load-tested) | src/routes/public.routes.js:28 |
| POST | /api/public/newsletter/confirm | unknown (not load-tested) | src/routes/public.routes.js:29 |
| POST | /api/public/newsletter/unsubscribe | unknown (not load-tested) | src/routes/public.routes.js:30 |
| GET | /api/saved-views | unknown (not load-tested) | src/routes/lead.routes.js:65 |
| POST | /api/saved-views | unknown (not load-tested) | src/routes/lead.routes.js:66 |
| DELETE | /api/saved-views/:id | unknown (not load-tested) | src/routes/lead.routes.js:68 |
| PATCH | /api/saved-views/:id | unknown (not load-tested) | src/routes/lead.routes.js:67 |
| GET | /api/superadmin/clients | unknown (not load-tested) | src/routes/superadmin.routes.js:39 |
| GET | /api/superadmin/me | unknown (not load-tested) | src/routes/superadmin.routes.js:29 |
| GET | /api/superadmin/overview | unknown (not load-tested) | src/routes/superadmin.routes.js:36 |
| GET | /api/superadmin/queries | unknown (not load-tested) | src/routes/superadmin.routes.js:66 |
| GET | /api/tags | unknown (not load-tested) | src/routes/crm.routes.js:74 |
| POST | /api/tags | unknown (not load-tested) | src/routes/crm.routes.js:75 |
| DELETE | /api/tags/:id | unknown (not load-tested) | src/routes/crm.routes.js:77 |
| PATCH | /api/tags/:id | unknown (not load-tested) | src/routes/crm.routes.js:76 |
| GET | /api/tasks | chatty / payload (static review) | src/routes/activity.routes.js:39 |
| POST | /api/tasks | unknown (not load-tested) | src/routes/activity.routes.js:41 |
| DELETE | /api/tasks/:id | unknown (not load-tested) | src/routes/activity.routes.js:45 |
| GET | /api/tasks/:id | chatty / payload (static review) | src/routes/activity.routes.js:43 |
| PATCH | /api/tasks/:id | unknown (not load-tested) | src/routes/activity.routes.js:44 |
| POST | /api/tasks/:id/cancel | unknown (not load-tested) | src/routes/activity.routes.js:48 |
| POST | /api/tasks/:id/complete | unknown (not load-tested) | src/routes/activity.routes.js:46 |
| POST | /api/tasks/:id/reopen | unknown (not load-tested) | src/routes/activity.routes.js:47 |
| POST | /api/tasks/bulk | unknown (not load-tested) | src/routes/activity.routes.js:42 |
| GET | /api/tasks/summary | chatty / payload (static review) | src/routes/activity.routes.js:40 |
| GET | /api/teams | chatty / payload (static review) | src/routes/team.routes.js:36 |
| POST | /api/teams | unknown (not load-tested) | src/routes/team.routes.js:37 |
| DELETE | /api/teams/:id | unknown (not load-tested) | src/routes/team.routes.js:39 |
| PATCH | /api/teams/:id | unknown (not load-tested) | src/routes/team.routes.js:38 |
| GET | /api/timeline | chatty / payload (static review) | src/routes/activity.routes.js:27 |
| DELETE | /api/users/me | unknown (not load-tested) | src/routes/user.routes.js:37 |
| PATCH | /api/users/me | unknown (not load-tested) | src/routes/user.routes.js:36 |
| GET | /api/users/me/2fa | unknown (not load-tested) | src/routes/user.routes.js:47 |
| POST | /api/users/me/2fa/disable | unknown (not load-tested) | src/routes/user.routes.js:50 |
| POST | /api/users/me/2fa/enable | unknown (not load-tested) | src/routes/user.routes.js:49 |
| POST | /api/users/me/2fa/recovery-codes | unknown (not load-tested) | src/routes/user.routes.js:51 |
| POST | /api/users/me/2fa/setup | unknown (not load-tested) | src/routes/user.routes.js:48 |
| DELETE | /api/users/me/email | unknown (not load-tested) | src/routes/user.routes.js:41 |
| POST | /api/users/me/email | unknown (not load-tested) | src/routes/user.routes.js:40 |
| PUT | /api/users/me/onboarding | unknown (not load-tested) | src/routes/user.routes.js:35 |
| POST | /api/users/me/password | CPU password hashing / unknown external delivery | src/routes/user.routes.js:39 |
| DELETE | /api/users/me/sessions | unknown (not load-tested) | src/routes/user.routes.js:44 |
| GET | /api/users/me/sessions | unknown (not load-tested) | src/routes/user.routes.js:43 |
| DELETE | /api/users/me/sessions/:sessionId | unknown (not load-tested) | src/routes/user.routes.js:45 |
| GET | /api/webhooks/in/facebook | unknown / external-service or worker-backed | src/routes/facebook.routes.js:33 |
| POST | /api/webhooks/in/facebook | unknown / external-service or worker-backed | src/routes/facebook.routes.js:34 |
