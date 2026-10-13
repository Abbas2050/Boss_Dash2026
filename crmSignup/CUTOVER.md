# crmSignup — cutover runbook

Every step here changes a live system: the production server, the FXBO CRM, the
Meta dataset, or the WordPress plugin that currently sends the welcome message.
None of it is automated and none of it should be done by anyone but the account
owner.

Design record: `../docs/superpowers/specs/2026-10-09-crm-signup-webhook-design.md`
Module reference: `./README.md`

**Nothing in this feature does anything until step 1 and step 4 are both done.**
Until then the endpoint rejects every request with 401 and no FXBO rule calls it.

---

## 1. Set the environment variables on the server

There is no `.env` in this repo. The variables live in
**Plesk → Node.js → Custom environment variables**. The full block, with every
default and its reason, is at the end of `.env.example` under
`# --- CRM events webhook ---`. Copy it from there rather than from memory.

Generate the webhook secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Generate the Meta token in Events Manager → the CRM implementation guide →
**Generate Access Token**. Doing this also rotates the token currently sitting
exposed inside FXBO.

Three of these will cost you an afternoon if you get them wrong:

- **`BREVO_LIST_ID` has no default.** Unset, blank or non-numeric and the
  contact is still created but joins **no list**, with no warning anywhere. Set
  it to `19` (All Clients).
- **Set `META_TEST_EVENT_CODE` now.** The first real traffic then lands under
  Events Manager → Test events and touches no production data. Step 8 removes it.
- **Set every provider key before you point FXBO at the endpoint.** A missing
  key stores that row as `skipped`, and `skipped` is **final** — setting the key
  later does not resend those rows. There is no backfill.

Then recycle the app.

## 2. Deploy and confirm the worker started

`server.js` is in the app root, so iisnode's `watchedFiles` covers it. After the
recycle the iisnode stdout log should carry:

```
[crm-events] worker started (interval=60s)
```

If that line is absent, `initCrmSignupStore()` threw and you will see
`[crm-events] store init failed:` instead — check the `AUTH_DB_*` variables.
Without the store there is no `signup_events` table, no sweeper, and every
webhook answers 503.

Two other lines worth recognising in that log:

- `[crm-events] CRM_WEBHOOK_SECRET is not set or is blank…` — the endpoint is
  failing closed. Without this warning a deploy that lost the secret looks
  exactly like FXBO being misconfigured.
- `[crm-events] worker disabled by CRM_EVENTS_WORKER_ENABLED=false` — nothing
  will be sent at all until that is changed back, webhooks included. See the
  note at the bottom of this file.

## 3. Allow-list the endpoint in the CRM

*CRM Configuration → Advanced → System Configuration → Assistant Webhooks List.*

Add `https://app.skylinkscapital.com/api/crm-events`.

A URL cannot be selected in a rule until it appears in this list. As of
9 October the list held only two URLs.

## 4. Create the rules

*Configuration → Assistant → Rules → Add New Rule.* Method **Outcoming
webhook**, POST.

**Leave rules 25, 42 and 11 alone.** Add new rules beside them.

| Stage | Event, as the dropdown words it |
|---|---|
| `registered` | `Client registered` |
| `verified` | `A client has been verified` |
| `live_account` | `Client opened new live account` |
| `first_deposit` | `First time deposit by client` |
| `lead` | **Blocked.** The dropdown offers only `A new lead has been assigned to you` and `A lead has been assigned to other manager` — both assignment, not creation. Ask FXBO for a creation trigger, or accept lead-assignment as a proxy knowing it fires late and not for every lead. No code depends on this; the endpoint takes the stage as a parameter. |

### The header

`Authorization` = the `CRM_WEBHOOK_SECRET` value, on every rule.

**The secret is compared against the entire header value.** `Bearer <secret>`
is rejected — paste the secret and nothing else. This is pinned by a test in
`router.test.js`, and it is the single likeliest reason a rule you have set up
correctly in every other respect returns 401.

**Not a query string.** The existing `hook.php` mirrors put their secret in the
URL, where it is visible in Webhook Stats and in every proxy log between here
and there.

### The parameters

All Type `string`. The first is **a literal you type**, not a placeholder — one
of the five stage names, matching the rule you are in.

| Name | Value |
|---|---|
| `stage` | `registered` / `verified` / `live_account` / `first_deposit` / `lead` |
| `client_id` | `%client_id_without_link%` |
| `first_name` | `%client_first_name%` |
| `last_name` | `%client_last_name%` |
| `full_name` | `%client_full_name%` |
| `email` | `%client_email%` |
| `phone` | `%client_phone%` |
| `is_lead` | `%client_is_lead%` |
| `marketing_consent` | `%custom_consent_marketing%` |
| `source` | `%custom_formname%` |
| `entity` | `%custom_change_me_field%` |
| `is_ib` | `%client_is_ib%` |
| `language` | `%client_language%` |
| `utm_source` | `%client_utm_source%` |
| `utm_medium` | `%client_utm_medium%` |
| `utm_campaign` | `%client_utm_campaign%` |
| `referer` | `%client_referer%` |
| `full_link` | `%client_full_link%` |
| `unique_id` | `%unique_id%` |

### Delivery & Retry

- **"Update parameters' values on retry" OFF.** A redelivery has to carry an
  identical payload, or our deduplication is reasoning about a different event.
- **401 out of the retry error codes.** Retrying a rejected secret never
  succeeds; it just fills the log.
- **503, 500, 502 and 504 IN the retry codes, and delivery check on.** The
  endpoint answers 503 *only* when it could not store the event — so that row
  does not exist, and FXBO's redelivery is the only recovery there is. The
  composite unique key makes a redelivery harmless. Without 503 in this list, a
  database blip silently loses every event that arrives during it.
- **400 and 404 out.** Both mean the request itself is wrong, and a retry would
  be byte-identical.

## 4b. Confirm the server runs in strict SQL mode

```sql
SELECT @@sql_mode;
```

Confirm `STRICT_TRANS_TABLES` is present. It is MySQL 8's default, so this is a
check, not an expected change.

Why it matters: `crm_client_id` is deliberately **not** truncated to fit its
column. It is the deduplication key, and two over-width ids sharing a prefix
would silently collide into one row while `findExistingFbc` looked them up uncut
and found neither. Letting the INSERT fail loudly is the safe failure — but it
only fails under `STRICT_TRANS_TABLES`. A non-strict server truncates silently
and reinstates exactly that collision.

## 5. Find out what `%client_is_lead%` actually contains

Press a rule's **Test webhook** button. The press is recognised and stored as
`invalid`, so it creates no Brevo contact and posts no conversion to Meta — then
read `raw_payload` on that row to see exactly what FXBO sends.

Then register one real test client and read `raw_payload` again, for the real
value rather than the test-press value.

If that value is not one of `0` `false` `no` `n` `off`, add the real literal to
**`CLIENT_LITERALS`** in `normalise.js` — not to `FALSY`, which sits next to it
in the same file and looks like the right place. Only `CLIENT_LITERALS` decides
lead-versus-client (`deriveRecordType`); `FALSY` is for the consent and IB
flags, and holds `""`, `null` and `undefined` as well. Adding the literal to
`FALSY` changes nothing about who gets a message.

Until the real literal is in `CLIENT_LITERALS`, **every client is read as a lead
and nobody gets a WhatsApp message.** That direction is deliberate: a lead who
receives a login link for an account that does not exist is worse than a client
who misses a welcome message.

## 6. Build the frontend, or the settings tab will not appear

On the server:

```bash
npm ci && npm run build
```

Then recycle.

This is not optional and not automatic. Verified on 13 October: the deployed
bundle was built on 1 October at 13:39, while that day's two frontend commits
landed at 16:24 — the last build predates them. Nothing rebuilds on push.

Use `npm run build` (`scripts/build.mjs`, which emits an unhashed
`assets/index.js`), **not** `npx vite build`, which emits hashed filenames the
server's `index.html` does not reference.

Confirm:

```bash
curl -sI https://app.skylinkscapital.com/assets/index.js | grep -i last-modified
```

The tab appears under Settings → **CRM Events**, and needs both `Settings` and
`Auth:ManageUsers` — the same pair as API Clients, because the endpoint behind
it is admin-only and a visible tab that always answers "Could not load" reads as
an outage rather than as a permission problem.

## 7. Acceptance test

1. **Meta:** events appear under Events Manager → Test events within minutes.
2. **WhatsApp:** one real registration, and the message **arrives on a
   handset** — not merely a 200 from us, and not merely a 2xx from DoubleTick.
   Then check that row's `whatsapp_status` reads `sent`.
   A `rejected` row beside a message that visibly arrived means DoubleTick
   returned a success value outside our allowlist of `SENT` / `ENQUEUED`. The
   detail column names it and it needs adding. This is the designed way to
   discover a third value: loudly and at once, rather than counted as a success
   for ever.
3. **Brevo:** the contact appears in list 19 with `EXT_ID` and `OPT_IN`
   populated.
4. **Idempotency:** re-posting the identical webhook sends no second message and
   creates no second row.
5. **`fbc` reuse:** the same client at a different stage creates a new row and
   reuses the stored `fbc` — check the two rows carry an identical value. A
   different value per stage would hand Meta a different click identity for the
   same person at each step, with no error anywhere.

## 8. Unset the test event code and go live

Remove `META_TEST_EVENT_CODE` and recycle. Events then appear in Events Manager
within the hour, and Diagnostics reports anything Meta objects to.

## 9. Switch off the duplicate senders

**Until this step is done, every website signup produces two WhatsApp messages
and two Meta conversions.**

1. **The `slc-crm` WordPress plugin** (`D:\Signup\Signup 2.0\slc-crm`): remove
   the DoubleTick send and the `CompleteRegistration` pixel event. Keep the
   forms, the CRM record creation with `utmParams` and `full_link`, and the
   pixel's `PageView` and `InitiateCheckout`.
2. **FXBO's own Meta integration**, once this is confirmed live.
3. **The Lovable promo pages** must not add conversion events for either step.

## 10. Hand the promo-page fix to that team

Not our change, but the integration is incomplete without it. The promo pages
put the landing URL in a custom field named `Website`, while the CRM's ClickID
rule reads `full_link` inside `utmParams`. All ~250 existing promo leads
therefore have an empty ClickID and cannot be attributed at all. The fix is the
same URL-encoded `utmParams` pattern the WordPress plugin already uses, on every
promo page and form.

---

## Two things to know before you need them

**`CRM_EVENTS_WORKER_ENABLED=false` is how you pause sending.** Only the literal
`false` (any case) is recognised — `0` and `off` leave the worker on. It stops
the polling timer *and* every sweep, including the immediate one a newly stored
event triggers through `kickCrmEventsWorker`. The endpoint keeps answering 200
and the events keep landing in `signup_events`; nothing is sent, and nothing is
lost. Each destination's clock is a column rather than a timer, so the first
sweep after you set it back to `true` catches up everything that came due in
between.

Do **not** reach for an unset provider key instead: a row stored while the key is
missing is marked `skipped`, which is final, and putting the key back never
resends it. Stopping the app pool is worse again — the webhook answers 503 until
FXBO has spent its twelve retries on each event.

**Two workers during a deploy is fine.** The host performs overlapped recycles,
so a draining worker and a new one do briefly sweep together, and
`claimDueEvents` takes no row lock — both read the same due rows. What keeps a
client from being messaged twice is the pre-send write: it only lands while the
action is still unsent and its clock is due, and the worker whose write matches
no row sends nothing and records nothing. In the log that worker says
`left to the sweeper that claimed row <id>`, which is a normal line during a
recycle and not a failure.
