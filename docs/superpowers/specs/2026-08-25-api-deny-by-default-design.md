# Deny-by-default API authentication

**Date:** 2026-08-25
**Status:** approved, not yet implemented

## Problem

Seventeen `/api` routes on the production server have no authentication. Two were
verified live from an ordinary machine with no credentials:

```
GET https://app.skylinkscapital.com/api/closing-balance-report      -> 200
GET https://app.skylinkscapital.com/api/wallet/google-sheet-mapping -> 200
```

The first returns the company's full treasury position: every PSP balance, bank
and crypto receivables, and the net figure. The second returns the finance sheet
cell mapping.

Six of the seventeen accept **writes** (six of the ten `/api` write routes on the server):

| Route | Effect if abused |
| --- | --- |
| `PUT /api/wallet/google-sheet-mapping` | changes which sheet cells the treasury report reads, altering the figures in the weekly email |
| `POST /api/wallet/google-sheet-mapping/reset` | discards the mapping |
| `POST /api/lp-equity-snapshots` | injects fabricated equity history |
| `POST /api/lp-equity-live-snapshots` | injects fabricated live equity history |
| `POST /api/dealing-client-lots-snapshots` | injects fabricated lot history |
| `POST /api/mock/alerts/trigger` | injects fabricated alerts into the dashboard |

These were not exercised. Confirming a write against production is itself the
harm being described.

The routes were not deliberately left open. They accumulated: each was added
without the middleware, and nothing made their absence visible. The same drift
produced the `/rest` proxy hole fixed in `076d52a` and the mock SignalR hub fixed
in `e959225`.

## Approach

Guarding the seventeen individually fixes today and not tomorrow. The default
stays open, so route eighteen is unprotected again by exactly the mechanism that
produced the first seventeen.

Instead, invert the default. A single middleware rejects any request to `/api` or
`/rest` without a valid session, and a short explicit allow-list names the
endpoints that genuinely cannot carry one. A new route is protected the moment it
is written. The failure mode becomes "my endpoint returns 401", which is noticed
in development, rather than "my endpoint is public", which is not noticed at all.

Considered and rejected:

- **Per-route `authRequired`.** Explicit and individually reviewable, but leaves
  the default open. This is how the current seventeen accumulated.
- **IP allow-listing the whole host.** Strong for an internal tool, but the
  weekly reports are read on a phone from arbitrary networks, so it would break a
  documented workflow.

## Design

### The gate

`requireSession` mounts ahead of every `/api` and `/rest` route. It delegates to
the existing `authRequired` from `auth/router.js` — the JWT verification, the
user lookup, the `token_version` revocation check and the suspended-account check
are all correct and are not being reimplemented.

Its only new responsibility is deciding whether a request is exempt.

Matching is on method plus exact path, never on a prefix. A prefix rule such as
`/api/docusign` exempting a webhook would also exempt every sibling route added
under it later, reintroducing the drift this is meant to stop.

### The allow-list

Eight entries. Everything else requires a session.

| Method | Path | Why it cannot carry a session |
| --- | --- | --- |
| POST | `/api/auth/login` | issues the session |
| GET | `/health` | monitoring probe |
| GET | `/api/docusign/health` | monitoring probe |
| POST | `/api/docusign/webhooks/fxbo/application-approved` | external caller; carries `DOCUSIGN_FXBO_WEBHOOK_BEARER` |
| POST | `/api/docusign/webhooks/connect` | external caller; HMAC-signed via `DOCUSIGN_CONNECT_HMAC_SECRET` |
| POST | `/oauth/token` | OAuth token exchange |
| GET | `/report-charts/:token/:name` | fetched by mail clients, which have no session |
| — | static assets and the SPA fallback | not under `/api` or `/rest` |

The chart route stays public deliberately. It is already protected by an
unguessable 32-hex capability token in the path, validated by regex, with an
explicit path-traversal check against the resolved directory. That is the correct
pattern for a resource an email client must fetch, and it is not changing.

The two webhooks are public to the network but not unauthenticated — each carries
its own shared secret. They are exempt from *session* auth, not from auth.

### CORS

```js
origin: process.env.CORS_ORIGIN ? split(...) : true   // current
```

With `CORS_ORIGIN` unset, `true` reflects whatever `Origin` the caller sends,
while `credentials: true` permits cookies and authorization. Any website a
logged-in user visits can then call this API as them.

The default becomes the application's own origin. An unset `CORS_ORIGIN` yields a
same-origin policy rather than an open one.

### Rate limiting

`POST /api/auth/login` has no limit, so password guessing against a known address
— `abbas@skylinkscapital.com` appears throughout the repo — is bounded only by
bcrypt's cost. A per-IP budget is added on that route alone. Limiting reads would
be churn; limiting the credential endpoint is the point.

### Dependencies

30 advisories: 2 critical, 20 high. `npm audit fix` for what resolves without a
breaking major, then a written triage of the rest separating runtime exposure
from build-time-only. `tar` and the `glob` CLI are build-time; `axios` and
`@remix-run/router` are not. Depth of fix follows that split rather than the
advisory count.

### Explicitly unchanged

bcrypt cost 12; the JWT and `token_version` revocation scheme; the parameterised
SQL layer; the chart capability-token design; the existing `nosniff`,
`X-Frame-Options: DENY` and `Referrer-Policy` headers. These are already right,
and changing them adds risk without benefit.

## Testing

The allow-list is the failure-prone part, so it is tested directly rather than
through the routes.

1. **Every route is classified.** A test enumerates route definitions in
   `server.js` and the mounted routers, and asserts each is either allow-listed or
   behind the gate. A new unguarded route fails the suite. This is the test that
   would have caught the original seventeen.
2. **The allow-list is exact.** `POST /api/auth/login` is exempt;
   `POST /api/auth/users` is not, despite the shared prefix.
3. **The named critical routes reject anonymous callers** — the treasury report
   and the six write endpoints, asserted individually so a regression names the
   endpoint it broke.
4. **CORS** rejects a foreign origin when `CORS_ORIGIN` is unset.

## Risks

**A misclassified endpoint breaks on deploy.** The allow-list was built by
reading every route definition, but that is care, not proof. Restart and exercise
the dashboard before Saturday 10:00 UAE, when the weekly reports send.

**Chart images are the most likely casualty.** If `/report-charts/:token/:name` is
caught by the gate, images in already-delivered emails break, including in mail
already in the boss's inbox. Verify by loading a chart URL in a signed-out
browser after deploying.

**Sessions are unaffected but worth watching.** The gate reuses `authRequired`,
so an existing token stays valid. Any wave of 401s after deploy indicates a
classification error, not expiry.

## Out of scope

Rotating the exposed CRM token, pointing the alerts hub back at the real backend,
and adding CSP/HSTS. Each is real and tracked separately; none belongs in this
change.
