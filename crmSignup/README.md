# crmSignup

Receives FXBO webhooks at five points in the client funnel, stores each once,
then independently sends a Meta Conversions API event, a DoubleTick WhatsApp
welcome, and a Brevo contact.

Design: `../docs/superpowers/specs/2026-10-09-crm-signup-webhook-design.md`

Configuration: the "CRM events webhook" block at the end of `../.env.example`.

## What each stage sends

| Stage | Meta event | WhatsApp | Brevo |
|---|---|---|---|
| `lead` | `Lead` | no | no |
| `registered` | `CompleteRegistration` | yes, to clients with a valid phone | yes |
| `verified` | `Client_Verified` | no | no |
| `live_account` | `TradingAccountOpened` | no | no |
| `first_deposit` | `Purchase` | no | no |

A destination that does not apply is stored as `skipped` with its reason, so a
processed row shows all three. FXBO has no trigger for `lead` yet (spec section
11).

## Routes

| Route | Guard |
|---|---|
| `POST /api/crm-events` | `CRM_WEBHOOK_SECRET` in the `Authorization` header, as the whole header value: `Bearer <secret>` is rejected, and an unset secret rejects everything. On the `PUBLIC_API_ROUTES` allow-list because FXBO cannot carry a session. |
| `GET /api/crm-events/overview` | `authRequired` + `adminOnly` (`canManageUsers`, otherwise 403). Takes `?days=` (1 to 90, default 30). Feeds the settings tab, whose menu entry (`/settings/crm-events`, `admin` group) requires `Settings` + `Auth:ManageUsers`. A per-page `Settings:crm-events` access chip also opens the tab, but does not satisfy the endpoint's gate. |

The stage is a **body parameter**, not a path segment, and all five rules post
to the one path. `auth/requireSession.js` matches its allow-list against actual
request paths, so a `:stage` pattern would never match; and the list is capped
at six entries by `auth/routeCoverage.test.js`.

## Five things that are easy to get wrong

**A 2xx from DoubleTick does not mean the message was sent.** It means the
request was accepted. The outcome is `messages[0].status`: `SENT` and
`ENQUEUED` mean it was accepted for sending, `FAILED ERROR REJECTED UNDELIVERED
UNDELIVERABLE INVALID` all mean it failed, and any other value is stored as
`rejected` with the value in the detail rather than assumed to be a send. None
of those is retried, because a 2xx means the message may already have gone out.

**`fbc` is not the raw `fbclid`,** and its timestamp must be **frozen**. Meta
wants `fb.1.<ms>.<fbclid>`. It is assembled once, at the first stage whose
`full_link` carries an `fbclid`, and stored. Later stages reuse that value.
Recomputing it per stage hands Meta a different click identity for the same
person at each step, with no error anywhere.

**Meta's `em` and `ph` are SHA-256 of the *normalised* value** — email
lowercased and trimmed, phone digits only. Hashing raw input produces a hash
Meta cannot match, and reports no problem.

**The handler never returns 5xx because a provider failed.** It answers 200 the
moment the row is stored, and that includes a duplicate, an invalid payload and
an FXBO "Test webhook" press (the last two are stored as `invalid` and send
nothing). A 5xx makes FXBO redeliver an event we already hold, and FXBO has its
own per-rule retry engine (configurable up to 12 attempts) on top of ours. The
one 5xx is `503` when the insert itself fails: nothing is held, so FXBO's
redelivery is the only recovery, and the unique key makes it harmless.

**Retries live in the `*_next_attempt_at` columns, never in a timer.** node-cron
and `setTimeout` die with the IIS worker on this host, and a lost five-minute
timer leaves a row stuck at `retrying` forever. Each destination has its own
status, attempt count and clock: 3 attempts five minutes apart (WhatsApp's count
is `WA_MAX_ATTEMPTS`). The sweeper is a `setInterval` that only reads those
columns, so a recycle costs at most one interval.

## Operating notes

- `signup_events` is created at startup, in the auth database. If the
  `AUTH_DB_*` variables are missing, the store fails to start, the sweeper does
  not start, and every webhook is answered 503.
- A destination with no key is recorded as `skipped`, and a skipped row is
  final. Set `META_CAPI_ACCESS_TOKEN`, `WA_API_KEY` and `BREVO_API_KEY` before
  pointing FXBO at the endpoint.
- Two workers can run at once, and the host arranges exactly that during an
  overlapped recycle. The sweeper's `SELECT` takes no lock, so both read the
  same due rows; the pre-send write is the claim, and the one whose `UPDATE`
  matches no row sends nothing. Nothing here needs one Node process.
- The settings tab does not appear until someone has run `npm run build` on the
  server (spec section 12).

## What the table holds

`signup_events` stores each client's email, phone and name along with the full
raw webhook payload (`raw_payload`), for valid, invalid and test-press events
alike. Nothing in this module deletes or expires rows, and no retention or purge
policy has been defined.

## Attributes

A Brevo contact carries up to 13 attributes, plus its email. `FIRSTNAME` and
`LASTNAME` are Brevo's standard ones. Two existing ones are reused rather than
duplicated: `EXT_ID` for the CRM client id and `OPT_IN` for marketing consent.
Nine Brevo attributes were created for this on 2026-10-09: `MIDDLE_NAME`,
`ENTITY`, `FORM_NAME`, `LANGUAGE`, `IS_IB`, `UTM_SOURCE`, `UTM_MEDIUM`,
`UTM_CAMPAIGN`, `REFERER`. `FORM_NAME` carries the `%custom_formname%` source.
`IS_TEST` is deliberately not sent (FXBO has no placeholder for it), so there is
nothing to create for it.

An attribute with no value is left out, except the two booleans, `OPT_IN` and
`IS_IB`, which are always sent, `false` included. Posting an attribute Brevo
does not know returns 400, classified permanent and stored as `rejected` — so a
new field needs the attribute created in Brevo first. All three destinations use
the same two words: `rejected` is the provider refusing this event, `failed` is a
transport failure or a spent attempt budget.
