# CRM events webhook — Meta CAPI + WhatsApp welcome + Brevo contact

**Date:** 2026-10-09, scope widened 2026-10-12
**Status:** Approved design, pending implementation plan

Receive FXBO Assistant Rule webhooks at five points in the client funnel, store
each one once, then independently send a Meta Conversions API event, a
DoubleTick WhatsApp welcome, and a Brevo contact.

> **2026-10-12 revision.** This started as a single-event signup webhook with two
> destinations. The *Signup & CRM Events — Integration Plan* (Claude Docs,
> 2026-10-12) widened it: five funnel stages, and Meta CAPI as a third
> destination. The architecture below is unchanged by that — one endpoint, one
> row per event, a worker that fans out and retries off database columns. What
> grew is a `stage` dimension and a third action. §4 records where this spec
> deliberately differs from that document.

---

## 1. What was verified in the CRM, and what it changed

Everything in this section was read from the live CRM and the FXBO wiki on
2026-10-09 and 2026-10-12, not assumed. Several points contradict the brief.

### There is no shared-secret auth provider

The brief says "the shared secret configured in FXBO's Webhook Auth". No such
thing exists. *Webhook Auth* offers exactly one type, **OAuth 2.0**, with one
provider configured (`DocuSign`). The integration plan's "each rule needs a
Webhook Auth profile" is not available either.

What FXBO does allow is a webhook **header**, and the allowed set is only four:
`Accept`, `Accept-Language`, `Accept-Encoding`, **`Authorization`**.

So the shared secret travels in `Authorization`. This matters: the existing
mirror rules authenticate with `?secret=…` in the query string to
`https://crm.skylinkscapitalllc.ae/hook.php`, and a secret in a URL is visible
in the CRM's own Webhook Stats table, in IIS logs, and to any proxy in between.
We are not copying that.

### FXBO has its own retry engine

Configurable per rule: delivery check on/off, retry-on-selected-error-codes, max
attempts (≤12), initial and max retry delay, an interval growth factor, and a
request timeout (≤30s, connect 5s).

This creates **two independent retry layers**, and conflating them is the
mistake to avoid. See §7.

### The webhook URL must be allowlisted first

*CRM Configuration → Advanced → System Configuration → Assistant Webhooks List.*
Our endpoint cannot be selected in a rule until it is added there. Today the
list holds exactly two URLs: the `hook.php` mirror, and
`app.skylinkscapital.com/api/docusign/webhooks/fxbo/application-approved`.

That second entry answers the integration plan's first open question. **This
repository is not the system receiving the existing 2,971 deliveries** — those
go to `crm.skylinkscapitalllc.ae`, a different host. But this repository already
owns an FXBO webhook endpoint, so it is the right home for the new one, and
`hook.php` stays undisturbed.

### Every trigger we need already exists

Confirmed in the event dropdown on 2026-10-12:

| Funnel stage | Event (dropdown wording) | Value | Status today |
|---|---|---|---|
| Became a client | `Client registered` | `registration` | Rule 25 exists, internal + email only |
| Client verified | `A client has been verified` | `client verified` | Rule 42 exists, already firing webhooks |
| Live account opened | `Client opened new live account` | `live account` | Rule 11 exists, internal only |
| First deposit | `First time deposit by client` | `transaction.first_time_deposit` | No rule |
| Lead created | — | — | No clean trigger, see §11 |

Rule 25 and rule 42 stay untouched; new rules are added beside them.

---

## 2. The payload is ours to define, and that matters

The integration plan concludes that "the webhook carries only the client id" and
that we must therefore call the FXBO REST API to fetch everything. That
conclusion is drawn from the *shape of the existing `hook.php` URL*, which is
that rule's design, not a platform constraint.

The parameter table was read in full on 2026-10-09. A new rule can send almost
everything directly:

| Our field | FXBO placeholder | Note |
|---|---|---|
| `crm_client_id` | `%client_id_without_link%` | **Not** `%client_id%` — documented as "Client ID + Link", it embeds markup and would poison a key column |
| `first_name` | `%client_first_name%` | |
| `last_name` | `%client_last_name%` | |
| `full_name` | `%client_full_name%` | Carried only to derive the middle name |
| `email` | `%client_email%` | |
| `phone` | `%client_phone%` | |
| `record_type` | `%client_is_lead%` | Inverted and cautious — see below |
| `marketing_consent` | `%custom_consent_marketing%` | |
| `source` | `%custom_formname%` | `SVG`, `MAU`, `UAE` |
| `entity` | `%custom_change_me_field%` | Labelled **Entity**; the internal name is leftover boilerplate |
| `is_ib` | `%client_is_ib%` | |
| `language` | `%client_language%` | |
| `utm_source` / `utm_medium` / `utm_campaign` | `%client_utm_source%` etc. | |
| `referer` | `%client_referer%` | FXBO's spelling, kept |
| `full_link` | `%client_full_link%` | "Visited registration page full link" — **this is where `fbclid` lives** |
| `fxbo_unique_id` | `%unique_id%` | Per-delivery id |

**`%client_full_link%` is the important one.** The integration plan states that
the CRM derives ClickID by extracting `fbclid` from `full_link`. The same
`full_link` is available to us as a webhook parameter, so we derive `fbc`
ourselves and never need the REST API to learn it. That closes the plan's open
questions about REST field names for ClickID and UTM source.

### So: parameters *and* the id, with REST as enrichment

The rules send the full parameter set **and** the client id. REST is then an
enrichment for the one thing no placeholder provides — **the deposit amount and
currency** on a first-deposit event — rather than a hard runtime dependency on
the critical path of every event. If a REST call fails we still hold a complete
record; under the pure-fetch design we would hold an id and nothing else.

### `record_type` is derived, and derived cautiously

`"client"` only when `%client_is_lead%` is a recognised falsy literal (`0`,
`false`, `no`, `n`, `off`); `"lead"` for anything else — including absent,
empty, and any value we do not recognise, all of which mean *unknown* rather
than *client*. The failure modes are not symmetric: a client who misses their
welcome message is a support ticket, a lead who receives a login link for an
account that does not exist is a complaint.

The WordPress plugin posts `lead: false`, so every website signup is already a
client. Only promo step-1 records are leads. FXBO's actual literals are still
unconfirmed and are settled by the first live delivery (§11).

### Three requested fields do not exist in FXBO

- **Middle name.** No placeholder. Derived from `%client_full_name%` minus the
  first and last name, and only when the full name genuinely brackets them.
- **Is test.** No placeholder of any kind. Dropped rather than faked.
- **Deposited.** No placeholder, correctly — it is a lifecycle fact, and it now
  arrives as its own stage.

`%client_is_verified%` exists but is excluded from the registration stage: KYC
has not run when it fires, so it is false for everyone. It arrives as a stage
instead.

---

## 3. Stage mapping

One endpoint, five rules, one `stage` on each row.

| Our `stage` | FXBO event | Meta `event_name` | WhatsApp | Brevo |
|---|---|---|---|---|
| `lead` | (none yet, §11) | `Lead` | no | no |
| `registered` | `Client registered` | `CompleteRegistration` | **yes** | **yes** |
| `verified` | `A client has been verified` | `SubmitApplication` | no | no |
| `live_account` | `Client opened new live account` | `TradingAccountOpened` | no | no |
| `first_deposit` | `First time deposit by client` | `Purchase` + value/currency | no | no |

Meta fires at every stage. WhatsApp and Brevo fire only at `registered`; at
every other stage they are stored `skipped` with reason `stage not applicable`,
so the admin view shows a complete row rather than a blank.

---

## 4. Decisions taken, with their reasons

Recorded so none of these later looks accidental.

**This becomes the only WhatsApp sender (2026-10-09).** The `slc-crm` WordPress
plugin currently sends the identical template on website signup. If FXBO also
fires `Client registered` for those people they receive two messages — the
stored row stops *CRM retries*, not *a second independent sender*. The
integration plan confirms the plugin's send is being removed. **It is a required
step, not a follow-up.**

**This becomes the only sender of Meta conversion events (2026-10-12).** Per the
integration plan: the plugin drops `CompleteRegistration` and keeps only
`PageView` and `InitiateCheckout`; the Lovable promo pages send no conversion
events at all. One owner per stage, so there is no pixel/CAPI overlap and no
`event_id` deduplication to build. If either of those pixels is later restored
to firing a conversion, this assumption breaks silently and the funnel
double-counts.

**Brevo keeps the full twelve-field set (2026-10-12, user's call).** The
integration plan says "first name, last name, email. Nothing else." That was put
to the user against the 9 October decision and the wider set was kept. The nine
custom attributes created in Brevo on 2026-10-09 stand. Attribution and entity
fields cannot be backfilled after signup, which is the argument that decided it.

**Brevo is not gated on marketing consent (2026-10-12, user's call).** The
integration plan gates it; the 9 October decision does not, and was reaffirmed.
Everyone lands in Brevo with consent recorded as `OPT_IN`, which is Brevo's own
flag and which its double-opt-in and compliance tooling reads. Campaigns segment
on it. Revisit if the list is ever used for something a non-consenting client
should not receive.

**Lives in this app.** MySQL, cron, admin routes and an FXBO webhook endpoint
all already exist here. The cost is inheriting IIS recycle behaviour, which §7
is designed around.

**Brevo: `POST /v3/contacts` with `updateEnabled: true`**, not
`/v3/contacts/import`. One contact per event. The single-contact call is
immediately idempotent and returns a per-contact result; the bulk importer is
asynchronous and returns a `processId`, so "did this contact land?" would need a
second lookup.

---

## 5. Module shape

Following the `docusign/` pattern — router, store, pure helpers:

```
crmSignup/
  router.js      POST /api/crm-events/:stage: auth, validate, store, 200. Nothing else.
  normalise.js   pure: raw payload -> normalised fields + validation verdict
  clickId.js     pure: full_link -> fbclid -> the wrapped fbc value
  store.js       MySQL schema, insert-if-absent, status updates, claim-due
  meta.js        CAPI payload builder + hashing + outcome classifier + send
  whatsapp.js    DoubleTick payload builder + outcome classifier + send
  brevo.js       contact upsert
  worker.js      cron sweeper: claim due rows, run all three independently
  adminRoute.js  server-rendered recent-events view
```

`normalise.js`, `clickId.js`, the payload builders and the outcome classifiers
are pure and tested directly. That is where the subtle bugs live: the
`messages[0].status` trap, the `fbc` wrapping, the hash normalisation, the phone
regex, the lead/client call.

---

## 6. Table: `signup_events`

| Column | Why |
|---|---|
| `stage` | Which funnel moment this row is. `UNIQUE (crm_client_id, stage)` — a client legitimately has five rows, and a redelivery of one stage has one |
| `whatsapp_next_attempt_at` / `brevo_next_attempt_at` / `meta_next_attempt_at` | The retry clocks. This is what makes retries survive an IIS recycle — see §7 |
| `*_attempts`, one per action | The brief had a single `attempts`. One shared counter cannot carry three independent retry schedules |
| `fbc` | The assembled click identifier, **frozen at first write** — see §8 |
| `fxbo_unique_id` | Distinguishes a genuine FXBO redelivery from a real second event |
| `raw_payload` | The body as received, so the first live delivery settles what `%client_is_lead%` contains |

Plus the normalised fields from §2, `received_at`, and per-action
`*_status` / `*_detail` ( `whatsapp_message_id` additionally).

Statuses: `pending | sent | retrying | failed | rejected | skipped | invalid`.
`invalid` is written to **all three** action statuses, because there is no
event-level status column and inventing one would mean two places to look.

Insert is `INSERT ... ON DUPLICATE KEY UPDATE id = id` so a redelivery is a
no-op **at the database**, not a check-then-act race in application code.

---

## 7. Retry ownership — the part that matters

Two engines, deliberately kept apart:

| Layer | Owns | Rule |
|---|---|---|
| FXBO → us | Did the event reach us at all | Return **200** the moment the row is stored. Never 5xx because a provider failed — that makes FXBO redeliver an event we already hold |
| Us → providers | Did the message send | Our own `*_next_attempt_at` sweeper: 3 attempts, 5 minutes apart |

**Retries must not use `setTimeout` or any in-memory queue.** node-cron dies with
the IIS worker on this host, and a Plesk idle timeout has already killed
scheduled sends here before. A five-minute timer held in process memory is
silently lost on a recycle, leaving rows stuck at `retrying` with nothing to
resume them. A `next_attempt_at` column swept by cron costs at most a minute.

Three details of our own layer:

- **The sweeper runs every minute**, claiming rows whose clock has passed.
- **The first attempt does not wait for the sweeper.** The worker is kicked
  once, fire-and-forget, immediately *after* the 200 is sent.
- **`attempts` increments before the request goes out**, so a crash mid-send
  costs one attempt instead of retrying forever.

Two FXBO-side settings follow:

- **"Update parameters' values on retry" OFF** — a redelivery must carry an
  identical payload, or our dedupe is reasoning about a different event.
- **401 excluded from the retry error codes** — retrying a rejected secret
  generates noise and never succeeds.

---

## 8. The three actions

### Meta Conversions API

`POST https://graph.facebook.com/v26.0/692517170017822/events?access_token=…`

Three fields are fixed constants Meta requires for CRM events:
`action_source: "system_generated"`, `custom_data.event_source: "crm"`,
`custom_data.lead_event_source: "FXBackOffice"`. `event_name` comes from §3 and
`event_time` is the stage's UNIX timestamp.

**Three traps, each of which degrades matching silently rather than erroring:**

1. **`fbc` is not the raw `fbclid`.** Meta expects `fb.1.<timestamp_ms>.<fbclid>`.
   We extract `fbclid` from `%client_full_link%` and wrap it.
2. **The `fbc` timestamp must be frozen.** It is written once, on the client's
   first event, and reused verbatim at every later stage. Recomputing it per
   stage gives Meta a different click identity for the same person at each
   step — no error, just a quietly broken funnel. This is why `fbc` is a stored
   column (§6) and not derived at send time.
3. **`em` and `ph` are arrays of SHA-256 of the *normalised* value** — email
   lowercased and trimmed, phone digits only with no `+`. Hashing the raw input
   produces a hash Meta cannot match.

`lead_id` is omitted: it exists only for Meta Lead Ads instant forms. ClickID
plus hashed email and phone already score 9.0/10 on match quality.

Retry only transport errors, 429 and 5xx; everything else is permanent.

**Known constraint:** Meta has applied financial-services data-sharing
restrictions to this dataset, blocking custom parameters. This may reject
`value` and `currency` on `Purchase`. Without value there is no return-on-ad-spend
measurement, which is much of the point — so the deposit stage is tested first,
not last.

### WhatsApp (DoubleTick)

Runs only when **all** hold: stage is `registered`, `record_type` is client,
phone matches `/^\+[1-9]\d{7,14}$/`, `source` is not in `SKIP_SOURCES`, and
`WA_API_KEY` is set. Otherwise `skipped` with the reason stored.

`POST https://public.doubletick.io/whatsapp/message/template`, header
`Authorization: <WA_API_KEY>` — **raw key, not `Bearer`**. Body as the brief
gives it: a `messages` array of one, each entry holding `content`
(`templateName`, `language`, `templateData.header/body/buttons`) and, as
siblings of `content`, `from`, `to` and `messageId`. Fresh UUID v4 per attempt.

**An HTTP 2xx does not mean sent.** It means accepted. The verdict is
`messages[0].status`, and these are failures, case-insensitively: `FAILED`,
`ERROR`, `REJECTED`, `UNDELIVERED`, `UNDELIVERABLE`, `INVALID`.

Retry only transport errors, 429 and 5xx. Any other non-2xx, and any 2xx
carrying a failure status, is permanent — retrying an unapproved template or a
bad key only burns attempts and delays the alert.

### Brevo

`POST /v3/contacts` with `updateEnabled: true` and `listIds: [19]` ("All
Clients"), at the `registered` stage only.

Twelve fields (§4). Two reuse Brevo's own attributes rather than minting custom
twins: `EXT_ID` carries the CRM client id, and `OPT_IN` carries marketing
consent. The other nine — `MIDDLE_NAME`, `ENTITY`, `FORM_NAME`, `LANGUAGE`,
`IS_IB`, `UTM_SOURCE`, `UTM_MEDIUM`, `UTM_CAMPAIGN`, `REFERER` — were created in
Brevo on 2026-10-09 and verified (27 attributes, up from 18).

**An attribute that does not exist in Brevo makes the call return 400**, which
this design classifies as permanent, so the contact would silently never land.
Any future field needs the attribute created first.

Still explicitly **not** sent: phone, date of birth, country, nationality, any
document data. All are available and all are deliberately left out.

Retry transport / 429 / 5xx up to 3 times; any other 4xx is permanent.

### Independence

The three actions never block each other. One failing leaves the others' status
untouched. No exception escapes the handler or the worker: every path ends in a
stored status.

---

## 9. Authentication

`Authorization` header, compared against `CRM_WEBHOOK_SECRET`.

- **Fail closed**: no secret configured → reject everything. This differs
  deliberately from `docusign/router.js`, which falls back to "open".
- Constant-time compare.
- Log the rejection — method, path, source IP, timestamp — and **never** the
  supplied header value.

An unauthenticated endpoint here lets anyone trigger WhatsApp sends to arbitrary
numbers at our cost, and inject fabricated conversions into the ad account.

---

## 10. An FXBO "Test webhook" press is not a signup

Pressing **Test webhook** substitutes every parameter with its own *label*, so
`client_id` arrives as the literal `"Client ID"` and `first_name` as
`"Client First Name"`. Those are non-empty strings: validation alone would
accept them, and we would create a Brevo contact named "Client First Name" in
the live marketing list and post a fabricated conversion to Meta.

`docusign/fxboPlaceholder.js` already recognises this shape for the DocuSign
rule, and its narrowness is the point: a raw token is proof on its own, but a
label needs corroboration from a second field, so a real client is never
mistaken for a test. A detected press is stored `invalid` and runs nothing.

---

## 11. Open questions

- **What `%client_is_lead%` actually contains** — `1`/`0`, `true`/`false`,
  `Yes`/`No`. Settled by one Test webhook press plus the first live delivery,
  both visible in `raw_payload`.
- **Whether `Client registered` also fires for leads.** If it does,
  `%client_is_lead%` is doing real work. Test before asking FXBO for anything.
- **A reliable lead-creation trigger.** The dropdown offers only
  `A new lead has been assigned to you` and `A lead has been assigned to other
  manager` — both assignment, not creation. The `lead` stage ships last and may
  need FXBO to add a trigger.
- **Deposit amount and currency** — whether a placeholder exists, or a REST call
  is needed. The only field confirmed to need REST.
- **Whether Meta accepts `value` and `currency`** given the financial-category
  restriction (§8).

Enabling *Save request snapshot for assistant rule webhooks* makes bodies
visible in Webhook Stats, which helps — but it stores PII, so turn it off again
after testing.

---

## 12. Admin view

A server-rendered page listing recent events with all three statuses, so "did
this client get their welcome message?" is answerable without a database query.

**Deliberately not a React settings page.** The frontend build has not deployed
since 2026-09-25 — `dist/` is gitignored and the server never runs
`npm run build`, so a React page would be invisible until that is fixed.

Behind `authRequired, adminOnly`, the pair the report routes already use.
`/account-alerts.html` is the precedent for *server-rendered rather than React*,
not for access control — it is a static `sendFile` with no guard, and this page
holds client PII. Phone numbers and email addresses masked.

---

## 13. Configuration

| Variable | Notes |
|---|---|
| `CRM_WEBHOOK_SECRET` | Required. Unset → reject everything |
| `META_DATASET_ID` | `692517170017822` |
| `META_CAPI_ACCESS_TOKEN` | Generated in Events Manager. Unset → Meta skipped silently |
| `META_API_VERSION` | `v26.0` |
| `META_TEST_EVENT_CODE` | Set during testing, unset in production |
| `WA_API_KEY` | Unset → WhatsApp skipped silently |
| `WA_TEMPLATE_NAME` | `registration_client_v3` |
| `WA_TEMPLATE_LANGUAGE` | `en` |
| `WA_TEMPLATE_BODY_PARAM` / `WA_TEMPLATE_BUTTON_URL` | `https://skylinkscapital.com/en/login/` |
| `WA_FROM_NUMBER` | `+971507192185` |
| `WA_MAX_ATTEMPTS` | `3` |
| `BREVO_API_KEY` | Already set. Unset → Brevo skipped silently |
| `BREVO_LIST_ID` | `19` — "All Clients" |
| `SKIP_SOURCES` | Comma-separated `%custom_formname%` values never messaged. WhatsApp only |

Never logged: `META_CAPI_ACCESS_TOKEN`, `WA_API_KEY`, `BREVO_API_KEY`,
`CRM_WEBHOOK_SECRET`. Never logged in plain text: full phone numbers, full email
addresses.

The Meta token currently stored inside FXBO is exposed and should be rotated;
generating a fresh one for this service does that in the same step.

---

## 14. Testing

**Pure units:** normalisation and the invalid-payload path; `fbclid` extraction
and `fbc` wrapping, including a `full_link` with no `fbclid`; hash
normalisation (a raw-input hash must differ from a normalised-input hash); the
phone regex at both ends of its range; all six WhatsApp failure statuses
case-insensitively; a 2xx-with-`FAILED` classified permanent; 429 and 5xx
retryable; each skip rule; the Test-webhook guard.

**Integration:** a second identical POST for the same client and stage inserts
nothing and sends nothing; the same client at a *different* stage inserts a new
row and reuses the stored `fbc`.

**Acceptance:** Meta events first, with `META_TEST_EVENT_CODE` set — they appear
under Test events within minutes and touch no real data. Test the `Purchase`
stage early, because the financial-category restriction may reject its value.
Then one real registration: the WhatsApp message **arrives on a handset**, not
merely a 2xx; the contact appears in Brevo list 19; re-posting the identical
webhook sends no second message.

---

## 15. Prerequisites, in order

1. Add the endpoint URL to *System Configuration → Assistant Webhooks List*.
2. Generate a Meta access token from Events Manager → the CRM implementation
   guide → Generate Access Token. Set the environment variables and recycle.
3. Create the rules (§1 table), starting with `registered`. Each: method
   `Outcoming webhook`, POST, `Authorization` header, parameters per §2, "update
   parameters on retry" off, 401 out of the retry codes.
4. Run the acceptance tests.
5. **Disable the WhatsApp send and the `CompleteRegistration` pixel event in the
   `slc-crm` WordPress plugin.** Until this is done, every website signup gets
   two WhatsApp messages and two Meta conversions.
6. Switch off FXBO's own Meta integration once this is live.

---

## 16. Out of scope

Backfilling clients who registered before this ships. The `Website` custom-field
fix on the Lovable promo pages — needed for ClickID on those 250 leads, but it
is their change, not ours. Replacing the `hook.php` mirror webhooks. Changes to
rules 25 and 42. The two WordPress plugin bugs (the UAE popup dropping the query
string, and the staging redirect to production). Fixing the frontend build —
noted in §12 because it constrains the admin view, but it is a separate problem.
