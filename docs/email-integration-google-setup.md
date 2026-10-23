# Google setup for employee email connections

Checked against the official Google documentation on **23 October 2026**. This foundation
requests identity and Gmail sending permission. The existing reply-sync implementation is
retained for previously authorized mailboxes; new connections cannot enable it.

## 1. Project and Gmail API

Open Google Cloud Console, select the intended organization, and create a project for TechSync.
Use separate projects/clients for development and production where possible. In **APIs &
Services → Library**, find **Gmail API** and click **Enable**. Google documents this project/API
setup in its [Gmail quickstart](https://developers.google.com/workspace/gmail/api/quickstart/js).
Use its console setup steps; this application uses a backend OAuth web client, rather than
the quickstart's browser-only authentication example.

## 2. Consent screen

Open **Google Auth platform → Branding**. Click **Get started** if prompted, then enter
the app name, support address and developer contact address. Choose **External** in
**Audience**, since TechSync serves multiple customers. Add the app logo, public homepage,
privacy-policy and terms URLs in Branding; add your authorized domains and verify ownership.
Use matching TechSync branding throughout. These are described in Google's
[consent configuration guide](https://developers.google.com/workspace/guides/configure-oauth-consent).

The homepage must be publicly accessible, describe the app and why it needs Google data,
and link to the same privacy policy registered in Branding. See Google's
[homepage requirements](https://support.google.com/cloud/answer/13807376?hl=en).

## 3. OAuth web client

In **Google Auth platform → Clients → Create client**, choose **Web application**. Name the
client for its environment and add the exact backend **Authorized redirect URI**:

| Environment | Example backend redirect URI |
| --- | --- |
| Local | `http://localhost:5000/api/email/connect/google/callback` |
| Staging | `https://api.staging.example.com/api/email/connect/google/callback` |
| Production | `https://api.example.com/api/email/connect/google/callback` |

Replace the example hosts with your actual API hosts. Frontend URLs belong in `APP_BASE_URL`,
not the redirect field. Origins, ports, paths and trailing slashes must match exactly. The
legacy `/api/integrations/gmail/callback` remains supported. Keep existing Google sign-in
redirect URIs registered if sharing its client; these are separate from Gmail connection.
See Google's [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).

Copy the client ID and secret into backend secret configuration. Never put them in `VITE_*`
variables. No JavaScript origin is needed for this backend redirect flow.

## 4. Scopes, test users and publishing

In **Data Access → Add or remove scopes**, add exactly:

```text
openid
email
profile
https://www.googleapis.com/auth/gmail.send
```

Do not add Gmail read/modify/metadata scopes for this phase. `gmail.send` is a **sensitive**
scope; prepare sensitive-scope verification before opening production access beyond the
testing/exception limits. See Google's [Gmail scope classification](https://developers.google.com/workspace/gmail/api/auth/scopes).

In **Audience**, keep development in **Testing**, add the intended Google accounts as test
users and save. Testing supports up to **100 test users**. Because this application requests
Gmail access, test-user authorizations and offline refresh tokens expire after **seven days**;
reconnect when needed. See Google's [audience and testing rules](https://support.google.com/cloud/answer/15549945?hl=en).

## 5. Environment configuration

Apply the migration before starting the updated API/worker. Keep the feature off until secrets
and redirect URIs are ready. API and worker must use the same keys and OAuth configuration.

```dotenv
EMAIL_FEATURE_ENABLED=false
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:5000/api/email/connect/google/callback
APP_BASE_URL=http://localhost:5173
EMAIL_TOKEN_ENCRYPTION_KEY=
EMAIL_TOKEN_KEY_VERSION=1
# Optional JSON map of previous versions during rotation:
EMAIL_TOKEN_ENCRYPTION_KEYS={}
GMAIL_SYNC_ENABLED=false
```

Generate the 32-byte base64 encryption key locally and store the result in your secret manager:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

The repository already supports Google Cloud KMS. **Keep `GMAIL_KMS_KEY_NAME` configured if
it is already in use**; KMS takes precedence and the local email encryption key is then
unnecessary. Existing account keys are still read using their stored version. KMS workloads
need encrypt/decrypt access on that key. Do not disable or delete old KMS versions while
records or pending revocations still reference them.

Dedicated `GOOGLE_GMAIL_CLIENT_ID` and `GOOGLE_GMAIL_CLIENT_SECRET` override the generic pair
only when configured together. `GOOGLE_OAUTH_REDIRECT_URI` takes precedence over the legacy
Gmail redirect variable. `APP_BASE_URL` overrides the existing `FRONTEND_URL`. The existing
`DATA_ENCRYPTION_KEY` remains required for short-lived encrypted PKCE state and other CRM
security features.

Set `EMAIL_FEATURE_ENABLED=true` only after configuration is complete. It overrides the
legacy `GMAIL_ENABLED` switch and validates configuration at startup. Keep
`GMAIL_SYNC_ENABLED=false` for a foundation-only rollout. Existing plan/role permissions remain
in force: connecting is available to non-viewer staff on Growth and above; owner/admin manage
the team. Each tenant can independently turn off connections in Team & Email.

For local development, open the frontend through Vite's `/api` proxy so the OAuth binding
cookie and callback share a host. Use `localhost` consistently. Staging/production should
use a same-site frontend/API deployment or an API reverse proxy so browsers send the binding
cookie on Google’s callback. No refresh cookie path changes are required.

## 6. Verification package

Prepare a public homepage, privacy-policy URL, terms URL, verified domain ownership, accurate
support/contact addresses and a demo video showing CRM sign-in, Gmail connection, the consent
screen and the intended send action. Explain why the narrow sending scope is required and how
users disconnect. Declare only functionality actually available in the release submitted to
Google: **this foundation alone does not add a sending UI**. Complete the later sending phase
before demonstrating that feature. See Google's
[sensitive-scope verification checklist](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

Suggested justification to adapt to the finished sending release:

> Employees connect their own work Gmail account so they can send a message to a CRM lead
> after explicitly choosing to send it. TechSync needs gmail.send for that action. Identity
> scopes show which mailbox was selected. This authorization does not request inbox access.
> Refresh credentials are encrypted and access can be disconnected by the employee or the
> customer's administrator.

Google can return an existing broader grant when incremental authorization is enabled.
TechSync records actual granted scopes but does not treat an inherited read scope as consent
to start sync for a new connection. An existing connection with the earlier team-history
consent can retain its previously authorized behavior.

## Connection troubleshooting

- **Access denied:** return to Email settings and retry when ready.
- **Sending unchecked:** enable sending on Google's consent screen.
- **No refresh token:** retry the consent flow; if necessary, remove TechSync under Google
  Account → Security → third-party connections, then reconnect.
- **Needs reconnect:** Google rejected the refresh grant. Reconnect once; the CRM does not
  repeatedly retry invalid credentials.
- **Disconnect still completing:** the durable revocation queue is retrying Google. Run the
  CRM worker, check its connectivity/configuration, then reconnect after that job completes.
- **Same mailbox in multiple tenants:** connection is allowed without exposing other
  customers. Google revocation can invalidate grants for the same Google user/client in other
  contexts; another affected connection will ask its owner to reconnect. This is a provider
  grant limitation, not permission to share CRM data between tenants.
