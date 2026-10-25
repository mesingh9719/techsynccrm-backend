# Phase 0 implementation record

25 October 2026. Implemented on `feat/google-workspace-foundation` in the independent backend and frontend repositories. User-staged Gmail/Templates changes were preserved. Canonical tracked program documents live under `backend/docs/integrations/google-workspace`; the workspace-level planning copy is retained for convenience.

## Delivered behavior

- Settings → Google connections: real connection metadata, per-service permission review, Google OAuth, independent service preferences, disconnect and separately confirmed project-grant removal. Gmail links to the existing email settings.
- Settings → Team & Google: owner/admin workspace preferences, paginated/searchable member status, local administrative disconnect, and paginated sanitized connection activity. An Integrations card links to the personal settings. Viewer access is read/remove-only for their own binding.
- Shared parameterized envelope implementation with legacy Gmail AAD/wire compatibility and a metadata/access-token adapter. Gmail remains its credential authority; existing send-only scopes, callback contracts and reconnect rules remain intact. The new Workspace profile can preserve a same-client/same-subject connected grant's refresh token when incremental consent omits a replacement. New/reconnect-required grants require offline credentials.
- Additive tenant-bound connection, consent, OAuth-state, tenant settings, activity and independent encrypted revocation-outbox models. Original live CRM session, one-use browser-bound state, PKCE, nonce, verified Google identity, exact scope allowlist, current membership/service checks and generation fencing protect the new flow. No arbitrary caller scopes or return URLs are accepted.
- Serialized refresh via a database lease, current-role/consent checks even on cache hits, invalid-grant reconnect status and bounded token cache. Membership/account deactivation hooks and workspace soft deletion detach credentials. Worker maintenance also detects invalid memberships. Provider cleanup survives operational-row deletion and runs with flags off.
- Local service-off keeps Google's permission intact. A workspace detach erases local credentials and revokes only when no binding remains for that grant. Explicit project removal invalidates known bindings across workspaces before queued provider revocation. No other tenant's identity is returned to the caller. Project-wide removal requires recent CRM login and explicit confirmation; admins can only detach a teammate locally.

## API contract

All routes are under `/api/google`. Authenticated responses use `{ success: true, data }`, set `Cache-Control: no-store`, and return allowlisted metadata only. Connection permissions are server enforced on every request; the frontend does not provide authority.

| Method and path | Authorization / input |
|---|---|
| `GET /connections/me` | Current member; own Workspace metadata, Gmail adapter metadata, configuration categories, service availability/preferences and consent version |
| `POST /oauth/start` | Non-viewer member, live CRM session; `{service: calendar|drive|sheets, consentVersion, returnTo?}`. Exact current version required; returns Google URL and sets an HttpOnly, SameSite=Lax 10-minute browser cookie |
| `GET /oauth/callback` | Public state-bound callback; original session/role checked again, nonce/subject verified; redirects only to allowlisted frontend settings/integrations paths. Codes, state and provider exceptions are not logged or returned |
| `PATCH /connections/:id/services/:service` | Own binding; `{enabled, consentVersion?}`. Enabling requires current version, narrow granted scope and all rollout/tenant/access checks. Disabling remains available to an existing owner with a viewer role |
| `POST /connections/:id/disconnect` | Own binding; local detach |
| `POST /connections/:id/revoke-project-grant` | Own binding and CRM login within 15 minutes; `{confirmProjectRevocation:true}` |
| `GET /admin/connections?page=1&pageSize=25&q=` | Owner/admin; max page size 100, name/email search, metadata only |
| `POST /admin/connections/:id/disconnect` | Owner/admin; binding must belong to this tenant; local detach only |
| `GET/PATCH /admin/settings` | Owner/admin; optional boolean fields `calendarEnabled`, `driveEnabled`, `sheetsEnabled`, `exportsEnabled`, at least one on PATCH |
| `GET /admin/sync-logs?page=1&pageSize=25&service=` | Owner/admin; optional allowlisted service; sanitized action/status/reason metadata |

Tenant defaults and four new server rollout flags are **false**. Service-off clears saved personal enabled preferences and increments generations; tenant re-enablement does not silently restore them. `exportsEnabled` reserves a later Google-export control and does not change existing CSV/Excel permissions. Configuration diagnostics validate declared project/client separation, callback and encryption syntax; actual Google APIs, IAM and OAuth verification remain external acceptance checks.

## Migration and runtime

Migration `20261025150000_google_workspace_foundation` is additive. `GoogleConnection` has unique tenant/user and tenant/id identities. Service consents and connection activity use tenant-composite foreign keys; due-state and tenant query indexes are included. `GoogleRevocation` intentionally has no tenant/user FK so deletion cannot cascade away its encrypted cleanup credential. It retains only the original envelope context identifiers and encrypted grant needed by cleanup.

`google.maintain` is registered in the existing pg-boss API/worker queues and scheduled every minute. It removes expired OAuth states, retains activity for 30 days, refresh-checks active enabled connections and retries revocation with backoff. Revocation records expire after 30 days, limiting encrypted-secret retention; unresolved provider removal after that retention window requires operational follow-up and the user's Google Account access-removal control. Existing wrapping versions must remain available until no dependent rows remain.

Rollback for production is flags-off plus compatible application rollback; leave the additive tables and cleanup worker in place until encrypted cleanup is finished. `prisma/rollbacks/20261025150000_google_workspace_foundation.sql` is local validation only and refuses destructive rollback while credentials or outbox entries remain. A transactionally isolated schema test verified that guard and an empty rollback. Production migration/deployment was not performed.

## Boundaries and remaining acceptance

Phase 0 does not create Calendar events, attach/copy Drive files, export/import Google Sheets, send invitations, add Google read scopes, provision infrastructure or alter public legal pages. The UI states these content features are pending. Local CSV/XLSX transfer functionality is unchanged.

Complete [Console/runtime setup](11-google-cloud-console-setup.md), real-account consent/refresh/revocation and real KMS IAM checks before a connection pilot. No live credential was exercised. Record the actual Calendar scope category and required Google verification before public rollout. Plan/feature pricing, later content controls and later-phase product decisions remain in the roadmap.
