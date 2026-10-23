# Email foundation implementation and release checklist

## Plan and existing-system decisions

The work extends the existing Gmail integration, as confirmed by the user. PostgreSQL and
Prisma 7 remain the database stack. `Organization` is the tenant; request middleware derives
`ctx.orgId`, `ctx.userId`, role and session ID from JWT authentication plus live membership
checks. Owner/admin map to tenant administrators; manager/sales_rep map to employees.
Existing Growth-plan gating and viewer restrictions are preserved.

The backend is ESM JavaScript, not a TypeScript application. Runtime modules follow that
established convention. `email-integration/providers/EmailProvider.ts` supplies the TypeScript
provider contract; the frontend additions use TypeScript with no `any`. No new dependency was
added. Existing Google OAuth, Zod, AES-GCM/KMS, Pino, Prisma, SMTP, notifications, React Query,
dialogs, toasts and signature editor are reused.

Implementation order/files:

1. Extend `prisma/schema.prisma`, add the foundation migration/rollback and
   `email-integration/crypto/tokenCrypto.js`.
2. Add `email-integration/{config,providers,dto,validators,service,controller,routes}.js` (provider
   contract is `.ts`), extend the existing Gmail connection/provider/refresh modules.
3. Add tenant-admin APIs and durable encrypted revocation; extend the existing membership and
   account-deletion hook through `integrations/gmail/hooks.js`.
4. Add frontend `EmailSettings`, `TeamEmail`, `EmailPrompt`, `ConnectionBadge` and
   `foundationApi`; extend navigation, setup progress and OAuth result handling.
5. Add offline security, Postgres integration and browser tests, plus setup/release docs.

The backend and frontend are separate Git repositories, both on `feat/email-foundation`.
Pre-existing uncommitted work is preserved. Production data, Google projects and deployment
configuration have not been changed.

## Storage and authorization

`GmailAccount` and `GmailOAuthState` adapt the requested EmailAccount/EmailOAuthState rather
than introducing a competing credential store. Existing lowercase statuses map to
`CONNECTED`, `NEEDS_RECONNECT`, `DISCONNECTED`, `ERROR` in the foundation DTOs. All accounts in
this table are implicitly GMAIL; SMTP/Microsoft implementations remain future work.
`credentialEnc` is the existing packed `v1.iv.authTag.ciphertext` AES-256-GCM envelope,
authenticated with tenant/account/purpose. It contains the refresh token only. `wrappedKey`
and `keyVersion` use existing KMS wrapping or a versioned local AES-GCM wrapper. Access tokens
stay in a bounded process cache.

The active-user unique index is preserved. Active Google-subject/email uniqueness is changed
from global to tenant-scoped; email comparison uses lowercase. Tenant settings/audits reference
Organization and User. OAuth state contains the originating user, tenant and session, hashed
state/browser binding, encrypted PKCE verifier, ten-minute expiry and atomic `usedAt` claim.
The callback cannot receive a bearer header from Google; it authenticates the browser-bound
state and checks the originating refresh-token session plus current membership. No user/tenant
identifier from a request body or query is trusted. The maintenance job removes expired state. For send-only accounts it also checks refresh-token health every 15 minutes, using the access-token cache until expiry; it never reads the mailbox. Revocation is detected when Google next rejects a refresh, so external revocation can take up to the cached access-token lifetime plus the health-check interval to appear.

Disconnect invalidates the account generation and clears its refresh credential in a transaction.
An encrypted revocation outbox is written atomically so failures cannot lose the remote revocation
task. A direct disconnect attempts that task immediately; departures are processed by the worker
within its normal minute schedule. Retries use a lease and bounded backoff. Successful revocations
delete the outbox secret. Pending revocations block reconnecting the same mailbox in that tenant.

New connections request only identity plus `gmail.send`; old grants do not automatically enable
sync. The existing send, templates, history and sync code is retained. Legacy history settings
remain under `/app/settings/gmail-history`. Existing history-authorized accounts retain their
consent version on reconnect if Google still grants reading.

## API surface

All endpoints below are relative to `/api/email`, use existing JWT/membership middleware
(except the browser-authenticated OAuth callback), and return the existing success/error shape.

| Method and path | Access |
| --- | --- |
| `GET /connect/google/start?returnTo=/app/settings/gmail` | Employee/owner/admin with existing connect permission |
| `GET /connect/google/callback` | One-use browser-bound OAuth state |
| `GET /accounts/me` | Current user's connection and tenant enablement |
| `POST /accounts/:id/disconnect` | Account owner or tenant owner/admin |
| `GET /admin/team?q=&status=all&page=1&pageSize=25` | Owner/admin; active members, paginated, summary counts |
| `POST /admin/accounts/:id/disconnect` | Owner/admin within the tenant |
| `POST /admin/remind` | Owner/admin; optional `userIds[]`, otherwise all unconnected non-viewers |
| `GET /admin/settings` / `PUT /admin/settings` | Owner/admin; validated, sanitized and audited |

Reminders create an in-app notification and audit entry atomically. SMTP is reused when
configured; an email-delivery failure does not lose the in-app reminder. Cooldown is checked
under a membership-row lock, once per recipient/tenant per 24 hours across concurrent requests.
The endpoint also limits requests to five per minute per IP. OAuth start limits to ten per
minute per IP. No reminders were sent to real users during implementation/testing.

## Deployment and key rotation

1. Review existing pending migrations and take the normal database backup/restore checkpoint.
   Configure the variables in [the Google setup guide](email-integration-google-setup.md).
2. With feature switches off, run `npm run db:migrate` from backend using the **direct**
   `DATABASE_URL_UNPOOLED` for the intended non-production environment first. The migration
   is transactional, sets a five-second lock timeout and changes no existing CRM table columns.
   Existing Gmail rows receive connection timestamps; no credential is rewritten by migration.
3. Run `npm run db:generate`, build, deploy the API and worker together, then the frontend.
4. Enable `EMAIL_FEATURE_ENABLED=true` with valid Google/KMS or local-key configuration.
   Keep `GMAIL_SYNC_ENABLED=false` for a foundation-only rollout. Run the QA below with Google
   test users. Only then roll out to the intended production customers.
5. Run `npm run worker` continuously; the existing minute maintenance job handles expired
   state and durable revocation even when Gmail access switches are off.

For local-key rotation, retain old keys in `EMAIL_TOKEN_ENCRYPTION_KEYS` (JSON version →
base64 key), set a new `EMAIL_TOKEN_KEY_VERSION` and `EMAIL_TOKEN_ENCRYPTION_KEY` on **all**
API/worker instances, then restart them. From backend:

```bash
node --env-file-if-exists=.env scripts/rotate-email-token-keys.js
# After reviewing dry-run counts against the intended database:
node --env-file-if-exists=.env scripts/rotate-email-token-keys.js --apply
```

This rewraps data keys for accounts and pending revocations using compare-and-set writes;
credential/message ciphertext need not change. Keep old keys until no account/outbox record
references them and the backup retention window permits retiring them. KMS rotation uses the
existing provider wrapping path; when configured with an unversioned KMS resource a dry run
can count all keys because stored versions identify the underlying cryptoKeyVersion.

## Rollback

Prefer switching off new connections and rolling back the frontend while keeping the additive
schema. A full schema rollback must be coordinated with the API/worker:

1. Stop connection writes and background work. Export new tenant settings/audit data if needed.
2. Drain `email_token_revocations`; local disconnect remains enforced while this drains.
3. If using local-key envelopes, rewrap them into the legacy KMS before rolling back to old
   provider code. Resolve cross-tenant duplicate active mailbox grants before restoring the old
   global uniqueness rules. Do not delete customer accounts automatically to do this.
4. Review and run `prisma/rollbacks/20261025000000_email_foundation.sql` against the intended
   environment only. It refuses unsafe conditions and runs in a transaction. It removes only
   foundation settings/audits/outbox/timestamps; original mailbox/history tables remain.
5. Deploy the previous API/worker/frontend. Prisma does not automatically undo an applied
   migration or remove its history record. Coordinate migration-history reconciliation with the
   operator before attempting to redeploy the same migration; production normally uses a new
   forward migration or the tested restore checkpoint instead of rewriting applied history.

## QA checklist

- [ ] Connect a personal Gmail and Google Workspace test user; verify the selected address is
  displayed even when it differs from CRM login. Check that new consent requests no read scope.
- [ ] Deny consent, uncheck send, omit/revoke offline access; confirm friendly retry messages.
- [ ] Expire/tamper/replay state, use another browser, sign out before callback; reject connection.
- [ ] Connect one mailbox as two employees in the same tenant; second is blocked. Connect it
  in another tenant; allowed with no information about the other customer.
- [ ] Disconnect self, then disconnect as admin. Confirm metadata remains, secrets are removed,
  the audit actor is correct, and an open employee screen updates on focus/within 30 seconds.
- [ ] Revoke in Google account settings, attempt refresh; show Needs reconnect once, without loops.
- [ ] Refresh concurrently, then disconnect; no cached token is returned on subsequent use.
- [ ] Invite/accept an employee through the existing flow; their first-login checklist includes
  Connect your Gmail. Dismiss the global banner and verify it stays hidden for seven days.
- [ ] Deactivate/delete a user; confirm local access stops atomically and worker revokes Google.
  Simulate Google outage; encrypted revocation remains retryable after process restart.
- [ ] Admin table: search, every status, pagination, empty/loading/error/retry; disconnect confirmation.
- [ ] Reminder: individual/all-unconnected, concurrent attempts, 24-hour cooldown; tenant B is untouched.
- [ ] Save settings with malicious signature markup; verify sanitized HTML and audit entry. Disable
  email; prompts disappear and both old/new connect endpoints reject new requests.
- [ ] Employee cannot open admin screen/call admin APIs; tenant A cannot read/disconnect tenant B.
- [ ] Check keyboard focus/Escape/confirm actions, 390px mobile layout and horizontal table scrolling.
- [ ] Check logs/responses for token/code/state/header leakage; test an old key during rotation.

## Automated validation and remaining work

The release report is in `email-integration-qa.md`. Live Google consent and actual Google/KMS
credential validation remain operator checks; no production mailbox was accessed.

Prompt 2 can use the provider contract, locked token helper, explicit DTOs, permissions and
tenant settings for sending from leads. Its provider `sendEmail` entry point deliberately
throws `not implemented` in this foundation; existing legacy sending code was not expanded.
Prompt 3 must introduce explicit incremental read authorization and a new sync consent version.
Stored visibility/signature preferences are reserved for enforcement in those phases. The
foundation has no SMTP-account/Microsoft implementation, composer, new template feature,
domain-wide delegation or tracking.
