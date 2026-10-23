# crmSignup

Receives FXBO webhooks at five points in the client funnel, stores each once,
then independently sends a Meta Conversions API event, a DoubleTick WhatsApp
welcome, a Brevo contact, an OpenAI conversion for ChatGPT Ads, and a Google Ads
conversion through the **Data Manager API**.

Design: `../docs/superpowers/specs/2026-10-09-crm-signup-webhook-design.md`
ChatGPT Ads: `../docs/superpowers/specs/2026-10-14-chatgpt-ads-conversions-design.md`
Google Ads: no design document of its own — the decisions are in `googleAds.js`
and in the "Google Ads conversions, through the DATA MANAGER API" block at the
end of `../.env.example`.

**Google Ads is the one destination with two phases, and that is the single most
important thing to know about this module.** It moved off
`ConversionUploadService.UploadClickConversions` on 2026-10-22, because that
call answered a real conversion with HTTP 200 carrying
`notAllowlistedError: CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE — New
integrations for uploading click conversions should use the Data Manager API`.
The new API accepts a conversion asynchronously: its 200 means only "accepted
for processing", and the real outcome is retrieved up to 24 hours later. So a
healthy Google conversion holds `retrying` for up to a day before it reads
`sent` — which the tab renders as **awaiting Google**, not as a fault, and which
does **not** hold up the scrub. See "Google Ads: two phases, and why a 200 is not
delivery" below.

Configuration: the "CRM events webhook" block at the end of `../.env.example`.

## What each stage sends

| Stage | Meta event | WhatsApp | Brevo | ChatGPT Ads event (`data.type`) | Google Ads conversion action |
|---|---|---|---|---|---|
| `lead` | `Lead` | no | no | `lead_created` (`customer_action`) — blocked upstream, no FXBO trigger | **none** — no action exists, same reason |
| `registered` | **not sent** -- the website pixel owns it | yes, to anyone with a valid phone, lead or client | yes, to clients only | **not sent** -- the website pixel owns it | **not sent** -- the GTM container owns it |
| `verified` | `StartTrial` | no | no | `custom`, `custom_event_name: client_verified` (`custom`) | `FXBO_Client_Verified` |
| `live_account` | `SubmitApplication` | no | no | `custom`, `custom_event_name: live_account_opened` (`custom`) | `FXBO_Live_Account_Opened` |
| `first_deposit` | `Purchase` + `value`/`currency` | no | no | `order_created` + `amount`/`currency` (`contents`) | `FXBO_First_Deposit` + `conversionValue`/`currency` |

**No single event sends to all five.** `registered` sends WhatsApp and Brevo;
every other stage sends Meta, ChatGPT Ads and Google Ads together, and nothing
else.

**Google has no event name on the wire.** Each stage maps to a CONVERSION ACTION
created in the Google Ads UI, and the ingest names it by its **numeric id** in
`destinations[].productDestinationId` — Google: "The ID of the Google Ads
conversion action in the `operatingAccount` that receives the events", taken
from the `id` field of `conversion_action` and **not** from its resource name.
The names above are resolved to those ids once per process and cached; a name
that does not resolve records `failed` naming it, because every way of getting
this wrong is silent (a hardcoded id reports into whatever action now holds it,
an omitted field is a conversion Google files against nothing, and a resource
name where the id belongs is a well-formed string that would be accepted with a
200 and refused a day later as an error count naming no row). Renaming one of
these actions in the UI stops that stage until the constant in `googleAds.js` is
changed to match, and needs a restart.

The actions must be type `UPLOAD_CLICKS` — "Website (Import from clicks)" in the
UI — which is what the Data Manager API requires for offline events, and which
the GAQL lookup filters on.

**`registered` has no Google entry at all, rather than a gated one.** The
customer's GTM container already fires `Account_Registration (GADs)` with
enhanced conversions, so that stage has an owner with better identity than this
service could supply. The absence is what makes a second one unconstructable.

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
processed row shows all five. FXBO has no trigger for `lead` yet (spec section
11).

`registered` is mapped to `CompleteRegistration` in `META_EVENT_NAMES` but
deliberately not sent: the WordPress signup plugin keeps firing that event as a
browser pixel, and sending it from here as well would book one registration as
two conversions. See `decideMetaSkip` in `meta.js` for why deduplicating instead
is not available to us. The mapping stays complete so that lifting the gate is
one change rather than two.

**The two Meta names in the table are not the ChatGPT Ads names beside them, on
purpose.** OpenAI keeps `client_verified` and `live_account_opened`: nothing on
that platform restricts an event name, and renaming there would break the
continuity of their reporting for no gain.

### What Meta's `user_data` carries — and the four parameters deliberately left out

Every stage this service sends carries the same six matchers, each omitted
entirely when the value behind it is empty:

| Key | From | Normalisation | Shape |
|---|---|---|---|
| `em` | `email` | trim, lowercase | `[sha256]` |
| `ph` | `phone` | digits only | `[sha256]` |
| `external_id` | `crm_client_id` | trim, **nothing else** | `[sha256]` |
| `fn` | `first_name` | lowercase, punctuation removed, spaces collapsed | `[sha256]` |
| `ln` | `last_name` | same as `fn` | `[sha256]` |
| `fbc` | `fbc` | none, verbatim | bare string |

`external_id`, `fn` and `ln` were added 2026-10-20, from Meta's Event Match
Quality panel for this dataset: it reported `user_data` carrying only `em`, `ph`
and `fbc`, and named these three as the gains available — `external_id` at a
claimed ~28% uplift and each name at ~15%.

**A name is not normalised like an email.** Meta's rule for `fn`/`ln` is
"lowercase only with no punctuation", so `O'Brien` and `Jean-Luc` hash as
`obrien` and `jeanluc`. A copied `hashEmail` would lowercase and trim and stop,
and every apostrophe and hyphen in the CRM would then hash to a digest Meta
cannot match, with no error on either side. Accents are **lowercased, not
folded**: Meta's own worked example is `Valéry` → `valéry`, and
`crmSignup/meta.test.js` pins all three of Meta's published example digests
rather than only agreeing with itself.

**`external_id` is an identifier, not a name,** and Meta specifies no
normalisation for it at all. Its one rule is consistency — the same id, in the
same format, everywhere we send it — because it is matched against our own other
sends rather than against Meta's profile data. So it is hashed as the CRM holds
it. It is built from the same `crm_client_id` that `event_id` is built from, and
lowercasing it or running it through the name rule would produce a digest no
other channel sending that id could reproduce.

**IP address and User agent are absent on purpose, and Meta's own panel will
keep recommending them.** This is the part to read before "fixing" it. Meta's
server-side parameter-builder library fills `client_ip_address` and
`user_agent` by reconstructing them from the incoming HTTP request — and that is
exactly why they cannot be filled here. **Our incoming request is FXBO's webhook
from an Azure server, not the client's browser.** We would be sending FXBO's
server IP and FXBO's user agent as the customer's own, *identically for every
client and every event*: a single uniform fake identity, which degrades matching
while the panel's coverage figure reports an improvement. `referrer_url` and
`event_source_url` are out for the same reason. Every stage here (`verified`,
`live_account`, `first_deposit`) is a back-office state change with no browser
involved at all, so there is no real value to reach for. `meta.test.js` forbids
all four by name over the serialised payload.

`fbp` is out for a different reason — it is a browser cookie our server never
sees, so sending it needs a website change first — and date of birth, city,
region, postcode and country are out because FXBO does not send them and we do
not store them.

**The names survive long enough, and only just.** `first_name` and `last_name`
are in `SCRUB_COLUMNS`, but the scrub runs only once every destination has
settled, which is after this send; and `processSignupEvent` refuses a row
carrying a `scrubbed_at` before any payload is built. The fallback behind that
guard is that the scrub writes `NULL` rather than a placeholder, so
`buildMetaPayload` omits the keys instead of hashing `""` — which would be one
shared fake surname across every client. `crm_client_id` survives the scrub
anyway, so `external_id` would be the one matcher left.

### Google Ads: two phases, and why a 200 is not delivery

Four things about this destination are different from the other four, and each
has already been got wrong somewhere in this repository's history.

#### The two phases

**`events:ingest` answers 200 for "accepted for asynchronous processing" and
nothing more.** The body carries a `requestId` and optional `fieldWarnings`. The
real outcome comes from

```
GET https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=...
```

as `requestStatus` per destination — `SUCCESS`, `PARTIAL_SUCCESS`, `FAILED` or
`PROCESSING` — and Google says it "may take up to 24 hours" (some requests
finish in about 30 minutes). So:

| Phase | Status in the row | Budget | Clock |
|---|---|---|---|
| ingest | `retrying`, with `google_request_id` | 3 attempts | 5 minutes |
| confirm | `retrying` until Google answers | 25 polls | 30 min, ×1.3, capped at 60 |

`SUCCESS` is the **only** thing that records `sent`. `FAILED` and
`PARTIAL_SUCCESS` record `rejected` naming Google's own reasons; 24 hours of
`PROCESSING` records `failed` with a detail saying Google may still record it
and that nothing here will learn that it did.

**`google_request_id` is what tells the two phases apart**, and the row cannot be
settled without it: empty means nothing has been ingested and the step ingests,
non-empty means a conversion is awaiting its answer and the step polls. The
writer sets it through `COALESCE`, so the claim taken before each poll cannot
null the id it is about to poll with — written plainly, the first poll's own
claim would erase it and the next sweep would ingest the conversion a second
time. The resend control clears it explicitly, so a resend ingests rather than
re-asking about a dead request.

**No sixth status word, deliberately.** `settled.js` refuses a vocabulary that
drifts, and the claim, the scrub precondition, the backstop and the resend each
name those five words in SQL — a status missing from `SETTLED` is resent for
ever, one missing from `SCRUBBABLE` never scrubs. `retrying` is the honest
member of the existing set: the conversion is unconfirmed, and the row must stay
claimable so that the answer is actually asked for.

**`google_request_id` is what makes that word readable, in two places that both
need it.** `retrying` means two different things on this destination — accepted
and waiting, or an upload that failed and is being retried — and only the id can
say which. The scrub precondition asks it to decide whether the row is finished
with its client data, and the CRM events tab asks it to decide whether the row
is a problem: `retrying` **with** an id renders *awaiting Google* against the
page's "still going out" symbol and is kept out of the "problems only" filter,
`retrying` **without** one stays a problem. The column is in
`listEventsSince`'s select list and travels to the page as its own field; it is
deliberately *not* parsed back out of `google_detail`, which carries it in prose,
because `redactDetail` masks any run of eight or more digits as a phone number
and an all-numeric id reads masked there.

**One event per request, and the cost is accepted.** The API takes up to 2,000
events and reports failures as `errorInfo.errorCounts[]` of
`{reason, recordCount}` with **no per-record identifier**. A batch of five coming
back `PARTIAL_SUCCESS` with `recordCount: 2` would name no rows — two of those
conversions would not exist and nothing could say which, and all five would have
to be settled on a guess. One event per request makes one `requestId` one
conversion. Google allows 300 requests a minute and 100,000 a day per Cloud
project; this service ingests on the order of ten conversions a day.

**The scrub does not wait for Google** (and for one day, 2026-10-22 to
2026-10-23, it did). A row's client data is nulled about a minute after signup,
and a conversion Google has *accepted* counts as finished for that purpose even
though it is still `retrying`. `scrubbableClause` carries one extra disjunct for
this and it is the only place that vocabulary is widened per destination:

```sql
(google_status IN ('sent','skipped')
 OR (google_status = 'retrying' AND google_request_id IS NOT NULL AND google_request_id <> ''))
```

Nothing is lost by it. `requestStatus:retrieve` takes `google_request_id` and
**nothing else** off the row, that column is not client data and is deliberately
not on the scrub list, so the confirmation polls across the scrub without
noticing it. The id is also the whole of the discrimination: a `retrying` with
an *empty* id is an upload that failed and is being retried, which is a send
with a payload still to build from the very columns this would be deleting, so
that one still holds the row. `processSignupEvent` applies the same two tests
with the same `str`, so the worker and the statement cannot come to disagree
about one row.

What used to stand in the way was `processSignupEvent`'s scrubbed-row guard,
which settles every unsettled action `skipped` — it would have recorded a skip
for a conversion Google had accepted, and `skipped` is final and out of the
resend's reach. The guard lets that one phase run instead (see "A scrubbed row"
below), so the retention cost was reversed rather than paid: holding a name, an
email and a phone for 24 hours instead of a minute was a straight breach of the
promise the table is kept under, and it bought nothing.

**The cost this does carry**, recorded rather than discovered later: a conversion
Google ultimately refuses settles `rejected` — or `failed`, after 24 hours of
`PROCESSING` — on a row that was scrubbed hours earlier, and `requeueFailedSends`
refuses a scrubbed row. So it is outside the resend control and the Resend card
counts it under `scrubbed` rather than under `resendable`. Nothing is hidden by
that. A Google re-ingest would not need the scrubbed columns anyway — it needs
the `gclid`, which survives — so widening the resend for this one destination is
available, and is its own decision.

**A scrubbed row.** It is an ordinary state for a Google row now rather than a
guard against the impossible: ingested, scrubbed about a minute later, then
polled across the scrub for up to a day. `processSignupEvent` therefore does
three things to such a row and no others — it runs the Google **confirm** phase
when `google_request_id` is set, it settles every other still-unsettled action
`skipped`, and it sends nothing at all. The rule the 2026-10-22 outage bought
governs every branch of it: *every action on every claimed row must end up
settled, or the row is claimed again for ever* — where `retrying` with a clock in
the future counts as settled, because `claimDueEvents` will not return the row
until that clock is due and the 25-poll budget bounds how often it can happen.
An action holding a word the claim query does not select on is left alone, since
writing nothing for it cannot bring the row back and writing a status we cannot
justify over it would destroy a real outcome.

#### The gclid

**It attributes on the `gclid` and on nothing else.** Meta and OpenAI both fall
back to the hashed email and phone when their click id is missing; here the
gclid goes in `adIdentifiers` and we send no `userData`, so there is no such
fallback — the gclid IS the identity of the click. So a row without one records
`skipped — no gclid: the click cannot be attributed in Google Ads`, which is the
commonest outcome here because most signups are organic. **It is deliberately
not sent unattributed**: Google counts such a conversion against no campaign, so
it inflates the account's total while leaving every campaign's own number
unchanged — it corrupts the figure the bidding reads, and nothing in the account
says where it came from. A visible skip is strictly better.

Auto-tagging is what supplies it: Google appends `gclid` to the landing URL
itself, so it arrives inside the same `full_link` the `fbclid` does and no
website change was needed. It is frozen in its own column at the client's first
event, for the reason `fbc` and `oppref` are, and it survives the scrub for a
sharper version of that reason — scrubbing it would not weaken the first
deposit's attribution weeks later, it would remove the conversion. It is also
redacted out of every detail and log line: it is not a credential, but it names
one person's click, and `google_detail` is read straight into the admin table.

#### `eventTimestamp`, and what the offset no longer decides

**It is an RFC 3339 `Timestamp`, with a `T`.** `conversionDateTime` on the old
upload was `yyyy-mm-dd hh:mm:ss+|-hh:mm` — a space — and the old separator is not
a laxer spelling of this one: a proto3 Timestamp refuses a space where the `T`
belongs.

**And the offset changed meaning, which is the easier half to miss.**
`conversionDateTime` was a LOCAL WALL CLOCK whose offset told Google which
instant the digits beside it named, so a UTC stamp under a `+04:00` label moved a
conversion by a DAY at the boundary. A `Timestamp` is an INSTANT:
`2026-10-22T02:30:00+04:00` and `2026-10-21T22:30:00Z` are the same moment and
Google files them identically, converting to the account's zone for reporting
from the account's OWN setting. So `GOOGLE_ADS_TIMEZONE_OFFSET` is now
**presentational** — it decides how the stamp reads to a person, not which day
the conversion lands on. It is kept at the account's +04:00 because a stamp a
reader can compare to the Google Ads UI without arithmetic is worth having, and
because the formatter is the one that cannot read the IIS host's own timezone.

#### Deduplication, the value, and access

**Deduplication is `transactionId`, and it is `<crm_client_id>:<stage>` — the
same identity Meta's `event_id` and OpenAI's event id are built from.** Google's
offline guide calls it optional and says it "is used for deduplication"; it is
the order-id equivalent and the same per-conversion-action uniqueness applies.
It matters more under an asynchronous API: the one window this service cannot
close by itself is a process dying between the ingest leaving and
`google_request_id` being written, and this id is what makes the repeat the same
conversion rather than a second one. It is not optional for us.

**The deposit's value is the DECIMAL.** `conversionValue` is a plain number:
$54.49 is `54.49`. The same FXBO lookup's `amountMinor` — `5449` — is what
OpenAI takes, and Google would accept it without a word, as a $5,449 deposit.
The Google Ads API states money in micros nearly everywhere, which is what makes
the mistake inviting from the other side too; conversion value is neither. The
field is `currency` here and was `currencyCode` on the old API.

**`consent` is not sent.** Both `adUserData` and `adPersonalization` are
documented optional and we have collected neither signal; sending
`CONSENT_GRANTED` because the sample payload does would be a claim about the
client nobody here can make. If Google ever requires it, the polls say so with
`PROCESSING_ERROR_REASON_DENIED_CONSENT`, which is visible in the row's detail.

**The Data Manager API needs its own scope, and this is the failure to expect
first.** `https://www.googleapis.com/auth/datamanager`, which
`scripts/google-ads-refresh-token.mjs` requests alongside `adwords` in one
consent. **A refresh token minted before 2026-10-22 carries only `adwords`, and
scopes are not additive on an existing token** — such a token resolves
conversion actions perfectly and is refused by every ingest with
`ACCESS_TOKEN_SCOPE_INSUFFICIENT` in the detail. The fix is to re-run that
script. The other named reasons are `SERVICE_DISABLED` (the API is not enabled
on the Cloud project), `PERMISSION_DENIED` (the access path does not reach the
operating account — stricter for the status retrieval, which must use the same
path as the ingest, with Admin or Standard access) and `RESOURCE_EXHAUSTED` (the
project quota, which arrives as a 429 and is retried).

**There is no developer token anywhere, and `GOOGLE_ADS_DEVELOPER_TOKEN` is no
longer read.** Two reasons: Google Ads sunset developer tokens on 2026-09-09
("optional and ignored by the API servers", and they "will start rejecting
developer tokens in API calls in a future major version"), and the Data Manager
API documents no such header at all — its destinations guide says "Don't set
request headers in an `IngestionService` request". Access to both APIs is the
access level of the Cloud project that owns the OAuth client.

**`GOOGLE_ADS_LOGIN_CUSTOMER_ID` is still read, in two shapes.** The
conversion-action lookup is a Google Ads API call and still sends it as the
`login-customer-id` header; the ingest takes no headers, so it becomes
`destinations[].loginAccount` in the body. It is omitted entirely when blank,
which defaults to the operating account — and it has to be right for the status
retrieval too, which Google requires to use the same access path as the ingest.

### The 19 October event-name experiment

**`verified` and `live_account` were renamed on 2026-10-19, superseding the 13
October choice of `Client_Verified` and `TradingAccountOpened`.** Meta accepts
our events and then discards them. Read against the live dataset
`692517170017822` over 16-19 October, a window that spans every event this
service has ever sent:

- Our side: seven sent, all `http 200`, across three API clients.
- Meta's side, same window: PageView 912, Initiate checkout 18, Complete
  registration 8, and **nothing else**. Zero of our seven.

Every **standard** name that reaches that dataset lands. Our two **custom**
names never appear, and Meta raises no diagnostic for them either — Diagnostics
"Previously detected" is empty, so Meta never said why. The dataset has core
setup on (portfolio-wide), and the event-blocking page's own gate text reads:
*"You can't share data (including in event names) that includes or is based on
health, financial, consumer report or otherwise sensitive information."* That
would indict `TradingAccountOpened` but says nothing about every custom name
being dropped.

`Purchase` was failing at the same time for a different and named reason — no
value, diagnostic `s2s_invalid_purchase_event_actions`, fixed and deployed — so
it is not evidence about names either way.

**The experiment ran on 20 October and settled it: only a standard name is ever
visible.** One client went through all three stages in four minutes — same
payload shape, same integration, the name the only variable. Meta's event list
for that day holds `Submit Application` and `Purchase`, both via Conversions
API. It does not hold `ApprovedApplication`.

The custom one was not lost in transit.
`connect.facebook.net/signals/config/<dataset_id>` lists it under
`unverifiedEventNames`, beside `TradingAccountOpened`, `Client_Verified`, and
the `Website*` names FXBO's own integration sent (ticket #71035, same dataset,
same dead end a month earlier). Meta receives a custom name, files it as an
unverified custom event, and an unverified custom event never surfaces.

**So the rule is custom-vs-standard, and nothing else.** It is not the financial
wording the event-blocking gate text describes — `ApprovedApplication` carries
no financial term and was filed identically. It is not `custom_data`, not core
setup discarding payloads, and not the domain. Each of those was a live theory;
each was wrong.

`verified` therefore moved to `StartTrial` on 20 October (user's call): a
standard name whose funnel position fits — the account exists and is active,
nothing has been paid yet. **Any future stage must take one of Meta's 17
standard event names**, however badly it reads, or it is invisible. The test
`sends only names from Meta's standard list` enforces this and carries the full
set.

**The readable names come back as Custom Conversions, not as event names.** An
operator who wants to read "Client verified" in Ads Manager gets it from a
Custom Conversion defined on whichever underlying name survives. The underlying
name only has to pass Meta's review; it never has to be the words a human reads,
and a Custom Conversion is also what gives a custom event standard-event
optimisation.

**The ownership risk to watch on `SubmitApplication`.** The belief in the room
is that the website already sends it on account-open. It does not: that name has
never been received by any of the three Meta data sources, which is why it was
free to take. But if the website ever starts sending it, this stage gets two
owners and double-counts — exactly the shape `Complete registration` is in
today, where Events Manager shows Integration **"Multiple"**. One owner per
stage, and for this stage the CRM is the better owner: FXBO's rule fires on the
confirmed account, while a website click is only intent. If the website side is
ever wired for it, take it out there rather than here, or rename this stage
again.

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
- **The minor-unit digits come from a table, and are read from the *settled*
  currency.** ISO 4217 gives JPY zero and KWD three; assuming two is a
  hundredfold error, not a rounding one. And a USDT deposit settles as USD, so
  it scales by USD's two places — USDT is 6-decimal on chain, and scaling by
  the ticker's own precision would turn $100 into $1,000,000. `minorUnitDigits`
  returns `null` for a code that has not been settled, so getting that order
  wrong is loud rather than plausible.
- **Which currencies are reportable is an allowlist, not a `/^[A-Z]{3}$/`
  test.** See below — this is the one thing in this section that was wrong in
  the first version of it.

### Crypto: pegged stablecoins map, non-pegged crypto deliberately does not

Skylinks takes crypto deposits, so this path is live rather than theoretical.

**USD-pegged stablecoins settle as `USD` at par.** `USDT` (and `USDTTRC20`,
`USDTBEP20`, `USDTPOL`, `USDTSOL`, `USDTAVAX`), `USDC` (and `USDCSOL`,
`USDCPOL`, `USDCBASE`, `USDCAVAX`), `PAX`, `TUSD` — thirteen codes, hard-coded
in `USD_PEGGED_CURRENCIES`. **There is no rate anywhere in the module**: the
amount is carried across untouched and only the code is rewritten, because a
pegged token is issued against a dollar and valuing it at par is a statement
about its issuance rather than an exchange-rate lookup.

**The peg is an accepted assumption, not an implicit one.** A material depeg
would quietly misreport deposit value, and nothing in the code would notice,
because there is no rate to disagree with. At a stablecoin's ordinary drift
(fractions of a cent) that is far below anything an ad platform optimises on,
and `wallet/cryptoRates.js` already accepts the identical error for the
identical reason on the treasury side. A sustained depeg is an operational
event: the fix is to remove the coin from the list, which makes its deposits
`failed` and visible rather than silently mispriced.

**`BTC`, `ETH`, `XRP`, `LTC` and everything else non-pegged stay unreportable**
— a permanent `failed` naming the code. Converting them needs a live rate this
module does not have, and a wrong rate does not give a slightly-off conversion;
it hands Meta a bid signal wrong by orders of magnitude, which is worse than the
conversion lost by sending nothing.

**That list is hard-coded and reads nothing from the environment,** for the same
reason `statuses: ["approved"]` does, only sharper: a variable that let someone
add `BTC` at 1:1 would report a 0.4 BTC deposit as $0.40 of revenue, and it
would be one typo away at all times. A test pins the membership exactly.

**It is enumerated, never pattern-matched.** `code.includes("USD")` would value
any future ticker containing those three letters at par, whatever it actually
is. `wallet/pspClients.js` carries that same warning on
`DOLLAR_DENOMINATED_CURRENCIES`, which answers the neighbouring question for PSP
wallet holdings and reached the same conclusion about the same tokens. Our list
is its dollar-pegged half; a test asserts the subset, so the two cannot drift
apart silently. It is a second copy rather than an import only because that
module pulls in `googleapis`, the Sheets reader and the live rate feed, and the
webhook's send path must not depend on any of them.

**Which currencies are reportable at all is an allowlist
(`REPORTABLE_CURRENCIES`), and that is a correction rather than a refinement.**
The first version of this feature tested `/^[A-Z]{3}$/` and shipped a real
defect: **every major non-pegged crypto ticker is exactly three letters**, so a
0.4 BTC deposit passed, went out as `value: 0.4, currency: "BTC"`, and reported
a five-figure deposit as forty cents of revenue — with Meta silently ignoring
the currency it could not read. `BRL` sits next to `BTC`, `ETB` next to `ETH`;
no pattern can separate them, which is why this is a list. Omissions from it
cost a visible `failed` naming the code and are a one-line fix; that is the
direction it is built to fail in.

The long allowlist carries the length and the short `MINOR_UNIT_DIGITS` table
carries the risk: a typo in the first refuses a deposit and says so, a typo in
the second silently misreports a real one by a factor of ten or a hundred.

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

## Eleven things that are easy to get wrong

**A three-letter shape test cannot tell a currency from a coin, and the
failure is silent.** `BTC`, `ETH`, `XRP`, `LTC`, `ADA`, `SOL`, `TRX`, `BNB` are
all exactly three letters, and so are `BRL`, `ETB`, `XCD`, `LSL`, `AED`, `SOS`,
`TRY`, `BND`. A pattern accepts both; only a list separates them. Meta then
ignores the currency it cannot read and the deposit is reported at its crypto
face value, so a 0.4 BTC deposit books as 0.40. This repository had already
learned it once — `wallet/pspClients.js` says *"this is an ALLOWLIST rather than
a pattern, and that is the whole point of it"* — and the first version of this
feature made the mistake anyway.

**So there are three gates, not one, and they are the same list.**
`settlementCurrency` is the door; `metaValueFields` and `openaiAmountFields`
each check `REPORTABLE_CURRENCIES` again before attaching a pair. That is
deliberate duplication of a *check*, not of a *list* — all three import the one
Set from `depositValue.js`, which costs no dependency because that module
imports only `sendTimeout.js` and `transientHttp.js`, both of which the two
senders already had. "An unsettled code cannot reach the builders" is a fact
about today's wiring, not about the builders, and the shape test was sitting one
call site away from repeating the mistake above. The two builders read
`isoCurrency` and **not** `settlementCurrency`: by the time a value reaches them
its amount has already been scaled to some currency's minor unit, so mapping
`USDT` to `USD` there would relabel a number without rescaling it. Settling
happens once, at the door.

`openai.test.js` asserts the two builders qualify every currency identically.
One of them narrowing or widening alone is how the same deposit comes to be
priced on one platform and dropped on the other.


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
Meta cannot match, and reports no problem. The same trap, with a *different*
rule, applies to `fn`/`ln` (punctuation removed, accents kept) and to
`external_id` (normalised not at all); see "What Meta's `user_data` carries"
above, which is also where the four recommended parameters we refuse to send
are explained.

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
survive from receipt until all five destinations are done with — including
across retries, which run up to three attempts five minutes apart, and including
a destination that failed, which a resend will need them for. After that, nothing
needs them.

**The scrub.** These eight columns are nulled and `scrubbed_at` is stamped:

    first_name, middle_name, last_name, email, phone,
    full_link, referer, raw_payload

`full_link` and `referer` are in that list because `full_link` carries the
`fbclid`, the `oppref`, the `gclid` and the whole query string verbatim, and
both are redundant once the three click ids and the `utm_*` columns have been
extracted from them.

Everything else stays, because it is the statistics the table exists for:
`crm_client_id`, `stage`, `fxbo_unique_id`, `record_type`, `is_lead_raw`,
`marketing_consent`, `is_ib`, `entity`, `source`, `language`, the three `utm_*`
columns, `fbc`, `oppref`, `gclid`, `whatsapp_request_id`, `google_request_id`,
every status / detail / attempts / clock column, the four delivery-proof columns
(`brevo_contact_id`, `whatsapp_delivery_status`, `whatsapp_delivery_at`,
`whatsapp_delivery_detail` -- see "Proving a message arrived"), `received_at` and
`updated_at`. `entity`, `source` and the `utm_*`
columns are segmentation, not identity, and FXBO cannot be asked for them per
funnel stage after the fact.

**`google_request_id` is the one absence from the scrub list that is about
correctness rather than about evidence** — and the only one the scrub routinely
runs *on a row that still needs it*. It is the handle the Data Manager API's
status retrieval takes, so a row whose conversion is still awaiting confirmation
would, without it, be read as never ingested and ingested a second time. It is
not client data — it names one request of ours to Google, not a person — and the
poll needs nothing else off the row, which is exactly why the two decisions are
independent: taking the client data while a conversion awaits its answer is sound
and is what `scrubbableClause` now does, and taking this would not be. Since
2026-10-23 that is the ordinary path, about a minute after signup, rather than a
floor under a case that could not arise.

**Seven of those are load-bearing, not merely kept:**

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
- **`gclid` deliberately survives, and of the three click ids it is the one
  whose loss would cost most.** Google attributes an offline click conversion on
  the gclid and on nothing else — there is no hashed-email fallback as there is
  for Meta and OpenAI — so scrubbing it would not weaken the first deposit's
  attribution weeks later, it would remove the conversion: the step would skip
  it outright, permanently, for every client whose signup had already settled.
  Like `oppref` it is not client data (it identifies an ad click, not a person)
  and is sent raw, with no wrapper and no timestamp.
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
| Settle | As soon as all five destinations have **succeeded or been deliberately skipped** (`sent` or `skipped`), or — Google's alone — have had a conversion **accepted** (`retrying` with a `google_request_id`) — normally about a minute after signup | Scrub |
| Invalid | `received_at` older than **7 days**, and all five statuses `invalid` | The whole row is deleted |
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
precondition — all five statuses scrubbable (Google's clause also accepting a
`retrying` that carries a `google_request_id`, for the reason under "The scrub
does not wait for Google" above), `scrubbed_at` still NULL — so it is correct
whatever the worker believes (`scrubbableClause` in `store.js`, the same lesson
as the row claim above). The worker's own check decides only whether to
try, so the ordinary row still costs one statement. It matters during an
overlapped recycle: when two workers split the five claims, neither one's copy
of the row ever shows all five settled, and a scrub decided from the copy alone
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

Two destinations replace the *word* beside the symbol with a truer one, and
neither adds a symbol: WhatsApp's comes from DoubleTick's own delivery report,
and Google's is *awaiting Google* for a `retrying` that carries a request id. In
both cases the status we actually stored is printed underneath as
`we recorded <status>`, so the kinder word hides nothing.
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
  is claimed, refused by the send guard, and settled `skipped` — so the resend is
  a no-op that reports as one, which is what the 2026-10-22 fix to that guard
  bought (before it, the row stayed `pending` for the rest of the table's life
  and poisoned the one counter that means "the dispatch worker is dead").
  **Since 2026-10-23 this also costs Google a resend it used to have:** a row
  whose conversion was accepted is scrubbed about a minute after signup, so a
  confirmation that comes back refused a day later lands `rejected` on a scrubbed
  row and this precondition will not touch it. It shows under `scrubbed` on the
  Resend card. A Google re-ingest would not actually need the scrubbed columns —
  it needs the `gclid`, which survives — so letting the resend reach a scrubbed
  row *for this destination only* is available, and is its own decision rather
  than part of the retention fix.
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
new field needs the attribute created in Brevo first. All five destinations use
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
