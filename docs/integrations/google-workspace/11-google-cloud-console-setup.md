# Google Cloud Console setup for Calendar, Meet and Sheets

Updated 25 October 2026. The code is implemented with all new flags off by default. No Cloud project, OAuth credential, real Google account operation or production migration was performed during implementation. These are the remaining operator steps. Calendar meetings, Google Meet links and app-created Google Sheets editing/lead exports are now implemented. See [current feature scope](14-calendar-meet-sheets.md). Drive attachment browsing remains pending.

## 1. Use your existing account and project

Open [Google Cloud Console](https://console.cloud.google.com/) with your existing Google account and select the project you already use for TechSync Gmail/sign-in. **No new account or project is required.** Record its **project ID and numeric project number** from project settings.

The OAuth client ID must start with the numeric `GOOGLE_WORKSPACE_PROJECT_NUMBER` followed by `-`. The server accepts the same project and detects sharing from the configured Gmail/sign-in client prefixes. Inventory aliases and credentials outside this deployment too: the application cannot discover other clients in Console. Google revocation affects the entire user's grant for a project, across its clients. In shared-project mode, Gmail and Workspace disconnects erase local credentials without calling Google's project-wide revoke endpoint. Full removal is performed by the user at [Google Account connections](https://myaccount.google.com/connections); Gmail and sign-in permissions may then need reconnecting. [Google web-server OAuth and revocation](https://developers.google.com/identity/protocols/oauth2/web-server).

Keep an inventory of environment, project number, client ID, callback, key version/resource, support contact and person responsible. Record credential locations, never secret values, in that inventory. A separate project remains an optional isolation choice for later; the application's shared-project mode supports your current setup.

## 2. Enable the APIs

In **APIs & Services → Library**, enable **Google Calendar API**, **Google Drive API** and **Google Sheets API** for the implemented features. You have already enabled Google Meet API; scheduled Meet links here are created by Google Calendar API, so Calendar API must also be enabled. No additional Meet scope is needed. OAuth itself does not prove those content methods work; they require a real-account pilot after deployment. Google Picker API and a browser-restricted API key are deferred until the Drive Picker phase. No service-account impersonation or domain-wide delegation is needed for per-user connections.

## 3. Configure Google Auth Platform

In **Google Auth Platform → Branding**, use the actual TechSync app name, support email and developer contact. Configure your owned application homepage, privacy policy and terms URLs, plus authorized domains. For production verification, the pages must accurately describe offline credentials, optional service permissions, disconnect/revocation, retention and external copies. Complete domain ownership verification as requested by Google. Do not advertise unshipped content features as active. [Google consent setup](https://developers.google.com/workspace/guides/configure-oauth-consent).

In **Audience**, choose **External** for a CRM serving customers outside your own Workspace organization. Start in **Testing**, adding the exact Google accounts of your authorized pilot testers. Internal is appropriate only for an app confined to the owning Workspace organization. Testing refresh credentials can have short lifetimes; treat pilot reconnection as an expected case, not a background service guarantee. [Google OAuth lifecycle](https://developers.google.com/identity/protocols/oauth2).

## 4. Add only the implemented scopes

In **Data Access → Add or remove scopes**, add the scope set below for features you intend to pilot. Preserve existing Gmail/sign-in scopes used by those features. The Workspace authorization request asks only for identity and the chosen Workspace service; incremental authorization can include supported Gmail scopes already granted in this shared project. Their presence does not enable Gmail reading/sending through the Workspace profile or silently enable another Workspace service.

| Purpose | Scope |
|---|---|
| Verified account identity | `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile` (the app uses `email`/`profile` aliases) |
| Dedicated app-created calendars | `https://www.googleapis.com/auth/calendar.app.created` |
| Drive and Sheets selected/app-created files | `https://www.googleapis.com/auth/drive.file` |

`drive.file` is classified non-sensitive in the official [Drive scope guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) and [Sheets scope guide](https://developers.google.com/workspace/sheets/api/scopes). It does not authorize the whole Drive or every spreadsheet. Sheets and Drive share this Google permission but have separate TechSync service preferences.

The official [Calendar scope guide](https://developers.google.com/workspace/calendar/api/auth) describes `calendar.app.created` without a complete per-scope sensitivity table. **Record its category as displayed in your project's Data Access page**, with dated evidence. Treat public Calendar rollout as needing sensitive-scope review until confirmed. Do not add broad Calendar, full Drive or full spreadsheets permissions for the Workspace features. Existing Gmail permissions retain their own consent and verification requirements. Record any verification requirement shown by Google; public launch remains pending until those requirements are met.

## 5. Reuse the existing web OAuth client

Go to **Google Auth Platform → Clients** and open the **Web application** client already used for Gmail/sign-in. Add this exact backend callback under **Authorized redirect URIs**, keeping every existing callback. You may create another Web application client inside this same project if you prefer, but it is optional and shares the same revocation boundary:

```text
Your local backend (8900):   http://localhost:8900/api/google/oauth/callback
Production example:         https://api.YOUR-DOMAIN/api/google/oauth/callback
```

Replace the example with the real deployed API origin. Match scheme, host, port and path exactly; no wildcard, query, fragment or trailing slash. A same-origin frontend API proxy can be the callback origin if it forwards `/api/google/oauth/callback` and cookies to the API. Use the same hostname consistently in local development (`localhost` and `127.0.0.1` are different cookie hosts).

This server OAuth flow does not require additional Authorized JavaScript origins; preserve the origins used by existing sign-in flows. No client secret is sent to the browser. A later Picker/browser integration has its own origin/key setup. Copy the existing web-client ID and secret into the Workspace backend settings; this implementation requires explicit `GOOGLE_WORKSPACE_*` values even when they match the Gmail/sign-in values. [Google credential setup](https://developers.google.com/workspace/guides/create-credentials), [web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

## 6. Configure the API and worker

The backend `.env.example` lists every new setting. Set these on **both API and worker**, initially keeping all rollout flags false:

```dotenv
GOOGLE_WORKSPACE_ENABLED=false
GOOGLE_WORKSPACE_CALENDAR_ENABLED=false
GOOGLE_WORKSPACE_DRIVE_ENABLED=false
GOOGLE_WORKSPACE_SHEETS_ENABLED=false
GOOGLE_WORKSPACE_CLIENT_ID=<web-client-id>
GOOGLE_WORKSPACE_CLIENT_SECRET=<resolved-client-secret>
GOOGLE_WORKSPACE_PROJECT_NUMBER=<numeric-project-number>
GOOGLE_WORKSPACE_REDIRECT_URI=<exact-registered-callback>
GOOGLE_WORKSPACE_TOKEN_KEY_VERSION=1
```

Choose **one** credential wrapping mechanism:

- KMS: set `GOOGLE_WORKSPACE_KMS_KEY_NAME=projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/KEY`. Enable Cloud KMS and give the API/worker workload identity encrypt/decrypt permission on that symmetric key. Use Application Default Credentials; no end-user Workspace scope is needed for KMS. Provisioning/cost approval remains an operator task.
- Versioned local wrapping key: generate a separate random 32-byte base64 key and store it as `GOOGLE_WORKSPACE_TOKEN_ENCRYPTION_KEY` in the secret manager. Do not reuse the QA fixture key. `GOOGLE_WORKSPACE_TOKEN_ENCRYPTION_KEYS` is a JSON version-to-key map for retaining older versions. The active version comes from `GOOGLE_WORKSPACE_TOKEN_KEY_VERSION`.

Never use `VITE_*` for these values or commit secrets. Keep old wrapping keys/KMS versions decryptable while any connection or 30-day revocation-outbox row still needs them. Changing the active wrapping version affects newly wrapped credentials; existing rows retain their version until reconnected/rewrapped. KMS setup must be tested with real runtime identities; syntactically valid configuration alone does not confirm IAM access.

Deploy the additive migrations `20261025150000_google_workspace_foundation` and `20261025180000_google_calendar_sheets` through your normal migration process, generate the Prisma client, then deploy/restart API and worker. The `google.maintain` worker job runs every minute and performs cleanup even with rollout disabled. Calendar/Sheets operations need the worker and `google.content.maintain` recovery as well. This implementation was migrated only on disposable local databases.

## 7. Enable a controlled feature pilot

1. With the Console and runtime values complete, turn `GOOGLE_WORKSPACE_ENABLED=true` and only the service flags selected for your pilot. Restart both processes. Leave other flags off.
2. In TechSync **Settings → Team & Google**, enable **Allow Calendar & Meet** and **Allow Google Sheets**. Enable **Allow lead exports to Google Sheets** when lead copying is intended. New workspaces start with every preference off.
3. Sign into TechSync as an authorized test user. Open **Settings → Google connections**, review a service's permission notice, check its acknowledgement and continue to Google. The Google account may differ from the CRM login account.
4. Confirm the returned account and chosen service preference. Verify cancellation and denied permission leave existing connections unchanged; connecting alone should create no content. Review/enable older Calendar and Sheets preferences again for the current consent version. Open the sidebar **Calendar & Meet**, set up the TechSync calendar, and schedule a guest-free Meet call. Open **Google Sheets** to create/edit a notes spreadsheet. From a lead, schedule a meeting or export selected lead fields.
5. Test access checks, local service-off, workspace disconnect and reconnect using designated test accounts only. In shared-project mode the UI shows **Manage Google Account access** instead of in-app project revocation. Confirm ordinary disconnect does not interrupt Gmail/sign-in. Test full removal separately at Google Account connections, expecting other service grants in the project to be invalidated and re-consent needed. Separate-project mode retains the in-app project-removal action with recent login and typed confirmation.

## 8. Before public launch

Complete the verification required by Data Access, accurate public branding/policy pages, authorized-domain evidence, reviewer demo and a real-account OAuth/refresh/KMS/departure/revocation smoke test. Confirm your Workspace administrator permits the OAuth client. Keep a kill-switch/worker/key inventory and observe reconnect/cleanup failures during the pilot. Broad or restricted scopes require a new design and review; they are outside this implementation.

## Troubleshooting

| Symptom | Check |
|---|---|
| Awaiting administrator setup | Global flags, all client/project/callback values, valid encryption key or KMS resource; `GET /api/google/connections/me` returns safe `setup.missing` categories |
| Service awaiting enablement | Service's server flag and tenant preference both enabled |
| `redirect_uri_mismatch` | Exact callback on the selected OAuth client's Console page and in the runtime variable |
| Access denied/test user blocked | Audience/testing list, correct Google account and Workspace admin app-access policy |
| Unexpected scopes | Project inventory; unsupported previously granted scopes/client. Supported existing Gmail send/read/modify grants are recognized only in shared-project mode; broad Drive/full-mail scopes remain rejected |
| Removal still completing | In isolated-project mode, check worker/retries/key access. In shared-project mode, pending Workspace snapshots are erased locally instead of revoked; use Google Account connections for full project removal |
| Reconnect required | Expired/revoked token, changed OAuth client, denied offline access, test-mode lifetime; reconnect intentionally |

Pending Console work is not evidence of a code failure, and passing mocked-provider tests is not evidence that these external settings are complete.
