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
| `registered` | **not sent** -- the website pixel owns it | yes, to clients with a valid phone | yes |
| `verified` | `Client_Verified` | no | no |
| `live_account` | `TradingAccountOpened` | no | no |
| `first_deposit` | `Purchase` | no | no |

**No single event sends to all three.** `registered` sends WhatsApp and Brevo;
every other stage sends Meta alone.

A destination that does not apply is stored as `skipped` with its reason, so a
processed row shows all three. FXBO has no trigger for `lead` yet (spec section
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
  pointing FXBO at the endpoint. `BREVO_LIST_ID` is the fourth: with the Brevo
  key set, an unusable list id is a `failed` send rather than a skip, and the
  startup log says so.
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
survive from receipt until all three destinations are done with — including
across retries, which run up to three attempts five minutes apart, and including
a destination that failed, which a resend will need them for. After that, nothing
needs them.

**The scrub.** These eight columns are nulled and `scrubbed_at` is stamped:

    first_name, middle_name, last_name, email, phone,
    full_link, referer, raw_payload

`full_link` and `referer` are in that list because `full_link` carries the
`fbclid` and the whole query string verbatim, and both are redundant once `fbc`
and the `utm_*` columns have been extracted from them.

Everything else stays, because it is the statistics the table exists for:
`crm_client_id`, `stage`, `fxbo_unique_id`, `record_type`, `is_lead_raw`,
`marketing_consent`, `is_ib`, `entity`, `source`, `language`, the three `utm_*`
columns, `fbc`, `whatsapp_request_id`, every status / detail / attempts / clock
column, `received_at` and `updated_at`. `entity`, `source` and the `utm_*`
columns are segmentation, not identity, and FXBO cannot be asked for them per
funnel stage after the fact.

**Two of those are load-bearing, not merely kept:**

- **`fbc` deliberately survives.** It is captured at signup and reused weeks
  later for the first-deposit conversion. Scrubbing it would send every later
  conversion to Meta with no ad attached, and Meta would accept all of them
  without complaint.
- **`crm_client_id` deliberately survives.** It is half the dedupe key. Without
  it FXBO's redelivery of a stage no longer collides on
  `(crm_client_id, stage)`: it inserts a second row and sends a second welcome.

**When it happens.** Three paths, in `worker.js`:

| | When | What |
|---|---|---|
| Settle | As soon as all three destinations have **succeeded or been deliberately skipped** (`sent` or `skipped`) — normally about a minute after signup | Scrub |
| Invalid | `received_at` older than **7 days**, and all three statuses `invalid` | The whole row is deleted |
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

That makes two sets, and conflating them is the mistake to avoid — both live in
`settled.js`, named for the question each answers:

| Set | Question | Members |
|---|---|---|
| `SETTLED` | do not attempt this action again | `sent`, `skipped`, `rejected`, `failed`, `invalid` |
| `SCRUBBABLE` | this row is safe to forget | `sent`, `skipped` |

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
precondition — all three statuses scrubbable, `scrubbed_at` still NULL — so it is
correct whatever the worker believes (`scrubbableClause` in `store.js`, the same
lesson as the row claim above). The worker's own check decides only whether to
try, so the ordinary row still costs one statement. It matters during an
overlapped recycle: when two workers split the three claims, neither one's copy
of the row ever shows all three settled, and a scrub decided from the copy alone
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
`raw_payload`; `scrubbed_at` is what lets the settings tab tell a scrubbed row
apart from one that never carried the value.

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
