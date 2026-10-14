# ChatGPT Ads (OpenAI) conversions — design

**Status:** design agreed 2026-10-14, not yet built.
**Extends:** `2026-10-09-crm-signup-webhook-design.md`. Everything there about
stages, retries, retention, masking and the settings tab applies unchanged; this
document covers only the fourth destination.

## 1. What this adds

A fourth destination beside Meta CAPI, DoubleTick WhatsApp and Brevo: OpenAI's
Conversions API, so ChatGPT Ads can attribute and optimise against the same
funnel. Server-side only. The browser pixel is the website's business.

    POST https://bzr.openai.com/v1/events?pid=<PIXEL_ID>
    Authorization: Bearer <OPENAI_CONVERSIONS_API_KEY>
    Content-Type: application/json

`PIXEL_ID` and the key come from the ChatGPT Ads conversion setup screen and
**must belong to the same ad account**. The key is a secret: never in the
repository, never in a log line.

## 2. What the official documentation says

Verified 2026-10-14 against `developers.openai.com/ads/conversion-tracking`,
`/ads/conversions-api` and `/ads/supported-events`, because the brief flagged
two unknowns. Both are now answered.

**Batching: up to 1,000 events per request — but "if one event in the batch
fails, the full batch fails."** There is no per-event error reporting. So we
send **one event per request**, as the other three senders do. Batching would
let a single malformed row destroy a whole sweep's worth of conversions, and we
would not be told which one.

**The `user` object takes SHA-256 lowercase hex**, in `emails_sha256`,
`phone_numbers_sha256`, `external_ids_sha256`, `first_names_sha256`,
`last_names_sha256`. Only the **first three** values of each list are used;
further ones are ignored silently rather than rejected.

Normalisation before hashing:

| Field | Rule |
|---|---|
| Email | Trim, lowercase. **Identical to Meta's.** |
| Phone | Keep the country code; remove whitespace, parentheses, periods and hyphens; remove a leading `+` **and leading zeroes**; hash the resulting 8–15 digits. **Not identical to Meta's.** |
| External id | Trim only. Case and punctuation preserved. |
| Names | Lowercase; remove whitespace and ASCII punctuation; keep non-ASCII characters and accents. |

**Not stated anywhere in the documentation:** the response shape, and any rate
limit. Treat both as unknown rather than assumed.

**The taxonomy has thirteen event names**, each requiring one `data.type`
family. `data.type` is the data *family*, not the event name, and a mismatch is
rejected:

    customer_action  app_installed, app_opened, appointment_scheduled,
                     lead_created, registration_completed
    contents         checkout_started, contents_viewed, items_added,
                     order_created, page_viewed
    plan_enrollment  subscription_created, trial_started
    custom           custom

**There is no verification event and no account-opened event.** The only route
for either is `custom` with a `custom_event_name` of 1–64 characters, lowercase
letters, numbers, underscores or dashes, not reusing a built-in name.

`validate_only: true` at the top level validates without recording. Such
requests **do not appear in event monitoring**, so a clean validation is not
evidence that anything landed.

## 3. The stage mapping, as decided

| Stage | OpenAI event | `data.type` | Notes |
|---|---|---|---|
| `lead` | `lead_created` | `customer_action` | Blocked: no FXBO trigger exists. Code is stage-agnostic, so nothing is needed when one appears. |
| `registered` | **not sent** | — | The website pixel owns it. See §4. |
| `verified` | `custom`, `custom_event_name: client_verified` | `custom` | |
| `live_account` | `custom`, `custom_event_name: live_account_opened` | `custom` | |
| `first_deposit` | `order_created` | `contents` | No `amount`, no `currency`. See §6. |

**`appointment_scheduled` is not implemented.** The brief's mapping table lists
it for "appointment / demo booked", but there is no such CRM stage and no FXBO
rule for one. It is omitted rather than faked.

## 4. `registration_completed` is the pixel's, not ours (2026-10-14, user's call)

OpenAI merges a browser event and a server event into one conversion only when
the Pixel ID, the event name **and** the id all match — the pixel's `event_id`
must equal our `id`. The pixel's id exists only in the page; ours would come
from FXBO, which has no field that could carry the browser's value across.

The brief states the rule itself: *"If you cannot share an id for a given stage,
send that stage from ONE side only — never both with different ids, which double
counts."*

So the pixel keeps `registration_completed` and we skip it. This is the same
decision, for the same reason, as `CompleteRegistration` on Meta, taken the same
day — one owner per stage, and for the registration stage the owner is the
browser.

The cost, recorded rather than hidden: that conversion is only ever as complete
as a browser pixel, so registrations from ad-blocked or tracking-restricted
browsers are unattributed for that step. Every other stage is server-side.

## 5. `oppref` must be frozen in its own column

`oppref` is OpenAI's click identifier, the equivalent of `fbclid`. **OpenAI's
documentation states that their Conversions API does not capture it**, so
without it a conversion cannot be attributed to the ad that produced it.

It arrives inside the landing URL the website already sends to the CRM as
`full_link`. It must be **extracted at first sight and stored in its own
column**, exactly as `fbc` is, for two independent reasons:

1. **`full_link` is scrubbed** about a minute after signup, once the
   destinations settle. Parsing it on demand would work for the first event of a
   client's life and fail silently for every later one.
2. **The first deposit is a different row, arriving weeks later**, with its own
   `full_link` — which will normally be empty, because that visit is not an ad
   click. `fbc` already solves this with a read that returns the first non-empty
   value stored for the client; `oppref` needs the identical treatment.

Unlike `fbc`, `oppref` is sent **raw**: there is no `fb.1.<ms>.` wrapper and no
timestamp, so nothing about it needs freezing beyond the value itself.

If `oppref` is absent the event is still sent — it is optional — and is simply
unattributed.

## 6. No deposit amount (2026-10-14, user's call)

`order_created` carries neither `amount` nor `currency`. Both are optional, and
`currency` is required only when `amount` is present, so the event is valid
without them.

This mirrors the 13 October decision for Meta's `Purchase`. The amount would
need an FXBO REST call that was cut from scope. It is now more feasible than it
was, because the CRM's OpenAPI specification is available in the repository, and
it would fix revenue attribution for Meta and ChatGPT Ads together — but it is
deliberately deferred to its own piece of work rather than bundled here.

The consequence: both platforms learn that a deposit happened, not what it was
worth, so there is no return-on-ad-spend measurement on either.

Amounts, when they are eventually sent, are **integers in the currency's minor
unit**: $129.99 is `12999`, not `129.99`.

## 7. Hashed identifiers (2026-10-14, user's call)

Send `emails_sha256` and `phone_numbers_sha256`. Not names, not external ids.
This matches what Meta already receives, and it is what lets OpenAI attribute a
conversion whose `oppref` is missing. Nothing identifying leaves in readable
form.

### The trap that testing would not catch

OpenAI's phone rule differs from Meta's: it strips a leading `+` **and leading
zeroes**. Meta's `hashPhone` strips all non-digits and keeps leading zeroes.

**For every phone this service would actually send, the two produce the same
hash.** `PHONE_RE` is `/^\+[1-9]\d{7,14}$/`, so a stored phone always begins
`+` followed by a non-zero digit, and there are never leading zeroes to strip.
The regex also already enforces 8–15 digits, which is exactly OpenAI's range.

So reusing Meta's function would pass every test, work against live data, and
silently break only if `PHONE_RE` were ever loosened. **Implement OpenAI's rule
on its own terms**, with its own tests pinning a known digest, and do not share
the phone helper between the two senders. The email helper may be shared,
because that rule genuinely is identical today — but say so in a comment, so a
future divergence is noticed rather than inherited.

## 8. Deduplication and retries

- `id` is the event's identity. For the stages we own there is no browser event
  to coordinate with, so it is derived from the CRM record —
  `<crm_client_id>:<stage>` — and is therefore **identical on every retry**, so
  a retry is recognised as the same conversion rather than a second one. This is
  the same scheme Meta's `event_id` uses.
- A `200` is **not** proof. The documentation does not state the response shape,
  so a response is treated as success only on a 2xx with no error body, and the
  real confirmation at cutover is the ChatGPT Ads event stream.
- Transient statuses reuse the shared `isTransientHttpStatus`. Everything else
  is permanent: `rejected` when OpenAI refuses, `failed` for transport errors
  and exhausted budgets, matching the vocabulary the other three senders settled
  on.

## 9. How it fits what exists

A fourth destination is a fourth set of columns, a fourth worker step and a
fourth card — it is not a special case anywhere:

- **Schema:** `oppref`, plus `openai_status`, `openai_detail`, `openai_attempts`
  and `openai_next_attempt_at`. `oppref` survives the scrub, like `fbc`;
  the four status columns are statistics and survive too.
- **The claim, the scrub, the backstop and the requeue** all enumerate
  destinations. Each must gain `openai`, and missing one of them is the failure
  mode to test for: a destination absent from the scrub precondition keeps
  client data for ever, and one absent from `claimDueEvents` never sends at all.
- **`validate_only`** is exposed as a configuration flag, because the brief's
  testing procedure needs it and because a flag is safer than editing code on a
  server.

Configuration: `OPENAI_CONVERSIONS_API_KEY`, `OPENAI_PIXEL_ID`,
`OPENAI_EVENTS_URL`, `OPENAI_VALIDATE_ONLY`, `OPENAI_MAX_ATTEMPTS`. An unset key
or pixel id means the destination is skipped, exactly as for the other three.

## 10. Build order

1. **`crmSignup/openai.js` and `oppref` extraction.** Pure and self-contained:
   the event map, the two hashes, the payload builder, the outcome classifier,
   the sender, and the `oppref` parser. Testable without touching the database.
2. **Wiring.** The schema columns and their guarded migrations, the store's
   reads and writes, the frozen-`oppref` read, the fourth worker step, and
   `openai` as a requeue destination — plus its inclusion in the claim, the
   scrub precondition, the backstop and the delete.
3. **Surface and documentation.** The overview counters, the settings tab's
   fourth card, `.env.example`, `README.md`, and the cutover steps — including
   the `validate_only` dry run and the event-stream check, since a 200 proves
   nothing.

## 11. Acceptance

1. One event with `validate_only: true` returns a 2xx.
2. A real event appears in **View event stream** in the conversion setup screen.
   A 200 alone does not count.
3. A redelivery of the same stage sends no second conversion and creates no
   second row.
4. A client whose landing URL carried `oppref` shows the same stored value on a
   later stage's row as on their first.
5. `registered` records `skipped` with the pixel reason, and no request is made.
