# CRM Events Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive FXBO webhooks at five points in the client funnel, store each once, then independently send a Meta Conversions API event, a DoubleTick WhatsApp welcome, and a Brevo contact.

**Architecture:** A `crmSignup/` module following the existing `docusign/` pattern — pure helpers tested directly, a thin MySQL store, one route handler registered in `server.js`, and a `setInterval` sweeper driving retries off database columns rather than in-memory timers. The HTTP handler does four things only: authenticate, validate, store, respond 200.

**Tech Stack:** Node ESM (`"type": "module"`), Express, `mysql2/promise`, global `fetch`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-crm-signup-webhook-design.md`

**Supersedes:** `docs/superpowers/plans/2026-10-09-crm-signup-webhook.md`, which covered one stage and two destinations. Do not execute both.

## Global Constraints

- **ESM only.** Every relative import carries its `.js` extension. No `require`.
- **Backend tests start with `// @vitest-environment node`** on line 1. The project default is `jsdom` (`vite.config.ts`), which breaks Node-only tests.
- **Never boot Express in a test.** Importing `server.js` opens a real listener and a database pool. Test handlers directly with a fake `res` (the pattern in `reports/reportScheduleRoute.test.js`), and verify route registration by reading `server.js` source (the pattern in `auth/routeCoverage.test.js`).
- **Never log `META_CAPI_ACCESS_TOKEN`, `WA_API_KEY`, `BREVO_API_KEY`, or `CRM_WEBHOOK_SECRET`.** Not on failure, not in a thrown error, not truncated.
- **Never log a full phone number or email address.** Use `maskPhone` / `maskEmail` from Task 1 everywhere — logs, stored `_detail` columns, admin view.
- **No exception escapes the handler or the worker.** Every path ends in a stored status.
- **Return 200 once the row is stored.** Never 5xx because a provider failed — that makes FXBO redeliver an event we already hold.
- **Retries live in database columns, never `setTimeout`.** node-cron and in-process timers die with the IIS worker on this host.
- **Run one test file:** `npx vitest run <path> --reporter=verbose` · **Full suite:** `npm test`

### The five stages

`lead` · `registered` · `verified` · `live_account` · `first_deposit`

| Stage | Meta `event_name` | WhatsApp | Brevo |
|---|---|---|---|
| `lead` | `Lead` | no | no |
| `registered` | `CompleteRegistration` | **yes** | **yes** |
| `verified` | `Client_Verified` | no | no |
| `live_account` | `TradingAccountOpened` | no | no |
| `first_deposit` | `Purchase` | no | no |

### The stage arrives as a body parameter, not a path segment

`POST /api/crm-events` with `stage` as a webhook parameter whose value is a
literal typed into each FXBO rule. **Not** `/api/crm-events/:stage`:
`auth/requireSession.js` matches the allow-list against the *actual request
path*, so a `:stage` pattern would never match and the route would fall through
to session auth. Five literal paths would need five allow-list entries, and
`auth/routeCoverage.test.js` caps that list at six (four are already used). One
path, one entry.

### One stage is still blocked — stated, not hidden

**`lead` needs no code assumption.** The endpoint is stage-agnostic, so the code
is complete regardless. Only its *FXBO rule* is blocked: the dropdown offers
`A new lead has been assigned to you` and `A lead has been assigned to other
manager`, both assignment rather than creation. Task 12 marks that rule blocked
pending FXBO. The other four stages are fully specified.

### `Purchase` carries no value or currency (2026-10-13, user's call)

An earlier draft fetched the deposit amount over the FXBO REST API so `Purchase`
could carry it. That is gone: no REST call, no discovery script, no deposit
columns, and the dataset's financial-category restriction on custom parameters
stops mattering. The trade-off, already noted in the user's own integration
plan, is that Meta learns a deposit happened but not what it was worth, so there
is no return-on-ad-spend measurement.

---

## File Structure

| File | Responsibility |
|---|---|
| `crmSignup/normalise.js` | Pure. Raw body → normalised fields, stage validation, validity verdict, masking. |
| `crmSignup/clickId.js` | Pure. `full_link` → `fbclid` → the wrapped `fbc`. |
| `crmSignup/meta.js` | Hashing, CAPI payload, outcome classifier, send. |
| `crmSignup/whatsapp.js` | DoubleTick payload, skip decision, outcome classifier, send. |
| `crmSignup/brevo.js` | Contact builder, outcome classifier, upsert. |
| `crmSignup/store.js` | MySQL: schema, insert-if-absent, `fbc` reuse, status updates, claim-due, list-recent. |
| `crmSignup/router.js` | `makeCrmEventsHandler` — auth, test-press guard, validate, store, 200. |
| `crmSignup/worker.js` | `planRetry`, `processSignupEvent`, the sweeper. |
| `crmSignup/stats.js` | Pure. Rows → health, funnel counts, per-destination counters, masked table rows. |
| `crmSignup/overviewRoute.js` | `GET /api/crm-events/overview` — the JSON the settings page reads. |
| `src/pages/settings/CrmEventsPage.tsx` | The settings tab. |
| `server.js` | Register two routes, init the store, start the worker. |
| `src/App.tsx`, `src/lib/permissions.ts` | Route and menu entry for the settings tab. |
| `auth/requireSession.js` | Add `POST /api/crm-events` to `PUBLIC_API_ROUTES`. |
| `docusign/fxboPlaceholder.js` | Extend `FXBO_PLACEHOLDER_LABELS`. |

---

## Task 1: Normalisation, stages and masking

**Files:**
- Create: `crmSignup/normalise.js`
- Test: `crmSignup/normalise.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `STAGES: string[]`, `isStage(value): boolean`
  - `PHONE_RE: RegExp`, `REQUIRED_FIELDS: string[]`
  - `isFalsyLiteral(value): boolean`
  - `deriveRecordType(isLead): "client" | "lead"`
  - `deriveMiddleName(fullName, firstName, lastName): string`
  - `maskEmail(email): string`, `maskPhone(phone): string`
  - `normaliseEvent(raw): { valid, missing, fields }`
  - `Fields` keys: `stage, crmClientId, firstName, middleName, lastName, email, phone, recordType, marketingConsent, source, entity, isIb, language, utmSource, utmMedium, utmCampaign, referer, fullLink, fxboUniqueId`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/normalise.test.js`:

```js
// @vitest-environment node
//
// The payload decisions that are easy to get wrong and expensive when wrong.
// Nothing here touches the network or a database.
import { describe, it, expect } from "vitest";
import {
  STAGES,
  isStage,
  PHONE_RE,
  isFalsyLiteral,
  deriveRecordType,
  deriveMiddleName,
  maskEmail,
  maskPhone,
  normaliseEvent,
} from "./normalise.js";

describe("stages", () => {
  it("knows exactly the five funnel stages", () => {
    expect(STAGES).toEqual(["lead", "registered", "verified", "live_account", "first_deposit"]);
  });

  it("rejects anything else, including near misses", () => {
    // The stage is typed by hand into each FXBO rule, so a typo is a real
    // failure mode and must not quietly create a sixth kind of row.
    expect(isStage("registered")).toBe(true);
    expect(isStage("Registered")).toBe(false);
    expect(isStage("register")).toBe(false);
    expect(isStage("")).toBe(false);
    expect(isStage(undefined)).toBe(false);
  });
});

describe("phone validation", () => {
  it("accepts both ends of the permitted length range", () => {
    expect(PHONE_RE.test("+12345678")).toBe(true);
    expect(PHONE_RE.test("+123456789012345")).toBe(true);
    expect(PHONE_RE.test("+971507192185")).toBe(true);
  });

  it("rejects one digit either side, a leading zero, and spacing", () => {
    expect(PHONE_RE.test("+1234567")).toBe(false);
    expect(PHONE_RE.test("+1234567890123456")).toBe(false);
    expect(PHONE_RE.test("+0123456789")).toBe(false);
    expect(PHONE_RE.test("971507192185")).toBe(false);
    expect(PHONE_RE.test("+971 50 719 2185")).toBe(false);
  });
});

describe("record type", () => {
  it("reads the recognised falsy literals as a client", () => {
    for (const v of ["0", "false", "FALSE", "no", "N", "off"]) {
      expect(deriveRecordType(v), v).toBe("client");
    }
  });

  it("reads absent, empty and unrecognised as a lead", () => {
    // A client who misses a welcome message is a support ticket; a lead who
    // gets a login link for an account that does not exist is a complaint.
    expect(deriveRecordType(undefined)).toBe("lead");
    expect(deriveRecordType("")).toBe("lead");
    expect(deriveRecordType("maybe")).toBe("lead");
    expect(deriveRecordType("1")).toBe("lead");
  });

  it("does not read null or undefined as a client", () => {
    // Both are falsy for consent and IB flags, where absent means no. For the
    // record type they mean unknown: a template variable that failed to render
    // arrives as one of these strings, and unknown resolves to lead.
    for (const v of ["null", "undefined"]) {
      expect(deriveRecordType(v), v).toBe("lead");
    }
  });
});

describe("isFalsyLiteral", () => {
  it("treats empty as falsy for ordinary flags", () => {
    expect(isFalsyLiteral("")).toBe(true);
    expect(isFalsyLiteral(undefined)).toBe(true);
    expect(isFalsyLiteral("1")).toBe(false);
  });

  it("still treats null and undefined as falsy, unlike the record type", () => {
    expect(isFalsyLiteral("null")).toBe(true);
    expect(isFalsyLiteral("undefined")).toBe(true);
  });
});

describe("middle name derivation", () => {
  it("takes what sits between a matching first and last name", () => {
    expect(deriveMiddleName("Ali Hassan Khan", "Ali", "Khan")).toBe("Hassan");
    expect(deriveMiddleName("Mohammed Ali Hassan Khan", "Mohammed", "Khan")).toBe("Ali Hassan");
  });

  it("returns empty when there is no middle to take", () => {
    expect(deriveMiddleName("Ali Khan", "Ali", "Khan")).toBe("");
    expect(deriveMiddleName("", "Ali", "Khan")).toBe("");
  });

  it("returns empty rather than guessing when the ends do not match", () => {
    expect(deriveMiddleName("John Smith Jones", "Bob", "Jones")).toBe("");
    expect(deriveMiddleName("John Smith Jones", "John", "Brown")).toBe("");
  });

  it("keeps a multi-word surname as the end it matches", () => {
    expect(deriveMiddleName("Ahmed Mohammed Al Mansoori", "Ahmed", "Al Mansoori")).toBe("Mohammed");
  });

  it("is not confused by case or extra spacing", () => {
    expect(deriveMiddleName("  ali   hassan   khan ", "Ali", "KHAN")).toBe("hassan");
  });
});

describe("masking", () => {
  it("never leaves the full address or number in the output", () => {
    expect(maskEmail("abbas.rahman@skylinkscapital.com")).not.toContain("abbas.rahman");
    expect(maskPhone("+971507192185")).not.toContain("7192185");
  });

  it("keeps enough to identify a record by eye", () => {
    expect(maskEmail("abbas@skylinkscapital.com")).toBe("a***@skylinkscapital.com");
    expect(maskPhone("+971507192185")).toBe("+971***85");
  });

  it("does not leak a second address when a field holds two", () => {
    // Splitting on the first '@' would show the second address whole.
    expect(maskEmail("a@x.com, bob.smith@y.com")).toBe("a***@y.com");
  });

  it("masks a short number entirely rather than barely", () => {
    // Four leading and two trailing characters is most of an 8-digit number.
    expect(maskPhone("12345678")).toBe("***");
    expect(maskPhone("+12345678")).toBe("***");
  });

  it("pins the 12-character boundary exactly", () => {
    expect(maskPhone("+96551234567")).toBe("+965***67"); // 12 characters
    expect(maskPhone("+6581234567")).toBe("***"); // 11 characters
  });

  it("handles empty and malformed input without throwing", () => {
    expect(maskEmail("")).toBe("");
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskPhone("")).toBe("");
    expect(maskPhone("+123")).toBe("***");
  });
});

describe("normaliseEvent", () => {
  const RAW = {
    stage: "registered",
    client_id: "88214",
    first_name: "Ali",
    last_name: "Khan",
    full_name: "Ali Hassan Khan",
    email: "  Ali.Khan@Example.COM ",
    phone: "+971507192185",
    is_lead: "0",
    marketing_consent: "1",
    source: "SVG",
    entity: "SVG Ltd",
    is_ib: "1",
    language: "en",
    utm_source: "meta",
    utm_medium: "cpc",
    utm_campaign: "zero-spread-ind-2",
    referer: "https://skylinkscapital.com/en/",
    full_link: "https://skylinkscapital.com/en/?utm_source=meta&fbclid=IwY2xjawUsILdI",
    unique_id: "d3f1-aa",
  };

  it("maps a complete payload", () => {
    const { valid, missing, fields } = normaliseEvent(RAW);
    expect(valid).toBe(true);
    expect(missing).toEqual([]);
    expect(fields).toEqual({
      stage: "registered",
      crmClientId: "88214",
      firstName: "Ali",
      middleName: "Hassan",
      lastName: "Khan",
      email: "ali.khan@example.com",
      phone: "+971507192185",
      recordType: "client",
      marketingConsent: true,
      source: "SVG",
      entity: "SVG Ltd",
      isIb: true,
      language: "en",
      utmSource: "meta",
      utmMedium: "cpc",
      utmCampaign: "zero-spread-ind-2",
      referer: "https://skylinkscapital.com/en/",
      fullLink: "https://skylinkscapital.com/en/?utm_source=meta&fbclid=IwY2xjawUsILdI",
      fxboUniqueId: "d3f1-aa",
    });
  });

  it("names every missing required field", () => {
    const { valid, missing } = normaliseEvent({ ...RAW, client_id: "", email: "  " });
    expect(valid).toBe(false);
    expect(missing).toEqual(["crmClientId", "email"]);
  });

  it("treats an unknown or absent stage as a missing required field", () => {
    expect(normaliseEvent({ ...RAW, stage: "typo" }).missing).toEqual(["stage"]);
    expect(normaliseEvent({ ...RAW, stage: undefined }).missing).toEqual(["stage"]);
  });

  it("does not treat a missing phone as invalid", () => {
    // A bad phone is a WhatsApp skip, not a bad event.
    const { valid, fields } = normaliseEvent({ ...RAW, phone: "" });
    expect(valid).toBe(true);
    expect(fields.phone).toBe("");
  });

  it("reads is_lead as the record type, independent of is_ib", () => {
    const { fields } = normaliseEvent({ ...RAW, is_lead: "1", is_ib: "0" });
    expect(fields.recordType).toBe("lead");
    expect(fields.isIb).toBe(false);
  });

  it("reads marketing_consent and is_ib into their own fields", () => {
    // RAW has both flags as "1", so a swap of the two wirings is invisible
    // unless one of them changes here.
    const { fields } = normaliseEvent({ ...RAW, marketing_consent: "0" });
    expect(fields.marketingConsent).toBe(false);
    expect(fields.isIb).toBe(true);
  });

  it("treats unrendered template literals as missing, but keeps them in fields", () => {
    // A template variable that failed to render arrives as "null" or "undefined".
    // Left as a key, every such event would collide on one row.
    const { valid, missing, fields } = normaliseEvent({
      stage: "registered",
      client_id: "null",
      first_name: "undefined",
      email: "null",
    });
    expect(valid).toBe(false);
    expect(missing).toEqual(["crmClientId", "firstName", "email"]);
    expect(fields.crmClientId).toBe("null");
    expect(normaliseEvent({ ...RAW, client_id: "NULL" }).missing).toEqual(["crmClientId"]);
  });

  it("defaults absent flags to false and never throws on an empty body", () => {
    const { valid, missing, fields } = normaliseEvent({});
    expect(valid).toBe(false);
    expect(missing).toEqual(["stage", "crmClientId", "firstName", "email"]);
    expect(fields.marketingConsent).toBe(false);
    expect(fields.isIb).toBe(false);
    expect(fields.recordType).toBe("lead");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run crmSignup/normalise.test.js --reporter=verbose`
Expected: FAIL — `Failed to load url ./normalise.js`

- [ ] **Step 3: Write the implementation**

Create `crmSignup/normalise.js`:

```js
/**
 * Turning one FXBO webhook body into the fields the rest of the module uses.
 *
 * Everything here is pure. The two decisions worth reading twice are the record
 * type (which gates whether anyone gets a WhatsApp message) and the middle name
 * (which FXBO has no placeholder for, so it is derived).
 */

/** The funnel, in order. The value is typed by hand into each FXBO rule. */
export const STAGES = ["lead", "registered", "verified", "live_account", "first_deposit"];

const STAGE_SET = new Set(STAGES);

export function isStage(value) {
  return STAGE_SET.has(String(value ?? ""));
}

/** E.164: a plus, a non-zero leading digit, then 7 to 14 more. 8-15 digits. */
export const PHONE_RE = /^\+[1-9]\d{7,14}$/;

/** Without these there is nothing to key on, nothing to greet, and nothing to
 *  create in Brevo. A missing phone is NOT fatal -- it is a WhatsApp skip. */
export const REQUIRED_FIELDS = ["stage", "crmClientId", "firstName", "email"];

/** A template variable that failed to render arrives as one of these strings.
 *  For the required fields it counts as missing, so a "null" client id cannot
 *  act as a shared key. The values themselves stay in `fields`. */
const UNRENDERED = new Set(["null", "undefined"]);

const FALSY = new Set(["", "0", "false", "no", "n", "off", "null", "undefined"]);

/**
 * The client-meaning literals for the record type, exactly as spec §2 names
 * them. Deliberately narrower than FALSY: the asymmetry is intentional, because
 * a lead who receives a login link for an account that does not exist is worse
 * than a client who misses a welcome message. So "null" and "undefined" stay out
 * here, even though they are falsy for consent and IB flags, where absent
 * legitimately means no.
 */
const CLIENT_LITERALS = new Set(["0", "false", "no", "n", "off"]);

const text = (v) => String(v ?? "").trim();

export function isFalsyLiteral(value) {
  return FALSY.has(text(value).toLowerCase());
}

/**
 * Lead or client.
 *
 * Only a recognised client literal (see CLIENT_LITERALS) makes a client. Absent,
 * empty and anything unrecognised resolve to "lead", the side that cannot cause
 * harm: the welcome message links to a login page, and a lead has no account to
 * log into.
 */
export function deriveRecordType(isLead) {
  return CLIENT_LITERALS.has(text(isLead).toLowerCase()) ? "client" : "lead";
}

/**
 * FXBO has no middle-name placeholder, so it comes out of the full name.
 * Conservative: the full name must begin with the first name and end with the
 * last, or we cannot say which part is the middle and return nothing. Matching
 * is on the whole first and last name, so a multi-word surname works.
 */
export function deriveMiddleName(fullName, firstName, lastName) {
  const collapse = (v) => text(v).replace(/\s+/g, " ");
  const full = collapse(fullName);
  const fullLower = full.toLowerCase();
  const first = collapse(firstName).toLowerCase();
  const last = collapse(lastName).toLowerCase();
  if (!full || !first || !last) return "";
  if (!fullLower.startsWith(`${first} `) || !fullLower.endsWith(` ${last}`)) return "";
  return full.slice(first.length, full.length - last.length).trim();
}

export function maskEmail(email) {
  const v = text(email);
  if (!v) return "";
  // The last '@' is the one that begins the domain. Splitting on the first
  // would leave a second address in a multi-address value whole.
  const at = v.lastIndexOf("@");
  if (at < 1) return "***";
  return `${v.slice(0, 1)}***${v.slice(at)}`;
}

export function maskPhone(phone) {
  const v = text(phone);
  if (!v) return "";
  // Four leading and two trailing characters must not cover most of a short number.
  if (v.length < 12) return "***";
  return `${v.slice(0, 4)}***${v.slice(-2)}`;
}

export function normaliseEvent(raw = {}) {
  const body = raw && typeof raw === "object" ? raw : {};
  const firstName = text(body.first_name);
  const lastName = text(body.last_name);
  const stage = text(body.stage);

  const fields = {
    stage: isStage(stage) ? stage : "",
    crmClientId: text(body.client_id),
    firstName,
    middleName: deriveMiddleName(body.full_name, firstName, lastName),
    lastName,
    email: text(body.email).toLowerCase(),
    phone: text(body.phone),
    recordType: deriveRecordType(body.is_lead),
    marketingConsent: !isFalsyLiteral(body.marketing_consent),
    source: text(body.source),
    entity: text(body.entity),
    isIb: !isFalsyLiteral(body.is_ib),
    language: text(body.language),
    utmSource: text(body.utm_source),
    utmMedium: text(body.utm_medium),
    utmCampaign: text(body.utm_campaign),
    referer: text(body.referer),
    fullLink: text(body.full_link),
    fxboUniqueId: text(body.unique_id),
  };

  const missing = REQUIRED_FIELDS.filter(
    (key) => !fields[key] || UNRENDERED.has(fields[key].toLowerCase()),
  );
  return { valid: missing.length === 0, missing, fields };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run crmSignup/normalise.test.js --reporter=verbose`
Expected: PASS — every `it` block written in the test step above, none added and none removed. There is deliberately no count here: this plan's prose counts have been wrong before, and the test file is the authority.

- [ ] **Step 5: Commit**

```bash
git add crmSignup/normalise.js crmSignup/normalise.test.js
git commit -m "CRM events: normalise one FXBO body, with the stage it arrived for"
```

---

## Task 2: Click ID — `fbclid` to `fbc`

**Files:**
- Create: `crmSignup/clickId.js`
- Test: `crmSignup/clickId.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `extractFbclid(fullLink): string`
  - `buildFbc(fbclid, timestampMs): string`
  - `deriveFbc(fullLink, timestampMs): string`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/clickId.test.js`:

```js
// @vitest-environment node
//
// The click identifier Meta matches on. Every mistake in this file degrades
// matching SILENTLY -- Meta accepts a malformed fbc and simply fails to match
// it, with no error anywhere.
import { describe, it, expect } from "vitest";
import { extractFbclid, buildFbc, deriveFbc } from "./clickId.js";

describe("extractFbclid", () => {
  it("pulls fbclid out of a landing URL", () => {
    expect(
      extractFbclid("https://skylinkscapital.com/en/?utm_source=meta&fbclid=IwY2xjawUsILdI")
    ).toBe("IwY2xjawUsILdI");
  });

  it("finds it wherever it sits in the query string", () => {
    expect(extractFbclid("https://x.com/p?fbclid=ABC")).toBe("ABC");
    expect(extractFbclid("https://x.com/p?a=1&fbclid=ABC&b=2")).toBe("ABC");
  });

  it("returns empty when there is none, rather than guessing", () => {
    expect(extractFbclid("https://skylinkscapital.com/en/")).toBe("");
    expect(extractFbclid("https://x.com/p?utm_source=google")).toBe("");
    expect(extractFbclid("")).toBe("");
    expect(extractFbclid(undefined)).toBe("");
  });

  it("does not throw on a value that is not a URL at all", () => {
    // full_link is whatever the CRM stored; it is not guaranteed well-formed.
    expect(() => extractFbclid("not a url")).not.toThrow();
    expect(extractFbclid("not a url")).toBe("");
  });

  it("still finds it in a string that is only a query fragment", () => {
    expect(extractFbclid("?fbclid=ABC")).toBe("ABC");
  });

  it("decodes a percent-encoded value", () => {
    expect(extractFbclid("https://x.com/p?fbclid=A%2BB")).toBe("A+B");
  });

  it("ignores a fragment after the query", () => {
    // A fragment is never part of the query and is never sent to the server.
    // Keeping it would put "#frag" inside the click id, a value Meta never matches.
    expect(extractFbclid("https://x.com/p?fbclid=ABC#frag")).toBe("ABC");
    // The fragment starts before the query, so the query is not in the part the
    // server sees. The fragment must be cut before the query is searched for.
    expect(extractFbclid("https://x.com/p#a?fbclid=ABC")).toBe("");
  });

  it("keeps a malformed escape as-is rather than throwing", () => {
    // The trailing %A is not a complete escape, so decodeURIComponent throws.
    // The raw value is still the only attribution we have.
    expect(() => extractFbclid("https://x.com/p?fbclid=%E0%A4%A")).not.toThrow();
    expect(extractFbclid("https://x.com/p?fbclid=%E0%A4%A")).toBe("%E0%A4%A");
  });
});

describe("buildFbc", () => {
  it("wraps the id in Meta's four-part form", () => {
    // fb.1.<timestamp_ms>.<fbclid>. Sending the bare fbclid is accepted and
    // silently unmatched, which is the whole hazard.
    expect(buildFbc("IwY2xjawUsILdI", 1673035686000)).toBe("fb.1.1673035686000.IwY2xjawUsILdI");
  });

  it("returns empty when there is no click id to wrap", () => {
    expect(buildFbc("", 1673035686000)).toBe("");
    expect(buildFbc(undefined, 1673035686000)).toBe("");
  });

  it("uses milliseconds, not seconds", () => {
    const fbc = buildFbc("ABC", 1673035686000);
    expect(fbc.split(".")[2]).toBe("1673035686000");
    expect(fbc.split(".")[2]).not.toBe("1673035686");
  });

  it("returns empty when the timestamp is not a usable millisecond time", () => {
    // Without this, a missing time becomes "fb.1.NaN.ABC": well-formed-looking
    // and never matched. Losing the attribution is the honest outcome.
    expect(buildFbc("ABC", undefined)).toBe("");
    expect(buildFbc("ABC", NaN)).toBe("");
    expect(buildFbc("ABC", null)).toBe("");
    expect(buildFbc("ABC", 0)).toBe("");
    expect(buildFbc("ABC", 1673035686000.5)).toBe("");
    expect(buildFbc("ABC", -5)).toBe("");
  });
});

describe("deriveFbc", () => {
  it("is extraction and wrapping in one step", () => {
    expect(deriveFbc("https://x.com/p?fbclid=ABC", 1673035686000)).toBe("fb.1.1673035686000.ABC");
  });

  it("is empty when the landing URL carried no click", () => {
    // Organic signups have no fbclid, and that is normal, not an error.
    expect(deriveFbc("https://x.com/p", 1673035686000)).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run crmSignup/clickId.test.js --reporter=verbose`
Expected: FAIL — `Failed to load url ./clickId.js`

- [ ] **Step 3: Write the implementation**

Create `crmSignup/clickId.js`:

```js
/**
 * The Meta click identifier.
 *
 * The CRM derives its own ClickID by pulling `fbclid` out of the landing URL it
 * was given as `full_link`. We get the same `full_link` as a webhook parameter,
 * so we derive the same thing without a REST call.
 *
 * Everything here fails quietly by design -- an organic signup has no fbclid,
 * and that is normal. What must NOT be quiet is a malformed result, so the
 * wrapping is tested rather than trusted: Meta accepts a bare fbclid and simply
 * never matches it.
 */

/** Meta's prefix and subdomain-index, both fixed for our use. */
const FBC_PREFIX = "fb";
const FBC_SUBDOMAIN_INDEX = "1";

export function extractFbclid(fullLink) {
  const raw = String(fullLink ?? "").trim();
  if (!raw) return "";

  // A fragment is never part of the query and is never sent to the server, so
  // it is cut off before the query is looked at.
  const hash = raw.indexOf("#");
  const noFragment = hash >= 0 ? raw.slice(0, hash) : raw;

  const q = noFragment.indexOf("?");
  const query = q >= 0 ? noFragment.slice(q + 1) : noFragment;

  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq) !== "fbclid") continue;
    const value = pair.slice(eq + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      // A malformed escape sequence is still a click id; keep it as-is rather
      // than discarding the only attribution we have.
      return value;
    }
  }
  return "";
}

/** `fb.1.<timestamp_ms>.<fbclid>` -- milliseconds, not seconds. */
export function buildFbc(fbclid, timestampMs) {
  const id = String(fbclid ?? "").trim();
  if (!id) return "";
  const ts = Number(timestampMs);
  // An absent or unusable time must not reach Meta as "NaN", "0" or a
  // fractional value: those look well-formed and are never matched.
  if (!Number.isInteger(ts) || ts <= 0) return "";
  return `${FBC_PREFIX}.${FBC_SUBDOMAIN_INDEX}.${ts}.${id}`;
}

export function deriveFbc(fullLink, timestampMs) {
  return buildFbc(extractFbclid(fullLink), timestampMs);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run crmSignup/clickId.test.js --reporter=verbose`
Expected: PASS — every `it` block written in the test step above, none added and none removed. There is deliberately no count here: this plan's prose counts have been wrong before, and the test file is the authority.

- [ ] **Step 5: Commit**

```bash
git add crmSignup/clickId.js crmSignup/clickId.test.js
git commit -m "CRM events: derive the Meta click id from the landing URL"
```

---

## Task 3: Meta Conversions API

**Files:**
- Create: `crmSignup/meta.js`
- Test: `crmSignup/meta.test.js`

**Interfaces:**
- Consumes: nothing (takes already-normalised values).
- Produces:
  - `META_EVENT_NAMES: Record<stage, string>`
  - `hashEmail(email): string`, `hashPhone(phone): string`
  - `buildMetaPayload({ stage, email, phone, fbc, eventTimeSeconds, eventId, testEventCode }): object`
  - `classifyMetaOutcome({ transportError, httpStatus, body }): { status, retryable, detail }`
  - `sendMetaEvent({ fetchImpl, datasetId, apiVersion, accessToken, payload }): Promise<outcome>`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/meta.test.js`:

```js
// @vitest-environment node
//
// The Conversions API half. Two of the three failure modes here produce no
// error at all -- Meta accepts the event and silently fails to match it -- so
// the hashing and the fixed constants are pinned by test rather than by care.
import { describe, it, expect, vi } from "vitest";
import {
  META_EVENT_NAMES,
  hashEmail,
  hashPhone,
  buildMetaPayload,
  classifyMetaOutcome,
  sendMetaEvent,
} from "./meta.js";

describe("event names", () => {
  it("maps every stage, and maps them to Meta's own vocabulary", () => {
    expect(META_EVENT_NAMES).toEqual({
      lead: "Lead",
      registered: "CompleteRegistration",
      verified: "Client_Verified",
      live_account: "TradingAccountOpened",
      first_deposit: "Purchase",
    });
  });
});

describe("hashing", () => {
  it("normalises the email before hashing, not after", () => {
    // Meta hashes the normalised value on its side. Hashing "  A@B.COM " as
    // typed produces a hash that can never match.
    expect(hashEmail("  Ali.Khan@Example.COM ")).toBe(hashEmail("ali.khan@example.com"));
  });

  it("strips everything but digits from the phone", () => {
    expect(hashPhone("+971 50 719-2185")).toBe(hashPhone("971507192185"));
    expect(hashPhone("+971507192185")).toBe(hashPhone("971507192185"));
  });

  it("produces a 64-character lowercase hex digest", () => {
    const h = hashEmail("a@b.com");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is a real SHA-256, checked against a known digest", () => {
    // sha256("ali.khan@example.com")
    expect(hashEmail("ali.khan@example.com")).toBe(
      "cefa37b4e787d579251247cab9b2ed08cf8e83e514c6cd887559baf6a9171870"
    );
  });

  it("returns empty for empty input rather than hashing the empty string", () => {
    // sha256("") is a valid digest and would be sent as if it were a real
    // address, poisoning match quality.
    expect(hashEmail("")).toBe("");
    expect(hashEmail(undefined)).toBe("");
    expect(hashPhone("")).toBe("");
    expect(hashPhone("not a number")).toBe("");
  });
});

describe("buildMetaPayload", () => {
  const base = {
    stage: "verified",
    email: "ali.khan@example.com",
    phone: "+971507192185",
    fbc: "fb.1.1673035686000.IwY2xjawUsILdI",
    eventTimeSeconds: 1673035686,
  };

  it("carries the three constants Meta requires for a CRM event", () => {
    const event = buildMetaPayload(base).data[0];
    expect(event.action_source).toBe("system_generated");
    expect(event.custom_data.event_source).toBe("crm");
    expect(event.custom_data.lead_event_source).toBe("FXBackOffice");
  });

  it("sends em and ph as arrays of hashes, never as raw values", () => {
    const serialised = JSON.stringify(buildMetaPayload(base));
    expect(serialised).not.toContain("ali.khan@example.com");
    expect(serialised).not.toContain("971507192185");
    const { user_data } = buildMetaPayload(base).data[0];
    expect(Array.isArray(user_data.em)).toBe(true);
    expect(Array.isArray(user_data.ph)).toBe(true);
    expect(user_data.em[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses the stage's event name and the given time", () => {
    const event = buildMetaPayload(base).data[0];
    expect(event.event_name).toBe("Client_Verified");
    expect(event.event_time).toBe(1673035686);
  });

  it("hashes the normalised values in the payload, not the raw input", () => {
    // Messy input on purpose. Meta hashes the normalised value on its side, so
    // the payload must carry the digest of the lowercased address and of the
    // bare digits, never a digest of the raw strings.
    const { user_data } = buildMetaPayload({
      ...base,
      email: "  Ali.Khan@Example.COM ",
      phone: "+971 50 719-2185",
    }).data[0];
    expect(user_data.em).toEqual(["cefa37b4e787d579251247cab9b2ed08cf8e83e514c6cd887559baf6a9171870"]);
    expect(user_data.ph).toEqual(["0449fd30f3348d64f7cd0fe7ffcf90c2b045494a653446c41204fe723587751b"]);
  });

  it("passes fbc through untouched", () => {
    // It was frozen at the client's first event; recomputing or reformatting
    // it here would give Meta a different click identity per stage.
    expect(buildMetaPayload(base).data[0].user_data.fbc).toBe("fb.1.1673035686000.IwY2xjawUsILdI");
  });

  it("omits absent matchers instead of sending empty ones", () => {
    const { user_data } = buildMetaPayload({ ...base, fbc: "", phone: "" }).data[0];
    expect("fbc" in user_data).toBe(false);
    expect("ph" in user_data).toBe(false);
    expect(user_data.em).toBeDefined();
  });

  it("omits em too when there is no email, not only fbc and ph", () => {
    // hashEmail returns "" for no email; that must not reach Meta as a matcher.
    const { user_data } = buildMetaPayload({ ...base, email: "" }).data[0];
    expect("em" in user_data).toBe(false);
  });

  it("never carries a value or a currency, at any stage", () => {
    // Decided 2026-10-13: Meta learns that a deposit happened, not what it was
    // worth. custom_data holds the two CRM constants and nothing else.
    for (const stage of ["registered", "verified", "live_account", "first_deposit"]) {
      const { custom_data } = buildMetaPayload({ ...base, stage }).data[0];
      expect(Object.keys(custom_data).sort(), stage).toEqual(["event_source", "lead_event_source"]);
    }
  });

  it("includes a test event code only when one is configured", () => {
    expect(buildMetaPayload({ ...base, testEventCode: "TEST1234" }).test_event_code).toBe("TEST1234");
    expect("test_event_code" in buildMetaPayload(base)).toBe(false);
  });

  it("emits event_id with the value the caller gives", () => {
    const event = buildMetaPayload({ ...base, eventId: "42:verified" }).data[0];
    expect(event.event_id).toBe("42:verified");
  });

  it("builds the same event_id from the same inputs, so a retry carries the same id", () => {
    const a = buildMetaPayload({ ...base, eventId: "42:verified" }).data[0].event_id;
    const b = buildMetaPayload({ ...base, eventId: "42:verified" }).data[0].event_id;
    expect(a).toBeDefined();
    expect(b).toBe(a);
  });

  it("omits event_id when none is given, rather than emitting undefined", () => {
    const event = buildMetaPayload(base).data[0];
    expect("event_id" in event).toBe(false);
  });
});

describe("classifyMetaOutcome", () => {
  it("treats a 2xx as sent", () => {
    expect(classifyMetaOutcome({ httpStatus: 200, body: { events_received: 1 } }).status).toBe("sent");
  });

  it("retries transport errors, 429 and 5xx", () => {
    expect(classifyMetaOutcome({ transportError: new Error("ETIMEDOUT") }).retryable).toBe(true);
    for (const httpStatus of [429, 500, 502, 503]) {
      expect(classifyMetaOutcome({ httpStatus, body: {} }).retryable, String(httpStatus)).toBe(true);
    }
  });

  it("treats other 4xx as permanent and keeps Meta's own message", () => {
    const result = classifyMetaOutcome({
      httpStatus: 400,
      body: { error: { message: "Invalid parameter", code: 100, error_subcode: 2804003 } },
    });
    expect(result.retryable).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("Invalid parameter");
  });

  it("does not call a 2xx that received zero events a success", () => {
    // Meta answers 200 while reporting it took nothing.
    const result = classifyMetaOutcome({ httpStatus: 200, body: { events_received: 0 } });
    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(false);
  });

  it("retries a 400 carrying Meta's application rate-limit code, and keeps its message", () => {
    // Meta throttles with a 400 and the Graph error code; the status is not to be trusted.
    const result = classifyMetaOutcome({
      httpStatus: 400,
      body: { error: { message: "(#4) Application request limit reached", code: 4 } },
    });
    expect(result.retryable).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("Application request limit reached");
  });

  it("retries every Graph throttling code carried on a 400", () => {
    for (const code of [1, 2, 4, 17, 32, 341, 613]) {
      const result = classifyMetaOutcome({ httpStatus: 400, body: { error: { message: "m", code } } });
      expect(result.retryable, String(code)).toBe(true);
    }
  });

  it("retries a 2xx with no usable count, since the outcome is unknown", () => {
    // A proxy answering 200 with an HTML page is not Meta saying anything. The
    // event_id makes a retry safe, so this is retryable.
    expect(classifyMetaOutcome({ httpStatus: 200, body: null })).toEqual({
      status: "failed",
      retryable: true,
      detail: "http 200 no events_received",
    });
  });

  it("keeps a 2xx that reports zero events permanent, since Meta said so", () => {
    expect(classifyMetaOutcome({ httpStatus: 200, body: { events_received: 0 } })).toEqual({
      status: "failed",
      retryable: false,
      detail: "http 200 events_received=0",
    });
  });

  it("retries a transient code whatever the HTTP status carrying it", () => {
    for (const httpStatus of [200, 400, 403, 404, 500]) {
      const result = classifyMetaOutcome({ httpStatus, body: { error: { message: "m", code: 4 } } });
      expect(result.retryable, String(httpStatus)).toBe(true);
      expect(result.status, String(httpStatus)).toBe("failed");
    }
  });

  it("keeps Meta's own message on a retryable 429 or 5xx, as it does on a 4xx", () => {
    for (const httpStatus of [429, 502]) {
      const result = classifyMetaOutcome({ httpStatus, body: { error: { message: "Upstream timed out" } } });
      expect(result.retryable, String(httpStatus)).toBe(true);
      expect(result.detail, String(httpStatus)).toContain("Upstream timed out");
    }
  });
});

describe("sendMetaEvent", () => {
  it("posts to the dataset's events edge with the token on the query string", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ events_received: 1 }) }));

    await sendMetaEvent({
      fetchImpl,
      datasetId: "692517170017822",
      apiVersion: "v26.0",
      accessToken: "tok",
      payload: { data: [] },
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v26.0/692517170017822/events?access_token=tok");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("turns a thrown fetch into a retryable outcome rather than an exception", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    const result = await sendMetaEvent({ fetchImpl, datasetId: "1", accessToken: "t", payload: {} });
    expect(result.retryable).toBe(true);
  });

  it("never puts the access token in the returned detail", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "bad" } }) }));
    const result = await sendMetaEvent({ fetchImpl, datasetId: "1", accessToken: "s3cret-token", payload: {} });
    expect(result.detail).not.toContain("s3cret-token");
  });

  it("does not throw on a failed response whose body is not JSON", async () => {
    // A load balancer answering 503 with an HTML page is ordinary. The body
    // cannot be read, but the status still says retry.
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    }));
    const result = await sendMetaEvent({ fetchImpl, datasetId: "1", accessToken: "t", payload: {} });
    expect(result.retryable).toBe(true);
  });

  it("posts to the apiVersion it is given", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ events_received: 1 }) }));
    await sendMetaEvent({ fetchImpl, datasetId: "1", apiVersion: "v99.0", accessToken: "t", payload: {} });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://graph.facebook.com/v99.0/1/events?access_token=t");
  });

  it("sends the payload as JSON in the body", async () => {
    const payload = { data: [{ event_name: "Lead", event_id: "1:lead" }], test_event_code: "TEST1" };
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ events_received: 1 }) }));
    await sendMetaEvent({ fetchImpl, datasetId: "1", accessToken: "t", payload });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it("percent-encodes the token, and it reads back intact", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ events_received: 1 }) }));
    await sendMetaEvent({ fetchImpl, datasetId: "1", accessToken: "a&b+c%", payload: {} });
    const [url] = fetchImpl.mock.calls[0];
    expect(new URL(url).searchParams.get("access_token")).toBe("a&b+c%");
  });

  it("keeps the token out of the detail when a transport error echoes the URL", async () => {
    // Native fetch does not echo the URL, but an injected fetchImpl can, and the
    // detail is logged. The raw and the encoded token must both be removed.
    const token = "a&b+c%";
    const fetchImpl = vi.fn(async (url) => {
      throw new Error(`request to ${url} failed`);
    });
    const result = await sendMetaEvent({ fetchImpl, datasetId: "1", accessToken: token, payload: {} });
    expect(fetchImpl.mock.calls[0][0]).toContain(encodeURIComponent(token));
    expect(result.retryable).toBe(true);
    expect(result.detail).not.toContain(token);
    expect(result.detail).not.toContain(encodeURIComponent(token));
  });

  it("keeps the raw token out of the detail too, when a transport error echoes it", async () => {
    const token = "a&b+c%";
    const fetchImpl = vi.fn(async () => {
      throw new Error(`rejected token ${token}`);
    });
    const result = await sendMetaEvent({ fetchImpl, datasetId: "1", accessToken: token, payload: {} });
    expect(result.detail).not.toContain(token);
  });

  it("redacts a token whose apostrophe the URL class re-encodes", async () => {
    // encodeURIComponent leaves an apostrophe alone, but the WHATWG URL class
    // writes it as %27. Neither form is the literal we built, so only the
    // structural pass can catch it.
    const token = "a'b";
    const fetchImpl = vi.fn(async (url) => {
      throw new Error(`request to ${new URL(url).href} failed`);
    });
    const result = await sendMetaEvent({ fetchImpl, datasetId: "1", accessToken: token, payload: {} });
    expect(result.retryable).toBe(true);
    expect(result.detail).not.toContain("a'b");
    expect(result.detail).not.toContain("a%27b");
  });

  it("leaves no residue when the token is a substring of its own encoded form", async () => {
    // "%25" encodes to "%2525", which contains "%25". Replacing the raw form first
    // would leave "[redacted]25" behind, so the encoded form has to go first.
    const token = "%25";
    const fetchImpl = vi.fn(async () => {
      throw new Error(`rejected ${encodeURIComponent(token)} now`);
    });
    const result = await sendMetaEvent({ fetchImpl, datasetId: "1", accessToken: token, payload: {} });
    expect(result.detail).toBe("transport: rejected [redacted] now");
  });

  it("redacts every occurrence of the token, not only the first", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("first a&b+c%, then a&b+c% again");
    });
    const result = await sendMetaEvent({ fetchImpl, datasetId: "1", accessToken: "a&b+c%", payload: {} });
    expect(result.detail).toBe("transport: first [redacted], then [redacted] again");
  });

});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run crmSignup/meta.test.js --reporter=verbose`
Expected: FAIL — `Failed to load url ./meta.js`

> If the known-digest assertion fails, trust the test file's expected value only
> after regenerating it yourself:
> `node -e "console.log(require('crypto').createHash('sha256').update('ali.khan@example.com').digest('hex'))"`
> and correct the literal in the test if it differs.

- [ ] **Step 3: Write the implementation**

Create `crmSignup/meta.js`:

```js
import { createHash } from "crypto";

export const GRAPH_HOST = "https://graph.facebook.com";

/** One Meta event per funnel stage. One owner per stage: the website pixel no
 *  longer fires conversions, so nothing here can double-count. */
export const META_EVENT_NAMES = {
  lead: "Lead",
  registered: "CompleteRegistration",
  verified: "Client_Verified",
  live_account: "TradingAccountOpened",
  first_deposit: "Purchase",
};

/** Meta requires exactly these three values on a CRM event. */
const ACTION_SOURCE = "system_generated";
const EVENT_SOURCE = "crm";
const LEAD_EVENT_SOURCE = "FXBackOffice";

// Transient Graph API conditions. Meta returns these with an unreliable
// HTTP status -- commonly 400 -- so the code is what decides, not the status.
//   1   unknown/transient, Meta's guidance is to retry
//   2   service temporarily unavailable
//   4   application-level rate limit
//   17  user-level rate limit
//   32  page-level rate limit
//   341 application limit reached, documented as temporary and retryable
//   613 custom-level rate limit
// 368 (temporary policy block) is left out: it will not clear on a retry.
const TRANSIENT_GRAPH_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Meta hashes the NORMALISED value on its side, so we must normalise before
 * hashing or the digests can never meet. Empty in, empty out -- sha256("") is
 * a perfectly valid digest that would be sent as though it were an address.
 */
export function hashEmail(email) {
  const v = String(email ?? "").trim().toLowerCase();
  return v ? sha256(v) : "";
}

export function hashPhone(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits ? sha256(digits) : "";
}

export function buildMetaPayload({ stage, email, phone, fbc, eventTimeSeconds, eventId, testEventCode }) {
  const user_data = {};

  const em = hashEmail(email);
  if (em) user_data.em = [em];

  const ph = hashPhone(phone);
  if (ph) user_data.ph = [ph];

  // Passed through verbatim: it was frozen at this client's first event, and
  // recomputing it per stage hands Meta a different click identity each time.
  const click = String(fbc ?? "").trim();
  if (click) user_data.fbc = click;

  // The two CRM constants and nothing else. A deposit reports that it
  // happened, not what it was worth (decided 2026-10-13).
  const custom_data = {
    event_source: EVENT_SOURCE,
    lead_event_source: LEAD_EVENT_SOURCE,
  };

  const event = {
    action_source: ACTION_SOURCE,
    custom_data,
    event_name: META_EVENT_NAMES[stage],
    event_time: Number(eventTimeSeconds),
    user_data,
  };

  // Meta dedupes on event_id plus event_name. The caller derives it from the
  // client and stage, so a retry of the same funnel event carries the same id.
  const id = String(eventId ?? "").trim();
  if (id) event.event_id = id;

  const payload = { data: [event] };

  const code = String(testEventCode ?? "").trim();
  if (code) payload.test_event_code = code;

  return payload;
}

export function classifyMetaOutcome({ transportError, httpStatus: rawStatus, body } = {}) {
  if (transportError) {
    return {
      status: "failed",
      retryable: true,
      detail: `transport: ${String(transportError?.message || transportError).slice(0, 200)}`,
    };
  }

  const httpStatus = Number(rawStatus) || 0;
  const reason = String(body?.error?.message ?? "").slice(0, 200);
  const detail = reason ? `http ${httpStatus} ${reason}` : `http ${httpStatus}`;

  // The Graph code decides, whatever status carries it: Meta throttles with a 400.
  if (TRANSIENT_GRAPH_CODES.has(Number(body?.error?.code))) {
    return { status: "failed", retryable: true, detail };
  }

  if (httpStatus === 429 || httpStatus >= 500) {
    return { status: "failed", retryable: true, detail };
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    // Meta's success body always carries the count. Without one, a proxy answered
    // instead of Meta: the outcome is unknown, and event_id makes a retry safe.
    // An explicit zero is Meta saying so, and a retry would hear the same thing.
    const received = Number(body?.events_received);
    if (received >= 1) {
      return { status: "sent", retryable: false, detail: `http ${httpStatus}` };
    }
    const noCount = body?.events_received == null || Number.isNaN(received);
    const reported = noCount ? "no events_received" : `events_received=${received}`;
    return { status: "failed", retryable: noCount, detail: `http ${httpStatus} ${reported}` };
  }

  return { status: "failed", retryable: false, detail };
}

/** Never throws, and never puts the access token in its result. */
export async function sendMetaEvent({
  fetchImpl = fetch,
  datasetId,
  apiVersion = "v26.0",
  accessToken,
  payload,
}) {
  const url = `${GRAPH_HOST}/${apiVersion}/${datasetId}/events?access_token=${encodeURIComponent(
    String(accessToken ?? "")
  )}`;

  // A fetch error may echo the request URL, which carries the token in raw and
  // encoded form. Neither may reach the detail, because the detail is logged.
  const token = String(accessToken ?? "");
  // Encoded before raw: a token containing % has a raw form that sits inside its
  // encoded form (%25 inside %2525), so the raw pass must never run first.
  const secrets = [encodeURIComponent(token), token].filter(Boolean);

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (transportError) {
    let message = String(transportError?.message || transportError);
    // Structural first: whatever follows access_token= is the token, in whatever
    // form the URL class re-serialised it. The literals then catch a bare quoted value.
    message = message.replace(/access_token=[^&\s]*/gi, "access_token=[redacted]");
    for (const secret of secrets) message = message.split(secret).join("[redacted]");
    return classifyMetaOutcome({ transportError: { message } });
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return classifyMetaOutcome({ httpStatus: response?.status, body });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run crmSignup/meta.test.js --reporter=verbose`
Expected: PASS — every `it` block written in the test step above, none added and none removed. There is deliberately no count here: this plan's prose counts have been wrong before, and the test file is the authority.

- [ ] **Step 5: Commit**

```bash
git add crmSignup/meta.js crmSignup/meta.test.js
git commit -m "CRM events: Meta CAPI sender, with the hashing Meta can actually match"
```

---

## Task 4: WhatsApp

**Files:**
- Create: `crmSignup/whatsapp.js`
- Test: `crmSignup/whatsapp.test.js`

**Interfaces:**
- Consumes: `PHONE_RE` from `crmSignup/normalise.js`.
- Produces:
  - `WHATSAPP_FAILURE_STATUSES: string[]`, `DOUBLETICK_TEMPLATE_URL: string`
  - `parseSkipSources(raw): Set<string>`
  - `decideWhatsappSkip({ stage, apiKey, recordType, source, phone, skipSources }): { reason } | null`
  - `buildWhatsappPayload({ templateName, language, firstName, bodyParam, buttonUrl, from, to, messageId }): object`
  - `classifyWhatsappOutcome({ transportError, httpStatus, body }): { status, retryable, detail, messageId }`
  - `sendWhatsappTemplate({ fetchImpl, apiKey, payload }): Promise<outcome>`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/whatsapp.test.js`:

```js
// @vitest-environment node
//
// The trap: DoubleTick answers 200 to a message it then rejects. The HTTP
// status says the request was accepted. messages[0].status says what happened
// to the message. Only the second one is the outcome.
import { describe, it, expect, vi } from "vitest";
import {
  WHATSAPP_FAILURE_STATUSES,
  parseSkipSources,
  decideWhatsappSkip,
  buildWhatsappPayload,
  classifyWhatsappOutcome,
  sendWhatsappTemplate,
} from "./whatsapp.js";

const base = {
  stage: "registered",
  apiKey: "k",
  recordType: "client",
  source: "SVG",
  phone: "+971507192185",
  skipSources: new Set(),
};

describe("skip decisions", () => {
  it("sends for a registered client with a valid phone from an allowed source", () => {
    expect(decideWhatsappSkip(base)).toBeNull();
  });

  it("sends nothing at any stage but registration", () => {
    for (const stage of ["lead", "verified", "live_account", "first_deposit"]) {
      expect(decideWhatsappSkip({ ...base, stage }), stage).toEqual({
        reason: "stage not applicable",
      });
    }
  });

  it("skips a lead with the exact documented reason", () => {
    expect(decideWhatsappSkip({ ...base, recordType: "lead" })).toEqual({
      reason: "lead, not client",
    });
  });

  it("skips an invalid phone without trying to repair it", () => {
    expect(decideWhatsappSkip({ ...base, phone: "00971507192185" })).toEqual({
      reason: "invalid phone number",
    });
    expect(decideWhatsappSkip({ ...base, phone: "" })).toEqual({ reason: "invalid phone number" });
  });

  it("skips an excluded source, case-insensitively", () => {
    const skipSources = parseSkipSources("CSV_UPLOAD, manual ,import");
    expect(decideWhatsappSkip({ ...base, source: "manual", skipSources })).toEqual({
      reason: "source excluded",
    });
    expect(decideWhatsappSkip({ ...base, source: "csv_upload", skipSources })).toEqual({
      reason: "source excluded",
    });
    expect(decideWhatsappSkip({ ...base, source: "SVG", skipSources })).toBeNull();
  });

  it("matches the webhook's source case-insensitively, not only the configured list", () => {
    const skipSources = parseSkipSources("manual");
    expect(decideWhatsappSkip({ ...base, source: "MANUAL", skipSources })).toEqual({
      reason: "source excluded",
    });
  });

  it("reports an unconfigured key before anything about the client", () => {
    // An unconfigured environment is our problem, not a fact about the lead.
    expect(decideWhatsappSkip({ ...base, apiKey: "", recordType: "lead" })).toEqual({
      reason: "whatsapp not configured",
    });
  });

  it("reports an unconfigured key ahead of the funnel stage as well", () => {
    expect(decideWhatsappSkip({ ...base, apiKey: "", stage: "lead" })).toEqual({
      reason: "whatsapp not configured",
    });
  });

  it("counts a whitespace-only key as unset", () => {
    expect(decideWhatsappSkip({ ...base, apiKey: "   " })).toEqual({ reason: "whatsapp not configured" });
  });

  it("accepts skipSources as the raw env string, not only a parsed Set", () => {
    expect(decideWhatsappSkip({ ...base, source: "manual", skipSources: "CSV_UPLOAD, manual" })).toEqual({
      reason: "source excluded",
    });
    expect(decideWhatsappSkip({ ...base, source: "SVG", skipSources: "CSV_UPLOAD, manual" })).toBeNull();
  });
});

describe("parseSkipSources", () => {
  it("is empty for an unset or blank value", () => {
    expect(parseSkipSources(undefined).size).toBe(0);
    expect(parseSkipSources("  ").size).toBe(0);
  });

  it("trims, lowercases and drops blanks", () => {
    expect([...parseSkipSources(" A , ,b ")]).toEqual(["a", "b"]);
  });
});

describe("buildWhatsappPayload", () => {
  const payload = buildWhatsappPayload({
    templateName: "registration_client_v3",
    language: "en",
    firstName: "Ali",
    bodyParam: "https://skylinkscapital.com/en/login/",
    buttonUrl: "https://skylinkscapital.com/en/login/",
    from: "+971507192185",
    to: "+971500000000",
    messageId: "uuid-1",
  });

  it("nests exactly one message with all three dynamic parts", () => {
    expect(payload).toEqual({
      messages: [
        {
          content: {
            templateName: "registration_client_v3",
            language: "en",
            templateData: {
              header: { type: "TEXT", placeholder: "Ali" },
              body: { placeholders: ["https://skylinkscapital.com/en/login/"] },
              buttons: [{ type: "URL", parameter: "https://skylinkscapital.com/en/login/" }],
            },
          },
          from: "+971507192185",
          to: "+971500000000",
          messageId: "uuid-1",
        },
      ],
    });
  });

  it("puts from, to and messageId beside content, not beside messages", () => {
    // Omitting either of from/messageId is on its own enough for the provider
    // to reject, and nesting them wrong is the same as omitting.
    expect(payload.messages[0].from).toBeTruthy();
    expect(payload.messages[0].messageId).toBeTruthy();
    expect(payload.from).toBeUndefined();
  });

  it("keeps the body placeholder and the button URL as two separate values", () => {
    // The shared fixture above uses one URL for both, so swapping them passes.
    const data = buildWhatsappPayload({
      templateName: "t",
      language: "en",
      firstName: "Ali",
      bodyParam: "BODY-PARAM",
      buttonUrl: "BUTTON-URL",
      from: "+971507192185",
      to: "+971500000000",
      messageId: "uuid-2",
    }).messages[0].content.templateData;
    expect(data.body.placeholders).toEqual(["BODY-PARAM"]);
    expect(data.buttons[0].parameter).toBe("BUTTON-URL");
  });
});

describe("classifyWhatsappOutcome", () => {
  it("treats a 2xx with a healthy status as sent", () => {
    expect(
      classifyWhatsappOutcome({ httpStatus: 200, body: { messages: [{ status: "SENT", messageId: "m-1" }] } })
    ).toEqual({ status: "sent", retryable: false, detail: "SENT", messageId: "m-1" });
  });

  it("treats a 2xx carrying any failure status as rejected and permanent", () => {
    for (const status of WHATSAPP_FAILURE_STATUSES) {
      const r = classifyWhatsappOutcome({ httpStatus: 200, body: { messages: [{ status }] } });
      expect(r.status, status).toBe("rejected");
      expect(r.retryable, status).toBe(false);
    }
  });

  it("matches failure statuses regardless of case", () => {
    const r = classifyWhatsappOutcome({ httpStatus: 200, body: { messages: [{ status: "uNdElIvErAbLe" }] } });
    expect(r.status).toBe("rejected");
  });

  it("retries transport errors, 429 and every 5xx", () => {
    expect(classifyWhatsappOutcome({ transportError: new Error("ECONNRESET") }).retryable).toBe(true);
    for (const httpStatus of [429, 500, 502, 503, 504]) {
      expect(classifyWhatsappOutcome({ httpStatus, body: {} }).retryable, String(httpStatus)).toBe(true);
    }
  });

  it("does not retry any other non-2xx", () => {
    for (const httpStatus of [400, 401, 403, 404, 422]) {
      const r = classifyWhatsappOutcome({ httpStatus, body: {} });
      expect(r.retryable, String(httpStatus)).toBe(false);
      expect(r.status, String(httpStatus)).toBe("rejected");
    }
  });

  it("refuses to call a 2xx with no message status a success", () => {
    const r = classifyWhatsappOutcome({ httpStatus: 200, body: {} });
    expect(r.status).toBe("failed");
    expect(r.retryable).toBe(false);
    expect(r.detail).toMatch(/no message status/i);
  });

  it("names each of the six documented failure statuses, not just whatever the list holds", () => {
    for (const status of ["FAILED", "ERROR", "REJECTED", "UNDELIVERED", "UNDELIVERABLE", "INVALID"]) {
      const r = classifyWhatsappOutcome({ httpStatus: 200, body: { messages: [{ status }] } });
      // The detail is the status itself, not the unrecognised fallback, so a dropped entry shows.
      expect(r, status).toEqual({ status: "rejected", retryable: false, detail: status, messageId: null });
    }
  });

  it("names a known failure in its detail, whatever the case DoubleTick used", () => {
    const upper = classifyWhatsappOutcome({
      httpStatus: 200,
      body: { messages: [{ status: "UNDELIVERABLE", messageId: "m-11" }] },
    });
    expect(upper).toEqual({ status: "rejected", retryable: false, detail: "UNDELIVERABLE", messageId: "m-11" });

    const mixed = classifyWhatsappOutcome({ httpStatus: 200, body: { messages: [{ status: "uNdElIvErAbLe" }] } });
    expect(mixed.detail).toBe("uNdElIvErAbLe");
  });

  it("does not send an unrecognised status, and does not retry it either", () => {
    const r = classifyWhatsappOutcome({
      httpStatus: 200,
      body: { messages: [{ status: "ACCEPTED_PENDING_REVIEW", messageId: "m-12" }] },
    });
    expect(r).toEqual({
      status: "rejected",
      retryable: false,
      detail: "unrecognised status: ACCEPTED_PENDING_REVIEW",
      messageId: "m-12",
    });
  });

  it("matches a healthy status regardless of case, as it does the failures", () => {
    const r = classifyWhatsappOutcome({ httpStatus: 200, body: { messages: [{ status: "sent", messageId: "m-13" }] } });
    expect(r.status).toBe("sent");
  });

  it("treats ENQUEUED as sent, the current value DoubleTick returns, whatever its case", () => {
    for (const status of ["ENQUEUED", "enqueued"]) {
      const r = classifyWhatsappOutcome({ httpStatus: 200, body: { messages: [{ status, messageId: "m-20" }] } });
      expect(r, status).toEqual({ status: "sent", retryable: false, detail: status, messageId: "m-20" });
    }
  });

  it("rejects the statuses DoubleTick does not document, so a new one is a deliberate change", () => {
    for (const status of ["QUEUED", "SUBMITTED", "ACCEPTED", "NOT_SENT", "SENT_FAILED"]) {
      const r = classifyWhatsappOutcome({ httpStatus: 200, body: { messages: [{ status }] } });
      expect(r, status).toEqual({
        status: "rejected",
        retryable: false,
        detail: `unrecognised status: ${status}`,
        messageId: null,
      });
    }
  });

  it("retries a 408 Request Timeout, which is transient by definition", () => {
    const r = classifyWhatsappOutcome({ httpStatus: 408, body: {} });
    expect(r.status).toBe("failed");
    expect(r.retryable).toBe(true);
  });

  it("treats any 2xx as accepted, from 201 through 299, when it carries a healthy status", () => {
    expect(
      classifyWhatsappOutcome({ httpStatus: 201, body: { messages: [{ status: "SENT", messageId: "m-21" }] } })
    ).toEqual({ status: "sent", retryable: false, detail: "SENT", messageId: "m-21" });
    expect(
      classifyWhatsappOutcome({ httpStatus: 202, body: { messages: [{ status: "ENQUEUED", messageId: "m-22" }] } })
    ).toEqual({ status: "sent", retryable: false, detail: "ENQUEUED", messageId: "m-22" });
    expect(
      classifyWhatsappOutcome({ httpStatus: 299, body: { messages: [{ status: "SENT", messageId: "m-24" }] } })
    ).toEqual({ status: "sent", retryable: false, detail: "SENT", messageId: "m-24" });
  });

  it("does not accept 199 or 300 as a 2xx, even with a healthy status in the body", () => {
    for (const httpStatus of [199, 300]) {
      const r = classifyWhatsappOutcome({ httpStatus, body: { messages: [{ status: "SENT" }] } });
      expect(r.status, String(httpStatus)).toBe("rejected");
      expect(r.retryable, String(httpStatus)).toBe(false);
    }
  });

  it("reports a thrown transport error as a failed, retryable outcome carrying its message", () => {
    expect(classifyWhatsappOutcome({ transportError: new Error("ECONNRESET") })).toEqual({
      status: "failed",
      retryable: true,
      detail: "transport: ECONNRESET",
      messageId: null,
    });
  });

  it("refuses a status that is not a string, rather than coercing it into a match", () => {
    for (const status of [123, {}, ["SENT"]]) {
      const r = classifyWhatsappOutcome({ httpStatus: 200, body: { messages: [{ status, messageId: "m-23" }] } });
      expect(r, JSON.stringify(status)).toEqual({
        status: "rejected",
        retryable: false,
        detail: `unrecognised status: ${JSON.stringify(status)}`,
        messageId: "m-23",
      });
    }
  });

  it("never classifies a non-allowlist outcome as sent", () => {
    // The file's headline invariant, pinned once for every branch that is not a send.
    const sentBody = { messages: [{ status: "SENT" }] };
    const cases = [
      ["transport error", { transportError: new Error("ECONNRESET") }],
      ...[408, 429, 500, 502, 503, 504].map((httpStatus) => [`http ${httpStatus}`, { httpStatus, body: sentBody }]),
      ...[199, 300, 301, 400, 401, 403, 404, 422].map((httpStatus) => [`http ${httpStatus}`, { httpStatus, body: sentBody }]),
      ...["FAILED", "ERROR", "REJECTED", "UNDELIVERED", "UNDELIVERABLE", "INVALID"].map((status) => [
        status,
        { httpStatus: 200, body: { messages: [{ status }] } },
      ]),
      ["unrecognised status", { httpStatus: 200, body: { messages: [{ status: "ACCEPTED_PENDING_REVIEW" }] } }],
      ["near-miss NOT_SENT", { httpStatus: 200, body: { messages: [{ status: "NOT_SENT" }] } }],
      ["near-miss SENT_FAILED", { httpStatus: 200, body: { messages: [{ status: "SENT_FAILED" }] } }],
      ["non-string 123", { httpStatus: 200, body: { messages: [{ status: 123 }] } }],
      ["non-string {}", { httpStatus: 200, body: { messages: [{ status: {} }] } }],
      ["non-string [SENT]", { httpStatus: 200, body: { messages: [{ status: ["SENT"] }] } }],
      ["no message status", { httpStatus: 200, body: {} }],
      ["empty messages array", { httpStatus: 200, body: { messages: [] } }],
      ["no HTTP status at all", { body: sentBody }],
      ["multi-entry, FAILED then SENT", { httpStatus: 200, body: { messages: [{ status: "FAILED" }, { status: "SENT" }] } }],
      ["messages is not an array", { httpStatus: 200, body: { messages: { 0: { status: "SENT" } } } }],
    ];
    for (const [label, input] of cases) {
      expect(classifyWhatsappOutcome(input).status, label).not.toBe("sent");
    }
  });
});

describe("sendWhatsappTemplate", () => {
  it("sends the raw key, not a Bearer token", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ status: "SENT", messageId: "m-9" }] }),
    }));

    await sendWhatsappTemplate({ fetchImpl, apiKey: "raw-key", payload: { messages: [] } });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe("raw-key");
    expect(init.headers.Authorization).not.toMatch(/^Bearer /);
  });

  it("turns a thrown fetch into a retryable outcome rather than an exception", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const r = await sendWhatsappTemplate({ fetchImpl, apiKey: "k", payload: {} });
    expect(r.retryable).toBe(true);
  });

  it("survives a response body that is not JSON", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token <");
      },
    }));
    const r = await sendWhatsappTemplate({ fetchImpl, apiKey: "k", payload: {} });
    expect(r.status).toBe("failed");
    expect(r.retryable).toBe(false);
  });

  it("posts the payload as JSON to the template endpoint", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ status: "SENT", messageId: "m-10" }] }),
    }));
    const payload = { messages: [{ to: "+971500000000" }] };

    await sendWhatsappTemplate({ fetchImpl, apiKey: "k", payload });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://public.doubletick.io/whatsapp/message/template");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it("reads the provider's HTTP status, so a 503 is retried rather than treated as a rejection", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const r = await sendWhatsappTemplate({ fetchImpl, apiKey: "k", payload: {} });
    expect(r.status).toBe("failed");
    expect(r.retryable).toBe(true);
  });

  it("reads messages[0].status from a 2xx body, so a FAILED message is rejected and a SENT one is sent", async () => {
    const undeliverable = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ status: "UNDELIVERABLE", messageId: "m-7" }] }),
    }));
    const sent = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ status: "SENT", messageId: "m-8" }] }),
    }));
    expect((await sendWhatsappTemplate({ fetchImpl: undeliverable, apiKey: "k", payload: {} })).status).toBe(
      "rejected"
    );
    expect((await sendWhatsappTemplate({ fetchImpl: sent, apiKey: "k", payload: {} })).status).toBe("sent");
  });

  it("treats a thrown falsy value as a transport failure, not as a rejection", async () => {
    for (const thrown of [undefined, null, 0, "", false]) {
      const fetchImpl = vi.fn(async () => {
        throw thrown;
      });
      const r = await sendWhatsappTemplate({ fetchImpl, apiKey: "k", payload: {} });
      expect(r.status, String(thrown)).toBe("failed");
      expect(r.retryable, String(thrown)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run crmSignup/whatsapp.test.js --reporter=verbose`
Expected: FAIL — `Failed to load url ./whatsapp.js`

- [ ] **Step 3: Write the implementation**

Create `crmSignup/whatsapp.js`:

```js
import { PHONE_RE } from "./normalise.js";

export const DOUBLETICK_TEMPLATE_URL = "https://public.doubletick.io/whatsapp/message/template";

/** A 2xx from DoubleTick means the REQUEST was accepted. These are the
 *  messages[0].status values that mean the MESSAGE was not. */
export const WHATSAPP_FAILURE_STATUSES = [
  "FAILED",
  "ERROR",
  "REJECTED",
  "UNDELIVERED",
  "UNDELIVERABLE",
  "INVALID",
];

const FAILURE_SET = new Set(WHATSAPP_FAILURE_STATUSES);

/** The messages[0].status values that mean the MESSAGE was accepted for sending.
 *  Two, because DoubleTick changed the value and the API reference never recorded
 *  it: SENT is the historical value, which the reference still documents, and
 *  ENQUEUED is the current one, per DoubleTick's help article on the template-send
 *  response. We do not know which this account's plan returns, so both are kept.
 *  Nothing else is: an unlisted status is rejected loudly, with its value in the
 *  detail, rather than assumed to be a send. */
const SENT_STATUSES = ["SENT", "ENQUEUED"];
const SENT_SET = new Set(SENT_STATUSES);

export function parseSkipSources(raw) {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Whether to send at all, and why not. Configuration first: an unset key is
 * our problem and should not be reported as a fact about the client.
 */
export function decideWhatsappSkip({ stage, apiKey, recordType, source, phone, skipSources }) {
  if (!String(apiKey ?? "").trim()) return { reason: "whatsapp not configured" };
  if (stage !== "registered") return { reason: "stage not applicable" };
  if (recordType !== "client") return { reason: "lead, not client" };
  const sources = skipSources instanceof Set ? skipSources : parseSkipSources(skipSources);
  if (sources.has(String(source ?? "").trim().toLowerCase())) return { reason: "source excluded" };
  if (!PHONE_RE.test(String(phone ?? ""))) return { reason: "invalid phone number" };
  return null;
}

/** `from` and `messageId` sit beside `content` inside the message, not at the
 *  top level, and omitting either is enough on its own for a rejection. */
export function buildWhatsappPayload({
  templateName,
  language,
  firstName,
  bodyParam,
  buttonUrl,
  from,
  to,
  messageId,
}) {
  return {
    messages: [
      {
        content: {
          templateName,
          language,
          templateData: {
            header: { type: "TEXT", placeholder: String(firstName ?? "") },
            body: { placeholders: [bodyParam] },
            buttons: [{ type: "URL", parameter: buttonUrl }],
          },
        },
        from,
        to,
        messageId,
      },
    ],
  };
}

export function classifyWhatsappOutcome({ transportError, httpStatus, body } = {}) {
  if (transportError) {
    return {
      status: "failed",
      retryable: true,
      detail: `transport: ${String(transportError?.message || transportError).slice(0, 200)}`,
      messageId: null,
    };
  }

  const code = Number(httpStatus) || 0;

  // A Request Timeout is transient by definition, as are 429 and every 5xx.
  if (code === 408 || code === 429 || code >= 500) {
    return { status: "failed", retryable: true, detail: `http ${code}`, messageId: null };
  }

  if (code < 200 || code >= 300) {
    // A bad key, an unapproved template, a malformed body: identical on retry.
    return { status: "rejected", retryable: false, detail: `http ${code}`, messageId: null };
  }

  const message = Array.isArray(body?.messages) ? body.messages[0] : null;
  const rawStatus = message?.status;

  // Only a string can be matched. Coercing anything else would let ["SENT"] pass as SENT.
  if (rawStatus !== undefined && rawStatus !== null && typeof rawStatus !== "string") {
    return {
      status: "rejected",
      retryable: false,
      detail: `unrecognised status: ${JSON.stringify(rawStatus)}`,
      messageId: message?.messageId ?? null,
    };
  }

  const status = String(rawStatus ?? "").trim();

  if (!status) {
    return {
      status: "failed",
      retryable: false,
      detail: "no message status in a 2xx response",
      messageId: message?.messageId ?? null,
    };
  }

  const messageId = message?.messageId ?? null;
  const upper = status.toUpperCase();

  if (SENT_SET.has(upper)) {
    return { status: "sent", retryable: false, detail: status, messageId };
  }

  if (FAILURE_SET.has(upper)) {
    return { status: "rejected", retryable: false, detail: status, messageId };
  }

  // A status we do not recognise is not a send. It is not retried either: it may
  // well mean the message was delivered, and a retry would send a second welcome.
  return {
    status: "rejected",
    retryable: false,
    detail: `unrecognised status: ${status}`,
    messageId,
  };
}

/** Never throws. */
export async function sendWhatsappTemplate({ fetchImpl = fetch, apiKey, payload }) {
  let response;
  try {
    response = await fetchImpl(DOUBLETICK_TEMPLATE_URL, {
      method: "POST",
      headers: {
        // Raw key. NOT "Bearer <key>" -- the provider rejects that.
        Authorization: String(apiKey ?? ""),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (transportError) {
    // A thrown falsy value is still a transport failure, not something that falls through.
    return classifyWhatsappOutcome({ transportError: transportError || new Error("unknown") });
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return classifyWhatsappOutcome({ httpStatus: response?.status, body });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run crmSignup/whatsapp.test.js --reporter=verbose`
Expected: PASS — every `it` block written in the test step above, none added and none removed. There is deliberately no count here: this plan's prose counts have been wrong before, and the test file is the authority.

- [ ] **Step 5: Commit**

```bash
git add crmSignup/whatsapp.js crmSignup/whatsapp.test.js
git commit -m "CRM events: WhatsApp welcome, and the 2xx-is-not-sent classifier"
```

---

## Task 5: Brevo

**Files:**
- Create: `crmSignup/brevo.js`
- Test: `crmSignup/brevo.test.js`

**Interfaces:**
- Consumes: the `Fields` shape from `crmSignup/normalise.js`.
- Produces:
  - `BREVO_CONTACTS_URL: string`
  - `decideBrevoSkip({ stage, apiKey }): { reason } | null`
  - `buildBrevoContact(fields, { listId }): object`
  - `classifyBrevoOutcome({ transportError, httpStatus, body }): { status, retryable, detail }`
  - `upsertBrevoContact({ fetchImpl, apiKey, contact }): Promise<outcome>`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/brevo.test.js`:

```js
// @vitest-environment node
//
// Brevo takes a fixed set of attributes, every one of which had to be created
// in the account before it could be sent (done 2026-10-09). Posting an
// attribute Brevo does not know returns 400, which this design treats as
// permanent -- so a typo here means the contact silently never lands.
import { describe, it, expect, vi } from "vitest";
import {
  decideBrevoSkip,
  buildBrevoContact,
  classifyBrevoOutcome,
  upsertBrevoContact,
} from "./brevo.js";

// The two booleans are set in opposite polarity to each other, so a swapped or
// hardcoded boolean cannot produce the same output as the right one. The
// opposite pair is exercised again in its own case below.
const FIELDS = {
  stage: "registered",
  crmClientId: "88214",
  firstName: "Ali",
  middleName: "Hassan",
  lastName: "Khan",
  email: "ali.khan@example.com",
  phone: "+971507192185",
  recordType: "client",
  marketingConsent: false,
  source: "SVG",
  entity: "SVG Ltd",
  isIb: true,
  language: "en",
  utmSource: "meta",
  utmMedium: "cpc",
  utmCampaign: "zero-spread-ind-2",
  referer: "https://skylinkscapital.com/en/",
  fullLink: "https://skylinkscapital.com/en/?fbclid=ABC",
  fxboUniqueId: "d3f1-aa",
};

describe("skip decisions", () => {
  it("runs only at registration", () => {
    expect(decideBrevoSkip({ stage: "registered", apiKey: "k" })).toBeNull();
    for (const stage of ["lead", "verified", "live_account", "first_deposit"]) {
      expect(decideBrevoSkip({ stage, apiKey: "k" }), stage).toEqual({
        reason: "stage not applicable",
      });
    }
  });

  it("skips silently when no key is configured", () => {
    expect(decideBrevoSkip({ stage: "registered", apiKey: "" })).toEqual({
      reason: "brevo not configured",
    });
  });

  it("treats every blank or missing key as unconfigured", () => {
    for (const apiKey of ["", "   ", undefined, null]) {
      expect(decideBrevoSkip({ stage: "registered", apiKey }), String(apiKey)).toEqual({
        reason: "brevo not configured",
      });
    }
  });

  it("reports an unconfigured key ahead of the stage", () => {
    expect(decideBrevoSkip({ stage: "lead", apiKey: "" })).toEqual({ reason: "brevo not configured" });
  });

  it("does not gate on marketing consent", () => {
    // Decided 2026-10-09 and reaffirmed 2026-10-12: everyone lands in Brevo
    // with consent recorded as OPT_IN, and campaigns segment on it.
    expect(decideBrevoSkip({ stage: "registered", apiKey: "k", marketingConsent: false })).toBeNull();
  });
});

describe("buildBrevoContact", () => {
  it("builds an idempotent upsert into the configured list", () => {
    const contact = buildBrevoContact({ ...FIELDS, email: "  Ali.Khan@Example.COM " }, { listId: "19" });
    expect(contact.email).toBe("ali.khan@example.com");
    expect(contact.updateEnabled).toBe(true);
    expect(contact.listIds).toEqual([19]);
  });

  it("maps every attribute to the id that exists in Brevo", () => {
    expect(buildBrevoContact(FIELDS, { listId: "19" }).attributes).toEqual({
      FIRSTNAME: "Ali",
      LASTNAME: "Khan",
      MIDDLE_NAME: "Hassan",
      EXT_ID: "88214",
      OPT_IN: false,
      ENTITY: "SVG Ltd",
      FORM_NAME: "SVG",
      LANGUAGE: "en",
      IS_IB: true,
      UTM_SOURCE: "meta",
      UTM_MEDIUM: "cpc",
      UTM_CAMPAIGN: "zero-spread-ind-2",
      REFERER: "https://skylinkscapital.com/en/",
    });
  });

  it("carries each boolean from its own field, in the opposite pair too", () => {
    const { attributes } = buildBrevoContact(
      { ...FIELDS, marketingConsent: true, isIb: false },
      { listId: "19" }
    );
    expect(attributes.OPT_IN).toBe(true);
    expect(attributes.IS_IB).toBe(false);
  });

  it("never sends the phone, and never sends an attribute Brevo lacks", () => {
    const contact = buildBrevoContact(FIELDS, { listId: "19" });
    const { attributes } = contact;
    expect(JSON.stringify(contact)).not.toContain("971507192185");
    expect(Object.keys(contact)).toEqual(["email", "updateEnabled", "attributes", "listIds"]);
    expect(attributes.PHONE).toBeUndefined();
    expect(attributes.SMS).toBeUndefined();
    expect(attributes.MARKETING_CONSENT).toBeUndefined(); // consent rides on OPT_IN
    expect(attributes.CRM_CLIENT_ID).toBeUndefined(); // the id rides on EXT_ID
    expect(attributes.FULL_LINK).toBeUndefined();
  });

  it("omits empty text attributes but always sends the booleans", () => {
    const { attributes } = buildBrevoContact(
      { ...FIELDS, middleName: "", entity: "", utmMedium: "", marketingConsent: false, isIb: false },
      { listId: "19" }
    );
    expect("MIDDLE_NAME" in attributes).toBe(false);
    expect("ENTITY" in attributes).toBe(false);
    expect("UTM_MEDIUM" in attributes).toBe(false);
    // A false boolean is a real value, not an absent one.
    expect(attributes.OPT_IN).toBe(false);
    expect(attributes.IS_IB).toBe(false);
  });

  it("omits a missing or null text field rather than sending the word for it", () => {
    const { attributes } = buildBrevoContact(
      { ...FIELDS, middleName: undefined, utmMedium: null },
      { listId: "19" }
    );
    expect("MIDDLE_NAME" in attributes).toBe(false);
    expect("UTM_MEDIUM" in attributes).toBe(false);
  });

  it("omits listIds entirely when no list is configured", () => {
    expect("listIds" in buildBrevoContact(FIELDS, { listId: "" })).toBe(false);
  });
});

describe("classifyBrevoOutcome", () => {
  it("treats 201 created and 204 updated as sent, and never as retryable", () => {
    const created = classifyBrevoOutcome({ httpStatus: 201, body: { id: 5 } });
    const updated = classifyBrevoOutcome({ httpStatus: 204, body: null });
    expect(created.status).toBe("sent");
    expect(updated.status).toBe("sent");
    expect(created.retryable).toBe(false);
    expect(updated.retryable).toBe(false);
  });

  it("retries transport errors, 429 and 5xx", () => {
    expect(classifyBrevoOutcome({ transportError: new Error("ETIMEDOUT") }).retryable).toBe(true);
    for (const httpStatus of [429, 500, 502, 503]) {
      expect(classifyBrevoOutcome({ httpStatus, body: {} }).retryable, String(httpStatus)).toBe(true);
    }
  });

  it("treats every other 4xx as permanent and keeps Brevo's own code", () => {
    const r = classifyBrevoOutcome({
      httpStatus: 400,
      body: { code: "invalid_parameter", message: "Attribute ENTITY does not exist" },
    });
    expect(r.retryable).toBe(false);
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("invalid_parameter");
  });

  it("reports transport errors, 429 and 5xx as failed, never as sent", () => {
    expect(classifyBrevoOutcome({ transportError: new Error("ETIMEDOUT") }).status).toBe("failed");
    for (const httpStatus of [429, 500, 502, 503]) {
      expect(classifyBrevoOutcome({ httpStatus, body: {} }).status, String(httpStatus)).toBe("failed");
    }
  });

  it("never counts a response that is not 2xx as sent", () => {
    // Anything the classifier does not recognise must fail closed.
    for (const httpStatus of [302, 304, 0, undefined]) {
      expect(classifyBrevoOutcome({ httpStatus, body: {} }).status, String(httpStatus)).toBe("failed");
    }
  });

  it("treats every other 4xx as permanent, not only 400", () => {
    for (const httpStatus of [401, 403, 404, 409, 422]) {
      const r = classifyBrevoOutcome({ httpStatus, body: {} });
      expect(r.retryable, String(httpStatus)).toBe(false);
      expect(r.status, String(httpStatus)).toBe("failed");
    }
  });
});

describe("upsertBrevoContact", () => {
  it("authenticates with the api-key header", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 1 }) }));
    await upsertBrevoContact({ fetchImpl, apiKey: "brevo-key", contact: { email: "a@b.c" } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.brevo.com/v3/contacts");
    expect(init.headers["api-key"]).toBe("brevo-key");
  });

  it("posts the contact as JSON to the contacts endpoint", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 1 }) }));
    const contact = { email: "ali.khan@example.com", updateEnabled: true, attributes: { EXT_ID: "88214" } };
    await upsertBrevoContact({ fetchImpl, apiKey: "k", contact });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Accept).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(contact);
  });

  it("carries Brevo's own code and message into the detail of a rejection", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ code: "invalid_parameter", message: "Attribute ENTITY does not exist" }),
    }));
    const r = await upsertBrevoContact({ fetchImpl, apiKey: "k", contact: {} });
    expect(r.detail).toBe("http 400 invalid_parameter: Attribute ENTITY does not exist");
    expect(r.retryable).toBe(false);
  });

  it("turns a thrown fetch into a retryable outcome rather than an exception", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    expect((await upsertBrevoContact({ fetchImpl, apiKey: "k", contact: {} })).retryable).toBe(true);
  });

  it("treats a thrown falsy value as a retryable transport failure", async () => {
    for (const thrown of [undefined, null, 0, "", false]) {
      const fetchImpl = vi.fn(async () => {
        throw thrown;
      });
      const r = await upsertBrevoContact({ fetchImpl, apiKey: "k", contact: {} });
      expect(r.status, String(thrown)).toBe("failed");
      expect(r.retryable, String(thrown)).toBe(true);
    }
  });

  it("treats a 204 with no body as success", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("no content");
      },
    }));
    expect((await upsertBrevoContact({ fetchImpl, apiKey: "k", contact: {} })).status).toBe("sent");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run crmSignup/brevo.test.js --reporter=verbose`
Expected: FAIL — `Failed to load url ./brevo.js`

- [ ] **Step 3: Write the implementation**

Create `crmSignup/brevo.js`:

```js
export const BREVO_CONTACTS_URL = "https://api.brevo.com/v3/contacts";

const text = (v) => String(v ?? "").trim();

/**
 * Brevo runs at registration only. It is deliberately NOT gated on marketing
 * consent: decided 2026-10-09 and reaffirmed 2026-10-12, everyone lands in the
 * list with consent recorded as OPT_IN, which is Brevo's own flag and which its
 * double-opt-in tooling reads. Campaigns segment on it.
 */
export function decideBrevoSkip({ stage, apiKey }) {
  if (!text(apiKey)) return { reason: "brevo not configured" };
  if (stage !== "registered") return { reason: "stage not applicable" };
  return null;
}

/**
 * One contact, ready for POST /v3/contacts with updateEnabled.
 *
 * Two attributes are Brevo's own rather than ours: EXT_ID carries the CRM
 * client id, and OPT_IN carries marketing consent -- a custom
 * MARKETING_CONSENT would be invisible to Brevo's compliance tooling.
 *
 * Empty text is omitted rather than sent as "". A false boolean IS sent,
 * because false is a real answer and absent is not.
 */
export function buildBrevoContact(fields = {}, { listId } = {}) {
  const attributes = {
    OPT_IN: Boolean(fields.marketingConsent),
    IS_IB: Boolean(fields.isIb),
  };

  const textAttributes = {
    FIRSTNAME: fields.firstName,
    LASTNAME: fields.lastName,
    MIDDLE_NAME: fields.middleName,
    EXT_ID: fields.crmClientId,
    ENTITY: fields.entity,
    FORM_NAME: fields.source,
    LANGUAGE: fields.language,
    UTM_SOURCE: fields.utmSource,
    UTM_MEDIUM: fields.utmMedium,
    UTM_CAMPAIGN: fields.utmCampaign,
    REFERER: fields.referer,
  };

  for (const [key, value] of Object.entries(textAttributes)) {
    const v = text(value);
    if (v) attributes[key] = v;
  }

  const contact = {
    email: text(fields.email).toLowerCase(),
    updateEnabled: true,
    attributes,
  };

  const list = Number(listId);
  if (Number.isFinite(list) && list > 0) contact.listIds = [list];

  return contact;
}

export function classifyBrevoOutcome({ transportError, httpStatus, body } = {}) {
  if (transportError) {
    return {
      status: "failed",
      retryable: true,
      detail: `transport: ${String(transportError?.message || transportError).slice(0, 200)}`,
    };
  }

  const code = Number(httpStatus) || 0;

  if (code === 429 || code >= 500) {
    return { status: "failed", retryable: true, detail: `http ${code}` };
  }

  if (code >= 200 && code < 300) {
    return { status: "sent", retryable: false, detail: `http ${code}` };
  }

  const reason = [body?.code, body?.message].filter(Boolean).join(": ").slice(0, 200);
  return {
    status: "failed",
    retryable: false,
    detail: reason ? `http ${code} ${reason}` : `http ${code}`,
  };
}

/** Never throws. */
export async function upsertBrevoContact({ fetchImpl = fetch, apiKey, contact }) {
  let response;
  try {
    response = await fetchImpl(BREVO_CONTACTS_URL, {
      method: "POST",
      headers: {
        "api-key": String(apiKey ?? ""),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(contact),
    });
  } catch (transportError) {
    // A thrown falsy value is still a transport failure, not something that falls through.
    return classifyBrevoOutcome({ transportError: transportError || new Error("unknown") });
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // 204 has no body, and that is a success, not a parse failure.
    body = null;
  }

  return classifyBrevoOutcome({ httpStatus: response?.status, body });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run crmSignup/brevo.test.js --reporter=verbose`
Expected: PASS — every `it` block written in the test step above, none added and none removed. There is deliberately no count here: this plan's prose counts have been wrong before, and the test file is the authority.

- [ ] **Step 5: Commit**

```bash
git add crmSignup/brevo.js crmSignup/brevo.test.js
git commit -m "CRM events: Brevo upsert against the attributes that exist"
```

---

## Task 6: The store

**Files:**
- Create: `crmSignup/store.js`
- Test: `crmSignup/store.test.js`

**Interfaces:**
- Consumes: the `Fields` shape from `crmSignup/normalise.js`.
- Produces:
  - `SIGNUP_EVENTS_SCHEMA: string`
  - `buildInsertParams(fields, derived, rawPayload): unknown[]` — `derived` is `{ fbc, whatsappRequestId }`
  - `initCrmSignupStore(): Promise<void>`
  - `findExistingFbc(crmClientId): Promise<string>`
  - `insertSignupEvent(fields, derived, rawPayload): Promise<{ inserted, id }>`
  - `markSignupInvalid(crmClientId, stage, detail): Promise<void>`
  - `claimDueEvents(limit, now): Promise<Row[]>`
  - `updateMetaStatus(id, { status, detail, attempts, nextAttemptAt }): Promise<void>`
  - `updateWhatsappStatus(id, { status, messageId, detail, attempts, nextAttemptAt }): Promise<void>`
  - `updateBrevoStatus(id, { status, detail, attempts, nextAttemptAt }): Promise<void>`
  - `listEventsSince(since, cap): Promise<Row[]>`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/store.test.js`:

```js
// @vitest-environment node
//
// The MySQL wrapper itself is not unit-tested -- docusign/store.js sets that
// precedent, and a pool needs a database. What IS tested is the schema text and
// the parameter builder, because both encode decisions a later edit could
// quietly undo: the composite key that makes a redelivery a no-op while still
// allowing five rows per client, and the per-action retry columns.
import { describe, it, expect } from "vitest";
import { SIGNUP_EVENTS_SCHEMA, buildInsertParams } from "./store.js";

describe("signup_events schema", () => {
  it("is unique on client AND stage, not client alone", () => {
    // A client legitimately has five rows, one per funnel stage. Unique on
    // crm_client_id alone would silently drop four of them.
    expect(SIGNUP_EVENTS_SCHEMA).toMatch(/UNIQUE KEY\s+\w+\s+\(crm_client_id,\s*stage\)/i);
    expect(SIGNUP_EVENTS_SCHEMA).not.toMatch(/UNIQUE KEY\s+\w+\s+\(crm_client_id\)/i);
  });

  it("gives each of the three actions its own counter and clock", () => {
    for (const column of [
      "meta_attempts",
      "meta_next_attempt_at",
      "whatsapp_attempts",
      "whatsapp_next_attempt_at",
      "brevo_attempts",
      "brevo_next_attempt_at",
    ]) {
      expect(SIGNUP_EVENTS_SCHEMA, column).toContain(column);
    }
  });

  it("stores the click id, so it can be frozen across stages", () => {
    expect(SIGNUP_EVENTS_SCHEMA).toMatch(/\bfbc\b/);
  });

  it("stores the WhatsApp request id, so a retry cannot send a second welcome", () => {
    // A send times out after 10s, and a timeout does not mean the message was
    // not delivered. A retry carrying a NEW messageId would be a second
    // welcome to the client, so the id is frozen on the row like the fbc.
    expect(SIGNUP_EVENTS_SCHEMA).toContain("whatsapp_request_id");
  });

  it("stores the raw payload", () => {
    expect(SIGNUP_EVENTS_SCHEMA).toMatch(/raw_payload\s+LONGTEXT/i);
  });

  it("defaults all three action statuses to pending", () => {
    for (const column of ["meta_status", "whatsapp_status", "brevo_status"]) {
      expect(SIGNUP_EVENTS_SCHEMA, column).toMatch(
        new RegExp(`${column}[^,]*DEFAULT 'pending'`, "i")
      );
    }
  });
});

describe("buildInsertParams", () => {
  const FIELDS = {
    stage: "registered",
    crmClientId: "88214",
    firstName: "Ali",
    middleName: "Hassan",
    lastName: "Khan",
    email: "ali.khan@example.com",
    phone: "+971507192185",
    recordType: "client",
    marketingConsent: true,
    source: "SVG",
    entity: "SVG Ltd",
    isIb: false,
    language: "en",
    utmSource: "meta",
    utmMedium: "cpc",
    utmCampaign: "zero-spread",
    referer: "https://skylinkscapital.com/en/",
    fullLink: "https://skylinkscapital.com/en/?fbclid=ABC",
    fxboUniqueId: "d3f1-aa",
  };

  it("converts booleans to the 1/0 MySQL stores", () => {
    const params = buildInsertParams(FIELDS, "fb.1.1.ABC", "{}");
    expect(params).toContain(1); // marketingConsent
    expect(params).toContain(0); // isIb
    expect(params).not.toContain(true);
    expect(params).not.toContain(false);
  });

  it("carries both frozen ids", () => {
    const params = buildInsertParams(
      FIELDS,
      { fbc: "fb.1.1673035686000.ABC", whatsappRequestId: "11111111-2222-4333-8444-555555555555" },
      "{}"
    );
    expect(params).toContain("fb.1.1673035686000.ABC");
    expect(params).toContain("11111111-2222-4333-8444-555555555555");
  });

  it("writes null rather than an empty string when an id is absent", () => {
    // An empty string would defeat findExistingFbc, which looks for a non-empty
    // value, and would make an absent request id indistinguishable from a blank.
    const params = buildInsertParams(FIELDS, {}, "{}");
    expect(params).not.toContain("");
  });

  it("serialises the raw payload as a string", () => {
    const params = buildInsertParams(FIELDS, {}, { a: 1 });
    expect(params[params.length - 1]).toBe('{"a":1}');
  });

  it("does not throw on an unserialisable payload", () => {
    const circular = {};
    circular.self = circular;
    expect(() => buildInsertParams(FIELDS, {}, circular)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run crmSignup/store.test.js --reporter=verbose`
Expected: FAIL — `Failed to load url ./store.js`

- [ ] **Step 3: Write the implementation**

Create `crmSignup/store.js`:

```js
import mysql from "mysql2/promise";

const AUTH_DB_HOST = process.env.AUTH_DB_HOST;
const AUTH_DB_PORT = Number(process.env.AUTH_DB_PORT || 3306);
const AUTH_DB_NAME = process.env.AUTH_DB_NAME;
const AUTH_DB_USER = process.env.AUTH_DB_USER;
const AUTH_DB_PASSWORD = process.env.AUTH_DB_PASSWORD;

let pool = null;
let initialized = false;

/**
 * Exported so a test can assert on it without a database.
 *
 * The composite UNIQUE key is the whole deduplication strategy: a client
 * legitimately holds one row per funnel stage, and a redelivery of one stage
 * collides at the database rather than in a check-then-act race.
 */
export const SIGNUP_EVENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS signup_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    crm_client_id VARCHAR(255) NOT NULL,
    stage VARCHAR(32) NOT NULL,
    fxbo_unique_id VARCHAR(255) NULL,
    first_name VARCHAR(255) NULL,
    middle_name VARCHAR(255) NULL,
    last_name VARCHAR(255) NULL,
    email VARCHAR(255) NULL,
    phone VARCHAR(32) NULL,
    record_type VARCHAR(16) NOT NULL DEFAULT 'lead',
    marketing_consent TINYINT(1) NOT NULL DEFAULT 0,
    is_ib TINYINT(1) NOT NULL DEFAULT 0,
    entity VARCHAR(255) NULL,
    source VARCHAR(255) NULL,
    language VARCHAR(64) NULL,
    utm_source VARCHAR(255) NULL,
    utm_medium VARCHAR(255) NULL,
    utm_campaign VARCHAR(255) NULL,
    referer VARCHAR(512) NULL,
    full_link VARCHAR(1024) NULL,
    fbc VARCHAR(255) NULL,
    whatsapp_request_id VARCHAR(64) NULL,
    meta_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    meta_detail TEXT NULL,
    meta_attempts INT NOT NULL DEFAULT 0,
    meta_next_attempt_at DATETIME NULL,
    whatsapp_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    whatsapp_message_id VARCHAR(64) NULL,
    whatsapp_detail TEXT NULL,
    whatsapp_attempts INT NOT NULL DEFAULT 0,
    whatsapp_next_attempt_at DATETIME NULL,
    brevo_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    brevo_detail TEXT NULL,
    brevo_attempts INT NOT NULL DEFAULT 0,
    brevo_next_attempt_at DATETIME NULL,
    raw_payload LONGTEXT NULL,
    received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_signup_events_client_stage (crm_client_id, stage)
  )
`;

const INSERT_COLUMNS = [
  "crm_client_id",
  "stage",
  "fxbo_unique_id",
  "first_name",
  "middle_name",
  "last_name",
  "email",
  "phone",
  "record_type",
  "marketing_consent",
  "is_ib",
  "entity",
  "source",
  "language",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "referer",
  "full_link",
  "fbc",
  "whatsapp_request_id",
  "raw_payload",
];

const bool = (v) => (v ? 1 : 0);
const str = (v) => (v === undefined || v === null || v === "" ? null : String(v));

export function buildInsertParams(fields = {}, derived = {}, rawPayload = null) {
  let serialised;
  try {
    serialised = typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload ?? {});
  } catch {
    serialised = '{"unserialisable":true}';
  }

  return [
    String(fields.crmClientId ?? ""),
    String(fields.stage ?? ""),
    str(fields.fxboUniqueId),
    str(fields.firstName),
    str(fields.middleName),
    str(fields.lastName),
    str(fields.email),
    str(fields.phone),
    String(fields.recordType ?? "lead"),
    bool(fields.marketingConsent),
    bool(fields.isIb),
    str(fields.entity),
    str(fields.source),
    str(fields.language),
    str(fields.utmSource),
    str(fields.utmMedium),
    str(fields.utmCampaign),
    str(fields.referer),
    str(fields.fullLink),
    str(derived.fbc),
    str(derived.whatsappRequestId),
    serialised,
  ];
}

function hasDbConfig() {
  return Boolean(AUTH_DB_HOST && AUTH_DB_NAME && AUTH_DB_USER && AUTH_DB_PASSWORD);
}

async function run(sql, params = []) {
  if (!pool) throw new Error("CRM events DB pool is not initialized.");
  const [result] = await pool.query(sql, params);
  return result;
}

async function all(sql, params = []) {
  if (!pool) throw new Error("CRM events DB pool is not initialized.");
  const [rows] = await pool.query(sql, params);
  return Array.isArray(rows) ? rows : [];
}

export async function initCrmSignupStore() {
  if (initialized) return;
  if (!hasDbConfig()) {
    throw new Error(
      "CRM events DB env vars are missing. Expected AUTH_DB_HOST, AUTH_DB_NAME, AUTH_DB_USER, AUTH_DB_PASSWORD."
    );
  }
  if (!pool) {
    pool = mysql.createPool({
      host: AUTH_DB_HOST,
      port: AUTH_DB_PORT,
      database: AUTH_DB_NAME,
      user: AUTH_DB_USER,
      password: AUTH_DB_PASSWORD,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
    });
  }
  await run(SIGNUP_EVENTS_SCHEMA);
  initialized = true;
}

/**
 * The click id this client already has, if any.
 *
 * This is what freezes it. The fbc is assembled once, at whichever stage
 * arrives first, and every later stage reuses the exact string -- recomputing
 * it would give Meta a different click identity for the same person at each
 * step, with no error anywhere.
 */
export async function findExistingFbc(crmClientId) {
  const rows = await all(
    `SELECT fbc FROM signup_events
      WHERE crm_client_id = ? AND fbc IS NOT NULL AND fbc <> ''
      ORDER BY received_at ASC
      LIMIT 1`,
    [String(crmClientId ?? "")]
  );
  return rows.length ? String(rows[0].fbc) : "";
}

export async function insertSignupEvent(fields, derived, rawPayload) {
  const placeholders = INSERT_COLUMNS.map(() => "?").join(", ");
  const result = await run(
    `INSERT INTO signup_events (${INSERT_COLUMNS.join(", ")})
     VALUES (${placeholders})
     ON DUPLICATE KEY UPDATE id = id`,
    buildInsertParams(fields, derived, rawPayload)
  );
  return { inserted: Number(result?.affectedRows) === 1, id: result?.insertId ?? null };
}

/**
 * A payload that failed validation. All three action statuses carry `invalid`,
 * because there is no event-level status column and inventing one would mean
 * two places to look.
 */
export async function markSignupInvalid(crmClientId, stage, detail) {
  const text = String(detail ?? "").slice(0, 500);
  await run(
    `UPDATE signup_events
        SET meta_status = 'invalid', meta_detail = ?,
            whatsapp_status = 'invalid', whatsapp_detail = ?,
            brevo_status = 'invalid', brevo_detail = ?
      WHERE crm_client_id = ? AND stage = ?`,
    [text, text, text, String(crmClientId ?? ""), String(stage ?? "")]
  );
}

export async function claimDueEvents(limit = 25, now = new Date()) {
  return all(
    `SELECT * FROM signup_events
      WHERE (meta_status     IN ('pending','retrying') AND (meta_next_attempt_at     IS NULL OR meta_next_attempt_at     <= ?))
         OR (whatsapp_status IN ('pending','retrying') AND (whatsapp_next_attempt_at IS NULL OR whatsapp_next_attempt_at <= ?))
         OR (brevo_status    IN ('pending','retrying') AND (brevo_next_attempt_at    IS NULL OR brevo_next_attempt_at    <= ?))
      ORDER BY received_at ASC
      LIMIT ?`,
    [now, now, now, Number(limit) || 25]
  );
}

export async function updateMetaStatus(id, { status, detail, attempts, nextAttemptAt }) {
  await run(
    `UPDATE signup_events
        SET meta_status = ?, meta_detail = ?, meta_attempts = ?, meta_next_attempt_at = ?
      WHERE id = ?`,
    [String(status), String(detail ?? "").slice(0, 500) || null, Number(attempts) || 0, nextAttemptAt ?? null, id]
  );
}

export async function updateWhatsappStatus(id, { status, messageId, detail, attempts, nextAttemptAt }) {
  await run(
    `UPDATE signup_events
        SET whatsapp_status = ?, whatsapp_message_id = ?, whatsapp_detail = ?,
            whatsapp_attempts = ?, whatsapp_next_attempt_at = ?
      WHERE id = ?`,
    [
      String(status),
      str(messageId),
      String(detail ?? "").slice(0, 500) || null,
      Number(attempts) || 0,
      nextAttemptAt ?? null,
      id,
    ]
  );
}

export async function updateBrevoStatus(id, { status, detail, attempts, nextAttemptAt }) {
  await run(
    `UPDATE signup_events
        SET brevo_status = ?, brevo_detail = ?, brevo_attempts = ?, brevo_next_attempt_at = ?
      WHERE id = ?`,
    [String(status), String(detail ?? "").slice(0, 500) || null, Number(attempts) || 0, nextAttemptAt ?? null, id]
  );
}

/**
 * Every event since a date, newest first, capped.
 *
 * The overview aggregates in JavaScript rather than SQL: the volume is low
 * (a few hundred rows in a 30-day window) and a pure function is testable
 * without a database, which GROUP BY is not.
 */
export async function listEventsSince(since, cap = 2000) {
  return all(
    `SELECT id, crm_client_id, stage, first_name, last_name, email, phone, record_type, source,
            meta_status, meta_detail, meta_attempts,
            whatsapp_status, whatsapp_detail, whatsapp_attempts,
            brevo_status, brevo_detail, brevo_attempts, received_at
       FROM signup_events
      WHERE received_at >= ?
      ORDER BY received_at DESC
      LIMIT ?`,
    [since, Number(cap) || 2000]
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run crmSignup/store.test.js --reporter=verbose`
Expected: PASS — every `it` block written in the test step above, none added and none removed. There is deliberately no count here: this plan's prose counts have been wrong before, and the test file is the authority.

- [ ] **Step 5: Commit**

```bash
git add crmSignup/store.js crmSignup/store.test.js
git commit -m "CRM events: one row per client per stage, with a frozen click id"
```

---

## Task 7: The route handler and its registration

**Files:**
- Create: `crmSignup/router.js`
- Test: `crmSignup/router.test.js`
- Modify: `docusign/fxboPlaceholder.js` and its test (extend the label list)
- Modify: `auth/requireSession.js` (one allow-list entry)
- Modify: `server.js` (import, register, init, start)

**Interfaces:**
- Consumes: `normaliseEvent`, `maskEmail` from `crmSignup/normalise.js`; `deriveFbc` from `crmSignup/clickId.js`; `findExistingFbc`, `insertSignupEvent`, `markSignupInvalid` from `crmSignup/store.js`; `detectUnsubstitutedPlaceholder`, `PLACEHOLDER_NOT_SUBSTITUTED`, `describePlaceholderRejection` from `docusign/fxboPlaceholder.js`.
- Produces: `makeCrmEventsHandler({ secret, findFbc, insert, markInvalid, onStored, normalise, now, newRequestId, logger }): (req, res) => Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/router.test.js`:

```js
// @vitest-environment node
//
// The handler does five things and nothing else: authenticate, reject a test
// press, validate, store, answer 200. Everything a provider might do happens
// later, in the worker, because the CRM must never wait on us and our failure
// must never look like a CRM failure.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { makeCrmEventsHandler } from "./router.js";
import { PUBLIC_API_ROUTES } from "../auth/requireSession.js";

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const VALID_BODY = {
  stage: "registered",
  client_id: "88214",
  first_name: "Ali",
  last_name: "Khan",
  email: "ali.khan@example.com",
  phone: "+971507192185",
  is_lead: "0",
  full_link: "https://skylinkscapital.com/en/?fbclid=IwY2xjawUsILdI",
};

function deps(overrides = {}) {
  return {
    secret: "s3cret",
    findFbc: vi.fn(async () => ""),
    insert: vi.fn(async () => ({ inserted: true, id: 1 })),
    markInvalid: vi.fn(async () => {}),
    onStored: vi.fn(() => {}),
    now: () => new Date("2026-10-12T12:00:00Z"),
    newRequestId: () => "11111111-2222-4333-8444-555555555555",
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

const req = (headers, body) => ({ headers, body, method: "POST", path: "/api/crm-events", ip: "1.2.3.4" });

describe("authentication", () => {
  it("accepts the configured secret", async () => {
    const res = fakeRes();
    await makeCrmEventsHandler(deps())(req({ authorization: "s3cret" }, VALID_BODY), res);
    expect(res.statusCode).toBe(200);
  });

  it("rejects a wrong or missing secret with 401 and stores nothing", async () => {
    for (const headers of [{ authorization: "wrong" }, {}]) {
      const d = deps();
      const res = fakeRes();
      await makeCrmEventsHandler(d)(req(headers, VALID_BODY), res);
      expect(res.statusCode).toBe(401);
      expect(d.insert).not.toHaveBeenCalled();
    }
  });

  it("fails closed when no secret is configured", async () => {
    // Unlike docusign/router.js, which falls back to open. An unauthenticated
    // endpoint lets anyone trigger WhatsApp sends at our cost and inject
    // fabricated conversions into the ad account.
    const d = deps({ secret: "" });
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req({ authorization: "anything" }, VALID_BODY), res);
    expect(res.statusCode).toBe(401);
    expect(d.insert).not.toHaveBeenCalled();
  });

  it("logs the rejection without ever logging the supplied value", async () => {
    const d = deps();
    await makeCrmEventsHandler(d)(req({ authorization: "sup3r-sekrit" }, VALID_BODY), fakeRes());
    const logged = JSON.stringify(d.logger.warn.mock.calls);
    expect(logged).not.toContain("sup3r-sekrit");
    expect(logged).not.toContain("s3cret");
  });
});

describe("the click id", () => {
  it("derives it from the landing URL on a client's first event", async () => {
    const d = deps();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), fakeRes());
    const [, derived] = d.insert.mock.calls[0];
    expect(derived.fbc).toBe("fb.1.1791806400000.IwY2xjawUsILdI");
  });

  it("reuses the stored one rather than recomputing it", async () => {
    // Recomputing per stage gives Meta a different click identity for the same
    // person at each step -- no error, just a quietly broken funnel.
    const d = deps({ findFbc: vi.fn(async () => "fb.1.1673035686000.OLD") });
    await makeCrmEventsHandler(d)(
      req({ authorization: "s3cret" }, { ...VALID_BODY, stage: "verified" }),
      fakeRes()
    );
    const [, derived] = d.insert.mock.calls[0];
    expect(derived.fbc).toBe("fb.1.1673035686000.OLD");
  });

  it("is empty for an organic signup, which is normal", async () => {
    const d = deps();
    await makeCrmEventsHandler(d)(
      req({ authorization: "s3cret" }, { ...VALID_BODY, full_link: "https://skylinkscapital.com/en/" }),
      fakeRes()
    );
    expect(d.insert.mock.calls[0][1].fbc).toBe("");
  });

  it("stores the event even when the lookup throws", async () => {
    const d = deps({
      findFbc: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res);
    expect(res.statusCode).toBe(200);
    expect(d.insert).toHaveBeenCalledTimes(1);
  });
});

describe("the WhatsApp request id", () => {
  it("is generated once, when the row is stored", async () => {
    const d = deps();
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res);
    const [, derived] = d.insert.mock.calls[0];
    expect(derived.whatsappRequestId).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("is a fresh value per row, not a constant", async () => {
    // Two different funnel events must not share one id, or DoubleTick could
    // treat the second as a replay of the first.
    const ids = [];
    const d = deps({ newRequestId: () => `id-${ids.length}` });
    const handler = makeCrmEventsHandler(d);
    await handler(req({ authorization: "s3cret" }, VALID_BODY), fakeRes());
    ids.push(d.insert.mock.calls[0][1].whatsappRequestId);
    await handler(req({ authorization: "s3cret" }, { ...VALID_BODY, stage: "verified" }), fakeRes());
    ids.push(d.insert.mock.calls[1][1].whatsappRequestId);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("storing", () => {
  it("answers 200 as soon as the row is stored", async () => {
    const d = deps();
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res);
    expect(res.body).toEqual({ ok: true, stored: true, duplicate: false });
    expect(d.onStored).toHaveBeenCalledTimes(1);
  });

  it("reports a duplicate as 200 and does not kick the worker", async () => {
    // FXBO retries. A duplicate is the system working, and a non-2xx would
    // make FXBO redeliver an event we already hold.
    const d = deps({ insert: vi.fn(async () => ({ inserted: false, id: null })) });
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, stored: true, duplicate: true });
    expect(d.onStored).not.toHaveBeenCalled();
  });

  it("stores an unknown stage as invalid and stops", async () => {
    const d = deps();
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, { ...VALID_BODY, stage: "typo" }), res);
    expect(res.statusCode).toBe(200);
    expect(d.markInvalid).toHaveBeenCalledTimes(1);
    expect(d.onStored).not.toHaveBeenCalled();
    expect(res.body.valid).toBe(false);
  });

  it("answers 200 even when the database throws", async () => {
    const d = deps({
      insert: vi.fn(async () => {
        throw new Error("ER_LOCK_WAIT_TIMEOUT");
      }),
    });
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.stored).toBe(false);
    expect(d.logger.error).toHaveBeenCalled();
  });

  it("never lets an exception escape, even from the worker kick", async () => {
    const d = deps({
      onStored: vi.fn(() => {
        throw new Error("worker exploded");
      }),
    });
    const res = fakeRes();
    await expect(
      makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res)
    ).resolves.toBeUndefined();
    expect(res.statusCode).toBe(200);
  });
});

describe("an FXBO Test webhook press", () => {
  // Pressing Test sends each parameter's LABEL instead of its value, so
  // client_id arrives as "Client ID" and email as "Client Email". Those are
  // non-empty strings: validation alone would accept them, plant a contact
  // called "Client First Name" in the live marketing list, and post a
  // fabricated conversion to the ad account.
  const TEST_PRESS = {
    stage: "registered",
    client_id: "Client ID",
    first_name: "Client First Name",
    last_name: "Client Last Name",
    email: "Client Email",
    phone: "Client Phone",
  };

  it("stores it as invalid and runs nothing", async () => {
    const d = deps();
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, TEST_PRESS), res);
    expect(res.statusCode).toBe(200);
    expect(d.onStored).not.toHaveBeenCalled();
    expect(d.markInvalid).toHaveBeenCalledTimes(1);
    expect(d.markInvalid.mock.calls[0][2]).toContain("placeholder_not_substituted");
  });

  it("leaves a real payload alone", async () => {
    const d = deps();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), fakeRes());
    expect(d.markInvalid).not.toHaveBeenCalled();
    expect(d.onStored).toHaveBeenCalledTimes(1);
  });

  it("does not read one odd-looking field as a test on its own", async () => {
    // A lone label is not proof -- corroboration from a second field is
    // required, or a real client with an unlucky name becomes a "test".
    const d = deps();
    await makeCrmEventsHandler(d)(
      req({ authorization: "s3cret" }, { ...VALID_BODY, last_name: "Client Last Name" }),
      fakeRes()
    );
    expect(d.markInvalid).not.toHaveBeenCalled();
  });
});

describe("registration in server.js", () => {
  const SERVER = readFileSync(path.resolve("server.js"), "utf8");

  it("registers the route with single quotes below the session gate", () => {
    // auth/routeCoverage.test.js looks for the literal with single quotes and
    // requires it to appear after app.use(requireSession).
    const at = SERVER.indexOf("app.post('/api/crm-events'");
    expect(at).toBeGreaterThan(-1);
    expect(SERVER.indexOf("app.use(requireSession)")).toBeLessThan(at);
  });

  it("is on the public allow-list, because FXBO cannot carry a session", () => {
    expect(PUBLIC_API_ROUTES.has("POST /api/crm-events")).toBe(true);
  });

  it("uses one path for all five stages, keeping the allow-list under its cap", () => {
    // The stage is a body parameter, not a path segment: isPublicApiRoute
    // matches the actual request path, so a ":stage" pattern would never
    // match, and five literal paths would breach the six-entry cap.
    expect(PUBLIC_API_ROUTES.size).toBeLessThanOrEqual(6);
    expect(SERVER).not.toContain("/api/crm-events/:");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run crmSignup/router.test.js --reporter=verbose`
Expected: FAIL — `Failed to load url ./router.js`

- [ ] **Step 3: Write the handler**

Create `crmSignup/router.js`:

```js
import { randomUUID, timingSafeEqual } from "crypto";
import { normaliseEvent, maskEmail } from "./normalise.js";
import { deriveFbc } from "./clickId.js";
import {
  detectUnsubstitutedPlaceholder,
  describePlaceholderRejection,
  PLACEHOLDER_NOT_SUBSTITUTED,
} from "../docusign/fxboPlaceholder.js";

/** Compare without leaking length or position through timing. */
function secretMatches(supplied, expected) {
  const a = Buffer.from(String(supplied ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * POST /api/crm-events.
 *
 * One path for all five stages: the stage is a body parameter whose value is
 * typed into each FXBO rule. A ":stage" path segment would never match the
 * public-route allow-list, which compares actual request paths.
 *
 * Authenticate, reject a test press, validate, store, answer 200. The handler
 * answers 200 even when the database throws, because a 5xx would make FXBO
 * redeliver on its own schedule.
 */
export function makeCrmEventsHandler({
  secret,
  findFbc,
  insert,
  markInvalid,
  onStored = () => {},
  normalise = normaliseEvent,
  now = () => new Date(),
  newRequestId = () => randomUUID(),
  logger = console,
}) {
  return async function crmEventsHandler(req, res) {
    const expected = String(secret ?? "");
    const supplied = String(req?.headers?.authorization ?? "");

    // Fail closed: an unconfigured secret rejects everything.
    if (!expected || !secretMatches(supplied, expected)) {
      logger.warn?.(
        `[crm-events] rejected: method=${req?.method} path=${req?.path} ip=${req?.ip} hasHeader=${Boolean(supplied)}`
      );
      return res.status(401).json({ error: "unauthorized" });
    }

    let verdict;
    try {
      verdict = normalise(req?.body);
    } catch (error) {
      logger.error?.(`[crm-events] normalise failed: ${error?.message || String(error)}`);
      return res.status(200).json({ ok: true, stored: false, valid: false });
    }

    const { valid, missing, fields } = verdict;

    // An FXBO "Test webhook" press substitutes every parameter with its own
    // LABEL, and those are non-empty strings that would otherwise validate.
    // docusign/fxboPlaceholder.js recognises the shape, and requires a second
    // corroborating field so a real client is never mistaken for a test.
    const detection = detectUnsubstitutedPlaceholder(req?.body, "client_id");
    const isTestPress = detection.placeholder;
    const reason = isTestPress
      ? `${PLACEHOLDER_NOT_SUBSTITUTED}: ${describePlaceholderRejection(detection)}`
      : `missing required fields: ${missing.join(", ")}`;

    try {
      // Frozen: assembled once, at whichever stage arrives first, then reused
      // verbatim. Recomputing per stage gives Meta a different click identity
      // for the same person at each step.
      let fbc = "";
      try {
        fbc = (await findFbc(fields.crmClientId)) || deriveFbc(fields.fullLink, now().getTime());
      } catch (error) {
        logger.error?.(`[crm-events] click id lookup failed: ${error?.message || String(error)}`);
        fbc = deriveFbc(fields.fullLink, now().getTime());
      }

      // Generated once, here, and reused on every send attempt. A send times
      // out after 10 seconds and a timeout does not mean the message was not
      // delivered, so a retry carrying a fresh id would be a second welcome.
      const { inserted } = await insert(
        fields,
        { fbc, whatsappRequestId: newRequestId() },
        req?.body
      );

      if (isTestPress || !valid) {
        logger.warn?.(
          `[crm-events] ${isTestPress ? "test press" : "invalid payload"} for ${maskEmail(fields.email) || "(no email)"}`
        );
        await markInvalid(fields.crmClientId, fields.stage, reason.slice(0, 500));
        return res.status(200).json({ ok: true, stored: true, duplicate: !inserted, valid: false });
      }

      if (inserted) {
        // Fire and forget, after the response is decided. The sweeper is the
        // safety net if this kick is lost to a recycle, not the normal path.
        try {
          onStored();
        } catch (error) {
          logger.error?.(`[crm-events] worker kick failed: ${error?.message || String(error)}`);
        }
      }

      return res.status(200).json({ ok: true, stored: true, duplicate: !inserted });
    } catch (error) {
      logger.error?.(`[crm-events] store failed: ${error?.message || String(error)}`);
      return res.status(200).json({ ok: true, stored: false, valid });
    }
  };
}
```

- [ ] **Step 4: Extend the shared placeholder label list**

`docusign/fxboPlaceholder.js` already carries the labels DocuSign's rule uses.
Ours sends more parameters, and each is another chance to corroborate a test
press. Add these to `FXBO_PLACEHOLDER_LABELS`, after `"Client Title (Mr/Mrs/Ms)"`
— all copied verbatim from FXBO's own table on 2026-10-09:

```js
  "Client Phone",
  "Client Language",
  "Client is Lead",
  "Client Is IB",
  "Entity",
  "Form Name",
  "UTM Source",
  "UTM Medium",
  "UTM Campaign",
  "Referer",
  "Unique ID",
  "Visited registration page full link",
```

Adding labels only ever makes detection more confident, never less, so this
cannot weaken DocuSign's existing guard. Append to `docusign/fxboPlaceholder.test.js`:

```js
describe("labels used by the CRM events rules", () => {
  it("recognises every label those rules send", () => {
    for (const label of [
      "Client Phone",
      "Client Language",
      "Client is Lead",
      "Client Is IB",
      "Entity",
      "Form Name",
      "UTM Source",
      "UTM Medium",
      "UTM Campaign",
      "Referer",
      "Unique ID",
      "Visited registration page full link",
    ]) {
      expect(isFxboPlaceholderLabel(label), label).toBe(true);
    }
  });

  it("still refuses to call an ordinary value a label", () => {
    // The list is a closed set, not a pattern. A real entity or form name
    // must not match.
    expect(isFxboPlaceholderLabel("SVG")).toBe(false);
    expect(isFxboPlaceholderLabel("UAE")).toBe(false);
    expect(isFxboPlaceholderLabel("meta")).toBe(false);
  });
});
```

Add `isFxboPlaceholderLabel` to that file's existing import if it is not there.

Run: `npx vitest run docusign/fxboPlaceholder.test.js --reporter=verbose`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Add the allow-list entry**

In `auth/requireSession.js`, inside `PUBLIC_API_ROUTES`, after the two DocuSign
entries:

```js
  // FXBO's funnel rules. Carries CRM_WEBHOOK_SECRET in the Authorization
  // header -- exempt from SESSION auth, not from auth. One path for all five
  // stages: the stage is a body parameter, because this list is matched
  // against actual request paths and is capped at six entries.
  "POST /api/crm-events",
```

- [ ] **Step 6: Wire it into server.js**

Add near the other `docusign` imports (around line 16-19):

```js
import { makeCrmEventsHandler } from "./crmSignup/router.js";
import { makeCrmEventsOverviewHandler } from "./crmSignup/overviewRoute.js";
import {
  initCrmSignupStore,
  findExistingFbc,
  insertSignupEvent,
  markSignupInvalid,
  listEventsSince,
} from "./crmSignup/store.js";
import { startCrmEventsWorker, kickCrmEventsWorker } from "./crmSignup/worker.js";
```

Register beside the other `app.use("/api/...")` registrations (around line
1298-1302), using **single quotes**:

```js
app.post('/api/crm-events', makeCrmEventsHandler({
  secret: process.env.CRM_WEBHOOK_SECRET,
  findFbc: findExistingFbc,
  insert: insertSignupEvent,
  markInvalid: markSignupInvalid,
  onStored: kickCrmEventsWorker,
}));

app.get('/api/crm-events/overview', authRequired, adminOnly, makeCrmEventsOverviewHandler({
  canManage: canManageUsers,
  listSince: listEventsSince,
}));
```

In the `server.listen` callback, beside `startDocusignReconcileScheduler()`:

```js
  initCrmSignupStore()
    .then(() => startCrmEventsWorker())
    .catch((e) => console.error("[crm-events] store init failed:", e?.message || String(e)));
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run crmSignup/router.test.js auth/routeCoverage.test.js docusign/fxboPlaceholder.test.js --reporter=verbose`
Expected: PASS. The allow-list is now five entries against a cap of six.

- [ ] **Step 8: Commit**

```bash
git add crmSignup/router.js crmSignup/router.test.js auth/requireSession.js server.js \
        docusign/fxboPlaceholder.js docusign/fxboPlaceholder.test.js
git commit -m "CRM events: POST /api/crm-events, authenticated, fail-closed, stage-aware"
```

---

## Task 8: The worker

**Files:**
- Create: `crmSignup/worker.js`
- Test: `crmSignup/worker.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2-6.
- Produces:
  - `planRetry({ attempts, maxAttempts, retryable, finalStatus, now, delayMinutes }): { status, attempts, nextAttemptAt }`
  - `rowToFields(row): Fields`
  - `processSignupEvent(row, deps): Promise<{ meta, whatsapp, brevo }>`
  - `startCrmEventsWorker(): { stop, intervalSeconds } | null`
  - `kickCrmEventsWorker(): void`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/worker.test.js`:

```js
// @vitest-environment node
//
// Two rules this file exists to hold: the retry clock lives in a column, and
// the three actions never interfere. A WhatsApp rejection must not stop a Meta
// event, and a Brevo retry must not move anyone else's clock.
import { describe, it, expect, vi } from "vitest";
import { planRetry, rowToFields, processSignupEvent } from "./worker.js";

describe("planRetry", () => {
  const now = new Date("2026-10-12T12:00:00Z");

  it("schedules the next attempt five minutes out while attempts remain", () => {
    const plan = planRetry({ attempts: 0, maxAttempts: 3, retryable: true, now, delayMinutes: 5 });
    expect(plan.status).toBe("retrying");
    expect(plan.attempts).toBe(1);
    expect(plan.nextAttemptAt.toISOString()).toBe("2026-10-12T12:05:00.000Z");
  });

  it("gives up once the attempt budget is spent", () => {
    const plan = planRetry({ attempts: 2, maxAttempts: 3, retryable: true, now, delayMinutes: 5 });
    expect(plan.attempts).toBe(3);
    expect(plan.status).toBe("failed");
    expect(plan.nextAttemptAt).toBeNull();
  });

  it("never schedules a retry for a permanent outcome", () => {
    const plan = planRetry({ attempts: 0, maxAttempts: 3, retryable: false, finalStatus: "rejected", now });
    expect(plan.status).toBe("rejected");
    expect(plan.nextAttemptAt).toBeNull();
  });
});

describe("rowToFields", () => {
  it("turns MySQL 1/0 back into booleans", () => {
    const fields = rowToFields({
      stage: "registered",
      crm_client_id: "88214",
      first_name: "Ali",
      marketing_consent: 1,
      is_ib: 0,
      utm_medium: null,
    });
    expect(fields.marketingConsent).toBe(true);
    expect(fields.isIb).toBe(false);
    expect(fields.utmMedium).toBe("");
  });
});

function row(overrides = {}) {
  return {
    id: 7,
    stage: "registered",
    crm_client_id: "88214",
    first_name: "Ali",
    middle_name: "",
    last_name: "Khan",
    email: "ali@example.com",
    phone: "+971507192185",
    record_type: "client",
    marketing_consent: 1,
    is_ib: 0,
    entity: "SVG",
    source: "SVG",
    language: "en",
    utm_source: "meta",
    utm_medium: "",
    utm_campaign: "",
    referer: "",
    full_link: "",
    fbc: "fb.1.1673035686000.ABC",
    whatsapp_request_id: "req-7",
    received_at: new Date("2026-10-12T12:00:00Z"),
    meta_status: "pending",
    meta_attempts: 0,
    whatsapp_status: "pending",
    whatsapp_attempts: 0,
    brevo_status: "pending",
    brevo_attempts: 0,
    ...overrides,
  };
}

function deps(overrides = {}) {
  return {
    config: {
      metaDatasetId: "692517170017822",
      metaApiVersion: "v26.0",
      metaAccessToken: "tok",
      metaTestEventCode: "",
      waApiKey: "wa-key",
      waTemplateName: "registration_client_v3",
      waTemplateLanguage: "en",
      waTemplateBodyParam: "https://skylinkscapital.com/en/login/",
      waTemplateButtonUrl: "https://skylinkscapital.com/en/login/",
      waFromNumber: "+971507192185",
      waMaxAttempts: 3,
      brevoApiKey: "brevo-key",
      brevoListId: "19",
      skipSources: new Set(),
    },
    sendMeta: vi.fn(async () => ({ status: "sent", retryable: false, detail: "http 200" })),
    sendWhatsapp: vi.fn(async () => ({ status: "sent", retryable: false, detail: "SENT", messageId: "m-1" })),
    upsertBrevo: vi.fn(async () => ({ status: "sent", retryable: false, detail: "http 201" })),
    saveMeta: vi.fn(async () => {}),
    saveWhatsapp: vi.fn(async () => {}),
    saveBrevo: vi.fn(async () => {}),
    newMessageId: () => "uuid-fixed",
    now: () => new Date("2026-10-12T12:00:00Z"),
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    ...overrides,
  };
}

describe("processSignupEvent", () => {
  it("runs all three at registration and records all three", async () => {
    const d = deps();
    await processSignupEvent(row(), d);
    expect(d.sendMeta).toHaveBeenCalledTimes(1);
    expect(d.sendWhatsapp).toHaveBeenCalledTimes(1);
    expect(d.upsertBrevo).toHaveBeenCalledTimes(1);
    for (const save of [d.saveMeta, d.saveWhatsapp, d.saveBrevo]) {
      expect(save).toHaveBeenCalledWith(7, expect.objectContaining({ status: "sent" }));
    }
  });

  it("sends only Meta at every other stage", async () => {
    for (const stage of ["lead", "verified", "live_account", "first_deposit"]) {
      const d = deps();
      await processSignupEvent(row({ stage }), d);
      expect(d.sendMeta, stage).toHaveBeenCalledTimes(1);
      expect(d.sendWhatsapp, stage).not.toHaveBeenCalled();
      expect(d.upsertBrevo, stage).not.toHaveBeenCalled();
      // Both still land in a stored status, so the admin view shows a complete
      // row rather than a blank one.
      expect(d.saveWhatsapp, stage).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ status: "skipped", detail: "stage not applicable" })
      );
    }
  });

  it("keeps the three independent when one throws outright", async () => {
    const d = deps({
      sendMeta: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await processSignupEvent(row(), d);
    expect(d.sendWhatsapp).toHaveBeenCalledTimes(1);
    expect(d.upsertBrevo).toHaveBeenCalledTimes(1);
    expect(d.saveMeta).toHaveBeenCalledWith(7, expect.objectContaining({ status: "retrying" }));
    expect(d.saveBrevo).toHaveBeenCalledWith(7, expect.objectContaining({ status: "sent" }));
  });

  it("gives Meta a stable event id, so a retry cannot double-count", async () => {
    const d = deps();
    await processSignupEvent(row({ stage: "verified" }), d);
    const first = d.sendMeta.mock.calls[0][0].payload.data[0].event_id;
    expect(first).toBe("88214:verified");

    // The same funnel event, retried, must carry the identical id.
    await processSignupEvent(row({ stage: "verified", meta_status: "retrying", meta_attempts: 1 }), d);
    expect(d.sendMeta.mock.calls[1][0].payload.data[0].event_id).toBe(first);
  });

  it("passes the stored fbc to Meta untouched", async () => {
    const d = deps();
    await processSignupEvent(row(), d);
    const { payload } = d.sendMeta.mock.calls[0][0];
    expect(payload.data[0].user_data.fbc).toBe("fb.1.1673035686000.ABC");
  });

  it("uses the row's received_at as the event time, in seconds", async () => {
    const d = deps();
    await processSignupEvent(row(), d);
    const { payload } = d.sendMeta.mock.calls[0][0];
    expect(payload.data[0].event_time).toBe(1791806400);
  });

  it("sends a deposit with no value attached", async () => {
    const d = deps();
    await processSignupEvent(row({ stage: "first_deposit" }), d);
    expect(d.sendMeta).toHaveBeenCalledTimes(1);
    const { payload } = d.sendMeta.mock.calls[0][0];
    expect(payload.data[0].event_name).toBe("Purchase");
    expect("value" in payload.data[0].custom_data).toBe(false);
  });

  it("skips a lead's WhatsApp with the documented reason, but still adds the contact", async () => {
    const d = deps();
    await processSignupEvent(row({ record_type: "lead" }), d);
    expect(d.sendWhatsapp).not.toHaveBeenCalled();
    expect(d.saveWhatsapp).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "skipped", detail: "lead, not client" })
    );
    expect(d.upsertBrevo).toHaveBeenCalledTimes(1);
  });

  it("touches nothing already settled", async () => {
    const d = deps();
    await processSignupEvent(
      row({ meta_status: "sent", whatsapp_status: "sent", brevo_status: "sent" }),
      d
    );
    expect(d.sendMeta).not.toHaveBeenCalled();
    expect(d.sendWhatsapp).not.toHaveBeenCalled();
    expect(d.upsertBrevo).not.toHaveBeenCalled();
    expect(d.saveMeta).not.toHaveBeenCalled();
  });

  it("reuses the row's WhatsApp request id on a retry, so no second welcome is sent", async () => {
    // The opposite of what the original brief asked for. A send times out after
    // ten seconds, and a timeout does not mean the message was not delivered,
    // so a retry carrying a fresh id would message the client twice.
    const ids = [];
    const d = deps({
      newMessageId: () => `uuid-${ids.length}`,
      sendWhatsapp: vi.fn(async ({ payload }) => {
        ids.push(payload.messages[0].messageId);
        return { status: "failed", retryable: true, detail: "http 503", messageId: null };
      }),
    });
    await processSignupEvent(row(), d);
    await processSignupEvent(row({ whatsapp_status: "retrying", whatsapp_attempts: 1 }), d);
    expect(ids).toEqual(["req-7", "req-7"]);
  });

  it("falls back to a generated id when the row carries none", async () => {
    const d = deps({ newMessageId: () => "generated" });
    await processSignupEvent(row({ whatsapp_request_id: null }), d);
    expect(d.sendWhatsapp.mock.calls[0][0].payload.messages[0].messageId).toBe("generated");
  });

  it("stops retrying once the budget is spent", async () => {
    const d = deps({
      sendMeta: vi.fn(async () => ({ status: "failed", retryable: true, detail: "http 500" })),
    });
    await processSignupEvent(row({ meta_status: "retrying", meta_attempts: 2 }), d);
    expect(d.saveMeta).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "failed", attempts: 3, nextAttemptAt: null })
    );
  });

  it("never logs a full phone number, email address or token", async () => {
    const d = deps({
      sendWhatsapp: vi.fn(async () => ({ status: "rejected", retryable: false, detail: "INVALID", messageId: null })),
      sendMeta: vi.fn(async () => ({ status: "failed", retryable: false, detail: "http 400" })),
    });
    await processSignupEvent(row(), d);
    const logged = JSON.stringify([
      ...d.logger.warn.mock.calls,
      ...d.logger.error.mock.calls,
      ...d.logger.info.mock.calls,
    ]);
    expect(logged).not.toContain("+971507192185");
    expect(logged).not.toContain("ali@example.com");
    expect(logged).not.toContain("tok");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run crmSignup/worker.test.js --reporter=verbose`
Expected: FAIL — `Failed to load url ./worker.js`

- [ ] **Step 3: Write the implementation**

Create `crmSignup/worker.js`:

```js
import { randomUUID } from "crypto";
import { maskEmail, maskPhone } from "./normalise.js";
import { buildMetaPayload, sendMetaEvent } from "./meta.js";
import {
  decideWhatsappSkip,
  buildWhatsappPayload,
  sendWhatsappTemplate,
  parseSkipSources,
} from "./whatsapp.js";
import { decideBrevoSkip, buildBrevoContact, upsertBrevoContact } from "./brevo.js";
import {
  claimDueEvents,
  updateMetaStatus,
  updateWhatsappStatus,
  updateBrevoStatus,
} from "./store.js";

const SETTLED = new Set(["sent", "skipped", "rejected", "failed", "invalid"]);

/**
 * What to write after one attempt.
 *
 * `attempts` is incremented here and written BEFORE the next attempt would
 * run, so a crash mid-send costs one attempt instead of retrying forever.
 */
export function planRetry({
  attempts = 0,
  maxAttempts = 3,
  retryable = false,
  finalStatus = "failed",
  now = new Date(),
  delayMinutes = 5,
}) {
  const used = Number(attempts) + 1;
  if (!retryable) return { status: finalStatus, attempts: used, nextAttemptAt: null };
  if (used >= Number(maxAttempts)) return { status: "failed", attempts: used, nextAttemptAt: null };
  return {
    status: "retrying",
    attempts: used,
    nextAttemptAt: new Date(now.getTime() + Number(delayMinutes) * 60_000),
  };
}

const str = (v) => String(v ?? "").trim();

export function rowToFields(row = {}) {
  return {
    stage: str(row.stage),
    crmClientId: str(row.crm_client_id),
    firstName: str(row.first_name),
    middleName: str(row.middle_name),
    lastName: str(row.last_name),
    email: str(row.email),
    phone: str(row.phone),
    recordType: str(row.record_type) || "lead",
    marketingConsent: Boolean(Number(row.marketing_consent)),
    isIb: Boolean(Number(row.is_ib)),
    entity: str(row.entity),
    source: str(row.source),
    language: str(row.language),
    utmSource: str(row.utm_source),
    utmMedium: str(row.utm_medium),
    utmCampaign: str(row.utm_campaign),
    referer: str(row.referer),
    fullLink: str(row.full_link),
  };
}

const eventTimeSeconds = (row) => Math.floor(new Date(row.received_at).getTime() / 1000);

async function runMetaStep(row, fields, deps) {
  const { config, sendMeta, now, logger } = deps;

  if (!str(config.metaAccessToken)) {
    return { status: "skipped", detail: "meta not configured", attempts: Number(row.meta_attempts) || 0, nextAttemptAt: null };
  }

  const payload = buildMetaPayload({
    stage: fields.stage,
    email: fields.email,
    phone: fields.phone,
    // Verbatim from the row: frozen at this client's first event.
    fbc: str(row.fbc),
    eventTimeSeconds: eventTimeSeconds(row),
    // One id per real funnel event, identical on every retry of it. Meta
    // deduplicates server events sharing an event_id and event_name, which is
    // what stops a lost response booking the conversion twice.
    eventId: `${fields.crmClientId}:${fields.stage}`,
    testEventCode: config.metaTestEventCode,
  });

  const outcome = await sendMeta({
    datasetId: config.metaDatasetId,
    apiVersion: config.metaApiVersion,
    accessToken: config.metaAccessToken,
    payload,
  });

  const plan = planRetry({
    attempts: Number(row.meta_attempts) || 0,
    maxAttempts: 3,
    retryable: outcome.retryable,
    finalStatus: outcome.status,
    now: now(),
  });

  if (plan.status !== "sent") {
    logger.warn?.(`[crm-events] meta ${plan.status} for ${maskEmail(fields.email)}: ${outcome.detail}`);
  }

  return { ...plan, detail: outcome.detail };
}

async function runWhatsappStep(row, fields, deps) {
  const { config, sendWhatsapp, newMessageId, now, logger } = deps;

  const skip = decideWhatsappSkip({
    stage: fields.stage,
    apiKey: config.waApiKey,
    recordType: fields.recordType,
    source: fields.source,
    phone: fields.phone,
    skipSources: config.skipSources,
  });

  if (skip) {
    return {
      status: "skipped",
      detail: skip.reason,
      messageId: null,
      attempts: Number(row.whatsapp_attempts) || 0,
      nextAttemptAt: null,
    };
  }

  const payload = buildWhatsappPayload({
    templateName: config.waTemplateName,
    language: config.waTemplateLanguage,
    firstName: fields.firstName,
    bodyParam: config.waTemplateBodyParam,
    buttonUrl: config.waTemplateButtonUrl,
    from: config.waFromNumber,
    to: fields.phone,
    // Frozen on the row at insert, NOT regenerated per attempt: a send times
    // out after 10 seconds, and a timeout does not mean the message was not
    // delivered, so a fresh id on a retry would be a second welcome.
    messageId: str(row.whatsapp_request_id) || newMessageId(),
  });

  const outcome = await sendWhatsapp({ apiKey: config.waApiKey, payload });

  const plan = planRetry({
    attempts: Number(row.whatsapp_attempts) || 0,
    maxAttempts: config.waMaxAttempts,
    retryable: outcome.retryable,
    finalStatus: outcome.status,
    now: now(),
  });

  if (plan.status !== "sent") {
    logger.warn?.(`[crm-events] whatsapp ${plan.status} for ${maskPhone(fields.phone)}: ${outcome.detail}`);
  }

  return { ...plan, detail: outcome.detail, messageId: outcome.messageId };
}

async function runBrevoStep(row, fields, deps) {
  const { config, upsertBrevo, now, logger } = deps;

  const skip = decideBrevoSkip({ stage: fields.stage, apiKey: config.brevoApiKey });
  if (skip) {
    return {
      status: "skipped",
      detail: skip.reason,
      attempts: Number(row.brevo_attempts) || 0,
      nextAttemptAt: null,
    };
  }

  const contact = buildBrevoContact(fields, { listId: config.brevoListId });
  const outcome = await upsertBrevo({ apiKey: config.brevoApiKey, contact });

  const plan = planRetry({
    attempts: Number(row.brevo_attempts) || 0,
    maxAttempts: 3,
    retryable: outcome.retryable,
    finalStatus: outcome.status,
    now: now(),
  });

  if (plan.status !== "sent") {
    logger.warn?.(`[crm-events] brevo ${plan.status} for ${maskEmail(fields.email)}: ${outcome.detail}`);
  }

  return { ...plan, detail: outcome.detail };
}

/**
 * One row, three actions, independently.
 *
 * Each step is wrapped on its own: a thrown step becomes a retryable stored
 * status and the others still run. Nothing escapes.
 */
export async function processSignupEvent(row, deps) {
  const fields = rowToFields(row);
  const result = { meta: null, whatsapp: null, brevo: null };

  const steps = [
    ["meta", "meta_status", "meta_attempts", runMetaStep, deps.saveMeta, 3],
    ["whatsapp", "whatsapp_status", "whatsapp_attempts", runWhatsappStep, deps.saveWhatsapp, deps.config.waMaxAttempts],
    ["brevo", "brevo_status", "brevo_attempts", runBrevoStep, deps.saveBrevo, 3],
  ];

  for (const [key, statusColumn, attemptsColumn, run, save, maxAttempts] of steps) {
    if (SETTLED.has(str(row[statusColumn]))) continue;
    try {
      result[key] = await run(row, fields, deps);
    } catch (error) {
      deps.logger.error?.(`[crm-events] ${key} step threw: ${error?.message || String(error)}`);
      result[key] = {
        ...planRetry({
          attempts: Number(row[attemptsColumn]) || 0,
          maxAttempts,
          retryable: true,
          now: deps.now(),
        }),
        detail: "step threw",
        messageId: null,
      };
    }
    await save(row.id, result[key]);
  }

  return result;
}

function liveConfig() {
  return {
    metaDatasetId: process.env.META_DATASET_ID || "692517170017822",
    metaApiVersion: process.env.META_API_VERSION || "v26.0",
    metaAccessToken: process.env.META_CAPI_ACCESS_TOKEN || "",
    metaTestEventCode: process.env.META_TEST_EVENT_CODE || "",
    waApiKey: process.env.WA_API_KEY || "",
    waTemplateName: process.env.WA_TEMPLATE_NAME || "registration_client_v3",
    waTemplateLanguage: process.env.WA_TEMPLATE_LANGUAGE || "en",
    waTemplateBodyParam: process.env.WA_TEMPLATE_BODY_PARAM || "https://skylinkscapital.com/en/login/",
    waTemplateButtonUrl: process.env.WA_TEMPLATE_BUTTON_URL || "https://skylinkscapital.com/en/login/",
    waFromNumber: process.env.WA_FROM_NUMBER || "+971507192185",
    waMaxAttempts: Math.max(1, Number(process.env.WA_MAX_ATTEMPTS || 3) || 3),
    brevoApiKey: process.env.BREVO_API_KEY || "",
    brevoListId: process.env.BREVO_LIST_ID || "",
    skipSources: parseSkipSources(process.env.SKIP_SOURCES),
  };
}

function liveDeps() {
  return {
    config: liveConfig(),
    sendMeta: (args) => sendMetaEvent(args),
    sendWhatsapp: ({ apiKey, payload }) => sendWhatsappTemplate({ apiKey, payload }),
    upsertBrevo: ({ apiKey, contact }) => upsertBrevoContact({ apiKey, contact }),
    saveMeta: updateMetaStatus,
    saveWhatsapp: updateWhatsappStatus,
    saveBrevo: updateBrevoStatus,
    newMessageId: () => randomUUID(),
    now: () => new Date(),
    logger: console,
  };
}

let sweeping = false;

export async function sweepOnce() {
  if (sweeping) return { skipped: true };
  sweeping = true;
  try {
    const rows = await claimDueEvents(25, new Date());
    const deps = liveDeps();
    for (const row of rows) {
      try {
        await processSignupEvent(row, deps);
      } catch (error) {
        console.error(`[crm-events] row ${row?.id} failed: ${error?.message || String(error)}`);
      }
    }
    return { processed: rows.length };
  } finally {
    sweeping = false;
  }
}

/** Fire and forget, right after the 200, so the welcome is not a minute late. */
export function kickCrmEventsWorker() {
  setImmediate(() => {
    sweepOnce().catch((e) => console.error("[crm-events] kick failed:", e?.message || String(e)));
  });
}

/**
 * The safety net, following startDocusignReconcileScheduler.
 *
 * setInterval rather than node-cron on purpose: the clock that matters lives in
 * the next_attempt_at columns, so a recycle costs at most one interval.
 */
export function startCrmEventsWorker() {
  const enabled = String(process.env.CRM_EVENTS_WORKER_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    console.log("[crm-events] worker disabled by CRM_EVENTS_WORKER_ENABLED=false");
    return null;
  }
  const intervalSeconds = Math.max(30, Number(process.env.CRM_EVENTS_WORKER_INTERVAL_SECONDS || 60) || 60);
  const timer = setInterval(() => {
    sweepOnce().catch((e) => console.error("[crm-events] sweep failed:", e?.message || String(e)));
  }, intervalSeconds * 1000);
  console.log(`[crm-events] worker started (interval=${intervalSeconds}s)`);
  return { stop: () => clearInterval(timer), intervalSeconds };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run crmSignup/worker.test.js --reporter=verbose`
Expected: PASS — every `it` block written in the test step above, none added and none removed. There is deliberately no count here: this plan's prose counts have been wrong before, and the test file is the authority.

- [ ] **Step 5: Commit**

```bash
git add crmSignup/worker.js crmSignup/worker.test.js
git commit -m "CRM events: worker fanning out to three destinations, independently"
```

---

## Task 9: The overview endpoint

The JSON behind the settings tab: health, funnel counts, per-destination
counters and the recent-events table, in one call.

**Files:**
- Create: `crmSignup/stats.js`, `crmSignup/stats.test.js`
- Create: `crmSignup/overviewRoute.js`, `crmSignup/overviewRoute.test.js`

**Interfaces:**
- Consumes: `maskEmail`, `maskPhone` from `crmSignup/normalise.js`; `STAGES` from `crmSignup/normalise.js`; `listEventsSince` from `crmSignup/store.js`.
- Produces:
  - `STALE_HOURS: number`
  - `summariseCrmEvents(rows, { now, staleHours }): { health, funnel, destinations }`
  - `toTableRow(row): object`
  - `makeCrmEventsOverviewHandler({ canManage, listSince, windowDays, tableLimit, now, logger }): (req, res) => Promise<void>`

- [ ] **Step 1: Write the failing test for the aggregation**

Create `crmSignup/stats.test.js`:

```js
// @vitest-environment node
//
// Aggregated in JavaScript rather than SQL on purpose: the volume is low and a
// pure function is testable without a database, which GROUP BY is not.
//
// The health figure is the one that matters most. A broken FXBO rule produces
// no errors anywhere -- it simply stops calling, and nothing else in the system
// would ever notice.
import { describe, it, expect } from "vitest";
import { STALE_HOURS, summariseCrmEvents, toTableRow } from "./stats.js";

const NOW = new Date("2026-10-13T12:00:00Z");

function row(overrides = {}) {
  return {
    id: 1,
    crm_client_id: "88214",
    stage: "registered",
    first_name: "Ali",
    last_name: "Khan",
    email: "ali.khan@example.com",
    phone: "+971507192185",
    record_type: "client",
    source: "SVG",
    meta_status: "sent",
    meta_detail: "http 200",
    meta_attempts: 1,
    whatsapp_status: "sent",
    whatsapp_detail: "SENT",
    whatsapp_attempts: 1,
    brevo_status: "sent",
    brevo_detail: "http 201",
    brevo_attempts: 1,
    received_at: "2026-10-13T11:00:00Z",
    ...overrides,
  };
}

describe("health", () => {
  it("reports how long ago the newest event arrived", () => {
    const { health } = summariseCrmEvents([row()], { now: NOW });
    expect(health.ageHours).toBeCloseTo(1, 3);
    expect(health.stale).toBe(false);
    expect(health.lastReceivedAt).toBe("2026-10-13T11:00:00.000Z");
  });

  it("goes stale past the threshold", () => {
    const old = row({ received_at: "2026-10-09T12:00:00Z" }); // 96 hours
    const { health } = summariseCrmEvents([old], { now: NOW });
    expect(health.ageHours).toBeCloseTo(96, 3);
    expect(health.stale).toBe(true);
  });

  it("reports no events at all as stale, never as healthy", () => {
    // Silence is the symptom of a broken rule, so it must not read as calm.
    const { health } = summariseCrmEvents([], { now: NOW });
    expect(health.lastReceivedAt).toBeNull();
    expect(health.stale).toBe(true);
    expect(health.ageHours).toBeNull();
  });

  it("takes the newest row regardless of the order it was given them", () => {
    const rows = [row({ received_at: "2026-10-10T12:00:00Z" }), row({ received_at: "2026-10-13T11:30:00Z" })];
    expect(summariseCrmEvents(rows, { now: NOW }).health.ageHours).toBeCloseTo(0.5, 3);
  });

  it("ignores a row whose timestamp will not parse", () => {
    const rows = [row({ received_at: "not a date" }), row()];
    expect(summariseCrmEvents(rows, { now: NOW }).health.ageHours).toBeCloseTo(1, 3);
  });
});

describe("funnel", () => {
  it("counts every stage, including the ones with nothing in them", () => {
    // A zero is information: it says that stage's rule is not firing.
    const rows = [row({ stage: "registered" }), row({ stage: "registered" }), row({ stage: "verified" })];
    expect(summariseCrmEvents(rows, { now: NOW }).funnel).toEqual({
      lead: 0,
      registered: 2,
      verified: 1,
      live_account: 0,
      first_deposit: 0,
    });
  });

  it("ignores a stage it does not recognise rather than inventing a key", () => {
    const rows = [row({ stage: "registered" }), row({ stage: "nonsense" })];
    expect(summariseCrmEvents(rows, { now: NOW }).funnel.registered).toBe(1);
    expect("nonsense" in summariseCrmEvents(rows, { now: NOW }).funnel).toBe(false);
  });
});

describe("destinations", () => {
  it("counts each status separately for each of the three", () => {
    const rows = [
      row(),
      row({ meta_status: "failed", whatsapp_status: "skipped", brevo_status: "retrying" }),
      row({ meta_status: "failed", whatsapp_status: "rejected", brevo_status: "sent" }),
    ];
    const { destinations } = summariseCrmEvents(rows, { now: NOW });
    expect(destinations.meta.sent).toBe(1);
    expect(destinations.meta.failed).toBe(2);
    expect(destinations.whatsapp.skipped).toBe(1);
    expect(destinations.whatsapp.rejected).toBe(1);
    expect(destinations.brevo.retrying).toBe(1);
    expect(destinations.brevo.sent).toBe(2);
  });

  it("always reports every status key, so a zero renders rather than vanishing", () => {
    const { destinations } = summariseCrmEvents([row()], { now: NOW });
    for (const name of ["meta", "whatsapp", "brevo"]) {
      expect(Object.keys(destinations[name]).sort(), name).toEqual([
        "failed",
        "invalid",
        "pending",
        "rejected",
        "retrying",
        "sent",
        "skipped",
      ]);
    }
  });

  it("counts an unknown status under nothing rather than throwing", () => {
    const { destinations } = summariseCrmEvents([row({ meta_status: "weird" })], { now: NOW });
    expect(destinations.meta.sent).toBe(0);
  });
});

describe("toTableRow", () => {
  it("masks the email and the phone", () => {
    const view = toTableRow(row());
    expect(view.email).toBe("a***@example.com");
    expect(view.phone).toBe("+971***85");
    expect(JSON.stringify(view)).not.toContain("ali.khan@example.com");
    expect(JSON.stringify(view)).not.toContain("+971507192185");
  });

  it("keeps the stage, the id and all three statuses with their reasons", () => {
    const view = toTableRow(row({ whatsapp_status: "skipped", whatsapp_detail: "lead, not client" }));
    expect(view.stage).toBe("registered");
    expect(view.crmClientId).toBe("88214");
    expect(view.whatsapp).toEqual({ status: "skipped", detail: "lead, not client", attempts: 1 });
    expect(view.meta.status).toBe("sent");
    expect(view.brevo.status).toBe("sent");
  });
});

describe("STALE_HOURS", () => {
  it("is 72, matching the DocuSign webhook health window", () => {
    expect(STALE_HOURS).toBe(72);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run crmSignup/stats.test.js --reporter=verbose`
Expected: FAIL — `Failed to load url ./stats.js`

- [ ] **Step 3: Write the aggregation**

Create `crmSignup/stats.js`:

```js
import { STAGES, maskEmail, maskPhone } from "./normalise.js";

/** Matches docusign/webhookLog.js, which calls the same silence the same way. */
export const STALE_HOURS = 72;

const STATUSES = ["pending", "sent", "skipped", "retrying", "failed", "rejected", "invalid"];

const DESTINATIONS = [
  ["meta", "meta_status", "meta_detail", "meta_attempts"],
  ["whatsapp", "whatsapp_status", "whatsapp_detail", "whatsapp_attempts"],
  ["brevo", "brevo_status", "brevo_detail", "brevo_attempts"],
];

function zeroCounts() {
  return Object.fromEntries(STATUSES.map((k) => [k, 0]));
}

/**
 * Health, funnel and per-destination counters from a window of rows.
 *
 * Health is the one that earns its place: a broken FXBO rule raises no error
 * anywhere, it simply stops calling. An empty window therefore reports STALE,
 * never healthy -- silence must not read as calm.
 */
export function summariseCrmEvents(rows, { now = new Date(), staleHours = STALE_HOURS } = {}) {
  const list = Array.isArray(rows) ? rows : [];

  const times = list
    .map((r) => Date.parse(String(r?.received_at ?? "")))
    .filter((t) => Number.isFinite(t));

  const newest = times.length ? Math.max(...times) : null;
  const ageHours = newest === null ? null : (now.getTime() - newest) / 3_600_000;

  const funnel = Object.fromEntries(STAGES.map((stage) => [stage, 0]));
  for (const r of list) {
    const stage = String(r?.stage ?? "");
    if (stage in funnel) funnel[stage] += 1;
  }

  const destinations = Object.fromEntries(DESTINATIONS.map(([name]) => [name, zeroCounts()]));
  for (const r of list) {
    for (const [name, statusColumn] of DESTINATIONS) {
      const status = String(r?.[statusColumn] ?? "");
      if (status in destinations[name]) destinations[name][status] += 1;
    }
  }

  return {
    health: {
      lastReceivedAt: newest === null ? null : new Date(newest).toISOString(),
      ageHours,
      stale: newest === null || ageHours > staleHours,
    },
    funnel,
    destinations,
  };
}

/** One row for the table, with the two PII fields masked. */
export function toTableRow(row = {}) {
  const view = {
    id: row.id,
    receivedAt: row.received_at,
    stage: String(row.stage ?? ""),
    crmClientId: String(row.crm_client_id ?? ""),
    name: [row.first_name, row.last_name].filter(Boolean).join(" "),
    email: maskEmail(row.email),
    phone: maskPhone(row.phone),
    recordType: String(row.record_type ?? ""),
    source: String(row.source ?? ""),
  };

  for (const [name, statusColumn, detailColumn, attemptsColumn] of DESTINATIONS) {
    view[name] = {
      status: String(row[statusColumn] ?? ""),
      detail: row[detailColumn] ?? null,
      attempts: Number(row[attemptsColumn]) || 0,
    };
  }

  return view;
}
```

- [ ] **Step 4: Write the failing test for the route**

Create `crmSignup/overviewRoute.test.js`:

```js
// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { makeCrmEventsOverviewHandler } from "./overviewRoute.js";

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const ADMIN = { sub: "1", role: "admin" };
const VIEWER = { sub: "2", role: "viewer" };
const canManage = (auth) => auth?.role === "admin";

const ROWS = [
  {
    id: 1,
    crm_client_id: "88214",
    stage: "registered",
    first_name: "Ali",
    last_name: "Khan",
    email: "ali.khan@example.com",
    phone: "+971507192185",
    record_type: "client",
    source: "SVG",
    meta_status: "sent",
    meta_detail: "http 200",
    meta_attempts: 1,
    whatsapp_status: "sent",
    whatsapp_detail: "SENT",
    whatsapp_attempts: 1,
    brevo_status: "sent",
    brevo_detail: "http 201",
    brevo_attempts: 1,
    received_at: "2026-10-13T11:00:00Z",
  },
];

describe("access", () => {
  it("refuses a caller who cannot manage users, without reading anything", async () => {
    const listSince = vi.fn(async () => ROWS);
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince })({ auth: VIEWER, query: {} }, res);
    expect(res.statusCode).toBe(403);
    expect(listSince).not.toHaveBeenCalled();
  });

  it("refuses a request with no session payload at all", async () => {
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince: vi.fn() })({ query: {} }, res);
    expect(res.statusCode).toBe(403);
  });
});

describe("the payload", () => {
  const now = () => new Date("2026-10-13T12:00:00Z");

  it("returns health, funnel, destinations and the table together", async () => {
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince: async () => ROWS, now })(
      { auth: ADMIN, query: {} },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "destinations",
      "events",
      "funnel",
      "health",
      "windowDays",
    ]);
    expect(res.body.funnel.registered).toBe(1);
    expect(res.body.destinations.meta.sent).toBe(1);
    expect(res.body.events).toHaveLength(1);
  });

  it("masks PII in the table it returns", async () => {
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince: async () => ROWS, now })(
      { auth: ADMIN, query: {} },
      res
    );
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain("ali.khan@example.com");
    expect(serialised).not.toContain("+971507192185");
  });

  it("asks the store for the requested window", async () => {
    const listSince = vi.fn(async () => ROWS);
    await makeCrmEventsOverviewHandler({ canManage, listSince, now })(
      { auth: ADMIN, query: { days: "7" } },
      fakeRes()
    );
    const [since] = listSince.mock.calls[0];
    expect(since.toISOString()).toBe("2026-10-06T12:00:00.000Z");
  });

  it("clamps a silly window rather than trusting the query string", async () => {
    const listSince = vi.fn(async () => ROWS);
    const handler = makeCrmEventsOverviewHandler({ canManage, listSince, now });

    await handler({ auth: ADMIN, query: { days: "99999" } }, fakeRes());
    expect(listSince.mock.calls[0][0].toISOString()).toBe("2026-07-15T12:00:00.000Z"); // 90 days

    await handler({ auth: ADMIN, query: { days: "0" } }, fakeRes());
    expect(listSince.mock.calls[1][0].toISOString()).toBe("2026-10-12T12:00:00.000Z"); // 1 day

    await handler({ auth: ADMIN, query: { days: "nonsense" } }, fakeRes());
    expect(listSince.mock.calls[2][0].toISOString()).toBe("2026-09-13T12:00:00.000Z"); // 30, the default
  });

  it("caps the table without capping the counts", async () => {
    // The funnel must count the whole window even when the table shows a page.
    const many = Array.from({ length: 10 }, (_, i) => ({ ...ROWS[0], id: i + 1 }));
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince: async () => many, now, tableLimit: 3 })(
      { auth: ADMIN, query: {} },
      res
    );
    expect(res.body.events).toHaveLength(3);
    expect(res.body.funnel.registered).toBe(10);
  });

  it("answers 500 without leaking the database message", async () => {
    const res = fakeRes();
    const listSince = async () => {
      throw new Error("ER_NO_SUCH_TABLE: signup_events");
    };
    await makeCrmEventsOverviewHandler({ canManage, listSince, now })({ auth: ADMIN, query: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("ER_NO_SUCH_TABLE");
  });
});
```

- [ ] **Step 5: Write the route**

Create `crmSignup/overviewRoute.js`:

```js
import { summariseCrmEvents, toTableRow } from "./stats.js";

const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 90;

function windowDays(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.floor(n)));
}

/**
 * GET /api/crm-events/overview?days=30
 *
 * Everything the settings tab needs in one call. The counts cover the whole
 * window; only the table is capped, so a busy month still reports an accurate
 * funnel.
 */
export function makeCrmEventsOverviewHandler({
  canManage,
  listSince,
  tableLimit = 200,
  now = () => new Date(),
  logger = console,
}) {
  return async function crmEventsOverviewHandler(req, res) {
    if (!canManage(req?.auth)) return res.status(403).json({ error: "forbidden" });

    const days = windowDays(req?.query?.days);
    const at = now();
    const since = new Date(at.getTime() - days * 24 * 3_600_000);

    let rows;
    try {
      rows = await listSince(since);
    } catch (error) {
      // The message can name internal schema, so it is logged, not returned.
      logger.error?.(`[crm-events] overview failed: ${error?.message || String(error)}`);
      return res.status(500).json({ error: "overview_failed" });
    }

    const { health, funnel, destinations } = summariseCrmEvents(rows, { now: at });

    return res.status(200).json({
      windowDays: days,
      health,
      funnel,
      destinations,
      events: rows.slice(0, tableLimit).map(toTableRow),
    });
  };
}
```

- [ ] **Step 6: Run both tests**

Run: `npx vitest run crmSignup/stats.test.js crmSignup/overviewRoute.test.js auth/routeCoverage.test.js --reporter=verbose`
Expected: PASS. `/api/crm-events/overview` is guarded, so it must NOT appear in `PUBLIC_API_ROUTES`.

- [ ] **Step 7: Commit**

```bash
git add crmSignup/stats.js crmSignup/stats.test.js crmSignup/overviewRoute.js crmSignup/overviewRoute.test.js
git commit -m "CRM events: overview endpoint with health, funnel and per-destination counts"
```

---

## Task 10: The settings tab

**Files:**
- Create: `src/pages/settings/CrmEventsPage.tsx`
- Test: `src/pages/settings/CrmEventsPage.test.tsx`
- Modify: `src/App.tsx` (lazy import + `SETTINGS_PAGES` entry)
- Modify: `src/lib/permissions.ts` (menu entry)

**Interfaces:**
- Consumes: `GET /api/crm-events/overview` from Task 9; `authHeaders` from `@/lib/auth`.
- Produces: `CrmEventsPage` (named export, matching every other settings page).

> **This page is invisible until someone runs `npm run build` on the server.**
> Verified 2026-10-13: the deployed bundle was built 2026-10-01 13:39 while that
> day's frontend commits landed at 16:24. Nothing rebuilds on push. Task 11
> step 6 covers it.

- [ ] **Step 1: Write the failing test**

Create `src/pages/settings/CrmEventsPage.test.tsx`:

```tsx
// The CRM events tab. jsdom is the project default, so no environment comment.
//
// The health strip is the reason this page exists: a broken FXBO rule produces
// no error anywhere, it just stops calling, and nothing else would notice.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { CrmEventsPage } from "./CrmEventsPage";

const SESSION_KEY = "slc.session.v2";

const OVERVIEW = {
  windowDays: 30,
  health: { lastReceivedAt: "2026-10-13T11:00:00.000Z", ageHours: 1, stale: false },
  funnel: { lead: 0, registered: 12, verified: 5, live_account: 3, first_deposit: 2 },
  destinations: {
    meta: { pending: 0, sent: 20, skipped: 0, retrying: 1, failed: 1, rejected: 0, invalid: 0 },
    whatsapp: { pending: 0, sent: 10, skipped: 12, retrying: 0, failed: 0, rejected: 0, invalid: 0 },
    brevo: { pending: 0, sent: 12, skipped: 10, retrying: 0, failed: 0, rejected: 0, invalid: 0 },
  },
  events: [
    {
      id: 1,
      receivedAt: "2026-10-13T11:00:00.000Z",
      stage: "registered",
      crmClientId: "88214",
      name: "Ali Khan",
      email: "a***@example.com",
      phone: "+971***85",
      recordType: "client",
      source: "SVG",
      meta: { status: "sent", detail: "http 200", attempts: 1 },
      whatsapp: { status: "sent", detail: "SENT", attempts: 1 },
      brevo: { status: "sent", detail: "http 201", attempts: 1 },
    },
    {
      id: 2,
      receivedAt: "2026-10-13T10:00:00.000Z",
      stage: "verified",
      crmClientId: "88215",
      name: "Sara Noor",
      email: "s***@example.com",
      phone: "+971***12",
      recordType: "client",
      source: "UAE",
      meta: { status: "failed", detail: "http 400 Invalid parameter", attempts: 3 },
      whatsapp: { status: "skipped", detail: "stage not applicable", attempts: 0 },
      brevo: { status: "skipped", detail: "stage not applicable", attempts: 0 },
    },
  ],
};

function installFetch(payload: unknown = OVERVIEW, status = 200) {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      token: "test.session.jwt",
      user: { id: "u1", name: "T", email: "t@t", role: "Super Admin", access: [], status: "active" },
      at: Date.now(),
    }),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("health strip", () => {
  it("shows when the last event arrived", async () => {
    installFetch();
    render(<CrmEventsPage />);
    await screen.findByText(/last event/i);
    expect(screen.getByText(/1 hour/i)).toBeTruthy();
  });

  it("warns loudly when nothing has arrived recently", async () => {
    // The whole point of the strip: silence is the symptom of a broken rule.
    installFetch({ ...OVERVIEW, health: { lastReceivedAt: null, ageHours: null, stale: true } });
    render(<CrmEventsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/no (crm )?events/i);
  });

  it("warns when events have stopped, even though some exist", async () => {
    installFetch({
      ...OVERVIEW,
      health: { lastReceivedAt: "2026-10-01T11:00:00.000Z", ageHours: 300, stale: true },
    });
    render(<CrmEventsPage />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("counts", () => {
  it("shows a tile for every funnel stage, zeroes included", async () => {
    // A zero says that stage's rule is not firing, which is information.
    installFetch();
    render(<CrmEventsPage />);
    await screen.findByText(/registered/i);
    for (const label of [/lead/i, /registered/i, /verified/i, /live account/i, /first deposit/i]) {
      expect(screen.getAllByText(label).length, String(label)).toBeGreaterThan(0);
    }
    expect(screen.getByTestId("funnel-registered")).toHaveTextContent("12");
    expect(screen.getByTestId("funnel-lead")).toHaveTextContent("0");
  });

  it("shows sent and failed per destination", async () => {
    installFetch();
    render(<CrmEventsPage />);
    await screen.findByTestId("dest-meta");
    expect(screen.getByTestId("dest-meta")).toHaveTextContent("20");
    expect(screen.getByTestId("dest-meta")).toHaveTextContent("1");
    expect(screen.getByTestId("dest-whatsapp")).toHaveTextContent("10");
  });
});

describe("the events table", () => {
  it("lists events with all three statuses", async () => {
    installFetch();
    render(<CrmEventsPage />);
    await screen.findByText("88214");
    expect(screen.getByText("88215")).toBeTruthy();
    expect(screen.getByText(/http 400 Invalid parameter/)).toBeTruthy();
  });

  it("filters by stage", async () => {
    installFetch();
    render(<CrmEventsPage />);
    await screen.findByText("88214");

    fireEvent.change(screen.getByLabelText(/stage/i), { target: { value: "verified" } });

    await waitFor(() => expect(screen.queryByText("88214")).toBeNull());
    expect(screen.getByText("88215")).toBeTruthy();
  });

  it("filters to problems only", async () => {
    installFetch();
    render(<CrmEventsPage />);
    await screen.findByText("88214");

    fireEvent.click(screen.getByLabelText(/problems only/i));

    // 88215 has a failed Meta send; 88214 is clean.
    await waitFor(() => expect(screen.queryByText("88214")).toBeNull());
    expect(screen.getByText("88215")).toBeTruthy();
  });

  it("says so plainly when the window holds nothing", async () => {
    installFetch({ ...OVERVIEW, events: [] });
    render(<CrmEventsPage />);
    expect(await screen.findByText(/no events in this period/i)).toBeTruthy();
  });
});

describe("loading and failure", () => {
  it("reports a failed request instead of rendering empty tiles", async () => {
    installFetch({ error: "overview_failed" }, 500);
    render(<CrmEventsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);
  });

  it("sends the session token", async () => {
    const fn = installFetch();
    render(<CrmEventsPage />);
    await screen.findByText("88214");
    const [, init] = fn.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: expect.stringContaining("test.session.jwt") });
  });

  it("refetches when the window changes", async () => {
    const fn = installFetch();
    render(<CrmEventsPage />);
    await screen.findByText("88214");

    fireEvent.change(screen.getByLabelText(/period/i), { target: { value: "7" } });

    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(String(fn.mock.calls[1][0])).toContain("days=7");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/pages/settings/CrmEventsPage.test.tsx --reporter=verbose`
Expected: FAIL — cannot resolve `./CrmEventsPage`

- [ ] **Step 3: Write the page**

Create `src/pages/settings/CrmEventsPage.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { authHeaders } from "@/lib/auth";

const OVERVIEW_URL = "/api/crm-events/overview";

const STAGE_LABELS: Record<string, string> = {
  lead: "Lead",
  registered: "Registered",
  verified: "Verified",
  live_account: "Live account",
  first_deposit: "First deposit",
};

const DESTINATIONS = [
  ["meta", "Meta"],
  ["whatsapp", "WhatsApp"],
  ["brevo", "Brevo"],
] as const;

/** A status that means something needs attention, as opposed to one that is
 *  simply not applicable at this stage. */
const PROBLEM = new Set(["failed", "rejected", "invalid", "retrying"]);

type Counts = Record<string, number>;

type DestinationStatus = { status: string; detail: string | null; attempts: number };

type EventRow = {
  id: number;
  receivedAt: string;
  stage: string;
  crmClientId: string;
  name: string;
  email: string;
  phone: string;
  recordType: string;
  source: string;
  meta: DestinationStatus;
  whatsapp: DestinationStatus;
  brevo: DestinationStatus;
};

type Overview = {
  windowDays: number;
  health: { lastReceivedAt: string | null; ageHours: number | null; stale: boolean };
  funnel: Counts;
  destinations: Record<string, Counts>;
  events: EventRow[];
};

function describeAge(hours: number | null): string {
  if (hours === null) return "never";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes ago`;
  if (hours < 48) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function toneFor(status: string): string {
  if (status === "sent") return "text-emerald-600";
  if (PROBLEM.has(status)) return "text-red-600";
  return "text-slate-500";
}

export function CrmEventsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState("all");
  const [problemsOnly, setProblemsOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${OVERVIEW_URL}?days=${days}`, { headers: { ...authHeaders() } });
      if (!resp.ok) throw new Error(String(resp.status));
      setData((await resp.json()) as Overview);
    } catch {
      // The server's message can name internal schema, so it is not shown.
      setError("Could not load CRM events.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const all = data?.events ?? [];
    return all.filter((row) => {
      if (stage !== "all" && row.stage !== stage) return false;
      if (!problemsOnly) return true;
      return [row.meta, row.whatsapp, row.brevo].some((d) => PROBLEM.has(d.status));
    });
  }, [data, stage, problemsOnly]);

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">CRM Events</h1>
          <p className="text-sm text-slate-500">
            Every FXBO funnel webhook, and what we sent to Meta, WhatsApp and Brevo.
          </p>
        </div>
        <label className="text-sm">
          <span className="mr-2">Period</span>
          <select
            aria-label="Period"
            className="rounded border px-2 py-1"
            value={String(days)}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </label>
      </header>

      {error ? (
        <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {data?.health.stale ? (
        <div role="alert" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          {data.health.lastReceivedAt
            ? `No CRM events for ${describeAge(data.health.ageHours)}. A rule in FXBO may have stopped firing.`
            : "No CRM events received at all. Check that the FXBO rules exist and point at this endpoint."}
        </div>
      ) : null}

      {data && !data.health.stale ? (
        <p className="text-sm text-slate-600">
          Last event {describeAge(data.health.ageHours)}.
        </p>
      ) : null}

      {loading && !data ? <p className="text-sm text-slate-500">Loading…</p> : null}

      {data ? (
        <>
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Funnel</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {Object.entries(STAGE_LABELS).map(([key, label]) => (
                <div key={key} data-testid={`funnel-${key}`} className="rounded border bg-white p-3">
                  <div className="text-2xl font-semibold tabular-nums">{data.funnel[key] ?? 0}</div>
                  <div className="text-xs text-slate-500">{label}</div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Destinations</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {DESTINATIONS.map(([key, label]) => {
                const counts = data.destinations[key] ?? {};
                return (
                  <div key={key} data-testid={`dest-${key}`} className="rounded border bg-white p-3">
                    <div className="mb-1 text-sm font-medium">{label}</div>
                    <dl className="grid grid-cols-2 gap-x-3 text-sm">
                      {["sent", "failed", "rejected", "retrying", "skipped"].map((status) => (
                        <div key={status} className="flex justify-between">
                          <dt className={toneFor(status)}>{status}</dt>
                          <dd className="tabular-nums">{counts[status] ?? 0}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            <div className="mb-2 flex flex-wrap items-center gap-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Events</h2>
              <label className="text-sm">
                <span className="mr-2">Stage</span>
                <select
                  aria-label="Stage"
                  className="rounded border px-2 py-1"
                  value={stage}
                  onChange={(e) => setStage(e.target.value)}
                >
                  <option value="all">All stages</option>
                  {Object.entries(STAGE_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label="Problems only"
                  checked={problemsOnly}
                  onChange={(e) => setProblemsOnly(e.target.checked)}
                />
                Problems only
              </label>
            </div>

            {rows.length === 0 ? (
              <p className="text-sm text-slate-500">No events in this period.</p>
            ) : (
              <div className="overflow-x-auto rounded border bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="p-2 text-left">Received</th>
                      <th className="p-2 text-left">Stage</th>
                      <th className="p-2 text-left">CRM id</th>
                      <th className="p-2 text-left">Name</th>
                      <th className="p-2 text-left">Email</th>
                      <th className="p-2 text-left">Phone</th>
                      <th className="p-2 text-left">Form</th>
                      <th className="p-2 text-left">Meta</th>
                      <th className="p-2 text-left">WhatsApp</th>
                      <th className="p-2 text-left">Brevo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id} className="border-t align-top">
                        <td className="p-2 whitespace-nowrap">{row.receivedAt}</td>
                        <td className="p-2">{STAGE_LABELS[row.stage] ?? row.stage}</td>
                        <td className="p-2">{row.crmClientId}</td>
                        <td className="p-2">{row.name}</td>
                        <td className="p-2">{row.email}</td>
                        <td className="p-2">{row.phone}</td>
                        <td className="p-2">{row.source}</td>
                        {DESTINATIONS.map(([key]) => {
                          const d = row[key];
                          return (
                            <td key={key} className="p-2">
                              <span className={`font-medium ${toneFor(d.status)}`}>{d.status}</span>
                              {d.detail ? <div className="text-xs text-slate-500">{d.detail}</div> : null}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Register the route**

In `src/App.tsx`, beside the other settings imports:

```tsx
const CrmEventsPage = lazy(() => import("./pages/settings/CrmEventsPage").then((m) => ({ default: m.CrmEventsPage })));
```

and in the `SETTINGS_PAGES` map, after `alerts`:

```tsx
  "crm-events": CrmEventsPage,
```

- [ ] **Step 5: Add the menu entry**

In `src/lib/permissions.ts`, after the `client-account-monitor` entry:

```ts
  // Sits under the alert pages: like them, its job is to make a silent
  // failure visible -- here, an FXBO rule that has stopped firing.
  { key: "crm-events", name: "CRM Events", path: "/settings/crm-events", icon: "Share2", group: "core", requiredPermissions: ["Settings"] },
```

The route is gated by the same rule as the menu (`canAccessSettingsItem`), so
this entry is what makes the page reachable at all — without it the URL 404s
even for an admin.

- [ ] **Step 6: Run the tests and the type check**

Run: `npx vitest run src/pages/settings/CrmEventsPage.test.tsx --reporter=verbose`
Expected: PASS — every `it` block written in the test step above, none added and none removed. There is deliberately no count here: this plan's prose counts have been wrong before, and the test file is the authority.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/pages/settings/CrmEventsPage.tsx src/pages/settings/CrmEventsPage.test.tsx \
        src/App.tsx src/lib/permissions.ts
git commit -m "CRM events: a settings tab showing health, funnel and per-destination status"
```

---

## Task 11: Configuration and module documentation

**Files:**
- Modify: `.env.example`
- Create: `crmSignup/README.md`

- [ ] **Step 1: Document the variables**

Append to `.env.example`:

```
# --- CRM events webhook (FXBO funnel -> Meta CAPI + WhatsApp + Brevo) ---
# Required. The endpoint rejects every request when this is unset.
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CRM_WEBHOOK_SECRET=
# Meta Conversions API. Unset token means Meta is skipped silently.
META_DATASET_ID=692517170017822
META_CAPI_ACCESS_TOKEN=
META_API_VERSION=v26.0
# Set while testing so events land under Test events and touch no real data.
# UNSET THIS IN PRODUCTION.
META_TEST_EVENT_CODE=
# WhatsApp. Unset key means WhatsApp is skipped silently.
WA_API_KEY=
WA_TEMPLATE_NAME=registration_client_v3
WA_TEMPLATE_LANGUAGE=en
WA_TEMPLATE_BODY_PARAM=https://skylinkscapital.com/en/login/
WA_TEMPLATE_BUTTON_URL=https://skylinkscapital.com/en/login/
WA_FROM_NUMBER=+971507192185
WA_MAX_ATTEMPTS=3
# Brevo. BREVO_API_KEY is already set for the alert emails and the same key
# covers Contacts. 19 is the "All Clients" list.
BREVO_LIST_ID=19
# Comma-separated %custom_formname% values never sent a WhatsApp message.
# This does NOT gate Meta or Brevo.
SKIP_SOURCES=
# The retry sweeper.
CRM_EVENTS_WORKER_ENABLED=true
CRM_EVENTS_WORKER_INTERVAL_SECONDS=60
```

- [ ] **Step 2: Write the module README**

Create `crmSignup/README.md`:

```markdown
# crmSignup

Receives FXBO webhooks at five points in the client funnel, stores each once,
then independently sends a Meta Conversions API event, a DoubleTick WhatsApp
welcome, and a Brevo contact.

Design: `../docs/superpowers/specs/2026-10-09-crm-signup-webhook-design.md`

## Routes

| Route | Guard |
|---|---|
| `POST /api/crm-events` | `CRM_WEBHOOK_SECRET` in the `Authorization` header. On the `PUBLIC_API_ROUTES` allow-list because FXBO cannot carry a session. |
| `GET /api/crm-events/overview` | `authRequired` + `adminOnly`. Feeds the settings tab. |

The stage is a **body parameter**, not a path segment, and all five rules post
to the one path. `auth/requireSession.js` matches its allow-list against actual
request paths, so a `:stage` pattern would never match; and the list is capped
at six entries by `auth/routeCoverage.test.js`.

## Five things that are easy to get wrong

**A 2xx from DoubleTick does not mean the message was sent.** It means the
request was accepted. The outcome is `messages[0].status`, and `FAILED ERROR
REJECTED UNDELIVERED UNDELIVERABLE INVALID` all mean it failed.

**`fbc` is not the raw `fbclid`,** and its timestamp must be **frozen**. Meta
wants `fb.1.<ms>.<fbclid>`. It is assembled once, at whichever stage arrives
first, and stored — recomputing it per stage hands Meta a different click
identity for the same person at each step, with no error anywhere.

**Meta's `em` and `ph` are SHA-256 of the *normalised* value** — email
lowercased and trimmed, phone digits only. Hashing raw input produces a hash
Meta cannot match, and reports no problem.

**The handler never returns 5xx because a provider failed.** It answers 200 the
moment the row is stored. A 5xx makes FXBO redeliver an event we already hold,
and FXBO has its own retry engine (up to 12 attempts) on top of ours.

**Retries live in the `*_next_attempt_at` columns, never in a timer.** node-cron
and `setTimeout` die with the IIS worker on this host, and a lost five-minute
timer leaves a row stuck at `retrying` forever.

## Attributes

Nine Brevo attributes were created for this on 2026-10-09: `MIDDLE_NAME`,
`ENTITY`, `FORM_NAME`, `LANGUAGE`, `IS_IB`, `UTM_SOURCE`, `UTM_MEDIUM`,
`UTM_CAMPAIGN`, `REFERER`. Two existing ones are reused rather than duplicated:
`EXT_ID` for the CRM client id and `OPT_IN` for marketing consent. Posting an
attribute Brevo does not know returns 400, classified permanent — so a new
field needs the attribute created in Brevo first.
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, including the pre-existing suites.

- [ ] **Step 4: Lint**

Run: `npx eslint crmSignup/ src/pages/settings/CrmEventsPage.tsx`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add .env.example crmSignup/README.md
git commit -m "CRM events: document the configuration and the five easy mistakes"
```

---

## Task 12: Deployment and cutover (manual, outside this repo)

These change live systems. Each needs the account owner present.

- [ ] **Step 1: Set the environment variables on the server**

There is no `.env` in the repo. Add the Task 10 block wherever the existing
variables live (Plesk → Node.js → Custom environment variables), then recycle.
Generate the secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Generate the Meta token at Events Manager → the CRM implementation guide →
**Generate Access Token**. This also rotates the exposed token currently stored
inside FXBO.

**Set `META_TEST_EVENT_CODE` now**, so the first real traffic lands under Test
events and touches no production data.

- [ ] **Step 2: Deploy and confirm the table exists**

`server.js` is in the app root, so iisnode's `watchedFiles` covers it. After the
recycle the startup log should carry `[crm-events] worker started (interval=60s)`.
If not, `initCrmSignupStore()` threw — check `AUTH_DB_*`.

- [ ] **Step 3: Allow-list the endpoint in the CRM**

*CRM Configuration → Advanced → System Configuration → Assistant Webhooks List.*
Add `https://app.skylinkscapital.com/api/crm-events`. It cannot be selected in a
rule until it appears here; today the list holds only two URLs.

- [ ] **Step 4: Create the rules**

*Configuration → Assistant → Rules → Add New Rule.* Method `Outcoming webhook`,
POST. Leave rules 25, 42 and 11 untouched — add new rules beside them.

| Stage | Event (dropdown wording) |
|---|---|
| `registered` | `Client registered` |
| `verified` | `A client has been verified` |
| `live_account` | `Client opened new live account` |
| `first_deposit` | `First time deposit by client` |
| `lead` | **Blocked** — no creation trigger exists. The dropdown offers only `A new lead has been assigned to you` and `A lead has been assigned to other manager`, both assignment. Ask FXBO, or accept lead-assignment as a proxy knowing it fires late and not for every lead. |

Header on every rule: `Authorization` = the `CRM_WEBHOOK_SECRET` value. **Not a
query string** — the existing `hook.php` mirrors put their secret in the URL,
where it is visible in Webhook Stats and every proxy log.

Parameters on every rule, all Type `string`. The first one is a **literal you
type**, not a placeholder:

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

Delivery & Retry: **"Update parameters' values on retry" OFF** (a redelivery
must carry an identical payload or our dedupe reasons about a different event),
and **401 excluded from the retry error codes** (retrying a rejected secret
never succeeds).

- [ ] **Step 5: Confirm what `%client_is_lead%` actually contains**

Press a rule's **Test webhook** button. The press is recognised and stored as
`invalid` (Task 7), so it creates no contact and posts no conversion — read
`raw_payload` on that row to see exactly what FXBO sends. Then register one real
test client and read `raw_payload` again for the real value. If it is not one of
`0 false no n off`, add the real literal to `FALSY` in `crmSignup/normalise.js`;
until then every client is treated as a lead and gets no WhatsApp.

- [ ] **Step 6: Build the frontend, or the settings tab will not appear**

On the server: `npm ci && npm run build`, then recycle.

This is not optional and not automatic. Verified on 2026-10-13: the deployed
bundle was built 2026-10-01 13:39, while that day's two frontend commits landed
at 16:24 — so the last build predates them. Nothing rebuilds on push.

Use `npm run build` (`scripts/build.mjs`, unhashed `assets/index.js`), **not**
`npx vite build`, which emits hashed filenames the server's `index.html` does
not reference.

Confirm with: `curl -sI https://app.skylinkscapital.com/assets/index.js | grep -i last-modified`

- [ ] **Step 7: Acceptance test**

1. Meta events appear under **Test events** within minutes.
2. One real registration: the WhatsApp message **arrives on a handset** — not
   merely a 200 from us, and not merely a 2xx from DoubleTick.
   Then check the row's `whatsapp_status` reads `sent`. A `rejected` row beside a
   message that visibly arrived means DoubleTick returned a success value outside
   our allowlist of `SENT` / `ENQUEUED` — the detail column names it, and it
   needs adding. This is the designed way to discover a third value: loud and
   immediate, rather than silently counted as a success forever.
3. The contact appears in Brevo list 19 with `EXT_ID` and `OPT_IN` populated.
4. Re-posting the identical webhook sends no second message and creates no
   second row.
5. The same client at a different stage creates a new row and reuses the stored
   `fbc` — check the two rows carry the identical value.

- [ ] **Step 8: Unset the test event code and go live**

Remove `META_TEST_EVENT_CODE` and recycle. Events then appear in Events Manager
within an hour, and Diagnostics reports any errors Meta finds.

- [ ] **Step 9: Switch off the duplicate senders**

Until these are done, every website signup produces two WhatsApp messages and
two Meta conversions:

1. **The `slc-crm` WordPress plugin** (`D:\Signup\Signup 2.0\slc-crm`): remove
   the DoubleTick send and the `CompleteRegistration` pixel event. Keep the
   forms, the CRM record creation with `utmParams` and `full_link`, and the
   pixel's `PageView` and `InitiateCheckout`.
2. **FXBO's own Meta integration**, once this is confirmed live.
3. **The Lovable promo pages** must not add conversion events for either step.

- [ ] **Step 10: Hand the promo-page fix to that team**

Not our change, but this integration is incomplete without it: the promo pages
put the landing URL in a custom field named `Website`, and the CRM's ClickID
rule reads `full_link` inside `utmParams` instead. All ~250 existing promo leads
therefore have an empty ClickID and cannot be attributed. The fix is the same
URL-encoded `utmParams` pattern the WordPress plugin already uses, on every
promo page and form.

---

## Self-Review

**Spec coverage.** §1 → Task 11 steps 3-4. §2 → Tasks 1, 2 and Task 11 step 4's
parameter table. §3 → Tasks 1, 3, 4, 5 (the stage gates). §4 → Tasks 5, 11
step 9. §5 → the File Structure table. §6 → Task 6. §7 → Tasks 7, 8. §8 →
Tasks 3, 4, 5. §9 → Task 7. §10 → Task 7 steps 1, 3, 4. §11 → Task 11 step 5.
§12 → Tasks 9, 10. §13 → Task 10. §14 → the tests in Tasks 1-10 plus Task 11
step 7. §15 → Task 11. §16 → not built; Task 11 step 10 hands the promo fix on
rather than doing it.

**Spec requirements deliberately altered,** recorded under Global Constraints:
the single `attempts`/`next_attempt_at` pair is split three ways; an empty
`%client_is_lead%` resolves to lead; the stage travels in the body rather than
the path, for the allow-list reason given there; `Purchase` carries no value or
currency; and the verified stage sends the custom event `Client_Verified`
rather than the standard `SubmitApplication`.

**Still blocked, stated rather than assumed:** the `lead` stage's FXBO trigger.
Task 11 step 4 marks that rule blocked; no code depends on it, because the
endpoint takes the stage as a parameter.

**Spec requirement not met by any task:** none.

**Type consistency.** `Fields` keys are produced by `normaliseEvent` (Task 1),
reproduced by `rowToFields` (Task 9), and consumed by `buildBrevoContact`
(Task 5) — the same camelCase names in all three, `stage` included. All three
classifiers return `{ status, retryable, detail }`, with `messageId` on the
WhatsApp one only. `planRetry` consumes `retryable` and `status` (as
`finalStatus`) and returns `{ status, attempts, nextAttemptAt }`; the store
writers take exactly that plus each step's `detail`. `deriveFbc` (Task 2) is
called only in Task 8 and its result is passed verbatim through
`insertSignupEvent` → the `fbc` column → `buildMetaPayload` (Task 3), never
recomputed. `pickDeposit` (Task 7) returns `{ amount, currency }`, which is what
`updateDepositAmount` (Task 6) and `buildMetaPayload`'s `value`/`currency` both
expect.
