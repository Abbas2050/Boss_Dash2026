# CRM signup webhook — WhatsApp welcome + Brevo contact

**Date:** 2026-10-09
**Status:** Approved design, pending implementation plan

Receive FXBO's `Client registered` event, store it once, then independently send
a DoubleTick WhatsApp welcome and add the person to a Brevo list.

---

## 1. What was verified in the CRM, and what it changed

Everything in this section was read from the live CRM and the FXBO wiki on
2026-10-09, not assumed. Several points contradict the original brief.

### The trigger already exists

Rule **25 "Client Registered"** fires on event `Client registered`, with methods
*Internal notification* + *Email*. We add a **new** rule using the
**"Outcoming webhook"** method and leave 25 untouched — it notifies managers and
is unrelated to this.

### There is no shared-secret auth provider

The brief says "the shared secret configured in FXBO's Webhook Auth". No such
thing exists. *Webhook Auth* offers exactly one type, **OAuth 2.0**, with one
provider configured (`DocuSign`).

What FXBO does allow is a webhook **header**, and the allowed set is only four:
`Accept`, `Accept-Language`, `Accept-Encoding`, **`Authorization`**.

So the shared secret travels in `Authorization`. This matters: the existing
mirror rules (42/43/45) authenticate with `?secret=…` in the query string to
`https://crm.skylinkscapitallc.ae/hook.php`, and a secret in a URL is visible in
the CRM's own Webhook Stats table, in IIS logs, and to any proxy in between. We
are not copying that.

### FXBO has its own retry engine

Configurable per rule: delivery check on/off, retry-on-selected-error-codes, max
attempts (≤12), initial and max retry delay, an interval growth factor, and a
request timeout (≤30s).

This creates **two independent retry layers**, and conflating them is the
mistake to avoid. See §6.

### The webhook URL must be allowlisted first

*CRM Configuration → Advanced → System Configuration → Assistant Webhooks List*.
Our endpoint cannot be selected in a rule until it is added there. This is a
prerequisite, not a deployment detail.

### The payload is ours to define

Fields are chosen from an "available parameters" table on step 3 of the rule.
Documented gotcha: parameter **Type must be `string`** for scalars like
`%client_language%`; `json` is only for arrays and objects.

---

## 2. Field mapping

Confirmed present in the parameters table:

| Our field | FXBO placeholder | Note |
|---|---|---|
| `crm_client_id` | `%client_id_without_link%` | **Not** `%client_id%` — that one is documented as "Client ID + Link" and embeds markup, which would poison a UNIQUE column |
| `first_name` | `%client_first_name%` | |
| `last_name` | `%client_last_name%` | |
| `email` | `%client_email%` | |
| `phone` | `%client_phone%` | |
| `record_type` | `%client_is_lead%` | Inverted — see below |
| `marketing_consent` | `%custom_consent_marketing%` | |
| `source` | `%custom_formname%` | |
| `fxbo_unique_id` | `%unique_id%` | Per-delivery id |
| `entity` | `%custom_change_me_field%` | Labelled **Entity** in the CRM. The internal name is leftover boilerplate; it is the right key |
| `is_ib` | `%client_is_ib%` | |
| `language` | `%client_language%` | |
| `full_name` | `%client_full_name%` | Carried only to derive the middle name — see below |
| `utm_source` | `%client_utm_source%` | |
| `utm_medium` | `%client_utm_medium%` | |
| `utm_campaign` | `%client_utm_campaign%` | |
| `referer` | `%client_referer%` | FXBO's spelling, kept |

Three fields that were asked for **do not exist in FXBO at all**, verified
against the full parameter table on 2026-10-09:

- **Middle name.** No placeholder. `%client_full_name%` is the only other name
  field, so the middle name is *derived*: take the full name, remove the first
  and last name, and whatever remains is the middle. Empty when there is
  nothing, which is the common case and is fine.
- **Is test.** No placeholder of any kind. Dropped (§3) rather than faked.
- **Deposited.** No placeholder, which is correct — it is a lifecycle fact, not
  a registration one.

`%client_is_verified%` *does* exist but is excluded: at the instant this webhook
fires, KYC has not run, so it is false for everyone. A field that is confidently
wrong is worse than a field we do not have. The events `A client has been
verified` and `First time deposit by client` both exist in the same rule
builder, and are where a later lifecycle sync would hang (§14).

`record_type` is **derived, and derived cautiously**: it is `"client"` only when
`%client_is_lead%` is a recognised falsy literal (`0`, `false`, `no`, `""`), and
`"lead"` for anything else, including a value we do not recognise. The literals
FXBO actually emits are unconfirmed (§9), and the two failure modes are not
symmetric — a client who misses their welcome message is a support ticket, a
lead who receives a login link for an account that does not exist is a
complaint. Unrecognised means lead.

`%custom_formname%` is the right source key rather than a free-text "source": the
`slc-crm` signup plugin already sets it per profile (`NEW_SIGNUP`, `UAE_SIGNUP`,
`SVG`), so `SKIP_SOURCES` keys on values that already exist and already mean
something. A back-office or imported client will have it empty or different.

The `%custom_consent_*%` family (`_marketing`, `_understanding`, `_acceptance`,
`_confirmation`) are the same keys that plugin writes, so the chain is consistent
end to end.

---

## 3. Decisions taken, with their reasons

Recorded so none of these later look accidental.

**This becomes the only WhatsApp sender (2026-10-09).** The `slc-crm` WordPress
plugin currently sends the identical template (`registration_client_v3`, same
from-number, same retry policy) on website signup. If FXBO also fires
`Client registered` for those people they receive two messages — `crm_client_id`
uniqueness stops *CRM retries*, not *a second independent sender*. Decision: the
plugin's WhatsApp send is disabled as part of this work. **It is a required step
of the implementation plan, not a follow-up.**

**Everyone is added to Brevo regardless of marketing consent (2026-10-09, user's
explicit call).** The reservation was put to the user and chosen against with it
in view: the Brevo list is a marketing list and `custom_consent_marketing` is the
flag that exists to govern it. Mitigation agreed: `marketing_consent` is still
sent to Brevo **as a contact attribute**, so the consent state travels with the
record and campaign sends can segment on it. Revisit if the list is ever used for
anything a non-consenting client should not receive.

**`IS_TEST` dropped (2026-10-09).** The original intent was to flag test
records so campaigns could exclude them. FXBO cannot supply the flag, and the
alternative — our receiver guessing from delivery shape — would be a field that
looks authoritative and is not. `SKIP_SOURCES` already gives a way to exclude a
whole form, which covers the real need.

**Contacts go to list #19 "All Clients" (2026-10-09, user's call).** A dedicated
list was offered and declined. Consequence to be aware of: that list already
holds 4,239 contacts from an existing process, so "did the webhook do this?" is
answered from `signup_events` and the admin view (§10), not from the list
itself.

**Lives in this app, not a standalone service and not `hook.php`.** MySQL, cron,
admin routes and the FXBO webhook auth pattern all already exist here. The cost
is inheriting IIS recycle behaviour, which §6 is designed around.

**Brevo: `POST /v3/contacts` with `updateEnabled: true`**, not
`/v3/contacts/import`. One contact per webhook. The single-contact call is
immediately idempotent and returns a per-contact result we can store; the bulk
importer is asynchronous and returns a `processId`, so "did this contact land?"
would need a second lookup.

---

## 4. Module shape

Following the `docusign/` pattern — router, store, pure helpers:

```
crmSignup/
  router.js      POST /crm-signup: auth, normalise, store, 200. Nothing else.
  normalise.js   pure: raw payload -> normalised fields + validation verdict
  store.js       MySQL schema, insert-if-absent, status updates, claim-due
  whatsapp.js    DoubleTick payload builder + outcome classifier (pure) + send
  brevo.js       contact upsert
  worker.js      cron sweeper: claim due rows, run both actions independently
  adminRoute.js  server-rendered recent-events view
```

`normalise.js`, the WhatsApp payload builder and the outcome classifier are pure
and tested directly. That is where the subtle bugs live: the `messages[0].status`
trap, the phone regex, the lead/client call.

---

## 5. Table: `signup_events`

The brief's columns, plus three that earn their place:

| Column | Why |
|---|---|
| `next_attempt_at` | The retry clock. This is what makes retries survive an IIS recycle — see §6 |
| `fxbo_unique_id` | Distinguishes a genuine FXBO redelivery from a real second event for the same client |
| `raw_payload` | The body as received, so the first live delivery settles what `%client_is_lead%` actually contains |

Plus: `crm_client_id` (UNIQUE), `first_name`, `last_name`, `email`, `phone`,
`record_type`, `marketing_consent`, `source`, `received_at`,
`whatsapp_status`, `whatsapp_message_id`, `whatsapp_detail`,
`brevo_status`, `brevo_detail`, `attempts`.

Statuses: WhatsApp `pending|sent|retrying|failed|rejected|skipped|invalid`;
Brevo `pending|sent|failed|skipped|invalid`.

`invalid` is added to **both** enums deliberately. The brief asks that a payload
missing required fields be "stored with status invalid", but there is no
separate event-level status column to hold it, and inventing one would mean two
places to look. A failed validation therefore writes `invalid` to both action
statuses, with the missing fields named in the `_detail` columns, and nothing
else runs.

Insert is `INSERT ... ON DUPLICATE KEY UPDATE id=id` so a redelivery is a no-op
**at the database**, not a check-then-act race in application code.

Created with `CREATE TABLE IF NOT EXISTS` at init, matching `docusign/store.js`.

---

## 6. Retry ownership — the part that matters

Two engines, deliberately kept apart:

| Layer | Owns | Rule |
|---|---|---|
| FXBO → us | Did the event reach us at all | Return **200** the moment the row is stored. Never 5xx because a provider failed — that makes FXBO redeliver an event we already hold |
| Us → DoubleTick / Brevo | Did the message send | Our own `next_attempt_at` sweeper: 3 attempts, 5 minutes apart |

**Retries must not use `setTimeout` or any in-memory queue.** node-cron dies with
the IIS worker on this host, and a Plesk idle timeout has already killed
scheduled sends here before. A five-minute timer held in process memory is
silently lost on a recycle, leaving rows stuck at `retrying` with nothing to
resume them. A `next_attempt_at` column swept by cron costs at most a minute of
delay across a recycle.

Three details of our own layer, so none of them is left to the implementation:

- **The sweeper runs every minute.** `attempts` and `next_attempt_at` are the
  whole state machine; the cron job claims rows whose `next_attempt_at` has
  passed.
- **The first attempt does not wait for the sweeper.** The worker is kicked
  once, fire-and-forget, immediately *after* the 200 has been sent — the welcome
  message should arrive in seconds, not up to a minute later. The sweeper is the
  safety net for that kick being lost to a recycle, not the normal path.
- **`attempts` is incremented before the request goes out, not after it comes
  back.** A crash or recycle mid-send then costs one attempt instead of
  retrying forever, and cannot double-send on the next tick.

Two FXBO-side settings follow from this:

- **"Update parameters' values on retry" OFF** — a redelivery must carry the
  identical payload, or our dedupe is reasoning about a different event.
- **401 excluded from FXBO's retry-on-error codes** — retrying a rejected secret
  generates noise and never succeeds.

---

## 7. Authentication

`Authorization` header, compared against `CRM_WEBHOOK_SECRET`.

- **Fail closed**: no secret configured → reject everything. This differs
  deliberately from `docusign/router.js`, which falls back to "open" when its
  bearer is unset.
- Constant-time compare.
- Log the rejection — method, path, source IP, timestamp — and **never** the
  supplied header value.

An unauthenticated endpoint here lets anyone trigger WhatsApp sends to arbitrary
numbers at our cost, which is why this is the one thing that fails closed.

---

## 8. The two actions

### WhatsApp (DoubleTick)

Runs only when **all** hold: `record_type` is client, phone matches
`/^\+[1-9]\d{7,14}$/`, `source` is not in `SKIP_SOURCES`, and `WA_API_KEY` is set.
Otherwise `skipped` with the reason stored — `"lead, not client"`,
`"invalid phone number"`, `"source excluded"`.

`POST https://public.doubletick.io/whatsapp/message/template`, header
`Authorization: <WA_API_KEY>` — **raw key, not `Bearer`**. Body exactly as the
brief gives it: a `messages` array of one, each entry holding `content`
(`templateName`, `language`, `templateData.header/body/buttons`) and, as
siblings of `content` rather than of `messages`, `from`, `to` and `messageId`.
Every field is required; omitting `from` or `messageId` is itself enough for
rejection. Fresh UUID v4 per attempt.

**An HTTP 2xx does not mean sent.** It means accepted. The verdict is
`messages[0].status`, and these are failures, case-insensitively:
`FAILED`, `ERROR`, `REJECTED`, `UNDELIVERED`, `UNDELIVERABLE`, `INVALID`.

Retry only transport errors, 429 and 5xx. Any other non-2xx, and any 2xx
carrying a failure status, is **permanent** — retrying an unapproved template or
a bad key only burns attempts and delays the alert.

### Brevo

`POST /v3/contacts` with `updateEnabled: true` and `listIds: [BREVO_LIST_ID]`.

The brief's original three fields were widened on 2026-10-09 to the set below.
Two of them reuse attributes Brevo already ships, which is better than minting
custom twins:

| Brevo attribute | Source | Type | Note |
|---|---|---|---|
| `EMAIL` | `email` | — | Identifier |
| `FIRSTNAME` | `first_name` | Text | Already existed |
| `LASTNAME` | `last_name` | Text | Already existed |
| `MIDDLE_NAME` | derived (§2) | Text | Created 2026-10-09 |
| `EXT_ID` | `crm_client_id` | Text | **Reused**, not created. Brevo's own external-id field — joins a contact back to the CRM record |
| `OPT_IN` | `marketing_consent` | Boolean | **Reused**, not created. Brevo's own marketing opt-in flag; its double-opt-in and compliance tooling reads this field, and a custom `MARKETING_CONSENT` would be invisible to them |
| `ENTITY` | `entity` | Text | Created. Which regulated entity the client signed under |
| `FORM_NAME` | `source` | Text | Created |
| `LANGUAGE` | `language` | Text | Created. Not `_DETECTED_LANGUAGE`, which Brevo owns and infers |
| `IS_IB` | `is_ib` | Boolean | Created |
| `UTM_SOURCE` / `UTM_MEDIUM` / `UTM_CAMPAIGN` | UTM fields | Text | Created |
| `REFERER` | `referer` | Text | Created |

All nine new attributes were created in Brevo on 2026-10-09 and verified (27
attributes total, up from 18). **An attribute that does not exist in Brevo makes
`POST /v3/contacts` return 400**, which this design classifies as permanent — so
the contact would silently never land. Any future field needs the attribute
created first.

Still explicitly **not** sent: phone, date of birth, country, nationality, and
any document data. All are available as FXBO placeholders and all are
deliberately left out.

Retry transport / 429 / 5xx up to 3 times; any other 4xx is permanent.

`BREVO_API_KEY` already exists in this app's environment (`alerts/alertNotifier.js`
uses it for transactional email). Contacts is a different endpoint, same key.

### Independence

The two actions never block each other. One failing leaves the other's status
untouched. No exception escapes the handler or the worker: every path ends in a
stored status.

---

## 9. Open questions, to settle with the first live delivery

- **What `%client_is_lead%` actually contains** — `1`/`0`, `true`/`false`,
  `Yes`/`No`. "Only message clients, never leads" is the guard stopping a lead
  receiving a login link for an account they do not have, so it gets confirmed
  rather than assumed. `raw_payload` plus the CRM's **Test webhook** button
  settles it.
- **Whether `%webhook_access_token%` is worth using.** FXBO can inject its own
  token; if it emits something verifiable that is better than a static shared
  secret. Decide after seeing one real delivery.

The parameter table itself is no longer an open question — it was read in full
on 2026-10-09 and §2 reflects it.

Enabling *Save request snapshot for assistant rule webhooks* makes bodies visible
in Webhook Stats, which helps here — but it stores PII, so turn it off again
after the acceptance test.

---

## 10. Admin view

A server-rendered page listing recent events with both statuses, so "did this
client get their welcome message?" is answerable without a database query.

**Deliberately not a React settings page.** The frontend build has not deployed
since 2026-09-25 — `dist/` is gitignored and the server never runs
`npm run build`, so a React page would be invisible until that is fixed. A
server-rendered route (the `account-alerts.html` pattern) ships with the backend.

Behind `authRequired, adminOnly`, the pair the report routes already use.
`/account-alerts.html` is cited above for *server-rendered rather than React*,
not for its access control — it is a static `sendFile` with no guard at all, and
this page holds client PII. Phone numbers and email addresses masked in the
listing.

---

## 11. Configuration

| Variable | Notes |
|---|---|
| `CRM_WEBHOOK_SECRET` | Required. Unset → reject everything |
| `WA_API_KEY` | Unset → WhatsApp skipped silently |
| `WA_TEMPLATE_NAME` | `registration_client_v3` |
| `WA_TEMPLATE_LANGUAGE` | `en` |
| `WA_TEMPLATE_BODY_PARAM` | `https://skylinkscapital.com/en/login/` |
| `WA_TEMPLATE_BUTTON_URL` | `https://skylinkscapital.com/en/login/` |
| `WA_FROM_NUMBER` | `+971507192185` |
| `WA_MAX_ATTEMPTS` | `3` |
| `BREVO_API_KEY` | Already set. Unset → Brevo skipped silently |
| `BREVO_LIST_ID` | `19` — "All Clients" |
| `SKIP_SOURCES` | Comma-separated `%custom_formname%` values never messaged |

Never logged: `WA_API_KEY`, `BREVO_API_KEY`, `CRM_WEBHOOK_SECRET`. Never logged
in plain text: full phone numbers, full email addresses.

---

## 12. Testing

**Pure units, tested directly:** normalisation and the invalid-payload path; the
phone regex at both ends of its range (`+12345678` accepted at 8 digits,
`+123456789012345` at 15, `+1234567` and `+1234567890123456` rejected) and
rejecting a leading zero (`+0123456789`); all six failure
statuses case-insensitively; a 2xx-with-`FAILED` body classified as permanent;
429 and 5xx classified as retryable; each skip rule; `SKIP_SOURCES` matching.

**Integration:** a second identical POST inserts nothing and sends nothing.

**Acceptance (manual, the brief's):** one test webhook to a real number —
confirm the message arrives **on the handset**, not merely a 2xx; the contact
appears in Brevo; re-posting the identical webhook sends no second message.

---

## 13. Prerequisites, in order

1. Add the endpoint URL to *System Configuration → Assistant Webhooks List*.
2. Deploy the backend and recycle (`server.js` is in the app root, so iisnode's
   default watch covers it).
3. Create the new rule: event `Client registered`, method `Outcoming webhook`,
   POST, `Authorization` header, parameters per §2, "update parameters on retry"
   off, 401 out of the retry codes.
4. Run the acceptance test.
5. **Disable the WhatsApp send in the `slc-crm` WordPress plugin** (§3). Until
   this is done, every website signup gets two messages.

---

## 14. Out of scope

Backfilling clients who registered before this ships. Any CRM event other than
`Client registered` — including the lifecycle sync that would keep verification
and deposit state current in Brevo, which is its own project and would hang off
the `A client has been verified` and `First time deposit by client` events.
Changes to rule 25. Replacing the existing
`hook.php` mirror webhooks. Fixing the frontend build — noted in §10 because it
constrains the admin view, but it is a separate problem.
