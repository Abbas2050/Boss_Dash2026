# Meta lead ads → FXBO leads

**Date:** 2026-11-06
**Status:** Approved design, pending implementation plan

Three Google Sheets are filled by Meta's Lead Ads integration. Every new row in
them becomes a lead in FXBO, once, within about a minute, with the sheet it came
from deciding whether it is an IB lead and who owns it.

---

## 1. What the sheets actually contain

Read on 2026-11-06 from the three workbooks, not assumed.

| Sheet | Id | Campaign | Rows | Headers |
|---|---|---|---|---|
| Iraq | `1-lAAXoqOQGwnGGKbTqGHSqe2hQmOOzh2HvluPABl3g8` | Partners-IB-Iraq | 30 real | English |
| Turkey | `1QTnAk_02wen7JoKnzb647YtH0HhI2KPElaH79Re-oKE` | Partners-IB-Turkey | 6 real | **Turkish** |
| UAE | `1aSbMb79K8L4YdFVyCXzOZB0SXoFjrxPsdCqYxb1K35c` | Zero-Spread-UAE | 0 real, 1 test | English |

All three carry the same eighteen columns in the same order:

```
id  created_time  ad_id  ad_name  adset_id  adset_name  campaign_id
campaign_name  form_id  form_name  is_organic  platform  email
phone_number  first_name  last_name  country  lead_status
```

Four facts from that data drive the design.

### Headers are localised, positions are not

The Turkey sheet names columns 13–17 `e-posta`, `telefon_numarası`, `adı`,
`soyadı`, `ülke`. A reader that looks up columns by header name works on two
sheets and silently reads blanks on the third — blanks that would reach FXBO as
a nameless, email-less lead. **Columns are therefore read by position.** The
header row is still read, once per poll, and compared against a table of known
labels per position; a mismatch disables that sheet and says so in the tab,
rather than importing garbage. Meta has no reason to reorder these columns, and
if it ever does, we stop instead of corrupting the CRM.

### Meta prefixes its identifiers

`l:1593296142070496`, `ag:120254281744030268`, `c:120254281171170268`,
`f:1417668933787039`, and crucially `p:+9647705108061`. The prefixes stop Sheets
reformatting long digit strings as numbers. The `p:` must be stripped before the
phone reaches FXBO; the `l:` lead id, stripped or not, is globally unique and
immutable, which makes it the deduplication key.

### One sheet contains only a Meta test lead

The UAE sheet's single row is `test@meta.com` with
`<test lead: dummy data for first_name>` in every text field and
`is_organic = true`. Meta writes one of these whenever a form is tested. It must
never reach the CRM.

### The `country` column is wrong often enough to ignore

Seven of the thirty Iraq rows say `US` while the phone number begins `+964`.
Meta reports the account's profile locale, not the lead's country. Country is
therefore derived from the phone's dialling code first.

---

## 2. Decisions taken with the user, 2026-11-06

| Question | Decision |
|---|---|
| Lead type | **Plain leads. `ib` is false on all three sheets.** The flag is still per-sheet, so one can be switched on without a deploy. |
| Lead source (`referrer`) | **Not sent.** Left empty, like the CRM's other 499 users. Per-sheet, so it can be switched on. |
| Owner | **Unassigned.** `managerId` is left empty on every sheet. The field is still per-sheet. |
| Tags | **None.** No tags are sent. The field is still per-sheet. |
| Language | **`en` on all three sheets**, including Iraq and Turkey. |
| The 36 rows already in the sheets | **Not imported.** Marked handled on first read. |
| Someone already in FXBO | **Skip on email. Allow on phone** — two people may share a line. |
| Latency | **About a minute.** The worker polls every 60 seconds. |

Four of these were originally answered the other way — an IB flag, a lead
source, an owner and tags, each chosen per sheet — and were reversed on the
same day, once the live CRM showed what those fields hold today (§2.1). The
per-sheet columns survive the reversal because they cost one nullable column
and one form field each, and because an answer that changed once can change
again.

What is left is a deliberately bare lead: a name, a way to contact them, a
country, and the Meta campaign that produced them. Everything the sales team
would otherwise have to undo is simply not set.

### 2.1 What the live CRM holds, read 2026-11-06

From the first 500 users (36 leads, 73 IBs), which is what made the three
reversals above the obvious call:

| Field | In use today |
|---|---|
| `managerId` | 20 on 229 users, then 23, 28, 7, 11, 29, 3; **224 unassigned** |
| `referrer` | 499 empty, one holding `13311` |
| `status` | 498 empty, `new` on two |
| `tags` | `15pBonus` (160), `IB` (16), and FXBO's own `Incomplete …` tags |
| `language` | 392 empty, `en` on 107 |
| `source` | `rest api` on 461 — FXBO sets this itself for anything the API creates |

Two consequences. An unassigned lead is the CRM's normal state, not an
oversight. And `referrer` is effectively a free field — which is an argument for
leaving it empty as everyone else does, and, if that is ever revisited, for
checking §6.3 first.

**`GET /rest/managers` is refused**: `403 invalid_grant`, "Method is not
allowed". The API user cannot list managers, the same scope gap that blocks API
Clients and Finalto Admin. Manager ids therefore have to be read from the FXBO
UI, which matters only if an owner is ever set.

---

## 3. Why polling, and not a push

Three ways to learn that a row arrived; we take the first.

**Polling from our server (chosen).** The `googleapis` service account that
already reads the FAB workbook (`wallet/fabAccountsSheet.js`) reads these three
every 60 seconds. Everything lives in this repo, and the design is self-healing:
when the IIS app pool is down — which it was on 1 and 3 November — the next poll
after it returns picks up every row that arrived meanwhile, and the unique lead
id makes a re-read harmless. No catch-up machinery is needed, unlike the
scheduled reports.

**An Apps Script trigger in each sheet.** Instant, but the script lives in a
Google account rather than in this repository. A copied sheet, a renamed tab or
a revoked trigger stops it with nothing in the dashboard able to notice. Three
scripts to keep alive against one worker.

**Meta's Lead Ads webhook, with no sheet at all.** Architecturally the cleanest
and the right long-term answer, but it needs a Facebook app with
`leads_retrieval`, App Review, a page subscription and a long-lived page token
per page. That is its own project; the sheets work today.

---

## 4. Shape

A new `metaLeads/` module, following `crmSignup/` file for file, because that
module already solves this shape: ingest, store once, act with retries, show it
in a tab.

| File | Responsibility |
|---|---|
| `metaLeads/sheetsReader.js` | Reads rows by column position; strips Meta's prefixes; verifies the header row |
| `metaLeads/normalise.js` | One row → one candidate lead, or a reason to skip it |
| `metaLeads/store.js` | MariaDB `meta_lead_sheets` and `meta_lead_rows`, on the existing `AUTH_DB_*` pool |
| `metaLeads/fxbo.js` | Email lookup, then `POST /rest/users/new` |
| `metaLeads/worker.js` | 60-second `setInterval`: poll each enabled sheet, then drain the queue |
| `metaLeads/router.js` | The tab's API: list rows, retry one, add/edit/enable a sheet |
| `src/pages/settings/MetaLeadsPage.tsx` | The `/settings/meta-leads` tab |

Reading and sending are separate passes over separate state, so a Google outage
cannot lose a queued lead and a CRM outage cannot make us re-read a sheet.

### Polling without re-reading the whole sheet every minute

Each sheet row in `meta_lead_sheets` holds `last_row_count`. A poll reads
`A{last_row_count + 1}:R`, which is an empty response in the common case where
nothing arrived. Once an hour the sheet is read in full instead, to catch rows
inserted above the end or edited after the fact. The unique lead id means the
full read can never produce a duplicate; it exists only to find what the
windowed read would miss.

### The row's life

```
new id seen ──> pending ──> sent
                   │
                   ├──> duplicate        (email already in FXBO)
                   ├──> skipped_test     (Meta test row)
                   ├──> skipped_empty    (no email and no phone)
                   ├──> skipped_existing (was in the sheet before registration)
                   └──> failed           (after retries; requeueable from the tab)
```

Transient CRM failures — a 429, a 5xx, a dropped socket — are retried with
exponential backoff up to six attempts, reusing `crmSignup/transientHttp.js`.
A 4xx that is not 429 is permanent: it is recorded with the CRM's own wording,
because "the CRM refused this" and "we have not tried yet" must never look alike
in the tab.

---

## 5. What is pushed to FXBO

One `POST /rest/users/new` per row, called from the server with the helpers in
`docusign/crm.js` — `getCrmBaseUrl()`, `authHeaders()`, `versionQuery()` — so
the CRM token is read in the same one place the Back Office panel reads it and
never reaches the browser. Not through the `/rest` proxy in `server.js`: that
proxy exists so the *browser* can reach the CRM without holding the token, and
a server process calling its own HTTP front door to talk to a third party adds
a hop and a failure mode for nothing.

| FXBO field | Value | Source |
|---|---|---|
| `lead` | `true` | always — this endpoint creates a client when false |
| `ib` | `false` | the sheet's setting, false on all three today |
| `firstName` | given name | §6.1 |
| `lastName` | family name | §6.1 |
| `email` | trimmed, lower-cased | `email` column |
| `phone` | `+9647705108061` | `phone_number`, `p:` stripped |
| `country` | ISO alpha-2 | §6.2 |
| `language` | `en` | the sheet's setting, `en` on all three |
| `utmParams` | query string | §6.4 |
| `sendWelcomeEmail` | `false` | these people did not ask for an account |
| `acceptedDocuments` | `false` | they have accepted nothing |

Eleven fields. **`managerId`, `referrer`, `tags` and `status` are not sent at
all**, because all three sheets leave them unset: the lead lands unassigned,
unattributed in the CRM's own fields, untagged, and on whatever status FXBO
gives it. Setting any of them on a sheet adds that field to that sheet's
payload and nothing else changes.

With `referrer` empty, **`utmParams` is the only attribution that reaches the
CRM.** FXBO files it under the user's marketing details, where the campaign, ad
set and ad can still be read per lead — so nothing is lost, but it is read in a
different place than a sales person would look first.

Everything else the endpoint accepts — `password`, `middleName`, `city`,
`birthDate`, `title`, `partnerId`, `secondaryEmail`, `secondaryPhone`,
`enabled`, `trader`, `marketingLinkId`, `referralLinkId`, `cellxpertCxd` — is
**omitted**, not sent empty. A Meta lead form gives us none of them, and sending
an empty string where FXBO has a default is how a default gets overwritten with
nothing.

The line between the two is whether we have an answer, not whether the answer is
interesting. `ib: false` is sent because the sheet states it; `city` is omitted
because nobody asked the lead for one. So a sheet switched to `ib: true` changes
one field in the payload, and no field ever carries a value we invented.

Every field above is therefore defensible on its own terms, and the payload is
small enough to read in full in the tab beside the row that produced it.

**The Meta lead id is deliberately not pushed.** It would have to go in a tag,
where it would be noise in every CRM list view. It is held in `meta_lead_rows`
and is searchable in the tab, which is where anyone tracing a lead back to its
ad will be looking anyway.

---

## 6. The mapping rules

### 6.1 Names

Both columns populated — use them as given: `Kaboul` / `Mutawa`.

`last_name` empty, which is most of the Iraq sheet — split `first_name` on its
final space. `ساجد كريم جاسم البياتي` gives `firstName = "ساجد كريم جاسم"` and
`lastName = "البياتي"`. A single word gives a `firstName` and no `lastName`.

The last space, not the first, because Arabic names here are a given name
followed by patronymics and a family name; the family name is the final token.

### 6.2 Country

In order, first that answers:

1. The phone's dialling code, by longest-prefix match against a table of
   unambiguous codes — `+964` → `IQ`, `+90` → `TR`, `+971` → `AE`. Codes shared
   by several countries (`+1`, `+7`) do not answer.
2. A country named in `adset_name` — `Partners-IB-Iraq` → `IQ`.
3. Meta's `country` column, which is right more often than it is wrong but is
   wrong on a fifth of the Iraq rows.

If none answers, `country` is omitted and the row still goes through. A lead
without a country is workable; a lead filed under the wrong one is not.

### 6.3 Lead source, when a sheet turns it on

`referrer` is off on all three sheets and nothing is sent. The derivation is
specified here because the per-sheet switch exists, and a rule invented later
under time pressure is how two sheets end up disagreeing about what a lead
source means.

When on, `referrer` is the row's `adset_name` — read from the row, not
configured, so the same sheet produces a different value as campaigns are
launched. `adset_name` is empty on organic and test rows, and on a lead from a
form shared outside an ad; the fallback is then `campaign_name`, then
`form_name`, because `Zero-Spread-UAE` is a more useful lead source than
nothing. If all three are empty the field is omitted.

**It needs one look before it is trusted.** The API documents `referrer` as
*lead source*, a free string, and 499 of 500 users leave it empty — but the one
that does not holds `13311`, which reads like a user id. If FXBO's UI renders
the field as a link to a referring user rather than as text, an ad set name
will look wrong there and belongs in a tag instead. Whoever switches this on
checks the first lead by eye.

### 6.4 utmParams

A query string of standard UTM keys only, because FXBO's own example shows UTM
keys and we have no evidence it keeps anything else:

```
utm_source=facebook&utm_medium=paid_social&utm_campaign=Partners-IB
&utm_content=Partners-IB-Iraq-Ad3&utm_term=Partners-IB-Iraq
```

`utm_source` is `facebook` or `instagram`, from the `platform` column's `fb` and
`ig`. Each value is URL-encoded; a form or ad name containing `&` would
otherwise truncate everything after it.

### 6.5 Rows that are skipped, not sent

- Any field containing `<test lead:`, or an email of `test@meta.com`, or
  `is_organic` true — `skipped_test`.
- No email **and** no phone — `skipped_empty`; there is no one to create.
- No email but a phone — **sent**, as a phone-only lead, and flagged in the tab.
  The email duplicate check cannot run, which is recorded rather than inferred.

---

## 7. Registering a sheet, and the first read

A sheet is added in the tab, not in code: spreadsheet id, tab name, a label,
the language, and — all defaulting to off or empty — the IB flag, a lead
source, an owner, a status and tags.

The three sheets go in like this:

| | Iraq | Turkey | UAE |
|---|---|---|---|
| Label | Meta – Iraq | Meta – Turkey | Meta – UAE |
| `language` | `en` | `en` | `en` |
| `ib` | off | off | off |
| `referrer` | off | off | off |
| `managerId` | empty | empty | empty |
| `tags` | empty | empty | empty |
| `status` | empty | empty | empty |

**Only the label differs.** That is the point, and it is worth stating plainly:
there is currently no setting on which the three sheets disagree, so any future
difference between them will be one somebody chose. The per-sheet columns exist
to make that choice cheap, not because it has been made.

On the **first** poll after a sheet is registered, every row then present is
written directly as `skipped_existing` and nothing is sent. The sheet's
`bootstrapped_at` is stamped in the same transaction. This is what makes going
live safe: the 36 leads already in these sheets, some of which the team has
worked by hand, cannot be re-created.

A sheet can be disabled at any time; disabled sheets are not polled, and rows
already queued for them still drain.

---

## 8. Failure, and what it looks like

Every failure is a row in the tab with the CRM's own message, the attempt count
and the time of the next attempt. Nothing fails silently and nothing is retried
for ever.

Three failures are distinguished because they need different actions:

- **The sheet could not be read** — the service account lost access, or the tab
  was renamed. Recorded against the sheet, not against any row, and shown beside
  its last successful read.
- **The header row changed** — the sheet is disabled and says so. Importing from
  a sheet whose columns moved is worse than not importing.
- **The CRM refused a row** — recorded against the row, with FXBO's wording,
  retried if transient and requeueable by hand if not.

---

## 9. Access and secrets

The three sheets must be shared, read-only, with the service account already
configured as `GA4_SERVICE_ACCOUNT_JSON`. Its scope stays
`spreadsheets.readonly`.

The CRM token is never read by this module directly; it goes through the proxy
in `server.js`, which is the only place `API_TOKEN` is read.

`/settings/meta-leads` and its API routes sit behind `requireSession` and a new
`Settings:meta-leads` permission chip in the Settings access panel.

---

## 10. Testing

Unit tests per file, following the module convention already in `crmSignup/`:

- `normalise` — the name split in both shapes and in Arabic; every country
  branch including the ambiguous dialling code; prefix stripping; each skip rule.
- `sheetsReader` — a Turkish header row read correctly by position; a reordered
  header row rejected; the windowed read and the hourly full read.
- `store` — the unique lead id refusing a second insert; bootstrap marking every
  existing row in one transaction.
- `fxbo` — the exact payload for an IB sheet and a retail sheet; omitted fields
  genuinely absent rather than empty; the email lookup's three outcomes.
- `worker` — a Google outage leaving the queue intact; a CRM outage not
  advancing `last_row_count`; backoff and the terminal attempt.

Each guard test is mutation-proved: the guard is broken on purpose and the test
is shown to fail before the guard is restored.
