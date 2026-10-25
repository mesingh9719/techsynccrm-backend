# Google Cloud Console setup for the Workspace foundation

Updated 25 October 2026. The code is implemented with all new flags off by default. No Cloud project, OAuth credential, real Google account operation or production migration was performed during implementation. These are the remaining operator steps. Calendar events, Drive attachments and Google Sheets exports are later phases; this setup enables connection preparation and access checks only.

## 1. Create a dedicated project

Open [Google Cloud Console](https://console.cloud.google.com/) and create a project such as `TechSync Workspace`. Record its **project ID and numeric project number** from project settings. Use a different project from every existing Gmail and Google sign-in client. Check existing deployed client IDs and their project inventory before choosing it.

The new client ID must start with the numeric `GOOGLE_WORKSPACE_PROJECT_NUMBER` followed by `-`. The server rejects a Workspace project matching a configured Gmail/sign-in project prefix. Inventory aliases and credentials outside this deployment too: the application cannot discover other clients in Google Console. Google revocation affects the entire user's grant for a project, across its clients. [Google web-server OAuth and revocation](https://developers.google.com/identity/protocols/oauth2/web-server).

Use separate development and production projects. Keep an inventory of environment, project number, client ID, callback, key version/resource, support contact and person responsible. Record credential locations, never secret values, in that inventory.

## 2. Enable the APIs

In **APIs & Services → Library**, enable **Google Calendar API**, **Google Drive API** and **Google Sheets API** for the planned features. OAuth itself does not prove those content methods work; they require later real-account tests. Google Picker API and a browser-restricted API key are deferred until the Drive Picker phase. No service-account impersonation or domain-wide delegation is needed for per-user connections.

## 3. Configure Google Auth Platform

In **Google Auth Platform → Branding**, use the actual TechSync app name, support email and developer contact. Configure your owned application homepage, privacy policy and terms URLs, plus authorized domains. For production verification, the pages must accurately describe offline credentials, optional service permissions, disconnect/revocation, retention and external copies. Complete domain ownership verification as requested by Google. Do not advertise unshipped content features as active. [Google consent setup](https://developers.google.com/workspace/guides/configure-oauth-consent).

In **Audience**, choose **External** for a CRM serving customers outside your own Workspace organization. Start in **Testing**, adding the exact Google accounts of your authorized pilot testers. Internal is appropriate only for an app confined to the owning Workspace organization. Testing refresh credentials can have short lifetimes; treat pilot reconnection as an expected case, not a background service guarantee. [Google OAuth lifecycle](https://developers.google.com/identity/protocols/oauth2).

## 4. Add only the implemented scopes

In **Data Access → Add or remove scopes**, configure the scope set below for features you intend to pilot. The application asks for a service only after that member reviews its permission notice.

| Purpose | Scope |
|---|---|
| Verified account identity | `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile` (the app uses `email`/`profile` aliases) |
| Dedicated app-created calendars | `https://www.googleapis.com/auth/calendar.app.created` |
| Drive and Sheets selected/app-created files | `https://www.googleapis.com/auth/drive.file` |

`drive.file` is classified non-sensitive in the official [Drive scope guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) and [Sheets scope guide](https://developers.google.com/workspace/sheets/api/scopes). It does not authorize the whole Drive or every spreadsheet. Sheets and Drive share this Google permission but have separate TechSync service preferences.

The official [Calendar scope guide](https://developers.google.com/workspace/calendar/api/auth) describes `calendar.app.created` without a complete per-scope sensitivity table. **Record its category as displayed in your project's Data Access page**, with dated evidence. Treat public Calendar rollout as needing sensitive-scope review until confirmed. No broad Calendar, full Drive, full spreadsheets or Gmail scopes belong in this new project. Record any verification requirement shown by Google; public launch remains pending until those requirements are met.

## 5. Create the web OAuth client

Go to **Google Auth Platform → Clients → Create client → Web application**. Name it for its environment. Under **Authorized redirect URIs**, register the exact backend callback:

```text
Local standard development: http://localhost:5000/api/google/oauth/callback
Production example:         https://api.YOUR-DOMAIN/api/google/oauth/callback
```

Replace the example with the real deployed API origin. Match scheme, host, port and path exactly; no wildcard, query, fragment or trailing slash. A same-origin frontend API proxy can be the callback origin if it forwards `/api/google/oauth/callback` and cookies to the API. Use the same hostname consistently in local development (`localhost` and `127.0.0.1` are different cookie hosts).

This server OAuth flow does not require Authorized JavaScript origins; no client secret is sent to the browser. A later Picker/browser integration has its own origin/key setup. Store the client ID and secret in the backend's secret manager. Preserve existing Gmail and sign-in callbacks. [Google credential setup](https://developers.google.com/workspace/guides/create-credentials), [web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

## 6. Configure the API and worker

The backend `.env.example` lists every new setting. Set these on **both API and worker**, initially keeping all rollout flags false:

```dotenv
GOOGLE_WORKSPACE_ENABLED=false
GOOGLE_WORKSPACE_CALENDAR_ENABLED=false
GOOGLE_WORKSPACE_DRIVE_ENABLED=false
GOOGLE_WORKSPACE_SHEETS_ENABLED=false
GOOGLE_WORKSPACE_CLIENT_ID=<web-client-id>
GOOGLE_WORKSPACE_CLIENT_SECRET=<secret-manager-reference-or-secret>
GOOGLE_WORKSPACE_PROJECT_NUMBER=<numeric-project-number>
GOOGLE_WORKSPACE_REDIRECT_URI=<exact-registered-callback>
GOOGLE_WORKSPACE_TOKEN_KEY_VERSION=1
```

Choose **one** credential wrapping mechanism:

- KMS: set `GOOGLE_WORKSPACE_KMS_KEY_NAME=projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/KEY`. Enable Cloud KMS and give the API/worker workload identity encrypt/decrypt permission on that symmetric key. Use Application Default Credentials; no end-user Workspace scope is needed for KMS. Provisioning/cost approval remains an operator task.
- Versioned local wrapping key: generate a separate random 32-byte base64 key and store it as `GOOGLE_WORKSPACE_TOKEN_ENCRYPTION_KEY` in the secret manager. Do not reuse the QA fixture key. `GOOGLE_WORKSPACE_TOKEN_ENCRYPTION_KEYS` is a JSON version-to-key map for retaining older versions. The active version comes from `GOOGLE_WORKSPACE_TOKEN_KEY_VERSION`.

Never use `VITE_*` for these values or commit secrets. Keep old wrapping keys/KMS versions decryptable while any connection or 30-day revocation-outbox row still needs them. Changing the active wrapping version affects newly wrapped credentials; existing rows retain their version until reconnected/rewrapped. KMS setup must be tested with real runtime identities; syntactically valid configuration alone does not confirm IAM access.

Deploy the additive migration `20261025150000_google_workspace_foundation` through your normal migration process, generate the Prisma client, then deploy/restart API and worker. The `google.maintain` worker job runs every minute and performs cleanup even with rollout disabled. This implementation was migrated only on disposable local databases.

## 7. Enable a controlled connection pilot

1. With the Console and runtime values complete, turn `GOOGLE_WORKSPACE_ENABLED=true` and only the service flags selected for your pilot. Restart both processes. Leave other flags off.
2. In TechSync **Settings → Team & Google**, enable the matching permission-setup preferences. New workspaces start with every preference off. The future-export preference does not enable a Google export feature in this release.
3. Sign into TechSync as an authorized test user. Open **Settings → Google connections**, review a service's permission notice, check its acknowledgement and continue to Google. The Google account may differ from the CRM login account.
4. Confirm the returned account and chosen service preference. Verify cancellation and denied permission leave existing connections unchanged; no Calendar event or Drive/Sheets content should be created in Phase 0.
5. Test access checks, reconnect after revocation, local service-off, workspace disconnect and the explicit project-removal action using designated test accounts only. Project removal requires a login less than 15 minutes old and typed account-email confirmation in the UI. Confirm worker cleanup and that Gmail/sign-in in their separate project still work.

## 8. Before public launch

Complete the verification required by Data Access, accurate public branding/policy pages, authorized-domain evidence, reviewer demo and a real-account OAuth/refresh/KMS/departure/revocation smoke test. Confirm your Workspace administrator permits the OAuth client. Keep a kill-switch/worker/key inventory and observe reconnect/cleanup failures during the pilot. Broad or restricted scopes require a new design and review; they are outside this implementation.

## Troubleshooting

| Symptom | Check |
|---|---|
| Awaiting administrator setup | Global flags, all client/project/callback values, valid encryption key or KMS resource; `GET /api/google/connections/me` returns safe `setup.missing` categories |
| Service awaiting enablement | Service's server flag and tenant preference both enabled |
| `redirect_uri_mismatch` | Exact callback on the selected OAuth client's Console page and in the runtime variable |
| Access denied/test user blocked | Audience/testing list, correct Google account and Workspace admin app-access policy |
| Unexpected scopes | Dedicated project inventory; previously granted broad scopes/client in that project. Do not bypass the allowlist |
| Removal still completing | Independent worker, revocation retries and retained wrapping-key/IAM access; the pending outbox blocks reconnect to that project grant |
| Reconnect required | Expired/revoked token, changed OAuth client, denied offline access, test-mode lifetime; reconnect intentionally |

Pending Console work is not evidence of a code failure, and passing mocked-provider tests is not evidence that these external settings are complete.
