# CRM events webhook — Meta CAPI + WhatsApp welcome + Brevo contact

**Date:** 2026-10-09, scope widened 2026-10-12, revised 2026-10-13,
first-deposit value added 2026-10-19
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

### So: parameters, and one REST call

The rules send the full parameter set, so nothing a placeholder can supply is
ever fetched.

~~Since `Purchase` no longer carries a value (§4), there is nothing left that a
placeholder cannot supply — so the service never calls the FXBO REST API, and an
outage there cannot stop a conversion, a message or a contact.~~ **Superseded
2026-10-19 (§4).** FXBO has no placeholder for the deposit amount, and Meta
refuses a `Purchase` that does not carry one, so the first-deposit stage makes
exactly one REST call: `POST /rest/transactions`. The consequence this paragraph
used to promise is now bounded rather than absolute — an FXBO REST outage stops
the **first-deposit** conversions on Meta and ChatGPT Ads, as `retrying` and
then `failed` rows an operator can resend. The four other stages, the WhatsApp
welcome and the Brevo contact are untouched by it.

`crmSignup/depositValue.js` holds that call. It reads `REST_PROXY_TARGET`,
`API_VERSION` and `API_TOKEN` — **the same three variables `server.js`'s `/rest`
proxy and `reports/reportShared.js` read**, so there is no fourth opinion about
where the CRM is or how to authenticate to it. The `/rest` base defaults to
`https://portal.skylinkscapital.com`. It is **not** `api.skylinkscapital.com`,
which is the trading backend, reached with a bearer exchanged from
`BACKEND_API_KEY`; either credential sent to the other host authenticates to
neither.

The query, and why each part of it is there:

```json
{ "fromUserId": 88214,
  "statuses": ["approved"],
  "transactionTypes": ["deposit"],
  "orders": [{ "field": "createdAt", "direction": "ASC" }],
  "segment": { "limit": 50, "offset": 0 } }
```

- **`POST`, not `GET`.** The OpenAPI specification (`CRM api doc.txt`, line
  3385) gives `/rest/transactions` a `post` operation taking a
  `TransactionListRequest` body. There is no `GET` form of the list; the only
  `GET` is `/rest/transactions/{id}`, which needs an id we do not have.
- **`fromUserId`** is the CRM user, which is what `crm_client_id` holds. Not
  `fromLoginSid`, a composite account id (`"2-154439"`) that one client owns
  several of. `agent/clientProfilingService.js` already reads a client's
  transactions this way.
- **`statuses: ["approved"]`** because a pending or declined deposit is not a
  conversion. Deliberately not configurable: a status list an environment
  variable could widen could book a declined deposit as revenue.
- **`transactionTypes: ["deposit"]`** is FXBO's own word for external client
  money arriving. The live vocabulary — `credit`, `deposit`, `ib transfer to
  account`, `ib transfer to account out`, `ib withdrawal`, `transfer in`,
  `transfer out`, `withdrawal` — is the one `reports/summaryCore.js` recorded
  from the first live weekly send. The returned rows are filtered on it again
  locally, so a server that ignored the filter cannot hand us a withdrawal.
- **`segment`** is the request's only required field.
- **`orders`** asks for the earliest first, and the earliest is **also chosen
  from the rows**. A server that quietly ignored the sort would hand us the
  client's *latest* deposit for their *first*-deposit conversion, and nothing
  about that answer would look wrong.

The fields read from `TransactionDefinition`, confirmed from the specification
rather than guessed: **`processedAmount`** with **`processedCurrency`**, falling
back to **`requestedAmount`** with **`requestedCurrency`**, plus `type` and
`createdAt` to choose the row. Each amount travels with **its own** currency and
the two pairs are never crossed — a deposit requested in EUR and processed in
USD would otherwise be reported as dollars labelled euros, a number Meta would
accept and bid against. The magnitude is taken, because direction comes from the
type and the CRM books some legs signed-negative (the same rule
`reports/summaryCore.js` applies to these rows). **Nothing else is read off the
transaction**: it also carries the client's comments, ticket and custom fields,
and none of that is stored or logged.

**`userFtd` is deliberately not used.** The request offers it, documented only
as "Transaction list by first time deposit", and
`reports/summaryCore.js` rejected it for reading two ways — it once put a
long-standing client under a "first ever deposit" heading. The stage already
tells us this is the first deposit; the query only has to find it.

**No new column and no new environment variable.** The amount is fetched at send
time and never stored: `signup_events` holds statistics, and a figure kept there
would be a second copy of FXBO's own ledger that nothing reconciles.

### `record_type` is derived, and derived cautiously

`"client"` only when `%client_is_lead%` is a recognised falsy literal (`0`,
`false`, `no`, `n`, `off`); `"lead"` for anything else — including absent,
empty, and any value we do not recognise, all of which mean *unknown* rather
than *client*.

~~The failure modes are not symmetric: a client who misses their welcome message
is a support ticket, a lead who receives a login link for an account that does
not exist is a complaint.~~ **That reasoning is superseded (2026-10-14, user's
call — §4).** The welcome message goes to leads as well now, so nothing is
gated on this verdict: `record_type` is a stored statistic. The cautious default
stays, because a statistic that claims `client` for a literal nobody recognises
is worse than one that admits doubt — but it is no longer the reason anybody
gets or misses a message, and a second test, `saysLead`, exists for the one
destination that does gate on lead/client. The two are deliberately **not** each
other's negation; §4 has the argument.

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
| `registered` | `Client registered` | `CompleteRegistration` | **yes**, lead or client | **yes**, clients only |
| `verified` | `A client has been verified` | `Client_Verified` | no | no |
| `live_account` | `Client opened new live account` | `TradingAccountOpened` | no | no |
| `first_deposit` | `First time deposit by client` | `Purchase` | no | no |

Meta fires at every stage. WhatsApp and Brevo fire only at `registered`; at
every other stage they are stored `skipped` with reason `stage not applicable`,
so the admin view shows a complete row rather than a blank.

The lead/client split in the last two columns was the other way round until
2026-10-14 — WhatsApp took clients only and Brevo took everyone. Both were
reversed that day (§4), and the two gates now fail in opposite directions on
purpose.

---

## 4. Decisions taken, with their reasons

Recorded so none of these later looks accidental.

**This becomes the only WhatsApp sender (2026-10-09).** The `slc-crm` WordPress
plugin currently sends the identical template on website signup. If FXBO also
fires `Client registered` for those people they receive two messages — the
stored row stops *CRM retries*, not *a second independent sender*. The
integration plan confirms the plugin's send is being removed. **It is a required
step, not a follow-up.**

**~~WhatsApp goes to clients only; a lead is skipped with `lead, not client`
(2026-10-09).~~ Superseded 2026-10-14 — see the next entry.** The reason given
was the approved template: its body and its button both point at
`https://skylinkscapital.com/en/login/`, and a lead has no account to log into.

**The welcome goes to leads as well as clients, on the same template
(2026-10-14, user's call).** The user was told the login link will not work for
a lead and chose to send anyway. No second template and no configuration for one
— the template is approved by Meta as it stands, and anything carrying a
different link would need its own approval.

So `decideWhatsappSkip` no longer takes a record type at all, and
**`record_type` gates no WhatsApp send.** What is left there is the funnel stage,
`WA_API_KEY`, the `SKIP_SOURCES` exclusion and the phone format — and the last
two apply to a lead exactly as to a client, so a lead with no usable number is
still `invalid phone number` rather than a send to nothing. The skip reason
`lead, not client` did not disappear with the gate: it moved to Brevo, three
entries below.

**~~This becomes the only sender of Meta conversion events (2026-10-12).~~
Superseded 2026-10-14 -- see the next entry.** The 12 October plan was that the
plugin drops `CompleteRegistration` and keeps only `PageView` and
`InitiateCheckout`, leaving this service the sole owner of every stage.

**The website pixel keeps `CompleteRegistration`; we send the other four
(2026-10-14, user's call).** The plugin is left alone apart from its DoubleTick
send, so it goes on firing `CompleteRegistration` in the browser, and
`decideMetaSkip` stops this service sending that stage. One owner per stage
still holds -- the owner of `registered` is now the pixel rather than us.

The usual alternative, firing both and letting Meta deduplicate on a shared
`event_id`, is not available: the pixel's id exists only in the page, ours
arrives from FXBO, and FXBO has no field that could carry the browser's value
across. Building one would mean changing the plugin, adding a CRM field and a
rule parameter -- more moving parts than the stage is worth.

The cost, recorded rather than hidden: `CompleteRegistration` is only ever as
complete as a browser pixel, so registrations from ad-blocked or
tracking-restricted browsers go unattributed for that step. The other four
stages are server-side and unaffected, which is the reason they stay here.
`META_EVENT_NAMES` still maps `registered`, so lifting the gate later is one
change rather than two.

A consequence worth knowing when reading the settings tab: **no single event
sends to all three destinations any more.** `registered` sends WhatsApp and
Brevo with Meta recorded as `skipped`; every other stage sends Meta with the
other two recorded `skipped`. A `registered` row still sitting at `pending` or
`retrying` for Meta when this deploys becomes `skipped` on its next sweep, and
its remaining Meta retries are abandoned.

The Lovable promo pages still send no conversion events at all. If either pixel
is later changed to fire a conversion for a stage we own, the assumption breaks
silently and the funnel double-counts.

**Brevo keeps the full attribute set (2026-10-12, user's call).** The
integration plan says "first name, last name, email. Nothing else." That was put
to the user against the 9 October decision and the wider set was kept. The nine
custom attributes created in Brevo on 2026-10-09 stand. Attribution and entity
fields cannot be backfilled after signup, which is the argument that decided it.
As shipped, `buildBrevoContact` sends the contact's email plus up to thirteen
attributes: Brevo's own `FIRSTNAME` and `LASTNAME`, the two reused ones `EXT_ID`
and `OPT_IN`, and the nine created on 9 October. An earlier draft of this section
said "twelve", which never matched any count of the code. `IS_TEST` is not among
them -- FXBO exposes no placeholder for it, so there is nothing to send and
nothing to create.

**Brevo is not gated on marketing consent (2026-10-12, user's call).** The
integration plan gates it; the 9 October decision does not, and was reaffirmed.
Everyone lands in Brevo with consent recorded as `OPT_IN`, which is Brevo's own
flag and which its double-opt-in and compliance tooling reads. Campaigns segment
on it. Revisit if the list is ever used for something a non-consenting client
should not receive.

**Brevo takes clients only (2026-10-14, user's call).** Until that day
`decideBrevoSkip` tested the API key and the stage and nothing else, so every
`registered` event became a contact, lead or client. It now carries the
`lead, not client` skip the WhatsApp gate used to.

**And the gate is a *positive lead test*, which is the part that matters.** It
skips only when the raw `%client_is_lead%` literal is one a new `LEAD_LITERALS`
set recognises (`1`, `true`, `yes`, `y`, `on`); absent, empty and anything
unrecognised **send**. It is deliberately not `record_type !== "client"`, which
looks like the same gate and behaves like its opposite:

- The wrong guess is not per-client. `deriveRecordType` resolves everything it
  does not recognise to `lead` (§2), so one unrecognised literal — a new FXBO
  version, a renamed field, a placeholder that stops rendering — would read
  **every** person as a lead and silently stop the Brevo list growing at all,
  with nothing erroring anywhere. §11 and CUTOVER step 5 exist because that
  literal genuinely cannot be known until the first live signup, so no
  destination may depend on having guessed it.
- The two failures are not comparable. A lead wrongly added to Brevo is one
  unwanted marketing contact, carrying `OPT_IN` and segmentable inside Brevo. A
  real client wrongly left out is marketing reach nobody can see was lost.

So this one fails toward **including** people, and the old WhatsApp gate failed
the other way for a reason that no longer applies. `deriveRecordType` is
unchanged — `record_type` is also stored as a statistic and has to keep meaning
what it means today — and the second test lives beside it as `saysLead`, with
the asymmetry written down in both places.

The cost, recorded rather than hidden: until the real lead literal is in
`LEAD_LITERALS`, every lead becomes a Brevo contact. That is the recoverable
direction, which is the whole point of choosing it.

**The verified stage sends a custom event, `Client_Verified` (2026-10-13,
user's call).** Not the standard `SubmitApplication`. Nothing needs creating in
Events Manager first — Meta registers an unrecognised `event_name` as a custom
event the moment it arrives. The consequence to know: custom events do not get
standard-event optimisation automatically, so optimising a campaign toward this
one means defining a **Custom Conversion** on it.

**~~`Purchase` carries no value or currency (2026-10-13, user's call).~~
SUPERSEDED 2026-10-19 — see the next entry.** The reason given was that it
removed the FXBO REST dependency entirely, along with the deposit columns and
the financial-category risk, and the trade-off was stated as: Meta learns that a
deposit happened but not what it was worth, so there is no return-on-ad-spend
measurement.

**`Purchase` carries `value` and `currency`, from FXBO (2026-10-19, user's
call).** **The trade-off the 13 October decision rested on does not exist.** Meta
does not merely fail to measure a valueless `Purchase` — it **refuses the event
outright**. Events Manager raised diagnostic
`s2s_invalid_purchase_event_actions`, detected 16 October, the day our first
conversions went out: *"The purchase event sent from your server is missing a
value parameter, so it can't be received or used for ads attribution or
optimisation. All purchase events must contain a value parameter and a currency
parameter."* **"Can't be received"** is literal. The Graph API answers `200` with
`events_received: 1`, our row records `sent`, and the conversion never exists.
Verified against the live dataset: three deposits sent, zero present.

So there was never a choice between *a conversion without its value* and *a
conversion with it*. There was a choice between *no conversion* and *the REST
call*, and the amount is a precondition of the send rather than an enrichment of
it.

Meta requires **both or neither**: a `Purchase` with one of the pair is the same
defect in a new shape. `metaValueFields` in `meta.js` is therefore one function
that can only return both or neither.

**ChatGPT Ads is done in the same change (2026-10-19),** reversing the deferral
in `2026-10-14-chatgpt-ads-conversions-design.md` §6, which already observed
that the call "would fix revenue attribution for Meta and ChatGPT Ads together".
Its `order_created` takes `amount` as an **integer in the currency's minor
unit** — $129.99 is `12999` — where Meta's `value` is the decimal `129.99` for
the same deposit. One lookup produces both, under names that carry the unit, and
the test fixture uses an amount where the two genuinely differ: a round number
would pass with the units crossed, and both platforms accept either without
complaint.

**What a failed lookup does, and why it is not a send.** A lookup that found
nothing settles the destination `retrying` and then `failed`, with a detail
naming the lookup — **never `sent`**, because a row reading `sent` for an event
Meta threw away is the whole of what is being fixed, and never `skipped`,
because a skip is a deliberate decision not to send and nothing decided this.
`failed` keeps the row's client data and is reachable by
`POST /api/crm-events/requeue`.

Two kinds of failure, bounded differently, for the reason
`decideBrevoListIdFailure` already distinguishes:

- **Retryable.** No deposit in FXBO yet, a 5xx, a timeout, an unreadable answer.
  The deposit webhook can beat FXBO's own transaction record into existence, so
  **retrying is right and skipping would be wrong**; three attempts five minutes
  apart bounds the wait at ten minutes.
- **Permanent.** A missing `API_TOKEN`, a client id that is not a number, a
  4xx, an amount of zero, a currency that is not an ISO code. None is different
  in five minutes, so the budget is not spent waiting for one.

**ChatGPT Ads is held back by the same gate although its `amount` is optional,
and that was a choice.** An unpriced `order_created` would be received and
counted. But OpenAI deduplicates on the event `id`, which is
`<crm_client_id>:<stage>` and identical on every retry and every resend — so an
unpriced conversion sent now is the **final** word on that deposit's value, and
no later send can correct it. That buys a conversion permanently worth zero, on
the one row where Meta's is being held for the same missing number, and leaves
the two platforms reporting one deposit as two different sums. The cost,
recorded rather than hidden: an FXBO outage lasting longer than the attempt
budget now costs ChatGPT Ads the conversion outright where it used to cost only
the amount — recoverable, because `failed` is resendable while the row is inside
OpenAI's own 7-day window.

**The call is on the first-deposit path and nowhere else.** One lookup per row,
asked for lazily after each step has decided its own skip and memoised so the
two destinations share one answer. It reuses `sendTimeout.js`, reads nothing off
the transaction but the amount and the currency, never throws, and never puts
the token in a URL.

**The table stores statistics, not client records, and scrubs the client data as
soon as all three destinations settle (2026-10-14, user's call — narrowed to
successes and skips later the same day, three entries below).** §6 left
retention as an open decision and the module README said so honestly: nothing
deleted or expired a row, so every name, email, phone and complete `raw_payload`
was kept for ever. The decision closes it. FXBO is the system of record for who a
client is; this table only has to answer "did client 48217 get their welcome
message?" and to recognise FXBO's redeliveries.

The client data is stored at all because the endpoint answers FXBO immediately
and sends afterwards, so the phone number and the email must survive from receipt
until all three destinations are done with, retries included — three attempts
five minutes apart. After that nothing needs them, except on a row whose
destination failed, which a resend needs them for (the entry three below).

Scrubbed: `first_name`, `middle_name`, `last_name`, `email`, `phone`,
`full_link`, `referer`, `raw_payload`. Three windows: the scrub runs the moment
all three statuses are `sent` or `skipped` (about a minute); an all-`invalid` row — a bad payload
or an FXBO test press, which never sent anything and never will — is deleted
whole after **7 days**; and any row still unscrubbed after **30 days** is
scrubbed regardless of its statuses, which catches rows that never settle because
`CRM_EVENTS_WORKER_ENABLED` was left off. Both windows are constants, not
configuration; the two periodic passes run from `sweepOnce` gated to once an hour
by an instant the sweep remembers, because §7's rule about timers applies to them
too.

Two corrections to the first implementation of that, both 2026-10-14. **The
settle scrub carries its own SQL precondition** — all three statuses final and
`scrubbed_at` still NULL, narrowed to successes and skips by the entry below —
rather than trusting the worker's in-memory copy of
the row: under the overlapped recycle of §7 two workers split the three claims,
so neither copy ever showed all three settled and neither scrubbed, which made
the thirty-day backstop the normal path for every recycle window instead of the
safety net it is. Both workers attempt it now, and the one that finishes last
wins. **And the backstop settles what it makes unsendable**, writing `failed`
with a detail saying the send was never attempted, because the send guard refuses
a scrubbed row for ever while nothing wrote a status saying so — a row left at
`pending` for the rest of the table's life poisons the one counter (§12) that
means "the dispatch worker is dead". `skipped` would be wrong: a skip is a
deliberate decision not to send.

Two columns deliberately survive the scrub. **`fbc`**, because it is captured at
signup and reused weeks later for the first-deposit conversion (§8), so scrubbing
it would send every later conversion to Meta with no ad attached and Meta would
accept all of them. **`crm_client_id`**, because it is half the dedupe key, and
without it a redelivery inserts a second row and sends a second welcome.
`entity`, `source` and the three `utm_*` columns stay as well: they are
segmentation, not identity, and they cannot be recovered from FXBO per funnel
stage after the fact.

`raw_payload` goes with the rest, and a new `is_lead_raw VARCHAR(32)` column
holds the raw `%client_is_lead%` literal in its place — `"0"`, `"false"`, `"1"`
or whatever FXBO renders. That literal is a flag, not client data, and it is the
one value `raw_payload` was being kept for: §11 and CUTOVER step 5 settle the
placeholder's contents by reading it. Since 2026-10-14 it is also read at send
time — Brevo's gate tests this column rather than `record_type` beside it — so
getting it wrong now costs a wrong `record_type` statistic and a Brevo contact
per lead, and **no longer stops anybody getting a WhatsApp message.** A second
new column,
`scrubbed_at`, makes the scrub auditable, tells the settings tab "scrubbed" apart
from "never had one", and gives the periodic queries something indexed to filter
on.

**The trade-off, recorded rather than hidden: the table can no longer be searched
by email or phone, because neither is retained.** A question of the form "which
row belongs to this address" has to be answered from FXBO, by client id. The
settings tab shows "scrubbed" in those columns rather than blank cells, so the
absence reads as the policy working rather than as a broken page.

**Only successes and deliberate skips are scrubbed; a failure keeps its client
data (2026-10-14, user's call).** Scrubbing on *any* final state scrubbed the
failures too. So a `failed` or `rejected` destination lost the name, the email
and the phone a resend needs about a minute after signup, and the clients were
permanently unrecoverable with a `failed` nobody could act on as the only trace —
which is the worst way for a misconfigured destination to behave, because the
misconfiguration is exactly the case that fails every row. A row is scrubbable
now only once **every** destination is `sent` or `skipped`; if any is `failed`,
`rejected` or `invalid`, the client data stays.

The 30-day backstop still catches those rows, and the user accepted that bound
explicitly. **The trade-off: recoverability bought at the price of holding client
data for up to 30 days on rows that failed.** A destination nobody ever fixes
therefore does not turn this table into a permanent store of client data; it only
widens the window from a minute to a month for the rows it broke.

That makes two sets of statuses, and conflating them is the mistake this is
written down to prevent. Both live in `crmSignup/settled.js`, named for the
question each answers: `SETTLED` (`sent`, `skipped`, `rejected`, `failed`,
`invalid`) is "do not attempt this action again", and `SCRUBBABLE` (`sent`,
`skipped`) is "this row is safe to forget". They fail in opposite directions and
only one of them is recoverable. The wide set where the narrow one belongs
**destroys data**: the scrub nulls a row a resend still needs. The narrow set
where the wide one belongs **re-sends**: a refused action reads as unfinished, is
claimed again, and the client gets a second WhatsApp welcome — the one message
with nothing deduplicating it (§8). The step skip in `worker.js` reads `SETTLED`;
the scrub and its SQL precondition read `SCRUBBABLE`; the backstop's "still
unsent" clause reads `SETTLED`, because built from the narrow one it would
overwrite a real refusal with its own `failed` and "never attempted". `settled.js`
refuses the drift at import rather than at deploy. `invalid` is outside
`SCRUBBABLE` and that changes nothing about those rows: all-`invalid` rows are
handled by the 7-day delete, not by the scrub.

What this decision does **not** include is the action that resets a kept row to
`pending` so it is claimed again. Keeping the data makes the resend possible; the
requeue itself is its own change — the next four entries.

**The resend is bulk, per destination (2026-10-14, user's call).** A control per
destination on the settings tab: "Resend 40 failed Brevo contacts". That matches
what actually happens — a wrong list id or a missing key breaks a window of
signups, the operator fixes the setting, and then clears the backlog in one
action. **Not per row**, which would be a page of forty buttons for one cause.
The count is shown before the action is committed, and it cannot come from the
per-destination counters beside it (§12): those follow the selected period and
they count scrubbed rows, which cannot be resent at all, so a button built on
them would promise 40 and deliver 12. `countResendableSends` answers the
question the control actually asks — `failed` or `rejected` **and** not scrubbed,
over the whole table — and returns the scrubbed half of the same set beside it,
out of one statement, so the shortfall adds up and the answer can name it.

`requeueFailedSends` sets one destination's status to `pending`, its attempt
count to `0` and its clock to `NULL`, with three preconditions in the statement
rather than in the caller — the same rule as the row claim and the scrub.
`scrubbed_at IS NULL`, because a requeued scrubbed row is claimed on every sweep,
refused by the send guard and never settles, so it sits at `pending` for the rest
of the table's life and poisons the one counter that means "the dispatch worker
is dead". The status filter, because a `sent` row put back to `pending` delivers a
second welcome. And the attempt reset, because `planRetry` reads the stored count:
at 3 of 3 the pre-send claim writes `failed` before the request even leaves, so
the tab shows a terminal failure while the request is in the air and one
transient 503 ends the resend instead of retrying it.

**WhatsApp is a separate, warned action (2026-10-14, user's call).** Meta
deduplicates on `event_id` and the Brevo upsert is idempotent, so resending those
two is safe and they share one control. WhatsApp is not safe: a `failed` or
`rejected` WhatsApp row **may already have reached the handset.** CUTOVER step 7
describes exactly that case — DoubleTick answers 2xx carrying a status outside our
allowlist, which §8 records as `rejected` on purpose so that the third value gets
found — and §8 is also where it is written down that this is the one message with
nothing deduplicating it. So WhatsApp gets its own control, its warning is visible
text rather than a tooltip, and it takes an explicit confirmation step. The real
fix for the CUTOVER step 7 row is adding the missing status value, not resending
it.

**The scope is `failed` and `rejected` (2026-10-14, user's call).** `rejected` is
included deliberately. A rejection is the provider refusing the request, which
sounds like the one thing not worth repeating — but Brevo's 400 for an attribute
that does not exist yet (§8) is a `rejected` that succeeds the moment the
attribute is created. The operator is pressing this because they fixed something,
and the system is in no position to second-guess which of the two they fixed.
`sent` and `skipped` are out — the first re-sends, and the second is a deliberate
decision not to send, so re-deciding it in bulk is not this action's business —
and `invalid` is out because there is nothing to send from such a row. That makes
a third set in `settled.js`, `REQUEUEABLE`, guarded at import beside the other
two; the three now partition `SETTLED` exactly, which a test pins so that a sixth
status lands in one of them on purpose.

`whatsapp_request_id` is **not** regenerated by a requeue, and the reasoning is
the reason rather than an oversight: if DoubleTick honours a repeated `messageId`,
reusing it means a resend of a message that genuinely never arrived still goes out
(DoubleTick never saw that id) while a resend of one that did arrive is
deduplicated — precisely the behaviour we want in both cases. Minting a fresh id
would guarantee the duplicate instead. Same reasoning as the over-width id being
truncated rather than nulled.

**The 30-day backstop stays absolute (2026-10-14, user's call),** measured from
signup, whatever happens to the row. No window extension for a resend. A row
scrubbed mid-resend is refused by the in-worker send guard, which sends nothing
and records why; and the answer's `alreadyScrubbed` is what tells an operator why
40 visible failures produced 12 resends. The bound accepted with the retention
decision is therefore still the bound.

`POST /api/crm-events/requeue` carries the destination as a body parameter, is
guarded with `authRequired` + `adminOnly` like the overview read, and is
deliberately **not** on `PUBLIC_API_ROUTES` — that list is for FXBO, which cannot
carry a session, and it is capped at six entries. An unknown destination is a 400
and is never defaulted. The route logs the action — the session user id with their
address masked, the destination, and the counts — because it triggers outbound
messages to clients and that needs an audit trail; no client data is in the line.
It kicks the worker afterwards, so the sends go promptly rather than waiting up to
a sweep.

**An unusable `BREVO_LIST_ID` is a failure at send time, not a contact in no
list (2026-10-14, user's call).** It failed open: unset, blank or non-numeric,
the contact was still created in Brevo but joined no list, while the row recorded
`sent`. Nobody would have found out until they opened list 19 to run a campaign
and found it short. Brevo is not called at all now, and the row records `failed`
with a detail naming the variable. **Terminal, not retryable:** a wrong
environment variable will not become right in five minutes, so three attempts
would be three identical non-attempts in the log. `failed` and not `rejected`
because Brevo never saw the request and `rejected` means the provider refused it
(§8); and not `skipped`, because a skip is a deliberate decision not to send and
this is a misconfiguration — the same reading the backstop's never-attempted
`failed` takes. With the decision above in place the row keeps its client data,
which is what makes the eventual resend possible.

**And `server.js` warns at startup when `BREVO_API_KEY` is set and the list id is
not usable (2026-10-14, user's call).** Beside the existing `CRM_WEBHOOK_SECRET`
warning, naming the variable and saying that every Brevo send will be recorded as
failed until it is fixed. It catches a typo before a single signup arrives, which
is the whole point. **Only when the API key is set:** with no key Brevo is
switched off entirely and recorded as "brevo not configured", so a warning about
its list would be noise on every boot of every install that does not use it. The
warning and the send-time gate read the one predicate (`isUsableBrevoListId`), so
a boot that calls the id fine and a send that then fails on it cannot happen.
Neither the key nor the list value is printed: the commonest way this variable
goes wrong is a paste from the line above it in `.env`.

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
  stats.js       pure: rows -> health, funnel counts, per-destination counters
  overviewRoute.js  GET /api/crm-events/overview, the JSON the settings tab reads
```

Plus `src/pages/settings/CrmEventsPage.tsx` — the settings tab itself (§12).

`normalise.js`, `clickId.js`, the payload builders and the outcome classifiers
are pure and tested directly. That is where the subtle bugs live: the
`messages[0].status` trap, the `fbc` wrapping, the hash normalisation, the phone
regex, and the two lead/client calls — `deriveRecordType` for the stored
statistic and `saysLead` for Brevo's gate, which are not each other's negation
(§4).

---

## 6. Table: `signup_events`

| Column | Why |
|---|---|
| `stage` | Which funnel moment this row is. `UNIQUE (crm_client_id, stage)` — a client legitimately has five rows, and a redelivery of one stage has one |
| `whatsapp_next_attempt_at` / `brevo_next_attempt_at` / `meta_next_attempt_at` | The retry clocks. This is what makes retries survive an IIS recycle — see §7 |
| `*_attempts`, one per action | The brief had a single `attempts`. One shared counter cannot carry three independent retry schedules |
| `fbc` | The assembled click identifier, **frozen at first write** — see §8 |
| `fxbo_unique_id` | Distinguishes a genuine FXBO redelivery from a real second event |
| `raw_payload` | The body as received. **Scrubbed once all three destinations are `sent` or `skipped` (2026-10-14)** — `is_lead_raw` below replaced the one use it was kept for |
| `is_lead_raw` | The raw `%client_is_lead%` literal, which survives the scrub. The first live delivery settles what the placeholder contains by reading this — and since 2026-10-14 Brevo's gate reads it too, so it is a live field and not only evidence |
| `scrubbed_at` | When the row's client data was removed, or NULL if it never was. Audited, read by the settings tab, and the leading column of the retention index |

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

**A failed store is the one case that should 5xx.** The 200 rule protects
against FXBO redelivering an event we already hold — so it applies the moment
the row exists, and not before. If the insert throws we hold nothing, FXBO's
retry engine is the only recovery available, and the composite unique key makes
a redelivery harmless. Answering 200 there drops the event permanently and
silently. That path returns **503** and logs the client id, stage and FXBO
unique id, so a lost event can at least be identified. Every other path,
including a duplicate, stays 200.

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

Every event also carries an **`event_id` of `<crm_client_id>:<stage>`**. Meta
deduplicates server events sharing an `event_id` and `event_name`, and we retry
transport errors and 5xx — so without one, a response lost after Meta had
already accepted the event would book the conversion twice on the retry. The id
is deliberately the same pair that is UNIQUE on our table: one id per real
funnel event, identical on every attempt at it.

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

Retry transport errors, 429, and 5xx. Also retry a response whose Graph
`error.code` is one of `1`, `2`, `4`, `17`, `32`, `341` or `613` — Meta's
throttling and transient-failure codes — **whatever HTTP status carries them**. Meta's own
rate-limiting guidance is that the status is not reliable and the error code is
what decides; these commonly arrive as a 400, which an
anything-else-is-permanent rule would silently drop.

A **2xx with no usable `events_received`** is retryable too: that shape means a
proxy answered rather than Meta, so the outcome is unknown rather than refused,
and the `event_id` makes a retry free of double-counting. An explicit
`events_received: 0` — Meta itself saying it took nothing — stays permanent,
because retrying would change nothing. Everything else stays permanent.

`custom_data` carries the two CRM constants, and on `first_deposit` the
deposit's `value` and `currency` as well (2026-10-19, §4 — superseding "the two
constants and nothing else", which rested on `Purchase` reporting that a deposit
happened and not its amount). The pair is attached by one function that can only
return both or neither, because Meta refuses an event carrying one of them
exactly as it refuses one carrying neither.

### WhatsApp (DoubleTick)

Runs only when **all** hold: stage is `registered`, phone matches
`/^\+[1-9]\d{7,14}$/`, `source` is not in `SKIP_SOURCES`, and `WA_API_KEY` is
set. Otherwise `skipped` with the reason stored.

**`record_type` is not among them (2026-10-14, §4).** A lead gets the same
template; the gate does not take a record type at all. The phone format and
`SKIP_SOURCES` apply to a lead exactly as they do to a client.

`POST https://public.doubletick.io/whatsapp/message/template`, header
`Authorization: <WA_API_KEY>` — **raw key, not `Bearer`**. Body as the brief
gives it: a `messages` array of one, each entry holding `content`
(`templateName`, `language`, `templateData.header/body/buttons`) and, as
siblings of `content`, `from`, `to` and `messageId`.

**The `messageId` is frozen per row, not fresh per attempt (2026-10-13).** The
brief said a fresh UUID v4 on every attempt. That is wrong once sends are
bounded by a 10-second timeout: a timeout does not mean the message was not
sent, so a retry carrying a *new* id is a second welcome message to the client —
the duplicate the whole design exists to prevent. The id is generated once when
the row is stored, kept in `whatsapp_request_id`, and reused on every attempt,
exactly as `fbc` is.

DoubleTick's documentation describes `messageId` as optional and auto-generated
when omitted, and says nothing about how a repeated one is treated. So the
residual risk runs the other way: if they reject a replayed id, a retry fails
permanently rather than duplicating. That is the better failure — it is visible
in the admin view, and the client is never messaged twice. Settle it at cutover
with one deliberate retry.

**An HTTP 2xx does not mean sent.** It means accepted. The verdict is
`messages[0].status`, and these are failures, case-insensitively: `FAILED`,
`ERROR`, `REJECTED`, `UNDELIVERED`, `UNDELIVERABLE`, `INVALID`.

**Only `SENT` and `ENQUEUED` count as a send.** DoubleTick changed this value
and did not update its API reference: the reference still shows `SENT`, while
their help article records that template sends now return `ENQUEUED`. Both are
allowed, because we do not know which this account's plan returns. Had we
allowed only the documented `SENT`, every welcome message would have been
recorded as rejected while arriving perfectly well.

**A status outside that pair is also not a send (2026-10-13).** The brief
enumerated six failure values, which makes a denylist: anything else — a status
DoubleTick adds later, or one we never knew about — would read as a successful
send. That is the same silent failure this section exists to prevent, moved one
step along, so an unrecognised status is recorded as `rejected` with the value
itself in the detail.

It is deliberately **not** retryable. A status we do not understand may well
mean the message was delivered, and retrying would send the client a second
welcome. The worst case this way is a row marked rejected for a message that
arrived — visible in the admin view, harmless to the client. The worst case the
other way is a client who silently never hears from us while every count reads
healthy.

Retry transport errors, 408, 429 and 5xx. A Request Timeout is transient by
definition and is exactly the case a retry fixes. Any other non-2xx, and any 2xx
carrying a failure or unrecognised status, is permanent — retrying an unapproved
template or a bad key only burns attempts and delays the alert.

### Brevo

`POST /v3/contacts` with `updateEnabled: true` and `listIds: [19]` ("All
Clients"), at the `registered` stage only, and **to clients only since
2026-10-14 (§4)** — a lead is `skipped` with `lead, not client`. That gate is a
positive test on the raw `%client_is_lead%` literal, so an unrecognised value
adds the contact rather than emptying the list; §4 has the argument, and it is
the one thing here not to "simplify" into `record_type !== "client"`.

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

**An unusable `BREVO_LIST_ID` is a `failed` send, decided before the request
(2026-10-14, §4).** Unset, blank or not a positive number: nothing is posted, and
the detail names the variable. Terminal, so no attempt is spent and no clock is
set. It used to fail open — a contact created in no list, recorded as `sent`.

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

That is the webhook. The two admin routes — the overview read and the requeue
write (§4, §12) — are session-gated instead, with `authRequired, adminOnly`, and
are **not** on `PUBLIC_API_ROUTES`: that allow-list exists for FXBO, which cannot
carry a session, and it is capped at six entries. The requeue route is the one
place a person can cause a send, which is why it is also the one place in this
module that writes an audit line.

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
  both visible in `is_lead_raw` (§4, 2026-10-14 — `raw_payload` is scrubbed).
  Both halves are wanted now: the client literal for `CLIENT_LITERALS` and the
  lead literal for `LEAD_LITERALS`. Neither can stop a message or empty a list
  any more (§4), so this is no longer a blocker — it is a wrong `record_type`
  statistic and a Brevo contact per lead until it is known.
- **Whether `Client registered` also fires for leads.** If it does,
  `%client_is_lead%` is doing real work — and since 2026-10-14 the work is
  entirely Brevo's: those leads get the WhatsApp welcome either way, and the
  question is only whether they land in the marketing list. Test before asking
  FXBO for anything.
- **A reliable lead-creation trigger.** The dropdown offers only
  `A new lead has been assigned to you` and `A lead has been assigned to other
  manager` — both assignment, not creation. The `lead` stage ships last and may
  need FXBO to add a trigger.

Enabling *Save request snapshot for assistant rule webhooks* makes bodies
visible in Webhook Stats, which helps — but it stores PII, so turn it off again
after testing.

---

## 12. The settings tab

A settings page at `/settings/crm-events`, following the pattern every other
settings page uses: one `src/pages/settings/CrmEventsPage.tsx`, lazy-loaded in
`App.tsx`, with a menu entry in `src/lib/permissions.ts`. It reads one JSON
endpoint, `GET /api/crm-events/overview`, and shows four things:

- **A health strip**, overall and **per stage**. The overall figure is when
  the last event of any kind arrived, with a warning after 72 hours. But the
  funnel runs five separate FXBO rules, and one global timestamp stays green
  while an individual rule is dead — the funnel count cannot reveal it either,
  since a 30-day total still shows a stage's pre-failure number for most of a
  month. So each stage reports its own last-seen and staleness. A stage that
  has fired and then gone quiet warns; one that has **never** fired says so
  and does not warn, because `lead` has no FXBO trigger yet and a tab
  permanently red for a reason nobody can fix is a tab people stop reading.
  This is the panel that catches a silently broken rule, and an empty window
  reports stale rather than healthy.
- **Funnel counts** — how many at each stage over the period, zeroes included,
  because a zero says that stage's rule is not firing.
- **Per-destination counters** — sent / failed / rejected / retrying / skipped
  for Meta, WhatsApp and Brevo separately.
- **The events table** — masked email and phone, the stage, and all three
  statuses with their reasons. Filterable by stage, and by problems only.
- **Two resend controls** (§4, 2026-10-14) — one for Meta and Brevo together,
  one for WhatsApp with its duplicate-welcome warning in visible text and a
  confirmation step. Each shows how many rows it would resend, from the
  overview's own `requeue` field and **not** from the counters above it: those
  are the window's and they count scrubbed rows. This is the page's only write.

Both the endpoint and the page sit behind `authRequired, adminOnly`, the pair
the report routes already use. The counts cover the whole window; only the table
is capped, so a busy month still reports an accurate funnel.

**Prerequisite.** The page is invisible until someone runs `npm run build` on
the server. Verified 2026-10-13: the deployed bundle was built 2026-10-01 13:39,
while that day's two frontend commits landed at 16:24 — the last build predates
them, and nothing rebuilds on push. One command, but not an optional one.

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
| `BREVO_LIST_ID` | `19` — "All Clients". Unset, blank or not a positive number → Brevo is **not called** and the row records `failed`; warned about at startup when `BREVO_API_KEY` is set |
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
under Test events within minutes and touch no real data. Check that
`Client_Verified` shows up as a custom event. Then one real registration: the WhatsApp message **arrives on a handset**, not
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
4. Run `npm ci && npm run build` on the server and recycle, or the settings
   tab will not appear (§12).
5. Run the acceptance tests.
6. **Disable the WhatsApp send and the `CompleteRegistration` pixel event in the
   `slc-crm` WordPress plugin.** Until this is done, every website signup gets
   two WhatsApp messages and two Meta conversions.
7. Switch off FXBO's own Meta integration once this is live.

---

## 16. Out of scope

Backfilling clients who registered before this ships. The `Website` custom-field
fix on the Lovable promo pages — needed for ClickID on those 250 leads, but it
is their change, not ours. Replacing the `hook.php` mirror webhooks. Changes to
rules 25 and 42. The two WordPress plugin bugs (the UAE popup dropping the query
string, and the staging redirect to production). Fixing the frontend build —
noted in §12 because it constrains the admin view, but it is a separate problem.
