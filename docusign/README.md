# DocuSign <-> FXBO Integration (Phase A-B)

This module sends documents for signature when an approved application event arrives from FXBO.

## Endpoints

- `GET /api/docusign/health`
- `POST /api/docusign/webhooks/fxbo/application-approved`
- `POST /api/docusign/webhooks/connect`
- `GET /api/docusign/overview` (auth: Back Office)
- `GET /api/docusign/applications/:applicationId` (auth: Back Office)
- `GET /api/docusign/envelopes/:envelopeId` (auth: Back Office)

## Required environment variables

```env
DOCUSIGN_INTEGRATION_KEY=
DOCUSIGN_USER_ID=
DOCUSIGN_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
DOCUSIGN_TEMPLATE_ID=

# Optional (recommended)
DOCUSIGN_TEMPLATE_ROLE=Signer
DOCUSIGN_EMAIL_SUBJECT=Please sign your application document
DOCUSIGN_AUTH_BASE=account-d.docusign.com
DOCUSIGN_ACCOUNT_ID=
DOCUSIGN_BASE_URI=

# Optional security
DOCUSIGN_FXBO_WEBHOOK_BEARER=
DOCUSIGN_CONNECT_HMAC_SECRET=

# OAuth token endpoint for FXBO Assistant Rules webhook auth
AUTH_CLIENT_ID=
AUTH_CLIENT_SECRET=
AUTH_JWT_SECRET=
AUTH_TOKEN_AUDIENCE=fxbo-assistant-webhooks
AUTH_TOKEN_EXPIRES_IN_SECONDS=3600
# Optional override if your public app URL differs from the request host
# AUTH_TOKEN_ISSUER=https://app.skylinkscapital.com/oauth/token

# Optional automatic sync of approved CRM docusign applications
DOCUSIGN_AUTO_SYNC_ENABLED=false
DOCUSIGN_AUTO_SYNC_INTERVAL_SECONDS=300
DOCUSIGN_AUTO_SYNC_RUN_ON_START=true
DOCUSIGN_SYNC_LOOKBACK_MINUTES=6
```

## FXBO Assistant Rules OAuth fields

When your backend is publicly reachable, configure FXBO Webhook Auth (OAuth 2.0) as follows:

- `Access token url`: `https://<your-public-host>/oauth/token`
- `Grant type`: `client_credentials`
- `Client id`: `AUTH_CLIENT_ID`
- `Client Secret`: `AUTH_CLIENT_SECRET`
- `Audience`: `AUTH_TOKEN_AUDIENCE` (default: `fxbo-assistant-webhooks`)
- `Content type`: `application/x-www-form-urlencoded`
- `Response token field key`: `access_token`
- `Response token type field key`: `token_type`
- `Response token expires in field key`: `expires_in`

## FXBO webhook payload contract

Send this JSON to `POST /api/docusign/webhooks/fxbo/application-approved` when an application is approved:

```json
{
  "applicationId": "12345",
  "email": "client@example.com",
  "name": "Client Name",
  "templateId": "optional-template-id",
  "roleName": "optional-template-role-name",
  "docType": "approve-form"
}
```

- `templateId` can be omitted to use `DOCUSIGN_TEMPLATE_ID`.
- `roleName` can be omitted to use `DOCUSIGN_TEMPLATE_ROLE`.
- Idempotent behavior: if `applicationId` already has an envelope, the endpoint returns existing data.

If your FXBO event gives you a CRM user id but not email/name, you can send this instead:

```json
{
  "applicationId": "12345",
  "userId": 9876,
  "docType": "approve-form"
}
```

The integration will call FXBO `/rest/users` using the existing CRM API token and use `firstName`, `lastName`, and `email` for the DocuSign signer.

If your FXBO event gives you only an application id, you can send this:

```json
{
  "applicationId": "12345",
  "docType": "approve-form"
}
```

The integration will try common FXBO application endpoints first to resolve applicant data from the application itself, then fall back to `/rest/users` if a `userId` can be derived.

## What this phase does

1. Receives approved application webhook from FXBO.
2. Creates and sends a DocuSign envelope from template.
3. Stores mapping in MySQL (`docusign_envelope_map` in `AUTH_DB_NAME`).
4. Accepts DocuSign Connect status updates and tracks envelope status.

## Who receives a document

The **FXBO Assistant rule** is the single source of truth for who gets a document.
On an approved application it POSTs the FXBO webhook, which sends the DocuSign
envelope. There is no backend poller that independently selects applications —
the previous send poller (`sync.js`, `type: "docusign"` sweep) was removed so the
CRM rule owns the decision.

Each inbound webhook call is recorded in `docusign_webhook_log`
(`outcome` = `sent` | `skipped` | `rejected`, with a reason code, bounded to the
newest 500 rows). `GET /api/docusign/overview` exposes a `webhook` health summary
(`lastReceivedAt`, `ageHours`, `stale`, `rejected7d`) which the Back Office panel
renders as a "last received / stale" line — so a rule that stops firing is visible
rather than silent.

Duplicate protection: before sending, the handler skips when the same signer email
already has an outstanding (`created`/`sent`/`delivered`) envelope, so a rule that
fires twice — or fires alongside a manual backfill — cannot double-send.

## Completion + CRM upload

The reconcile poller (`reconcile.js`, every `DOCUSIGN_RECONCILE_INTERVAL_SECONDS`)
pulls DocuSign status changes and, on completion, downloads the signed PDF and
uploads it to the client's FXBO record (config `DOCUSIGN_CRM_DOC_CONFIG_ID`). This
is separate from "who receives a document" and is the only completion detector,
because the account has no DocuSign Connect configuration.

## Next phase (C-D)

- Download signed documents when status becomes `completed`.
- Push files to your CRM endpoint (`/rest/applications/{id}/approve-form` or your final upload endpoint).
- Add retry queue and dead-letter handling for failed uploads.
