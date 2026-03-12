# DocuSign <-> FXBO Integration (Phase A-B)

This module sends documents for signature when an approved application event arrives from FXBO.

## Endpoints

- `GET /api/docusign/health`
- `POST /api/docusign/webhooks/fxbo/application-approved`
- `POST /api/docusign/sync-approved-applications`
- `GET /api/docusign/sync-status`
- `POST /api/docusign/webhooks/connect`
- `GET /api/docusign/applications/:applicationId`
- `GET /api/docusign/envelopes/:envelopeId`

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

## Real CRM approved sync flow

Use this when you want the backend to fetch and process all CRM applications of type `docusign`:

```json
POST /api/docusign/sync-approved-applications
{}
```

Behavior:

- Calls `POST /rest/applications?version=...` with `{ "type": "docusign" }`
- Uses `createdAt.begin/end` by default (rolling window, default `DOCUSIGN_SYNC_LOOKBACK_MINUTES=6`)
- Processes only applications where `status` is `approved`
- Skips applications already present in `docusign_envelope_map`
- Uses `userId` to fetch signer `firstName`, `lastName`, and `email` from `/rest/users`
- Sends DocuSign envelope only for approved + unsent records

You can override the query body on manual trigger with any of these fields:

- `user`
- `createdAt` (`begin`/`end`)
- `processedAt` (`begin`/`end`)
- `checkedAt` (`begin`/`end`)
- `uploadedByClient`
- `orders`
- `segment`

If automatic sync is enabled, the same flow runs on an interval using the env settings above.

`GET /api/docusign/sync-status` returns:

- `schedulerEnabled`
- `intervalSeconds`
- `isRunning`
- `lastStartedAt`
- `lastCompletedAt`
- `lastTrigger`
- `lastSummary`
- `lastError`

## Next phase (C-D)

- Download signed documents when status becomes `completed`.
- Push files to your CRM endpoint (`/rest/applications/{id}/approve-form` or your final upload endpoint).
- Add retry queue and dead-letter handling for failed uploads.
