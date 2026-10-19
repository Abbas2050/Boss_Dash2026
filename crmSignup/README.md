# crmSignup

Receives FXBO webhooks at five points in the client funnel, stores each once,
then independently sends a Meta Conversions API event, a DoubleTick WhatsApp
welcome, a Brevo contact, and an OpenAI conversion for ChatGPT Ads.

Design: `../docs/superpowers/specs/2026-10-09-crm-signup-webhook-design.md`
ChatGPT Ads: `../docs/superpowers/specs/2026-10-14-chatgpt-ads-conversions-design.md`

Configuration: the "CRM events webhook" block at the end of `../.env.example`.

## What each stage sends

| Stage | Meta event | WhatsApp | Brevo | ChatGPT Ads event (`data.type`) |
|---|---|---|---|---|
| `lead` | `Lead` | no | no | `lead_created` (`customer_action`) — blocked upstream, no FXBO trigger |
| `registered` | **not sent** -- the website pixel owns it | yes, to anyone with a valid phone, lead or client | yes, to clients only | **not sent** -- the website pixel owns it |
| `verified` | `Client_Verified` | no | no | `custom`, `custom_event_name: client_verified` (`custom`) |
| `live_account` | `TradingAccountOpened` | no | no | `custom`, `custom_event_name: live_account_opened` (`custom`) |
| `first_deposit` | `Purchase` + `value`/`currency` | no | no | `order_created` + `amount`/`currency` (`contents`) |

**No single event sends to all four.** `registered` sends WhatsApp and Brevo;
every other stage sends Meta and ChatGPT Ads together, and nothing else.

**`data.type` is the data *family*, not the event name**, and a mismatched pair
is rejected — so the family is never written beside an event name in code. It is
looked up from the one table in `openai.js` that holds all thirteen of OpenAI's
event names. The column above repeats it only to be read.

**`first_deposit` carries the deposit's value on both platforms (2026-10-19,
user's call), and that is the one stage that calls FXBO.** It supersedes the
13/14 October decisions to send no amount, which rested on a trade-off that does
not exist: Meta does not merely fail to measure a valueless `Purchase`, it
**discards** it. See "The deposit value" below — that section is the one to read
before touching anything on this stage.

**The lead/client split applies to Brevo and not to WhatsApp (2026-10-14, user's
call).** It was the other way round until that date. The two gates fail in
opposite directions on purpose — see "which way each gate fails" below.

A destination that does not apply is stored as `skipped` with its reason, so a
processed row shows all four. FXBO has no trigger for `lead` yet (spec section
11).

`registered` is mapped to `CompleteRegistration` in `META_EVENT_NAMES` but
deliberately not sent: the WordPress signup plugin keeps firing that event as a
browser pixel, and sending it from here as well would book one registration as
two conversions. See `decideMetaSkip` in `meta.js` for why deduplicating instead
is not available to us. The mapping stays complete so that lifting the gate is
one change rather than two.

## Routes

| Route | Guard |
|---|---|
| `POST /api/crm-events` | `CRM_WEBHOOK_SECRET` in the `Authorization` header, as the whole header value: `Bearer <secret>` is rejected, and an unset secret rejects everything. On the `PUBLIC_API_ROUTES` allow-list because FXBO cannot carry a session. |
| `GET /api/crm-events/overview` | `authRequired` + `adminOnly` (`canManageUsers`, otherwise 403). Takes `?days=` (1 to 90, default 30). Feeds the settings tab, whose menu entry (`/settings/crm-events`, `admin` group) requires `Settings` + `Auth:ManageUsers`. A per-page `Settings:crm-events` access chip also opens the tab, but does not satisfy the endpoint's gate. |
| `POST /api/crm-events/requeue` | `authRequired` + `adminOnly`, the same pair. Body `{"destination": "meta" \| "whatsapp" \| "brevo" \| "openai"}`; an unknown one is a 400 and is never defaulted. Puts that destination's `failed` and `rejected` rows back to `pending`, logs who asked, kicks the worker, and answers `{destination, requeued, alreadyScrubbed, expired}`. `expired` is OpenAI's alone and is a literal `0` for the other three: it is the failures still holding their client data that OpenAI refuses on their age. Together the three numbers account for every failure a destination has, which is the whole of the difference between what a card shows and what a press delivers. See "Resending a failure" below. |

| `POST /api/crm-events/whatsapp-status` | **None, deliberately.** DoubleTick's `MESSAGE_STATUS_UPDATE` webhook carries no signature and no secret header, and there is no endpoint to ask a message's status instead (verified 2026-10-16). The capability is the `whatsapp_request_id` on the row -- a UUID v4 we generate at insert and freeze -- which the one statement behind this route matches on exactly. Guessing a v4 UUID buys the three `whatsapp_delivery_*` columns of one row: marking one message delivered, read or failed. It sends nothing, requeues nothing, writes no status the worker reads, and answers `200 {"ok":true}` to everything, so it cannot be used to discover which ids exist. On `PUBLIC_API_ROUTES`, which is now **full at six**. See "Proving a message arrived" below. |

The stage is a **body parameter**, not a path segment, and all five rules post
to the one path. `auth/requireSession.js` matches its allow-list against actual
request paths, so a `:stage` pattern would never match; and the list is capped
at six entries by `auth/routeCoverage.test.js`. The requeue route's destination
is a body parameter for the same reason, even though that route is session-gated
and deliberately **not** on the allow-list: the allow-list is for FXBO, which
cannot carry a session.

## The deposit value

**Meta does not reject a `Purchase` with no value — it discards it.** The Graph
API answers `200` with `events_received: 1`, the row records `sent`, and the
conversion never reaches the dataset. Events Manager says so under diagnostic
`s2s_invalid_purchase_event_actions`, detected 16 October, the day our first
conversions went out: three deposits sent, zero present. *"All purchase events
must contain a value parameter and a currency parameter."*

So on this one stage the amount is a **precondition of the send**, not an
enrichment of it, and `crmSignup/depositValue.js` fetches it from FXBO:

    POST <REST_PROXY_TARGET>/rest/transactions?version=<API_VERSION>
    Authorization: Bearer <API_TOKEN>

    { "fromUserId": <crm_client_id>, "statuses": ["approved"],
      "transactionTypes": ["deposit"],
      "orders": [{ "field": "createdAt", "direction": "ASC" }],
      "segment": { "limit": 50, "offset": 0 } }

Read from the answer: `processedAmount` with `processedCurrency`, falling back to
`requestedAmount` with `requestedCurrency`, plus `type` and `createdAt` to pick
the row. **Nothing else** — the transaction also carries the client's comments,
ticket and custom fields, and none of that is stored or logged.

**`POST`, not `GET`** (`CRM api doc.txt` line 3385 — the list has no `GET`
form). **`REST_PROXY_TARGET` + `API_TOKEN`, not `api.skylinkscapital.com` +
`BACKEND_API_KEY`**: those are the trading backend's, and either credential sent
to the other host authenticates to neither. The three variables are the same
ones `server.js`'s `/rest` proxy and `reports/reportShared.js` read, so there is
no fourth opinion about where the CRM is. **No new column and no new variable.**

Five things in that one call that look like style and are not:

- **Each amount travels with its own currency.** A deposit requested in EUR and
  processed in USD, reported as dollars labelled euros, is a number Meta accepts
  and bids against.
- **The earliest deposit is chosen from the rows, not trusted from `orders`.** A
  server that ignored the sort would hand us the client's *latest* deposit for
  their *first*-deposit conversion, and nothing about that answer would look
  wrong.
- **`statuses: ["approved"]` is a constant, not a setting.** A status list an
  environment variable could widen could book a declined deposit as revenue.
- **`userFtd` is deliberately unused.** It is documented only as "Transaction
  list by first time deposit", reads two ways, and once put a long-standing
  client under a "first ever deposit" heading in the weekly summary
  (`reports/summaryCore.js` says so). The stage already tells us this is the
  first deposit.
- **The minor-unit digits come from a table.** ISO 4217 gives JPY zero and KWD
  three; assuming two is a hundredfold error, not a rounding one.

**A failed lookup is never `sent`, and never `skipped`.** `sent` would be the
exact lie this change removes; `skipped` is final and nothing decided it. The
destination records `retrying` and then `failed`, with a detail naming the
lookup, so the row keeps its client data and
`POST /api/crm-events/requeue` reaches it.

| Lookup failure | Bounded how | Why |
|---|---|---|
| No deposit in FXBO yet, 5xx, 408/429, timeout, unreadable answer | Retryable: 3 attempts five minutes apart, then `failed` | **The deposit webhook can arrive before FXBO's own transaction record is queryable.** Skipping a conversion over a few seconds' lag would be the wrong direction to fail in, and the attempt budget caps the wait at ten minutes. |
| No `API_TOKEN`, a non-numeric client id, 4xx, amount of zero, a currency that is not a 3-letter ISO code | `failed` at once, no attempt spent | None is different in five minutes, so waiting only delays the failure an operator has to act on — the same reasoning `decideBrevoListIdFailure` applies to an unusable list id. |

**ChatGPT Ads is held back by the same gate although its `amount` is optional,
and that was a decision rather than symmetry.** An unpriced `order_created`
would be received and counted. But OpenAI deduplicates on the event `id`
(`<crm_client_id>:<stage>`, identical on every retry and resend), so an unpriced
conversion sent now is the **final** word on that deposit's value — a conversion
permanently worth zero, on the one row where Meta's is being held for the same
missing number, leaving the two platforms reporting one deposit as two different
sums. The cost, recorded rather than hidden: an FXBO outage longer than the
attempt budget now costs ChatGPT Ads the conversion outright where it used to
cost only the amount. `failed` is resendable inside OpenAI's 7-day window, which
is what makes that the recoverable direction.

**One call per row, and only on this stage.** The lookup is lazy — each step
decides its own skip first, so a row whose Meta and ChatGPT Ads steps are both
skipped or settled costs nothing — and memoised, so the two destinations share
one answer. It reuses `sendTimeout.js` for its bound (`CRM_SEND_TIMEOUT_MS`),
never throws, and a failure takes neither the worker nor the other destinations
with it.

## Ten things that are easy to get wrong

**Meta's `value` and ChatGPT Ads' `amount` are the same deposit in different
units, and no test you would naturally write could tell.** Meta wants the
decimal `129.99`; OpenAI wants the integer `12999`, the minor unit. Both
platforms accept either number without a word, so the only symptom of a swap is
a deposit reported a hundredfold, or a hundredth, in somebody else's dashboard.
`depositValue.js` therefore returns one object carrying both under names that
say which is which — `valueDecimal` and `amountMinor` — `metaValueFields` reads
only the first, `openaiAmountFields` only the second and refuses a non-integer,
and the fixtures use $129.99 because a round amount passes with the units
crossed. The decimal is **derived from** the integer, in one rounding, so the
two cannot drift.

**Both halves of each pair are attached by one function, and that is structural
rather than tidy.** Meta is explicit that a `Purchase` needs `value` **and**
`currency`, and it discards an event carrying one of them exactly as it discards
one carrying neither; OpenAI requires `currency` whenever `amount` is present.
Two `if`s at a call site are what make the half-filled event constructible, so
`metaValueFields` and `openaiAmountFields` can each only return both or nothing.


**The two lead/client gates fail in opposite directions, and copying one into
the other inverts it** — *which way each gate fails*. `deriveRecordType` in
`normalise.js` returns `"client"` only for a recognised client literal
(`CLIENT_LITERALS` = `0` `false` `no` `n` `off`); absent, empty and anything
unrecognised resolve to `"lead"`.

- **WhatsApp has no gate at all any more.** A lead gets the same template as a
  client. Its body and button both link to
  `https://skylinkscapital.com/en/login/`, which a lead has no account for; the
  user was told that and chose to send anyway (2026-10-14). There is no second
  template and no configuration for one. `record_type` therefore gates no
  WhatsApp send — the phone format and `SKIP_SOURCES` are the only facts about
  the person left in `decideWhatsappSkip`, and both apply to a lead exactly as
  they do to a client.
- **Brevo's gate is a *positive lead test*, not `recordType !== "client"`.**
  `decideBrevoSkip` skips only when the raw `%client_is_lead%` literal is one
  `LEAD_LITERALS` recognises (`1` `true` `yes` `y` `on`); absent, empty and
  unrecognised values all send.

The second one looks like a style choice and is not. `recordType !== "client"`
would read **every** person as a lead the moment FXBO sends one literal we do
not recognise — a new FXBO version, a renamed field, a placeholder that stops
rendering — and the Brevo list would silently stop growing, with nothing
erroring anywhere. The wrong guess is not per-client, which is what makes it
dangerous: `CUTOVER.md` step 5 exists precisely because that literal cannot be
known until the first live signup.

Weigh the two failures and they are not comparable. A lead wrongly added to
Brevo is one unwanted marketing contact, carrying `OPT_IN` and segmentable
inside Brevo. A real client wrongly left out is marketing reach nobody can see
was lost. So Brevo fails toward **including** them. The old WhatsApp gate failed
the other way for the reason that no longer applies: while leads were skipped,
guessing wrong cost a client their welcome message rather than sending a lead a
dead login link.

`deriveRecordType` itself is unchanged, and must stay that way: `record_type` is
stored as a statistic and has to keep meaning what it means today.

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

**OpenAI's phone rule is not Meta's, and no test you would naturally write
could tell.** OpenAI strips a leading `+` **and leading zeroes**; Meta's
`hashPhone` strips every non-digit and *keeps* leading zeroes. For every phone
this service can currently send the two produce an identical digest, because
`PHONE_RE` is `/^\+[1-9]\d{7,14}$/` — a stored phone always begins with a plus
followed by a non-zero digit, so there are never leading zeroes to strip, and
that regex already enforces OpenAI's own 8–15 digits. So calling Meta's helper
here would pass every realistic test, work against live data, and silently stop
matching the day `PHONE_RE` is loosened: a `0097150…` would be hashed with its
zeroes and never match again, with no error anywhere. `openai.js` therefore
writes OpenAI's rule on its own terms and `openai.test.js` pins it with a number
that *has* the zeroes, so the difference is exercised rather than assumed. The
**email** helper is also a second copy, for the opposite reason: that rule
genuinely is identical today, so a test asserts the two digests are equal — and
a divergence on either side then fails loudly instead of being inherited.

**OpenAI refuses a conversion more than 7 days old, which is a constraint on
retrying from database columns.** Their bound on `timestamp_ms` is "within the
last 7 days and no more than 10 minutes in the future", and that timestamp comes
from the row's `received_at`. An ordinary send, about a minute after signup, is
nowhere near it. A **resend** of a week-old failure is outside it — and
re-stamping the event with the current time is not available, because it would
claim the conversion happened today and saying when it happened is the row's
whole purpose. So the OpenAI step skips such a row with a reason naming the
window, `requeueFailedSends` will not match it, and `countResendableSends`
reports it as `expired` instead of promising it. The count and the skip are built
from the same two constants in `openai.js`, imported rather than restated: a
count built on 7 days beside a skip built on 6 is a button offering forty rows
and delivering none. The 10-minute future bound needs no handling, since
`received_at` is written by us on arrival — but a badly skewed server clock would
trip it, which is why that reason exists too.

**`registration_completed` is the website pixel's, exactly as
`CompleteRegistration` is.** Same decision, same day, same reason, taken
independently for each destination. OpenAI merges a browser event and a server
event into one conversion only when the pixel id, the event name **and** the id
all match — the pixel's `event_id` must equal our `id`. The pixel's id exists
only in the page; ours comes from FXBO, which has no field that could carry the
browser's value across. Sending both with different ids double counts, so one
owner per stage, and for the registration stage the owner is the browser. The
mapping in `OPENAI_EVENTS` stays complete so that lifting the gate is one change
rather than two, and `PIXEL_OWNED_STAGE` is its own constant rather than an
import from `meta.js` — lifting one gate must not silently lift the other. The
cost, recorded rather than hidden: that conversion is only ever as complete as a
browser pixel, so registrations from ad-blocked or tracking-restricted browsers
are unattributed for that step on both platforms. Every other stage is
server-side.

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
  final. Set `META_CAPI_ACCESS_TOKEN`, `WA_API_KEY`, `BREVO_API_KEY` and
  `OPENAI_CONVERSIONS_API_KEY` before pointing FXBO at the endpoint. Two more
  settings behave like keys without being one, and the startup log says so for
  both: `BREVO_LIST_ID`, where with the Brevo key set an unusable list id is a
  `failed` send rather than a skip, and `OPENAI_PIXEL_ID`, where with the OpenAI
  key set a missing pixel id is a `skipped` send — final, and unreachable by the
  resend, which is why it is warned about at boot.
- **`API_TOKEN` is a third such setting, and the `first_deposit` stage is the
  only thing here that needs it.** Unset, that stage's Meta and ChatGPT Ads
  sends record `failed` with a detail naming the variable — not `skipped`, so a
  resend reaches them once it is set. `server.js` already logs at startup that
  every `/rest` request will be refused without it, so the warning exists; what
  is new is that a conversion depends on it. The other four stages are
  unaffected.
- Two workers can run at once, and the host arranges exactly that during an
  overlapped recycle. The sweeper's `SELECT` takes no lock, so both read the
  same due rows; the pre-send write is the claim, and the one whose `UPDATE`
  matches no row sends nothing. Nothing here needs one Node process.
- The settings tab does not appear until someone has run `npm run build` on the
  server (spec section 12).

## What the table holds

**`signup_events` stores statistics, not client records (2026-10-14, user's
call).** FXBO is the system of record for who a client is. This table only has to
answer "did client 48217 get their welcome message?" and to recognise FXBO's
redeliveries.

The client's details are stored at all for one reason: the endpoint answers FXBO
immediately and sends afterwards, so the phone number and the email have to
survive from receipt until all four destinations are done with — including
across retries, which run up to three attempts five minutes apart, and including
a destination that failed, which a resend will need them for. After that, nothing
needs them.

**The scrub.** These eight columns are nulled and `scrubbed_at` is stamped:

    first_name, middle_name, last_name, email, phone,
    full_link, referer, raw_payload

`full_link` and `referer` are in that list because `full_link` carries the
`fbclid`, the `oppref` and the whole query string verbatim, and both are
redundant once `fbc`, `oppref` and the `utm_*` columns have been extracted from
them.

Everything else stays, because it is the statistics the table exists for:
`crm_client_id`, `stage`, `fxbo_unique_id`, `record_type`, `is_lead_raw`,
`marketing_consent`, `is_ib`, `entity`, `source`, `language`, the three `utm_*`
columns, `fbc`, `oppref`, `whatsapp_request_id`, every status / detail /
attempts / clock column, the four delivery-proof columns (`brevo_contact_id`,
`whatsapp_delivery_status`, `whatsapp_delivery_at`, `whatsapp_delivery_detail`
-- see "Proving a message arrived"), `received_at` and `updated_at`. `entity`, `source` and the `utm_*`
columns are segmentation, not identity, and FXBO cannot be asked for them per
funnel stage after the fact.

**Six of those are load-bearing, not merely kept:**

- **`fbc` deliberately survives.** It is captured at signup and reused weeks
  later for the first-deposit conversion. Scrubbing it would send every later
  conversion to Meta with no ad attached, and Meta would accept all of them
  without complaint.
- **`oppref` deliberately survives, for the same reasons as `fbc` and with one
  difference.** It is OpenAI's click identifier, extracted from `full_link` at
  the client's first event and reused weeks later for the first-deposit
  conversion — whose own `full_link` is normally empty, because that visit is
  not an ad click. OpenAI's Conversions API does not capture it, so without it a
  conversion cannot be attributed to the ad that produced it, and OpenAI would
  accept every unattributed one without complaint. The difference from `fbc`:
  it is sent **raw**, with no `fb.1.<ms>.` wrapper and no timestamp, so there is
  nothing about it to freeze beyond the value itself. Absent is normal — the
  event is still sent, simply unattributed.
- **`crm_client_id` deliberately survives.** It is half the dedupe key. Without
  it FXBO's redelivery of a stage no longer collides on
  `(crm_client_id, stage)`: it inserts a second row and sends a second welcome.
- **The four delivery-proof columns deliberately survive (2026-10-16), and for
  one of them the scrub would otherwise win the race.** None of them is client
  data: `brevo_contact_id` names a row in Brevo, and the WhatsApp three are a
  status word, an instant and DoubleTick's own failure message (masked on the
  way in like every other detail). `brevo_contact_id` has to survive because the
  question "did client 48217's contact really get created" is asked days later
  and Brevo mints an id only when it *creates*, so a scrubbed one can never be
  re-read. The `whatsapp_delivery_*` three are usually written **after** the
  scrub -- DoubleTick's webhook is minutes behind a send that settles in about
  one -- which is also why `recordWhatsappDelivery` is the one write in
  `store.js` with no `scrubbed_at IS NULL` precondition. With one, nearly every
  delivery report we ever receive would be thrown away.
- **`is_lead_raw` deliberately survives, and since 2026-10-14 it is read at send
  time rather than only by a person.** Brevo's gate tests this literal, not
  `record_type` beside it. A requeued `failed` Brevo row is sent from the row,
  so the column has to be there when the resend runs — which it is, because the
  scrub leaves it and the send guard refuses a scrubbed row anyway.

**When it happens.** Three paths, in `worker.js`:

| | When | What |
|---|---|---|
| Settle | As soon as all four destinations have **succeeded or been deliberately skipped** (`sent` or `skipped`) — normally about a minute after signup | Scrub |
| Invalid | `received_at` older than **7 days**, and all four statuses `invalid` | The whole row is deleted |
| Backstop | `received_at` older than **30 days** and `scrubbed_at` still NULL | Scrub, whatever the statuses say, and settle whatever is still unsent as `failed` |

Both windows are constants in `worker.js`, not environment variables. The two
periodic passes run from `sweepOnce`, gated to at most once an hour by an instant
the sweep remembers — not a timer, for the reason every other clock here lives in
a column.

An **invalid** row — an unparseable payload or an FXBO "Test webhook" press — is
settled at insert and never reaches the worker, so the settle path never sees it.
That is deliberate: those rows never sent anything and never will, and they are
the rows CUTOVER step 5 reads, so they keep everything including `raw_payload`
for their 7 days and then go whole.

**A failed or rejected row keeps its client data (2026-10-14, user's call).**
Scrubbing on *any* final state meant a row whose destination was misconfigured
was scrubbed the minute it failed, and the name, email and phone a resend needs
were gone for good — so the clients were permanently unrecoverable, with a
`failed` nobody could act on as the only trace. `BREVO_LIST_ID` is the concrete
case. So a row is scrubbable only once **every** destination is `sent` or
`skipped`; if any is `failed`, `rejected` or `invalid`, the client data stays
until the send is retried or the 30-day backstop takes it. The backstop is what
bounds that: a destination nobody ever fixes still does not make this table a
permanent store of client data.

That makes more than one set of statuses, and conflating them is the mistake to
avoid — all three live in `settled.js`, named for the question each answers:

| Set | Question | Members |
|---|---|---|
| `SETTLED` | do not attempt this action again | `sent`, `skipped`, `rejected`, `failed`, `invalid` |
| `SCRUBBABLE` | this row is safe to forget | `sent`, `skipped` |
| `REQUEUEABLE` | may an operator ask for this one again | `failed`, `rejected` |

The three partition `SETTLED` exactly — `SCRUBBABLE`, `REQUEUEABLE`, and
`invalid` on its own — which a test pins, so a sixth status added later lands in
one of them deliberately rather than defaulting into whichever list was edited
first.

They fail in opposite directions and only one of them is recoverable. The wide
set where the narrow one belongs **destroys data**: the scrub nulls a row a
resend still needs. The narrow set where the wide one belongs **re-sends**: a
refused action reads as unfinished, is claimed again, and the client gets a
second WhatsApp welcome. The step skip in `worker.js` reads `SETTLED`; the scrub
and its SQL precondition read `SCRUBBABLE`; the backstop's "still unsent" clause
reads `SETTLED`, because built from the narrow one it would overwrite a real
refusal with its own `failed`.

`invalid` is excluded from `SCRUBBABLE` and that changes nothing about those
rows: an all-`invalid` row is handled by the 7-day delete, not by the scrub.

**The settle path asks the row, not the worker.** The `UPDATE` carries its own
precondition — all four statuses scrubbable, `scrubbed_at` still NULL — so it is
correct whatever the worker believes (`scrubbableClause` in `store.js`, the same
lesson as the row claim above). The worker's own check decides only whether to
try, so the ordinary row still costs one statement. It matters during an
overlapped recycle: when two workers split the four claims, neither one's copy
of the row ever shows all four settled, and a scrub decided from the copy alone
happened in neither — the row waited the full thirty days in exactly the case
this policy reduces to a minute. Both attempt it now, the earlier attempt matches
nothing, and the one that finishes last scrubs.

The **backstop** catches rows the settle path never reaches: a worker left off by
`CRM_EVENTS_WORKER_ENABLED`, or a row whose scrub could not be written in the
moment it settled. It also **settles what it makes unsendable**: a destination
still `pending` or `retrying` is written `failed`, with a detail saying the send
was never attempted because the data it needed is gone. Without that the row
reads `pending` for the rest of the table's life — and `pending` piling up is the
one signal that means the dispatch worker is dead, so a single row stuck there
makes the number an operator would check unusable. `failed` rather than `skipped`:
a skip is a deliberate decision not to send, and nothing decided this.

**The cost, recorded rather than hidden:** the table can no longer be searched by
email or phone, because neither is retained. `is_lead_raw` holds the raw
`%client_is_lead%` literal so that CUTOVER step 5 still works without
`raw_payload` — and, since 2026-10-14, so that Brevo's gate has a literal to
test; `scrubbed_at` is what lets the settings tab tell a scrubbed row apart from
one that never carried the value.

## Proving a message arrived

**A status and an HTTP code are not evidence.** The tab used to read
`WhatsApp sent — ENQUEUED` and `Brevo sent — http 201` for a real client, and
neither says anything landed: `ENQUEUED` is DoubleTick's own queue, and `201` is
a transport code rather than a contact anybody can point at. Four columns exist
to close that gap (2026-10-16), and none of them is a status — nothing sends from
them, retries on them or scrubs them. They are evidence.

**Brevo: `brevo_contact_id`.** The create call returns an `id`, which names a
row in Brevo that can be opened. `classifyBrevoOutcome` reads it off a 2xx and
only off a 2xx — Brevo's 409 for a duplicate quotes the existing contact's id in
its message, and recording that beside a `rejected` would be proof of a contact
this call did not make.

**A 2xx with no id is not a failure.** `updateEnabled: true` makes the call an
upsert and Brevo mints an id only when it *creates*, so a returning client's
update legitimately returns none — exactly the case where the contact is
certainly there. Turning that into a failure would offer a resend for every
repeat registration. The detail says which of the two happened
(`no contact id (an update returns none)`), because a blank proof column has to
be tellable from a proof we failed to read. The id is *not* repeated in the
detail of a success: it has a column of its own and the tab prints both.

The column is written through `COALESCE`, and that is not decoration.
`updateBrevoStatus` runs twice per send — the pre-send claim, which cannot know
an id yet, and then the outcome. Written plainly, a later claim (a resend, a
sweep that found the row due again) would null the proof of a contact that
exists, and nothing would put it back.

**WhatsApp: there is no equivalent, and no endpoint to ask.** Verified against
DoubleTick's documentation on 2026-10-16: a message's status arrives **only** by
their `MESSAGE_STATUS_UPDATE` webhook.

- `https://learn.doubletick.io/webhooks-and-public-api/webhooks/how-to-use-message-status-update-webhook`
- `https://docs.doubletick.io/reference/messaging-webhooks-1`

The payload carries `messageId`, `status`, `statusTimestamp` and `failMessage`.
`whatsappStatus.js` reads it, `whatsappStatusRoute.js` answers it, and
`recordWhatsappDelivery` stores it. Registration is manual, in DoubleTick's UI —
CUTOVER step 7b.

**Why the endpoint takes no shared secret.** Their webhook has none to send: no
signature, no secret header, nothing to verify. The alternatives were to refuse
the feature or to invent a secret they cannot carry. What exists instead is
already in the request — `whatsapp_request_id` is a UUID v4 we generate at
insert and freeze, and the one statement behind the route matches on it exactly.
**The id is the capability.** Guessing a v4 UUID reaches one row, and the worst
possible effect is marking one message delivered, read or failed. The endpoint
sends nothing, requeues nothing, and writes no column the worker reads — the
claim, the scrub precondition, the backstop and the resend all read
`whatsapp_status`, which is not in that statement.

It answers `200 {"ok":true}` to everything: a known id, an unknown id, a body it
could not read, a database that is down. Answering differently when a guess
landed would make it an oracle for which ids exist, which is how a capability
stops being one.

**The secret is also not in the path or the query string, and that is the same
decision twice.** The existing `hook.php` mirrors put theirs in the URL, where
it is readable in the CRM's own webhook log and in every proxy log in between. A
secret printed on every delivery is worse than none, because it looks like
authentication. For the same reason the log lines here carry eight characters of
the id and never the whole of it.

**Two things their documentation does not settle, handled rather than guessed:**

- **The read status string is undocumented.** It is described in prose; the exact
  value is written down nowhere. So the status is stored **verbatim** and the
  display is derived from it: `DELIVERED` and `READ` are matched
  case-insensitively, `FAILED` moves the symbol the other way, and anything else
  leaves the symbol alone and prints as itself. Nothing hardcodes a guess as the
  only read value — an allowlist built on one would drop the real string
  silently, which is the `SENT`/`ENQUEUED` trap above moved one step along. An
  unrecognised value also gets a log line naming it, so it is found without
  anyone opening the tab.
- **Whether `messageId` is ours is unverified.** Their docs do not say whether
  the id on this event is the one we supplied or one they generate. Nothing
  guesses: `recordWhatsappDelivery` reports how many rows it matched, and a
  status that matched **no** row is logged as
  `whatsapp status for an id we never issued`, with a running count of how many
  have done so since the worker started. Once is a shape surprise; every time is
  the answer, and the line says so. The first id that *does* match is logged once
  as `whatsapp status matched the id we froze`. One real message settles it
  either way, in the iisnode stdout log that CUTOVER step 2 reads.

**The tab shows four symbols, not two.** `✓` sent, `✗` failed/rejected/invalid,
`–` skipped, `⋯` pending/retrying, plus `?` for a status the page has never
heard of. A cross on `skipped` would be wrong and would mislead daily: Meta and
ChatGPT Ads are skipped on **every** registration by design, and a dashboard
with a permanent red column is one people stop reading. The symbol leads, the
status word follows it, and the reason sits under both — all as text, never a
`title`, because this page is read on a phone where there is no hover.
WhatsApp's symbol shows the best known truth: a row DoubleTick has reported
delivered or read says so, one it reports failed shows a cross however the send
was recorded, and one still waiting says `no delivery report yet` rather than
letting a tick imply a handset.

## Resending a failure

Keeping a failed row's client data only made the resend possible. **Nothing in
the worker can retry it**: the step skip reads `SETTLED`, so a `failed` or
`rejected` destination is never claimed again however due its clock is. The
resend is an operator action, on the settings tab, through
`POST /api/crm-events/requeue`.

**Bulk, per destination (2026-10-14, user's call).** That is the shape of the
problem: a wrong list id or a missing key breaks a window of signups, and the
operator fixes the setting and then clears the backlog in one action. There is no
per-row resend. The count is shown on the control before it is pressed.

`requeueFailedSends` sets one destination's status to `pending`, its attempt
count to `0` and its clock to `NULL`. Three preconditions, all in the statement:

- **`scrubbed_at IS NULL`.** A scrubbed row has no client data left. Requeued, it
  is claimed on every sweep, refused by the send guard, and never settles —
  `pending` for the rest of the table's life, which poisons the one counter that
  means "the dispatch worker is dead".
- **`failed` and `rejected` only** (`REQUEUEABLE` in `settled.js`). A `sent` row
  must be untouchable by this path: it would deliver a second welcome.
- **The attempt count back to 0.** `planRetry` reads the stored count, so a row
  left at 3 of 3 is written `failed` by the pre-send claim *before* its request
  leaves — the tab shows a terminal failure while the request is in the air, and
  one transient 503 ends the resend instead of retrying it.

**`rejected` is in scope on purpose.** It sounds like the one thing not worth
repeating, but Brevo's 400 for an attribute that does not exist yet is a
`rejected` that succeeds the moment the attribute is created. The operator is
clicking because they fixed something, and the system does not try to guess
which.

**The delivery-proof columns are left alone by a requeue (2026-10-16).**
`whatsapp_delivery_*` records what DoubleTick told us about one frozen
`messageId`, and a resend reuses that same id — so the report still describes the
message this row is about, and clearing it would destroy the only evidence of it.
`brevo_contact_id` is left for the stronger version of the same reason: Brevo
mints an id only when it creates, so a resend that updates the existing contact
returns none, and a requeue that cleared the column would lose the proof for
good. Both are evidence rather than state; nothing re-derives them.

**`whatsapp_request_id` is not regenerated, and that is the point.** It is frozen
per row at insert. If DoubleTick honours a repeated `messageId`, reusing it means
a resend of a message that genuinely never arrived still goes out — DoubleTick
never saw that id — while a resend of one that *did* arrive is deduplicated. Both
are what we want. Minting a fresh id would guarantee the duplicate instead. (Same
reasoning as an over-width id being cut rather than nulled, in `store.js`.)

**WhatsApp has its own control, and its own warning. The other three share
one.** Meta deduplicates on `event_id`, the Brevo upsert is idempotent, and
OpenAI deduplicates on the event `id` — which is derived from
`<crm_client_id>:<stage>` and is therefore identical on every retry and every
resend. So those three share one control and resending them is safe. WhatsApp
has none of those properties, and a `failed` WhatsApp row **may already have
reached the handset** — CUTOVER step 7's case, where DoubleTick answers 2xx with
a status outside our allowlist and we record `rejected` on purpose so the value
gets found. So its control says in visible text that resending may send a second
welcome message, and it takes an explicit confirmation.

The test for that grouping is **"would a repeat reach a person twice"**, not
"would a repeat be wasted". An OpenAI resend of a row outside the 7-day window
reaches nobody and sends nothing — the step skips it and the count never offered
it — so the window makes the number smaller and is not a reason to warn.

**The 30-day backstop is absolute**, measured from signup, whatever a resend
does. There is no window extension: a row scrubbed mid-resend is refused by the
in-worker send guard, which sends nothing and records why. That is also why the
answer carries `alreadyScrubbed` — the operator can see 40 failures on the
destination card (those counters count scrubbed rows) and get 12 resends, and the
other 28 are rows no requeue will ever reach.

**ChatGPT Ads has a second such reason, and the answer carries that too.**
`expired` is the failures that still hold their client data and that OpenAI
refuses on their age alone. So a destination's failures are exactly
`resendable + scrubbed + expired`, and all three travel together out of one
statement — read separately they could be counted either side of a scrub and
would not add up. Reporting one of the two shortfalls and not the other is worse
than reporting neither, because the subtraction then looks complete when it is
not. The tab says the expired rows are OpenAI's rule rather than a fault here,
in the muted tone the card uses and not the amber of WhatsApp's warning.

The route logs the action: who asked (the session user id, with their address
masked), which destination, and how many rows. It triggers outbound messages to
clients, so it needs an audit trail; there is no client data in the line.

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
new field needs the attribute created in Brevo first. All four destinations use
the same two words: `rejected` is the provider refusing this event, `failed` is a
transport failure or a spent attempt budget.

**`BREVO_LIST_ID` fails closed (2026-10-14, user's call).** Unset, blank or not a
positive number, no request is made and the row records `failed` with a detail
naming the variable — terminal, because a wrong environment variable will not be
right in five minutes, and the row keeps its client data so the send can be
retried once it is fixed. It used to fail *open*: the contact was created, joined
no list, and the row said `sent`, so nobody would have found out until they
opened list 19 to run a campaign and found it short. `failed` rather than
`rejected` because Brevo never saw the request, and rather than `skipped` because
nothing decided this. `server.js` also warns at startup when `BREVO_API_KEY` is
set and the list id is not usable, which catches the typo before a signup
arrives; both read `isUsableBrevoListId` in `brevo.js`, so the warning and the
gate cannot disagree.
