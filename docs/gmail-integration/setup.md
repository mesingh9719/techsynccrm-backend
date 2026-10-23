# Gmail operator setup

Scope A is implemented on backend/frontend branches `feat/gmail-integration`. Google Cloud is **not configured**. Both Gmail switches default to false. The local tests use fake providers and a disposable database; no real email was read or sent.

## Existing Google client keys

The backend accepts your existing `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; no renaming is required. Optional `GOOGLE_GMAIL_CLIENT_ID` / `GOOGLE_GMAIL_CLIENT_SECRET` override them **as a pair**, so credentials from two clients cannot be mixed. Keep these values only in backend environment settings.

For local development, the callback defaults to `http://localhost:5000/api/integrations/gmail/callback` (or your configured `PORT`). Register that exact URI on the Google OAuth **web application** client. Production requires an explicit HTTPS `GOOGLE_GMAIL_REDIRECT_URI`; `GOOGLE_REDIRECT_URI` is also accepted. Never infer a production callback from an incoming request.

The client keys are recognized in the current local backend. Remaining setup: create a symmetric KMS key, give the API/worker identity encrypt/decrypt access, set `GMAIL_KMS_KEY_NAME`, then set `GMAIL_ENABLED=true` and `GMAIL_SYNC_ENABLED=true`. Restart both processes after editing their environment. Until then Gmail stays disabled; keys alone cannot securely persist the mailbox refresh token. No credentials were changed or printed during verification.

After setup, open a lead → **Email** or **Settings → Gmail**, accept work-mailbox sharing, click **Connect Gmail**, choose a Google account, and allow the requested permissions. The popup returns to CRM and the open draft is retained; connection never sends it automatically. If Google severs the popup opener, CRM checks the authenticated connection status instead. Administrators see missing setup and the exact callback URL in the connection prompt. There is no employee app-password step.

## Keep the current local application working

Existing manual activity logging and email-app links work without Google setup. The lead header’s **Email** action opens the composer with an inline setup explanation. The timeline’s **Log email** action records an email sent elsewhere. Gmail settings are at `/app/settings/gmail`.

Install backend dependencies, generate the client, and apply migrations to the **intended development database** before starting the updated API/worker. Keep existing environment files. Do not copy example values over configured secrets.

```bash
# backend/ — use your existing development configuration
npm ci
npm run db:status
npm run db:migrate
npm run db:generate
npm run build
```

`db:migrate` uses `DATABASE_URL_UNPOOLED`. Review the target first. The additive migrations are `20261023090000_gmail_integration` and `20261023100000_gmail_cleanup_constraints`. Neither was applied to a production or connected Neon database during this work.

Run `npm run dev` and `npm run dev:worker` separately in backend; run `npm run dev` in frontend. Leave `GMAIL_ENABLED=false` and `GMAIL_SYNC_ENABLED=false` until the steps below are ready.

## 1. Google Cloud project and OAuth client

Use separate test and production projects. Enable Gmail API, Cloud Pub/Sub API, and Cloud KMS API. Use a billing-enabled project where those services require it. Assign an operational owner.

In Google Auth Platform, configure branding, audience, support contact, developer contacts, verified owned domains, public homepage, and privacy policy. For a development External application, add only consenting test users. Create an **OAuth web application** client. Register the exact callback:

```text
https://YOUR_API_HOST/api/integrations/gmail/callback
```

For local OAuth, register `http://localhost:5000/api/integrations/gmail/callback` and use `localhost` consistently for the API and browser development site. The backend OAuth cookie is HTTP-only, SameSite=Lax, and Secure for HTTPS callbacks. Set existing `FRONTEND_URL` to the actual frontend origin so the callback returns to `/gmail/callback`. Allow the frontend origin in existing backend CORS settings. The callback consumes a one-use browser-bound state and checks the original live CRM session and membership.

Request exactly:

```text
openid
email
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.readonly
```

`gmail.send` is sensitive; `gmail.readonly` is restricted. Before public launch, complete the applicable Google verification and server-side restricted-data security assessment/CASA process. Do not treat development test-user access as public launch approval. External Testing refresh credentials with Gmail scopes normally expire after seven days. Workspace administrator policies can also block access. See [scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes), [restricted verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), and [testing token expiry](https://developers.google.com/identity/protocols/oauth2#expiration).

## 2. KMS and runtime identity

Create a symmetric **ENCRYPT_DECRYPT** Cloud KMS key in the intended region. Configure the CryptoKey resource, without a version suffix:

```text
projects/YOUR_PROJECT/locations/YOUR_LOCATION/keyRings/YOUR_RING/cryptoKeys/YOUR_KEY
```

Give the API and worker runtime identities `roles/cloudkms.cryptoKeyEncrypterDecrypter` on that key only. The application uses Google Application Default Credentials (ADC). Prefer a runtime service account or workload identity federation. For local development, use a dedicated development identity with ADC (`gcloud auth application-default login`); it still needs key IAM access. Do not put credentials in frontend variables, source control, chat, or job payloads. See [KMS key setup](https://docs.cloud.google.com/kms/docs/create-encryption-keys) and [ADC](https://docs.cloud.google.com/docs/authentication/application-default-credentials).

Each mailbox has its own random AES-256-GCM data key, wrapped by KMS. Credentials and message content use tenant/account/purpose-bound authenticated encryption. Old KMS versions must remain decryptable while retained content uses them. Normal primary-version rotation works; disabling/destroying an old version makes its content unavailable. A different CryptoKey requires a separate controlled rewrap migration; the stored key resource remains authoritative for old data. Both API and worker need decrypt access, including when Gmail rollout switches are disabled and history is still readable.

## 3. Pub/Sub push

Create a topic in the **same project as the Gmail OAuth client**. Grant **Pub/Sub Publisher** on this topic to:

```text
gmail-api-push@system.gserviceaccount.com
```

Create a dedicated push-authentication service account. Create a subscription with the normal wrapped Pub/Sub message envelope and an HTTPS push endpoint:

```text
https://YOUR_API_HOST/api/webhooks/gmail
```

Enable authenticated push using that service account. Set an explicit audience equal to the endpoint URL, then use the same audience in backend settings. The subscription creator needs `iam.serviceAccounts.actAs` on the push identity. The Pub/Sub service agent needs `roles/iam.serviceAccountTokenCreator` as required by Google's authenticated-push instructions. The handler verifies Google's signed ID token, audience, verified-email claim and the exact configured service identity. Do not disable authentication or configure payload unwrapping. See [Gmail push setup](https://developers.google.com/workspace/gmail/api/guides/push) and [authenticated Pub/Sub push](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).

The worker renews mailbox watches daily. Google requires renewal at least every seven days. Push only marks durable work due and enqueues IDs; polling recovers dropped notifications or queue outages. An empty topic enables polling without watches; start with this mode if no public development webhook is available. Push is not required to test sending or polling.

## 4. Backend configuration

Inject the following into **both API and worker** using the secret/environment manager. Example names and nonsecret defaults are in backend `.env.example`.

| Variable | Value |
|---|---|
| `GMAIL_ENABLED` | `true` only when OAuth and KMS are ready |
| `GMAIL_SYNC_ENABLED` | `true` for inbound polling, delivery-report checks, and watch renewal |
| `GOOGLE_CLIENT_ID` | OAuth web-client ID; optional dedicated `GOOGLE_GMAIL_CLIENT_ID` override |
| `GOOGLE_CLIENT_SECRET` | OAuth web-client secret; backend only; optional dedicated `GOOGLE_GMAIL_CLIENT_SECRET` override |
| `GOOGLE_GMAIL_REDIRECT_URI` | Exact registered callback URI |
| `GMAIL_KMS_KEY_NAME` | CryptoKey resource from step 2 |
| `GMAIL_PUBSUB_TOPIC` | `projects/YOUR_PROJECT/topics/YOUR_TOPIC`, or empty for polling only |
| `GMAIL_PUBSUB_AUDIENCE` | Exact authenticated push audience |
| `GMAIL_PUBSUB_SERVICE_ACCOUNT` | Exact push service-account email |
| `GMAIL_POLL_SECONDS` | `300` default; minimum `60` |
| `GMAIL_MESSAGE_RETENTION_DAYS` | `365` default; maximum `365`; use a shorter approved value if needed |

Use existing `DATABASE_URL` for the application, `DATABASE_URL_UNPOOLED` for migrations/pg-boss, and existing `DATA_ENCRYPTION_KEY` for short-lived encrypted OAuth PKCE state. Keep existing file storage configuration for outbound CRM attachments. There are no Gmail frontend secrets. The initial lookback is user-selected 0 or 30 days, capped at 500 matched messages; it is not an environment option.

## 5. Pilot and release order

1. Review the public Gmail privacy section and actual infrastructure/backup commitments. Complete applicable Google requirements before broad release.
2. Back up the intended database and apply both additive migrations with Gmail flags off. Generate Prisma client, build, deploy compatible API and worker, then frontend.
3. Start the worker and verify existing health/heartbeat checks. Gmail queues are `gmail.send`, `gmail.sync`, and `gmail.maintain`; maintenance runs once per minute. Gmail job payloads contain identifiers only.
4. Enable the switches for an environment limited to consenting test users. Growth, Business and Enterprise workspaces are eligible; Starter is gated. Select a dedicated work mailbox. One active Google identity is allowed globally, and one active mailbox per employee/workspace.
5. Connect from lead Email or Gmail settings, review sharing/exclusions, and explicitly send to a test lead address controlled by the team. Verify Gmail Sent, a real recipient reply, threaded rendering, template/signature, and a small existing CRM attachment.
6. Verify token revocation/reconnect, disconnect, history deletion, viewer access, hidden records, unknown-send reconciliation, polling without push, and watch renewal. Use only dedicated test accounts; no customer email is needed.
7. Inspect sanitized ID/status logs, worker lag, last successful sync, coverage-gap state and quota usage. Tune bounded worker concurrency and poll interval against actual project quotas. No latency SLA or cloud cost has been measured locally.

## Operations and rollback

- **Reconnect required:** ask the employee to reconnect through CRM. An omitted refresh token on reconnect preserves a still-valid stored token; a first connection requires one. A draft is held only in the open page, not browser storage.
- **Unknown send:** inspect Gmail Sent and allow reconciliation by the exact generated Message-ID. Never reset `unknown` to `queued`. If no evidence resolves it, the employee must consciously start a new draft after checking Gmail.
- **Confirmed permanent Google DSN:** the message becomes bounced and the recipient is suppressed. Detection intentionally requires a known original ID, structured recipient/status fields and a matching Google authentication result. It cannot detect every provider/alias/bounce form. Transient or uncertain reports do not suppress. A suppression review/removal UI is deferred; an operator must review the exact tenant/address row before an approved database correction.
- **Employee departure/seat removal:** credentials and queued sends are disabled in the same database transaction. Existing record history remains subject to access/retention. Workers recheck current membership, role, plan and record scope.
- **Delete history:** own user or administrator requests deletion, which disconnects first. The worker removes content and provider timeline entries in bounded batches, then erases the account data key after completion. Minimal IDs/fingerprints remain to prevent re-import. Large histories can need multiple runs; monitor completion. Backup restore must preserve/reapply deletion records before mail processing resumes.
- **Rollback:** set both flags false, stop new sends/sync, deploy compatible code, keep additive tables and decryption access. Privacy cleanup still runs. Disconnect/revoke mailboxes if access must be revoked. Do not resend accepted or unknown messages. Keep a worker version that enforces expiry/deletion; old pre-Gmail code cannot perform Gmail cleanup. Destructive schema removal is a separate operator decision; [rollback.sql](rollback.sql) is a review-only empty-data rollback script and was not run.

Before public release, finish the [manual QA/deployment checklist](qa-deployment.md), verify Google infrastructure with real test accounts, document backup expiry, establish alerting and the annual assessment owner. These are remaining launch tasks, not completed local tests.
