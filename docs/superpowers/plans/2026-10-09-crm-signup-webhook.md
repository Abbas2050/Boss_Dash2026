# CRM Signup Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive FXBO's `Client registered` webhook, store it once, then independently send a DoubleTick WhatsApp welcome and upsert the person into Brevo list 19.

**Architecture:** A `crmSignup/` module following the existing `docusign/` pattern — pure helpers tested directly, a thin MySQL store, a route handler registered in `server.js`, and a `setInterval` sweeper that drives retries off database columns rather than in-memory timers. The HTTP handler does four things only: authenticate, normalise, store, respond 200. Everything else happens in the worker.

**Tech Stack:** Node ESM (`"type": "module"`), Express, `mysql2/promise`, global `fetch`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-crm-signup-webhook-design.md`

## Global Constraints

- **ESM only.** Every relative import carries its `.js` extension. No `require`.
- **Backend tests start with `// @vitest-environment node`** on line 1. The project default is `jsdom` (`vite.config.ts`), which breaks Node-only tests.
- **Never boot Express in a test.** Importing `server.js` opens a real listener and a database pool. Test handlers directly with a fake `res` (the pattern in `reports/reportScheduleRoute.test.js`), and verify route registration by reading `server.js` source (the pattern in `auth/routeCoverage.test.js`).
- **Never log `WA_API_KEY`, `BREVO_API_KEY`, or `CRM_WEBHOOK_SECRET`.** Not on failure, not in a thrown error, not truncated.
- **Never log a full phone number or email address.** Use `maskPhone` / `maskEmail` from Task 1 everywhere — logs, stored `_detail` columns, admin view.
- **No exception escapes the handler or the worker.** Every path ends in a stored status.
- **Return 200 once the row is stored.** Never 5xx because a provider failed — that makes FXBO redeliver an event we already hold.
- **Retries live in database columns, never `setTimeout`.** node-cron and in-process timers die with the IIS worker on this host.
- **Run a single test file with:** `npx vitest run <path> --reporter=verbose`
- **Run the full suite with:** `npm test`

### Two corrections to the spec, applied in this plan

1. **`attempts` and `next_attempt_at` are split per action** into `whatsapp_attempts` / `whatsapp_next_attempt_at` and `brevo_attempts` / `brevo_next_attempt_at`. The spec inherited a single pair from the brief, but one shared counter cannot carry two independent retry schedules — a WhatsApp retry would move Brevo's clock and the spec's own "the two actions never block each other" would be false.
2. **An empty `%client_is_lead%` means lead, not client.** Spec §2 lists `""` among the client-meaning literals. It should not be: absent and empty are *unknown*, and the spec's own argument ("a lead who receives a login link for an account that does not exist is a complaint") makes unknown resolve to lead.

### Reason strings — exact, lowercase, no trailing stop

`lead, not client` · `invalid phone number` · `source excluded` · `whatsapp not configured` · `brevo not configured` · `test record`

---

## File Structure

| File | Responsibility |
|---|---|
| `crmSignup/normalise.js` | Pure. Raw FXBO body → normalised fields + validity verdict. Masking helpers. |
| `crmSignup/normalise.test.js` | Tests for the above. |
| `crmSignup/whatsapp.js` | DoubleTick payload builder, skip decision, outcome classifier (all pure) + the send. |
| `crmSignup/whatsapp.test.js` | Tests for the pure three. |
| `crmSignup/brevo.js` | Contact builder, outcome classifier (pure) + the upsert. |
| `crmSignup/brevo.test.js` | Tests for the pure two. |
| `crmSignup/store.js` | MySQL: schema, insert-if-absent, status updates, claim-due, list-recent. |
| `crmSignup/store.test.js` | Schema assertions + pure row builders. |
| `crmSignup/router.js` | `makeCrmSignupHandler` — auth, normalise, store, 200. |
| `crmSignup/router.test.js` | Auth and handler-contract tests. |
| `crmSignup/worker.js` | `planRetry`, `processSignupEvent`, `startCrmSignupWorker`. |
| `crmSignup/worker.test.js` | Retry planning and independence tests. |
| `crmSignup/adminRoute.js` | `makeCrmSignupAdminHandler` — server-rendered recent-events table. |
| `crmSignup/adminRoute.test.js` | Gate + masking tests. |
| `server.js` | Register the two routes, init the store, start the worker. |
| `auth/requireSession.js` | Add `POST /api/crm-signup` to `PUBLIC_API_ROUTES`. |
| `.env.example` | Document the new variables. |

---

## Task 1: Normalisation and masking

**Files:**
- Create: `crmSignup/normalise.js`
- Test: `crmSignup/normalise.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PHONE_RE: RegExp`
  - `REQUIRED_FIELDS: string[]`
  - `isFalsyLiteral(value: unknown): boolean`
  - `deriveRecordType(isLead: unknown): "client" | "lead"`
  - `deriveMiddleName(fullName, firstName, lastName): string`
  - `maskEmail(email: unknown): string`
  - `maskPhone(phone: unknown): string`
  - `normaliseSignup(raw: object): { valid: boolean, missing: string[], fields: Fields }`
  - `Fields` keys: `crmClientId, firstName, middleName, lastName, email, phone, recordType, marketingConsent, source, entity, isIb, language, utmSource, utmMedium, utmCampaign, referer, fxboUniqueId`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/normalise.test.js`:

```js
// @vitest-environment node
//
// The payload decisions that are easy to get wrong and expensive when wrong.
//
// Nothing here touches the network or a database: these are the pure functions
// the router and the worker both lean on.
import { describe, it, expect } from "vitest";
import {
  PHONE_RE,
  isFalsyLiteral,
  deriveRecordType,
  deriveMiddleName,
  maskEmail,
  maskPhone,
  normaliseSignup,
} from "./normalise.js";

describe("phone validation", () => {
  it("accepts both ends of the permitted length range", () => {
    expect(PHONE_RE.test("+12345678")).toBe(true); // 8 digits, the minimum
    expect(PHONE_RE.test("+123456789012345")).toBe(true); // 15, the maximum
    expect(PHONE_RE.test("+971507192185")).toBe(true);
  });

  it("rejects one digit either side of the range", () => {
    expect(PHONE_RE.test("+1234567")).toBe(false);
    expect(PHONE_RE.test("+1234567890123456")).toBe(false);
  });

  it("rejects a leading zero, a missing plus, and spacing", () => {
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

  it("reads anything truthy as a lead", () => {
    for (const v of ["1", "true", "yes", "Y"]) {
      expect(deriveRecordType(v), v).toBe("lead");
    }
  });

  it("reads absent, empty and unrecognised as a lead", () => {
    // The asymmetry is deliberate. A client who misses a welcome message is a
    // support ticket; a lead who gets a login link for an account that does
    // not exist is a complaint. FXBO's real literals are still unconfirmed, so
    // anything we do not recognise must land on the safe side.
    expect(deriveRecordType(undefined)).toBe("lead");
    expect(deriveRecordType("")).toBe("lead");
    expect(deriveRecordType("maybe")).toBe("lead");
  });
});

describe("isFalsyLiteral", () => {
  it("treats empty as falsy for ordinary flags", () => {
    // Consent and is-IB legitimately default to false when absent; only
    // deriveRecordType needs empty to mean "unknown".
    expect(isFalsyLiteral("")).toBe(true);
    expect(isFalsyLiteral(undefined)).toBe(true);
    expect(isFalsyLiteral("1")).toBe(false);
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
    // If the full name does not bracket first...last, we cannot tell which
    // part is the middle, and a wrong middle name is worse than none.
    expect(deriveMiddleName("John Smith Jones", "Bob", "Jones")).toBe("");
    expect(deriveMiddleName("John Smith Jones", "John", "Brown")).toBe("");
  });

  it("is not confused by case or extra spacing", () => {
    expect(deriveMiddleName("  ali   hassan   khan ", "Ali", "KHAN")).toBe("hassan");
  });
});

describe("masking", () => {
  it("never leaves the full address or number in the output", () => {
    const email = "abbas.rahman@skylinkscapital.com";
    const phone = "+971507192185";
    expect(maskEmail(email)).not.toContain("abbas.rahman");
    expect(maskPhone(phone)).not.toBe(phone);
    expect(maskPhone(phone)).not.toContain("7192185");
  });

  it("keeps enough to identify a record by eye", () => {
    expect(maskEmail("abbas@skylinkscapital.com")).toBe("a***@skylinkscapital.com");
    expect(maskPhone("+971507192185")).toBe("+971***85");
  });

  it("handles empty and malformed input without throwing", () => {
    expect(maskEmail("")).toBe("");
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskPhone("")).toBe("");
    expect(maskPhone("+123")).toBe("***");
  });
});

describe("normaliseSignup", () => {
  const RAW = {
    client_id: "88214",
    first_name: "Ali",
    last_name: "Khan",
    full_name: "Ali Hassan Khan",
    email: "  Ali.Khan@Example.COM ",
    phone: "+971507192185",
    is_lead: "0",
    marketing_consent: "1",
    source: "NEW_SIGNUP",
    entity: "SVG",
    is_ib: "0",
    language: "en",
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "gulf-q4",
    referer: "https://skylinkscapital.com/en/",
    unique_id: "d3f1-aa",
  };

  it("maps a complete payload", () => {
    const { valid, missing, fields } = normaliseSignup(RAW);
    expect(valid).toBe(true);
    expect(missing).toEqual([]);
    expect(fields).toEqual({
      crmClientId: "88214",
      firstName: "Ali",
      middleName: "Hassan",
      lastName: "Khan",
      email: "ali.khan@example.com",
      phone: "+971507192185",
      recordType: "client",
      marketingConsent: true,
      source: "NEW_SIGNUP",
      entity: "SVG",
      isIb: false,
      language: "en",
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "gulf-q4",
      referer: "https://skylinkscapital.com/en/",
      fxboUniqueId: "d3f1-aa",
    });
  });

  it("names every missing required field", () => {
    const { valid, missing } = normaliseSignup({ ...RAW, client_id: "", email: "  " });
    expect(valid).toBe(false);
    expect(missing).toEqual(["crmClientId", "email"]);
  });

  it("does not treat a missing phone as invalid", () => {
    // A bad phone is a WhatsApp skip, not a bad event: Brevo does not need it.
    const { valid, fields } = normaliseSignup({ ...RAW, phone: "" });
    expect(valid).toBe(true);
    expect(fields.phone).toBe("");
  });

  it("defaults absent flags to false and never throws on an empty body", () => {
    const { valid, missing, fields } = normaliseSignup({});
    expect(valid).toBe(false);
    expect(missing).toEqual(["crmClientId", "firstName", "email"]);
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
 * Everything here is pure. The two decisions worth reading twice are the
 * record type (which gates whether anyone gets a WhatsApp message at all) and
 * the middle name (which FXBO has no placeholder for, so it is derived).
 */

/** E.164: a plus, a non-zero leading digit, then 7 to 14 more. 8-15 digits. */
export const PHONE_RE = /^\+[1-9]\d{7,14}$/;

/** Without these three there is nothing to dedupe on, nothing to greet, and
 *  nothing to create in Brevo. A missing phone is NOT fatal -- it is a
 *  WhatsApp skip, and Brevo never sees the phone anyway. */
export const REQUIRED_FIELDS = ["crmClientId", "firstName", "email"];

const FALSY = new Set(["", "0", "false", "no", "n", "off", "null", "undefined"]);

const text = (v) => String(v ?? "").trim();

export function isFalsyLiteral(value) {
  return FALSY.has(text(value).toLowerCase());
}

/**
 * Lead or client.
 *
 * Only a RECOGNISED falsy literal makes a client. Absent, empty and anything
 * unrecognised all resolve to "lead", which is the side that cannot cause
 * harm: the welcome message links to a login page, and a lead has no account
 * to log into. FXBO's actual literals are confirmed by the first live
 * delivery, not assumed here.
 */
export function deriveRecordType(isLead) {
  const v = text(isLead).toLowerCase();
  if (v === "") return "lead";
  return FALSY.has(v) ? "client" : "lead";
}

/**
 * FXBO has no middle-name placeholder, so it comes out of the full name.
 *
 * Conservative by design: the full name must genuinely begin with the first
 * name and end with the last, otherwise we cannot say which part is the
 * middle and return nothing. A wrong middle name is worse than none.
 */
export function deriveMiddleName(fullName, firstName, lastName) {
  const parts = text(fullName).split(/\s+/).filter(Boolean);
  if (parts.length < 3) return "";
  if (parts[0].toLowerCase() !== text(firstName).toLowerCase()) return "";
  if (parts[parts.length - 1].toLowerCase() !== text(lastName).toLowerCase()) return "";
  return parts.slice(1, -1).join(" ");
}

export function maskEmail(email) {
  const v = text(email);
  if (!v) return "";
  const at = v.indexOf("@");
  if (at < 1) return "***";
  return `${v.slice(0, 1)}***${v.slice(at)}`;
}

export function maskPhone(phone) {
  const v = text(phone);
  if (!v) return "";
  if (v.length < 8) return "***";
  return `${v.slice(0, 4)}***${v.slice(-2)}`;
}

export function normaliseSignup(raw = {}) {
  const body = raw && typeof raw === "object" ? raw : {};
  const firstName = text(body.first_name);
  const lastName = text(body.last_name);

  const fields = {
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
    fxboUniqueId: text(body.unique_id),
  };

  const missing = REQUIRED_FIELDS.filter((key) => !fields[key]);
  return { valid: missing.length === 0, missing, fields };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run crmSignup/normalise.test.js --reporter=verbose`
Expected: PASS, 17 tests

- [ ] **Step 5: Commit**

```bash
git add crmSignup/normalise.js crmSignup/normalise.test.js
git commit -m "CRM signup: normalise one FXBO body into the fields we use"
```

---

## Task 2: WhatsApp payload, skip decision, outcome classifier

**Files:**
- Create: `crmSignup/whatsapp.js`
- Test: `crmSignup/whatsapp.test.js`

**Interfaces:**
- Consumes: `PHONE_RE` from `crmSignup/normalise.js`.
- Produces:
  - `WHATSAPP_FAILURE_STATUSES: string[]`
  - `DOUBLETICK_TEMPLATE_URL: string`
  - `parseSkipSources(raw: string): Set<string>`
  - `decideWhatsappSkip({ apiKey, recordType, source, phone, skipSources }): { reason: string } | null`
  - `buildWhatsappPayload({ templateName, language, firstName, bodyParam, buttonUrl, from, to, messageId }): object`
  - `classifyWhatsappOutcome({ transportError, httpStatus, body }): { status, retryable, detail, messageId }`
  - `sendWhatsappTemplate({ fetchImpl, apiKey, payload }): Promise<classifyWhatsappOutcome result>`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/whatsapp.test.js`:

```js
// @vitest-environment node
//
// The WhatsApp half, and specifically the trap in it: DoubleTick answers 200
// to a message it then rejects. The HTTP status says the request was accepted.
// messages[0].status says what happened to the message. Only the second one is
// the outcome.
import { describe, it, expect, vi } from "vitest";
import {
  WHATSAPP_FAILURE_STATUSES,
  parseSkipSources,
  decideWhatsappSkip,
  buildWhatsappPayload,
  classifyWhatsappOutcome,
  sendWhatsappTemplate,
} from "./whatsapp.js";

const SKIP_NONE = new Set();

describe("skip decisions", () => {
  const base = {
    apiKey: "k",
    recordType: "client",
    source: "NEW_SIGNUP",
    phone: "+971507192185",
    skipSources: SKIP_NONE,
  };

  it("sends for a client with a valid phone from an allowed source", () => {
    expect(decideWhatsappSkip(base)).toBeNull();
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
    expect(decideWhatsappSkip({ ...base, phone: "" })).toEqual({
      reason: "invalid phone number",
    });
  });

  it("skips an excluded source, case-insensitively", () => {
    const skipSources = parseSkipSources("CSV_UPLOAD, manual ,import");
    expect(decideWhatsappSkip({ ...base, source: "manual", skipSources })).toEqual({
      reason: "source excluded",
    });
    expect(decideWhatsappSkip({ ...base, source: "csv_upload", skipSources })).toEqual({
      reason: "source excluded",
    });
    expect(decideWhatsappSkip({ ...base, source: "NEW_SIGNUP", skipSources })).toBeNull();
  });

  it("skips silently when no API key is configured", () => {
    expect(decideWhatsappSkip({ ...base, apiKey: "" })).toEqual({
      reason: "whatsapp not configured",
    });
  });

  it("reports the configuration skip before anything about the client", () => {
    // An unconfigured environment is our problem, not a fact about the lead.
    expect(decideWhatsappSkip({ ...base, apiKey: "", recordType: "lead" })).toEqual({
      reason: "whatsapp not configured",
    });
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
    // to reject the message, and nesting them wrong is the same as omitting.
    const message = payload.messages[0];
    expect(message.from).toBeTruthy();
    expect(message.messageId).toBeTruthy();
    expect(payload.from).toBeUndefined();
    expect(payload.messageId).toBeUndefined();
  });
});

describe("classifyWhatsappOutcome", () => {
  const ok = { messages: [{ status: "SENT", messageId: "m-1" }] };

  it("treats a 2xx with a healthy status as sent", () => {
    expect(classifyWhatsappOutcome({ httpStatus: 200, body: ok })).toEqual({
      status: "sent",
      retryable: false,
      detail: "SENT",
      messageId: "m-1",
    });
  });

  it("treats a 2xx carrying any failure status as rejected and permanent", () => {
    // This is the whole point of the module. A 2xx is acceptance of the
    // REQUEST. Retrying will produce the same rejection and burn an attempt.
    for (const status of WHATSAPP_FAILURE_STATUSES) {
      const result = classifyWhatsappOutcome({
        httpStatus: 200,
        body: { messages: [{ status }] },
      });
      expect(result.status, status).toBe("rejected");
      expect(result.retryable, status).toBe(false);
    }
  });

  it("matches failure statuses regardless of case", () => {
    const result = classifyWhatsappOutcome({
      httpStatus: 200,
      body: { messages: [{ status: "uNdElIvErAbLe" }] },
    });
    expect(result.status).toBe("rejected");
    expect(result.retryable).toBe(false);
  });

  it("retries a transport error", () => {
    const result = classifyWhatsappOutcome({ transportError: new Error("ECONNRESET") });
    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(true);
  });

  it("retries 429 and every 5xx", () => {
    for (const httpStatus of [429, 500, 502, 503, 504]) {
      expect(classifyWhatsappOutcome({ httpStatus, body: {} }).retryable, String(httpStatus)).toBe(true);
    }
  });

  it("does not retry any other non-2xx", () => {
    for (const httpStatus of [400, 401, 403, 404, 422]) {
      const result = classifyWhatsappOutcome({ httpStatus, body: {} });
      expect(result.retryable, String(httpStatus)).toBe(false);
      expect(result.status, String(httpStatus)).toBe("rejected");
    }
  });

  it("refuses to call a 2xx with no message status a success", () => {
    const result = classifyWhatsappOutcome({ httpStatus: 200, body: {} });
    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(false);
    expect(result.detail).toMatch(/no message status/i);
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
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.method).toBe("POST");
  });

  it("turns a thrown fetch into a retryable outcome rather than an exception", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    });

    const result = await sendWhatsappTemplate({ fetchImpl, apiKey: "k", payload: {} });

    expect(result.retryable).toBe(true);
    expect(result.status).toBe("failed");
  });

  it("survives a response body that is not JSON", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token <");
      },
    }));

    const result = await sendWhatsappTemplate({ fetchImpl, apiKey: "k", payload: {} });

    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(false);
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

/**
 * A 2xx from DoubleTick means the REQUEST was accepted. These are the
 * messages[0].status values that mean the MESSAGE was not. Compared
 * case-insensitively.
 */
export const WHATSAPP_FAILURE_STATUSES = [
  "FAILED",
  "ERROR",
  "REJECTED",
  "UNDELIVERED",
  "UNDELIVERABLE",
  "INVALID",
];

const FAILURE_SET = new Set(WHATSAPP_FAILURE_STATUSES);

export function parseSkipSources(raw) {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Whether to send at all, and why not.
 *
 * Configuration is checked first: an unset key is our problem and should not
 * be reported as a fact about the client.
 */
export function decideWhatsappSkip({ apiKey, recordType, source, phone, skipSources }) {
  if (!String(apiKey ?? "").trim()) return { reason: "whatsapp not configured" };
  if (recordType !== "client") return { reason: "lead, not client" };
  const sources = skipSources instanceof Set ? skipSources : parseSkipSources(skipSources);
  if (sources.has(String(source ?? "").trim().toLowerCase())) return { reason: "source excluded" };
  if (!PHONE_RE.test(String(phone ?? ""))) return { reason: "invalid phone number" };
  return null;
}

/**
 * Every field below is required by the approved template. `from` and
 * `messageId` sit beside `content` inside the message, not at the top level,
 * and omitting either is on its own enough for the provider to reject.
 */
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

  if (code === 429 || code >= 500) {
    return { status: "failed", retryable: true, detail: `http ${code}`, messageId: null };
  }

  if (code < 200 || code >= 300) {
    // Anything else -- a bad key, an unapproved template, a malformed body --
    // will fail identically on every retry.
    return { status: "rejected", retryable: false, detail: `http ${code}`, messageId: null };
  }

  const message = Array.isArray(body?.messages) ? body.messages[0] : null;
  const status = String(message?.status ?? "").trim();

  if (!status) {
    return {
      status: "failed",
      retryable: false,
      detail: "no message status in a 2xx response",
      messageId: message?.messageId ?? null,
    };
  }

  if (FAILURE_SET.has(status.toUpperCase())) {
    return {
      status: "rejected",
      retryable: false,
      detail: status,
      messageId: message?.messageId ?? null,
    };
  }

  return {
    status: "sent",
    retryable: false,
    detail: status,
    messageId: message?.messageId ?? null,
  };
}

/**
 * Never throws. Every failure comes back as a classified outcome so the caller
 * has exactly one code path.
 */
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
    return classifyWhatsappOutcome({ transportError });
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
Expected: PASS, 17 tests

- [ ] **Step 5: Commit**

```bash
git add crmSignup/whatsapp.js crmSignup/whatsapp.test.js
git commit -m "CRM signup: WhatsApp payload, skip rules, and the 2xx-is-not-sent classifier"
```

---

## Task 3: Brevo contact and outcome classifier

**Files:**
- Create: `crmSignup/brevo.js`
- Test: `crmSignup/brevo.test.js`

**Interfaces:**
- Consumes: the `Fields` shape from `crmSignup/normalise.js`.
- Produces:
  - `BREVO_CONTACTS_URL: string`
  - `buildBrevoContact(fields, { listId }): object`
  - `classifyBrevoOutcome({ transportError, httpStatus, body }): { status, retryable, detail }`
  - `upsertBrevoContact({ fetchImpl, apiKey, contact }): Promise<classifyBrevoOutcome result>`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/brevo.test.js`:

```js
// @vitest-environment node
//
// Brevo takes a fixed set of attributes, every one of which had to be created
// in the Brevo account before it could be sent (done 2026-10-09). Posting an
// attribute Brevo does not know returns 400, which this design treats as
// permanent -- so a typo here means the contact silently never lands.
import { describe, it, expect, vi } from "vitest";
import { buildBrevoContact, classifyBrevoOutcome, upsertBrevoContact } from "./brevo.js";

const FIELDS = {
  crmClientId: "88214",
  firstName: "Ali",
  middleName: "Hassan",
  lastName: "Khan",
  email: "ali.khan@example.com",
  phone: "+971507192185",
  recordType: "client",
  marketingConsent: true,
  source: "NEW_SIGNUP",
  entity: "SVG",
  isIb: false,
  language: "en",
  utmSource: "google",
  utmMedium: "cpc",
  utmCampaign: "gulf-q4",
  referer: "https://skylinkscapital.com/en/",
  fxboUniqueId: "d3f1-aa",
};

describe("buildBrevoContact", () => {
  it("builds an idempotent upsert into the configured list", () => {
    const contact = buildBrevoContact(FIELDS, { listId: "19" });
    expect(contact.email).toBe("ali.khan@example.com");
    expect(contact.updateEnabled).toBe(true);
    expect(contact.listIds).toEqual([19]);
  });

  it("maps every attribute to the id that exists in Brevo", () => {
    const { attributes } = buildBrevoContact(FIELDS, { listId: "19" });
    expect(attributes).toEqual({
      FIRSTNAME: "Ali",
      LASTNAME: "Khan",
      MIDDLE_NAME: "Hassan",
      EXT_ID: "88214",
      OPT_IN: true,
      ENTITY: "SVG",
      FORM_NAME: "NEW_SIGNUP",
      LANGUAGE: "en",
      IS_IB: false,
      UTM_SOURCE: "google",
      UTM_MEDIUM: "cpc",
      UTM_CAMPAIGN: "gulf-q4",
      REFERER: "https://skylinkscapital.com/en/",
    });
  });

  it("never sends the phone, and never sends an unknown attribute", () => {
    const { attributes } = buildBrevoContact(FIELDS, { listId: "19" });
    const serialised = JSON.stringify(attributes);
    expect(serialised).not.toContain("971507192185");
    expect(attributes.PHONE).toBeUndefined();
    expect(attributes.SMS).toBeUndefined();
    expect(attributes.COUNTRY).toBeUndefined();
    expect(attributes.IS_TEST).toBeUndefined();
    expect(attributes.MARKETING_CONSENT).toBeUndefined(); // consent rides on OPT_IN
    expect(attributes.CRM_CLIENT_ID).toBeUndefined(); // the id rides on EXT_ID
  });

  it("omits empty text attributes but always sends the booleans", () => {
    const { attributes } = buildBrevoContact(
      { ...FIELDS, middleName: "", entity: "", utmMedium: "", marketingConsent: false },
      { listId: "19" }
    );
    expect("MIDDLE_NAME" in attributes).toBe(false);
    expect("ENTITY" in attributes).toBe(false);
    expect("UTM_MEDIUM" in attributes).toBe(false);
    // A false boolean is a real value, not an absent one.
    expect(attributes.OPT_IN).toBe(false);
    expect(attributes.IS_IB).toBe(false);
  });

  it("omits listIds entirely when no list is configured", () => {
    const contact = buildBrevoContact(FIELDS, { listId: "" });
    expect("listIds" in contact).toBe(false);
  });
});

describe("classifyBrevoOutcome", () => {
  it("treats 201 created and 204 updated as sent", () => {
    expect(classifyBrevoOutcome({ httpStatus: 201, body: { id: 5 } }).status).toBe("sent");
    expect(classifyBrevoOutcome({ httpStatus: 204, body: null }).status).toBe("sent");
  });

  it("retries transport errors, 429 and 5xx", () => {
    expect(classifyBrevoOutcome({ transportError: new Error("ETIMEDOUT") }).retryable).toBe(true);
    for (const httpStatus of [429, 500, 502, 503]) {
      expect(classifyBrevoOutcome({ httpStatus, body: {} }).retryable, String(httpStatus)).toBe(true);
    }
  });

  it("treats every other 4xx as permanent", () => {
    for (const httpStatus of [400, 401, 403, 404]) {
      const result = classifyBrevoOutcome({ httpStatus, body: { code: "invalid_parameter" } });
      expect(result.retryable, String(httpStatus)).toBe(false);
      expect(result.status, String(httpStatus)).toBe("failed");
    }
  });

  it("carries Brevo's own error code into the detail", () => {
    const result = classifyBrevoOutcome({
      httpStatus: 400,
      body: { code: "invalid_parameter", message: "Attribute ENTITY does not exist" },
    });
    expect(result.detail).toContain("invalid_parameter");
  });
});

describe("upsertBrevoContact", () => {
  it("authenticates with the api-key header", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 1 }) }));

    await upsertBrevoContact({ fetchImpl, apiKey: "brevo-key", contact: { email: "a@b.c" } });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.brevo.com/v3/contacts");
    expect(init.headers["api-key"]).toBe("brevo-key");
    expect(init.method).toBe("POST");
  });

  it("turns a thrown fetch into a retryable outcome rather than an exception", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });

    const result = await upsertBrevoContact({ fetchImpl, apiKey: "k", contact: {} });

    expect(result.retryable).toBe(true);
    expect(result.status).toBe("failed");
  });

  it("treats a 204 with no body as success", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("no content");
      },
    }));

    const result = await upsertBrevoContact({ fetchImpl, apiKey: "k", contact: {} });

    expect(result.status).toBe("sent");
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
 * One contact, ready for POST /v3/contacts with updateEnabled.
 *
 * Two attributes are Brevo's own rather than ours: EXT_ID carries the CRM
 * client id, and OPT_IN carries marketing consent. Brevo's double-opt-in and
 * compliance tooling reads OPT_IN, which a custom MARKETING_CONSENT would be
 * invisible to.
 *
 * Empty text is omitted rather than sent as "". A false boolean is sent,
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
    return classifyBrevoOutcome({ transportError });
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
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add crmSignup/brevo.js crmSignup/brevo.test.js
git commit -m "CRM signup: Brevo contact upsert against the attributes that exist"
```

---

## Task 4: The store

**Files:**
- Create: `crmSignup/store.js`
- Test: `crmSignup/store.test.js`

**Interfaces:**
- Consumes: the `Fields` shape from `crmSignup/normalise.js`.
- Produces:
  - `SIGNUP_EVENTS_SCHEMA: string`
  - `buildInsertParams(fields, rawPayload): unknown[]`
  - `initCrmSignupStore(): Promise<void>`
  - `insertSignupEvent(fields, rawPayload): Promise<{ inserted: boolean }>`
  - `markSignupInvalid(crmClientId, detail): Promise<void>`
  - `claimDueEvents(limit, now): Promise<Row[]>`
  - `updateWhatsappStatus(id, { status, messageId, detail, attempts, nextAttemptAt }): Promise<void>`
  - `updateBrevoStatus(id, { status, detail, attempts, nextAttemptAt }): Promise<void>`
  - `listRecentSignupEvents(limit): Promise<Row[]>`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/store.test.js`:

```js
// @vitest-environment node
//
// The MySQL wrapper itself is not unit-tested -- docusign/store.js sets that
// precedent, and a pool needs a database. What IS tested is the schema text
// and the parameter builder, because both encode decisions that a later edit
// could quietly undo: the UNIQUE key that makes a redelivery a no-op, and the
// per-action retry columns that keep WhatsApp and Brevo independent.
import { describe, it, expect } from "vitest";
import { SIGNUP_EVENTS_SCHEMA, buildInsertParams } from "./store.js";

describe("signup_events schema", () => {
  it("makes crm_client_id unique", () => {
    // Without this a CRM redelivery is a second row and a second WhatsApp.
    expect(SIGNUP_EVENTS_SCHEMA).toMatch(/UNIQUE KEY\s+\w+\s+\(crm_client_id\)/i);
  });

  it("gives each action its own attempt counter and clock", () => {
    // One shared pair cannot carry two independent retry schedules.
    for (const column of [
      "whatsapp_attempts",
      "whatsapp_next_attempt_at",
      "brevo_attempts",
      "brevo_next_attempt_at",
    ]) {
      expect(SIGNUP_EVENTS_SCHEMA, column).toContain(column);
    }
  });

  it("stores the raw payload", () => {
    // The first live delivery is what settles what %client_is_lead% contains.
    expect(SIGNUP_EVENTS_SCHEMA).toMatch(/raw_payload\s+LONGTEXT/i);
  });

  it("defaults both action statuses to pending", () => {
    expect(SIGNUP_EVENTS_SCHEMA).toMatch(/whatsapp_status[^,]*DEFAULT 'pending'/i);
    expect(SIGNUP_EVENTS_SCHEMA).toMatch(/brevo_status[^,]*DEFAULT 'pending'/i);
  });
});

describe("buildInsertParams", () => {
  const FIELDS = {
    crmClientId: "88214",
    firstName: "Ali",
    middleName: "Hassan",
    lastName: "Khan",
    email: "ali.khan@example.com",
    phone: "+971507192185",
    recordType: "client",
    marketingConsent: true,
    source: "NEW_SIGNUP",
    entity: "SVG",
    isIb: false,
    language: "en",
    utmSource: "google",
    utmMedium: "cpc",
    utmCampaign: "gulf-q4",
    referer: "https://skylinkscapital.com/en/",
    fxboUniqueId: "d3f1-aa",
  };

  it("converts booleans to the 1/0 MySQL stores", () => {
    const params = buildInsertParams(FIELDS, "{}");
    expect(params).toContain(1); // marketingConsent
    expect(params).toContain(0); // isIb
    expect(params).not.toContain(true);
    expect(params).not.toContain(false);
  });

  it("serialises the raw payload as a string", () => {
    const params = buildInsertParams(FIELDS, { a: 1 });
    expect(params[params.length - 1]).toBe('{"a":1}');
  });

  it("does not throw on an unserialisable payload", () => {
    const circular = {};
    circular.self = circular;
    expect(() => buildInsertParams(FIELDS, circular)).not.toThrow();
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
 * The UNIQUE key is the whole deduplication strategy: a redelivery collides at
 * the database rather than in a check-then-act race in application code.
 */
export const SIGNUP_EVENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS signup_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    crm_client_id VARCHAR(255) NOT NULL,
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
    UNIQUE KEY uq_signup_events_crm_client_id (crm_client_id)
  )
`;

const INSERT_COLUMNS = [
  "crm_client_id",
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
  "raw_payload",
];

const bool = (v) => (v ? 1 : 0);
const str = (v) => (v === undefined || v === null || v === "" ? null : String(v));

export function buildInsertParams(fields = {}, rawPayload = null) {
  let serialised;
  try {
    serialised = typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload ?? {});
  } catch {
    serialised = '{"unserialisable":true}';
  }

  return [
    String(fields.crmClientId ?? ""),
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
    serialised,
  ];
}

function hasDbConfig() {
  return Boolean(AUTH_DB_HOST && AUTH_DB_NAME && AUTH_DB_USER && AUTH_DB_PASSWORD);
}

async function run(sql, params = []) {
  if (!pool) throw new Error("CRM signup DB pool is not initialized.");
  const [result] = await pool.query(sql, params);
  return result;
}

async function all(sql, params = []) {
  if (!pool) throw new Error("CRM signup DB pool is not initialized.");
  const [rows] = await pool.query(sql, params);
  return Array.isArray(rows) ? rows : [];
}

export async function initCrmSignupStore() {
  if (initialized) return;
  if (!hasDbConfig()) {
    throw new Error(
      "CRM signup DB env vars are missing. Expected AUTH_DB_HOST, AUTH_DB_NAME, AUTH_DB_USER, AUTH_DB_PASSWORD."
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
 * Insert unless we already hold this client id.
 *
 * `ON DUPLICATE KEY UPDATE id = id` is a deliberate no-op: it makes a
 * redelivery cost one statement and report zero affected rows, with no race
 * between a SELECT and an INSERT.
 */
export async function insertSignupEvent(fields, rawPayload) {
  const placeholders = INSERT_COLUMNS.map(() => "?").join(", ");
  const result = await run(
    `INSERT INTO signup_events (${INSERT_COLUMNS.join(", ")})
     VALUES (${placeholders})
     ON DUPLICATE KEY UPDATE id = id`,
    buildInsertParams(fields, rawPayload)
  );
  return { inserted: Number(result?.affectedRows) === 1, id: result?.insertId ?? null };
}

/**
 * A payload that failed validation. Both action statuses carry `invalid`,
 * because there is no event-level status column and inventing one would mean
 * two places to look.
 */
export async function markSignupInvalid(crmClientId, detail) {
  await run(
    `UPDATE signup_events
        SET whatsapp_status = 'invalid', whatsapp_detail = ?,
            brevo_status = 'invalid', brevo_detail = ?
      WHERE crm_client_id = ?`,
    [String(detail ?? "").slice(0, 500), String(detail ?? "").slice(0, 500), String(crmClientId ?? "")]
  );
}

/** Rows with work outstanding whose clock has come round. */
export async function claimDueEvents(limit = 25, now = new Date()) {
  return all(
    `SELECT * FROM signup_events
      WHERE (whatsapp_status IN ('pending', 'retrying') AND (whatsapp_next_attempt_at IS NULL OR whatsapp_next_attempt_at <= ?))
         OR (brevo_status    IN ('pending', 'retrying') AND (brevo_next_attempt_at    IS NULL OR brevo_next_attempt_at    <= ?))
      ORDER BY received_at ASC
      LIMIT ?`,
    [now, now, Number(limit) || 25]
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

export async function listRecentSignupEvents(limit = 100) {
  return all(
    `SELECT id, crm_client_id, first_name, last_name, email, phone, record_type, source,
            whatsapp_status, whatsapp_detail, whatsapp_attempts,
            brevo_status, brevo_detail, brevo_attempts, received_at
       FROM signup_events
      ORDER BY received_at DESC
      LIMIT ?`,
    [Number(limit) || 100]
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run crmSignup/store.test.js --reporter=verbose`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add crmSignup/store.js crmSignup/store.test.js
git commit -m "CRM signup: signup_events store with per-action retry columns"
```

---

## Task 5: The route handler and its registration

**Files:**
- Create: `crmSignup/router.js`
- Test: `crmSignup/router.test.js`
- Modify: `docusign/fxboPlaceholder.js` (extend `FXBO_PLACEHOLDER_LABELS`)
- Modify: `docusign/fxboPlaceholder.test.js` (cover the new labels)
- Modify: `auth/requireSession.js` (add one allow-list entry)
- Modify: `server.js` (import, register the route, init the store)

**Interfaces:**
- Consumes: `normaliseSignup`, `maskEmail` from `crmSignup/normalise.js`; `insertSignupEvent`, `markSignupInvalid` from `crmSignup/store.js`; `detectUnsubstitutedPlaceholder`, `PLACEHOLDER_NOT_SUBSTITUTED`, `describePlaceholderRejection` from `docusign/fxboPlaceholder.js`.
- Produces: `makeCrmSignupHandler({ secret, insert, markInvalid, normalise, onStored, logger }): (req, res) => Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/router.test.js`:

```js
// @vitest-environment node
//
// The handler does four things and nothing else: authenticate, normalise,
// store, answer 200. Everything a provider might do happens later, in the
// worker, because the CRM must never wait on us and our failure must never
// look like a CRM failure.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { makeCrmSignupHandler } from "./router.js";
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
  client_id: "88214",
  first_name: "Ali",
  last_name: "Khan",
  email: "ali.khan@example.com",
  phone: "+971507192185",
  is_lead: "0",
};

function deps(overrides = {}) {
  return {
    secret: "s3cret",
    insert: vi.fn(async () => ({ inserted: true, id: 1 })),
    markInvalid: vi.fn(async () => {}),
    onStored: vi.fn(() => {}),
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

const req = (headers, body) => ({ headers, body, method: "POST", path: "/api/crm-signup", ip: "1.2.3.4" });

describe("authentication", () => {
  it("accepts the configured secret", async () => {
    const d = deps();
    const res = fakeRes();
    await makeCrmSignupHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res);
    expect(res.statusCode).toBe(200);
  });

  it("rejects a wrong secret with 401 and stores nothing", async () => {
    const d = deps();
    const res = fakeRes();
    await makeCrmSignupHandler(d)(req({ authorization: "wrong" }, VALID_BODY), res);
    expect(res.statusCode).toBe(401);
    expect(d.insert).not.toHaveBeenCalled();
  });

  it("rejects a missing header", async () => {
    const d = deps();
    const res = fakeRes();
    await makeCrmSignupHandler(d)(req({}, VALID_BODY), res);
    expect(res.statusCode).toBe(401);
  });

  it("fails closed when no secret is configured", async () => {
    // Unlike docusign/router.js, which falls back to open. An unauthenticated
    // endpoint here lets anyone trigger WhatsApp sends at our cost.
    const d = deps({ secret: "" });
    const res = fakeRes();
    await makeCrmSignupHandler(d)(req({ authorization: "anything" }, VALID_BODY), res);
    expect(res.statusCode).toBe(401);
    expect(d.insert).not.toHaveBeenCalled();
  });

  it("logs the rejection without ever logging the supplied value", async () => {
    const d = deps();
    await makeCrmSignupHandler(d)(req({ authorization: "sup3r-sekrit" }, VALID_BODY), fakeRes());
    const logged = JSON.stringify(d.logger.warn.mock.calls);
    expect(logged).not.toContain("sup3r-sekrit");
    expect(logged).not.toContain("s3cret");
  });
});

describe("storing", () => {
  it("answers 200 as soon as the row is stored", async () => {
    const d = deps();
    const res = fakeRes();
    await makeCrmSignupHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res);
    expect(res.statusCode).toBe(200);
    expect(d.insert).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ ok: true, stored: true, duplicate: false });
  });

  it("reports a duplicate as 200, not an error", async () => {
    // FXBO retries. A duplicate is the system working, and a non-2xx would
    // make FXBO redeliver an event we already hold.
    const d = deps({ insert: vi.fn(async () => ({ inserted: false, id: null })) });
    const res = fakeRes();
    await makeCrmSignupHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, stored: true, duplicate: true });
  });

  it("does not kick the worker for a duplicate", async () => {
    const d = deps({ insert: vi.fn(async () => ({ inserted: false, id: null })) });
    await makeCrmSignupHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), fakeRes());
    expect(d.onStored).not.toHaveBeenCalled();
  });

  it("stores an invalid payload as invalid and stops", async () => {
    const d = deps();
    const res = fakeRes();
    await makeCrmSignupHandler(d)(
      req({ authorization: "s3cret" }, { ...VALID_BODY, email: "" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(d.markInvalid).toHaveBeenCalledTimes(1);
    expect(d.onStored).not.toHaveBeenCalled();
    expect(res.body.valid).toBe(false);
  });

  it("answers 200 even when the database throws", async () => {
    // A 5xx would make FXBO retry on its own schedule and double-handle.
    const d = deps({
      insert: vi.fn(async () => {
        throw new Error("ER_LOCK_WAIT_TIMEOUT");
      }),
    });
    const res = fakeRes();
    await makeCrmSignupHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res);
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
      makeCrmSignupHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res)
    ).resolves.toBeUndefined();
    expect(res.statusCode).toBe(200);
  });
});

describe("an FXBO Test webhook press", () => {
  // Pressing Test sends each parameter's LABEL instead of its value, so
  // client_id arrives as "Client ID" and email as "Client Email". Those are
  // non-empty strings, so validation alone would accept them and plant a
  // contact called "Client First Name" in the live marketing list.
  const TEST_PRESS = {
    client_id: "Client ID",
    first_name: "Client First Name",
    last_name: "Client Last Name",
    email: "Client Email",
    phone: "Client Phone",
    is_lead: "Client is Lead",
  };

  it("stores it as invalid and runs neither action", async () => {
    const d = deps();
    const res = fakeRes();
    await makeCrmSignupHandler(d)(req({ authorization: "s3cret" }, TEST_PRESS), res);
    expect(res.statusCode).toBe(200);
    expect(d.onStored).not.toHaveBeenCalled();
    expect(d.markInvalid).toHaveBeenCalledTimes(1);
    expect(res.body.valid).toBe(false);
  });

  it("records a reason that names it as a test, not a misconfiguration", async () => {
    const d = deps();
    await makeCrmSignupHandler(d)(req({ authorization: "s3cret" }, TEST_PRESS), fakeRes());
    const [, detail] = d.markInvalid.mock.calls[0];
    expect(detail).toContain("placeholder_not_substituted");
  });

  it("leaves a real payload alone", async () => {
    // The guard must be narrow: a genuine signup must never be read as a test.
    const d = deps();
    await makeCrmSignupHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), fakeRes());
    expect(d.markInvalid).not.toHaveBeenCalled();
    expect(d.onStored).toHaveBeenCalledTimes(1);
  });

  it("does not read one odd-looking field as a test on its own", async () => {
    // A lone label is not proof -- corroboration from another field is
    // required, or a real client named in an unlucky way becomes a "test".
    const d = deps();
    await makeCrmSignupHandler(d)(
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
    const at = SERVER.indexOf("app.post('/api/crm-signup'");
    const gate = SERVER.indexOf("app.use(requireSession)");
    expect(at).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(at);
  });

  it("is on the public allow-list, because FXBO cannot carry a session", () => {
    expect(PUBLIC_API_ROUTES.has("POST /api/crm-signup")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run crmSignup/router.test.js --reporter=verbose`
Expected: FAIL — `Failed to load url ./router.js`

- [ ] **Step 3: Write the handler**

Create `crmSignup/router.js`:

```js
import { timingSafeEqual } from "crypto";
import { normaliseSignup, maskEmail } from "./normalise.js";
import {
  detectUnsubstitutedPlaceholder,
  describePlaceholderRejection,
  PLACEHOLDER_NOT_SUBSTITUTED,
} from "../docusign/fxboPlaceholder.js";

/**
 * Compare without leaking length or position through timing.
 * Different lengths are unequal, and are reported as such without comparing.
 */
function secretMatches(supplied, expected) {
  const a = Buffer.from(String(supplied ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * POST /api/crm-signup.
 *
 * Authenticate, normalise, store, answer 200. Nothing else: the CRM must never
 * wait on a provider, and our failure must never look like a CRM failure. The
 * handler therefore answers 200 even when the database throws -- a 5xx would
 * make FXBO redeliver on its own schedule.
 */
export function makeCrmSignupHandler({
  secret,
  insert,
  markInvalid,
  onStored = () => {},
  normalise = normaliseSignup,
  logger = console,
}) {
  return async function crmSignupHandler(req, res) {
    // Fail closed. An unconfigured secret rejects everything rather than
    // leaving the endpoint open to anyone who finds the URL.
    const expected = String(secret ?? "");
    const supplied = String(req?.headers?.authorization ?? "");

    if (!expected || !secretMatches(supplied, expected)) {
      // The supplied value is never logged, in any form.
      logger.warn?.(
        `[crm-signup] rejected: method=${req?.method} path=${req?.path} ip=${req?.ip} hasHeader=${Boolean(supplied)}`
      );
      return res.status(401).json({ error: "unauthorized" });
    }

    // An FXBO "Test webhook" press substitutes every parameter with its own
    // LABEL -- client_id arrives as the literal "Client ID". Those are
    // non-empty strings, so normalisation alone would accept them and we would
    // create a Brevo contact called "Client First Name" in the live marketing
    // list. docusign/fxboPlaceholder.js already recognises this shape, and
    // deliberately requires corroboration from a second field so that a real
    // client is never mistaken for a test.
    const detection = detectUnsubstitutedPlaceholder(req?.body, "client_id");
    if (detection.placeholder) {
      const reason = `${PLACEHOLDER_NOT_SUBSTITUTED}: ${describePlaceholderRejection(detection)}`;
      logger.warn?.(`[crm-signup] ${reason}`);
      try {
        await insert({ crmClientId: `test:${Date.now()}`, recordType: "lead" }, req?.body);
        await markInvalid(`test:${Date.now()}`, reason.slice(0, 500));
      } catch (error) {
        logger.error?.(`[crm-signup] could not record test press: ${error?.message || String(error)}`);
      }
      return res.status(200).json({ ok: true, stored: true, valid: false, test: true });
    }

    let verdict;
    try {
      verdict = normalise(req?.body);
    } catch (error) {
      logger.error?.(`[crm-signup] normalise failed: ${error?.message || String(error)}`);
      return res.status(200).json({ ok: true, stored: false, valid: false });
    }

    const { valid, missing, fields } = verdict;

    try {
      const { inserted } = await insert(fields, req?.body);

      if (!valid) {
        await markInvalid(fields.crmClientId, `missing required fields: ${missing.join(", ")}`);
        logger.warn?.(
          `[crm-signup] invalid payload for ${maskEmail(fields.email) || "(no email)"}: missing ${missing.join(", ")}`
        );
        return res.status(200).json({ ok: true, stored: true, duplicate: !inserted, valid: false });
      }

      if (inserted) {
        // Fire and forget, AFTER the response is decided. The sweeper is the
        // safety net if this kick is lost to a recycle; it is not the normal
        // path, because a welcome message should arrive in seconds.
        try {
          onStored();
        } catch (error) {
          logger.error?.(`[crm-signup] worker kick failed: ${error?.message || String(error)}`);
        }
      }

      return res.status(200).json({ ok: true, stored: true, duplicate: !inserted });
    } catch (error) {
      logger.error?.(`[crm-signup] store failed: ${error?.message || String(error)}`);
      return res.status(200).json({ ok: true, stored: false, valid });
    }
  };
}
```

- [ ] **Step 4: Extend the shared placeholder label list**

`docusign/fxboPlaceholder.js` already carries the labels DocuSign's rule uses.
Our rule sends more parameters, and each one is another chance to corroborate a
test press. Add these to `FXBO_PLACEHOLDER_LABELS`, after `"Client Title (Mr/Mrs/Ms)"`
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
```

Adding labels only ever makes detection more confident, never less, so this
cannot weaken DocuSign's existing guard. Append to `docusign/fxboPlaceholder.test.js`:

```js
describe("labels used by the CRM signup rule", () => {
  it("recognises every label that rule sends", () => {
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
    ]) {
      expect(isFxboPlaceholderLabel(label), label).toBe(true);
    }
  });

  it("still refuses to call an ordinary value a label", () => {
    // The list is a closed set, not a pattern. A real entity or form name
    // must not match.
    expect(isFxboPlaceholderLabel("SVG")).toBe(false);
    expect(isFxboPlaceholderLabel("NEW_SIGNUP")).toBe(false);
    expect(isFxboPlaceholderLabel("google")).toBe(false);
  });
});
```

Add `isFxboPlaceholderLabel` to that file's existing import if it is not
already there.

Run: `npx vitest run docusign/fxboPlaceholder.test.js --reporter=verbose`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Add the allow-list entry**

In `auth/requireSession.js`, inside `PUBLIC_API_ROUTES`, after the two DocuSign entries:

```js
  // FXBO's "Client registered" rule. Carries CRM_WEBHOOK_SECRET in the
  // Authorization header -- exempt from SESSION auth, not from auth.
  "POST /api/crm-signup",
```

- [ ] **Step 6: Wire it into server.js**

Add to the import block near the other `docusign` imports (around line 16-19):

```js
import { makeCrmSignupHandler } from "./crmSignup/router.js";
import { initCrmSignupStore, insertSignupEvent, markSignupInvalid } from "./crmSignup/store.js";
import { startCrmSignupWorker, kickCrmSignupWorker } from "./crmSignup/worker.js";
```

Register the route next to the other `app.use("/api/...")` registrations (around line 1298-1302), using **single quotes**:

```js
app.post('/api/crm-signup', makeCrmSignupHandler({
  secret: process.env.CRM_WEBHOOK_SECRET,
  insert: insertSignupEvent,
  markInvalid: markSignupInvalid,
  onStored: kickCrmSignupWorker,
}));
```

In the `server.listen` callback, beside `startDocusignReconcileScheduler()`:

```js
  initCrmSignupStore()
    .then(() => startCrmSignupWorker())
    .catch((e) => console.error("[crm-signup] store init failed:", e?.message || String(e)));
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run crmSignup/router.test.js auth/routeCoverage.test.js docusign/fxboPlaceholder.test.js --reporter=verbose`
Expected: PASS. `routeCoverage` must still pass — the allow-list is capped at 6 entries and this is the 5th.

- [ ] **Step 8: Commit**

```bash
git add crmSignup/router.js crmSignup/router.test.js auth/requireSession.js server.js \
        docusign/fxboPlaceholder.js docusign/fxboPlaceholder.test.js
git commit -m "CRM signup: POST /api/crm-signup, authenticated and fail-closed"
```

---

## Task 6: The worker

**Files:**
- Create: `crmSignup/worker.js`
- Test: `crmSignup/worker.test.js`

**Interfaces:**
- Consumes: `decideWhatsappSkip`, `buildWhatsappPayload`, `sendWhatsappTemplate`, `parseSkipSources` from `crmSignup/whatsapp.js`; `buildBrevoContact`, `upsertBrevoContact` from `crmSignup/brevo.js`; `claimDueEvents`, `updateWhatsappStatus`, `updateBrevoStatus` from `crmSignup/store.js`; `maskEmail`, `maskPhone` from `crmSignup/normalise.js`.
- Produces:
  - `planRetry({ attempts, maxAttempts, retryable, finalStatus, now, delayMinutes }): { status, nextAttemptAt, attempts }`
  - `rowToFields(row): Fields`
  - `processSignupEvent(row, deps): Promise<{ whatsapp, brevo }>`
  - `startCrmSignupWorker(): { stop: () => void, intervalSeconds: number } | null`
  - `kickCrmSignupWorker(): void`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/worker.test.js`:

```js
// @vitest-environment node
//
// Two rules this file exists to hold: the retry clock lives in a column, and
// the two actions never interfere. A WhatsApp rejection must not stop a Brevo
// upsert, and a Brevo retry must not move the WhatsApp clock.
import { describe, it, expect, vi } from "vitest";
import { planRetry, rowToFields, processSignupEvent } from "./worker.js";

describe("planRetry", () => {
  const now = new Date("2026-10-09T12:00:00Z");

  it("schedules the next attempt five minutes out while attempts remain", () => {
    const plan = planRetry({ attempts: 0, maxAttempts: 3, retryable: true, now, delayMinutes: 5 });
    expect(plan.status).toBe("retrying");
    expect(plan.attempts).toBe(1);
    expect(plan.nextAttemptAt.toISOString()).toBe("2026-10-09T12:05:00.000Z");
  });

  it("gives up once the attempt budget is spent", () => {
    const plan = planRetry({ attempts: 2, maxAttempts: 3, retryable: true, now, delayMinutes: 5 });
    expect(plan.attempts).toBe(3);
    expect(plan.status).toBe("failed");
    expect(plan.nextAttemptAt).toBeNull();
  });

  it("never schedules a retry for a permanent outcome", () => {
    const plan = planRetry({
      attempts: 0,
      maxAttempts: 3,
      retryable: false,
      finalStatus: "rejected",
      now,
    });
    expect(plan.status).toBe("rejected");
    expect(plan.nextAttemptAt).toBeNull();
    expect(plan.attempts).toBe(1);
  });
});

describe("rowToFields", () => {
  it("turns MySQL 1/0 back into booleans", () => {
    const fields = rowToFields({
      crm_client_id: "88214",
      first_name: "Ali",
      middle_name: "Hassan",
      last_name: "Khan",
      email: "ali@example.com",
      phone: "+971507192185",
      record_type: "client",
      marketing_consent: 1,
      is_ib: 0,
      entity: "SVG",
      source: "NEW_SIGNUP",
      language: "en",
      utm_source: "google",
      utm_medium: null,
      utm_campaign: null,
      referer: null,
    });
    expect(fields.marketingConsent).toBe(true);
    expect(fields.isIb).toBe(false);
    expect(fields.utmMedium).toBe("");
  });
});

function row(overrides = {}) {
  return {
    id: 7,
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
    source: "NEW_SIGNUP",
    language: "en",
    utm_source: "",
    utm_medium: "",
    utm_campaign: "",
    referer: "",
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
    sendWhatsapp: vi.fn(async () => ({ status: "sent", retryable: false, detail: "SENT", messageId: "m-1" })),
    upsertBrevo: vi.fn(async () => ({ status: "sent", retryable: false, detail: "http 201" })),
    saveWhatsapp: vi.fn(async () => {}),
    saveBrevo: vi.fn(async () => {}),
    newMessageId: () => "uuid-fixed",
    now: () => new Date("2026-10-09T12:00:00Z"),
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    ...overrides,
  };
}

describe("processSignupEvent", () => {
  it("sends both and records both", async () => {
    const d = deps();
    await processSignupEvent(row(), d);
    expect(d.sendWhatsapp).toHaveBeenCalledTimes(1);
    expect(d.upsertBrevo).toHaveBeenCalledTimes(1);
    expect(d.saveWhatsapp).toHaveBeenCalledWith(7, expect.objectContaining({ status: "sent" }));
    expect(d.saveBrevo).toHaveBeenCalledWith(7, expect.objectContaining({ status: "sent" }));
  });

  it("still runs Brevo when WhatsApp throws outright", async () => {
    const d = deps({
      sendWhatsapp: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await processSignupEvent(row(), d);
    expect(d.upsertBrevo).toHaveBeenCalledTimes(1);
    expect(d.saveBrevo).toHaveBeenCalledWith(7, expect.objectContaining({ status: "sent" }));
    // The thrown step still lands in a stored status, and it is retryable.
    expect(d.saveWhatsapp).toHaveBeenCalledWith(7, expect.objectContaining({ status: "retrying" }));
  });

  it("still runs WhatsApp when Brevo throws outright", async () => {
    const d = deps({
      upsertBrevo: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await processSignupEvent(row(), d);
    expect(d.saveWhatsapp).toHaveBeenCalledWith(7, expect.objectContaining({ status: "sent" }));
    expect(d.saveBrevo).toHaveBeenCalledWith(7, expect.objectContaining({ status: "retrying" }));
  });

  it("skips a lead with the documented reason and sends no message", async () => {
    const d = deps();
    await processSignupEvent(row({ record_type: "lead" }), d);
    expect(d.sendWhatsapp).not.toHaveBeenCalled();
    expect(d.saveWhatsapp).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "skipped", detail: "lead, not client" })
    );
    // A lead is still a contact.
    expect(d.upsertBrevo).toHaveBeenCalledTimes(1);
  });

  it("skips an invalid phone without attempting a send", async () => {
    const d = deps();
    await processSignupEvent(row({ phone: "0507192185" }), d);
    expect(d.sendWhatsapp).not.toHaveBeenCalled();
    expect(d.saveWhatsapp).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "skipped", detail: "invalid phone number" })
    );
  });

  it("skips Brevo silently when no key is configured", async () => {
    const d = deps();
    d.config.brevoApiKey = "";
    await processSignupEvent(row(), d);
    expect(d.upsertBrevo).not.toHaveBeenCalled();
    expect(d.saveBrevo).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "skipped", detail: "brevo not configured" })
    );
  });

  it("touches neither action once it is already settled", async () => {
    const d = deps();
    await processSignupEvent(row({ whatsapp_status: "sent", brevo_status: "sent" }), d);
    expect(d.sendWhatsapp).not.toHaveBeenCalled();
    expect(d.upsertBrevo).not.toHaveBeenCalled();
    expect(d.saveWhatsapp).not.toHaveBeenCalled();
    expect(d.saveBrevo).not.toHaveBeenCalled();
  });

  it("generates a fresh message id for every attempt", async () => {
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
    expect(ids).toEqual(["uuid-0", "uuid-1"]);
  });

  it("stops retrying WhatsApp once the budget is spent", async () => {
    const d = deps({
      sendWhatsapp: vi.fn(async () => ({ status: "failed", retryable: true, detail: "http 500", messageId: null })),
    });
    await processSignupEvent(row({ whatsapp_status: "retrying", whatsapp_attempts: 2 }), d);
    expect(d.saveWhatsapp).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "failed", attempts: 3, nextAttemptAt: null })
    );
  });

  it("never logs a full phone number or email address", async () => {
    const d = deps({
      sendWhatsapp: vi.fn(async () => ({ status: "rejected", retryable: false, detail: "INVALID", messageId: null })),
    });
    await processSignupEvent(row(), d);
    const logged = JSON.stringify([
      ...d.logger.warn.mock.calls,
      ...d.logger.error.mock.calls,
      ...d.logger.info.mock.calls,
    ]);
    expect(logged).not.toContain("+971507192185");
    expect(logged).not.toContain("ali@example.com");
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
import {
  decideWhatsappSkip,
  buildWhatsappPayload,
  sendWhatsappTemplate,
  parseSkipSources,
} from "./whatsapp.js";
import { buildBrevoContact, upsertBrevoContact } from "./brevo.js";
import { claimDueEvents, updateWhatsappStatus, updateBrevoStatus } from "./store.js";

const SETTLED = new Set(["sent", "skipped", "rejected", "failed", "invalid"]);

/**
 * What to write after one attempt.
 *
 * `attempts` is incremented here, and the caller writes it BEFORE the next
 * attempt would run -- a crash mid-send then costs one attempt instead of
 * retrying forever.
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

  if (!retryable) {
    return { status: finalStatus, attempts: used, nextAttemptAt: null };
  }
  if (used >= Number(maxAttempts)) {
    return { status: "failed", attempts: used, nextAttemptAt: null };
  }
  return {
    status: "retrying",
    attempts: used,
    nextAttemptAt: new Date(now.getTime() + Number(delayMinutes) * 60_000),
  };
}

const str = (v) => String(v ?? "").trim();

export function rowToFields(row = {}) {
  return {
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
  };
}

async function runWhatsappStep(row, fields, deps) {
  const { config, sendWhatsapp, newMessageId, now, logger } = deps;

  const skip = decideWhatsappSkip({
    apiKey: config.waApiKey,
    recordType: fields.recordType,
    source: fields.source,
    phone: fields.phone,
    skipSources: config.skipSources,
  });

  if (skip) {
    return { status: "skipped", detail: skip.reason, messageId: null, attempts: Number(row.whatsapp_attempts) || 0, nextAttemptAt: null };
  }

  const payload = buildWhatsappPayload({
    templateName: config.waTemplateName,
    language: config.waTemplateLanguage,
    firstName: fields.firstName,
    bodyParam: config.waTemplateBodyParam,
    buttonUrl: config.waTemplateButtonUrl,
    from: config.waFromNumber,
    to: fields.phone,
    messageId: newMessageId(),
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
    logger.warn?.(
      `[crm-signup] whatsapp ${plan.status} for ${maskPhone(fields.phone)}: ${outcome.detail}`
    );
  }

  return { ...plan, detail: outcome.detail, messageId: outcome.messageId };
}

async function runBrevoStep(row, fields, deps) {
  const { config, upsertBrevo, now, logger } = deps;

  if (!str(config.brevoApiKey)) {
    return { status: "skipped", detail: "brevo not configured", attempts: Number(row.brevo_attempts) || 0, nextAttemptAt: null };
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
    logger.warn?.(`[crm-signup] brevo ${plan.status} for ${maskEmail(fields.email)}: ${outcome.detail}`);
  }

  return { ...plan, detail: outcome.detail };
}

/**
 * One row, both actions, independently.
 *
 * Each step is wrapped on its own: a thrown step becomes a retryable stored
 * status and the other step still runs. Nothing escapes.
 */
export async function processSignupEvent(row, deps) {
  const fields = rowToFields(row);
  const result = { whatsapp: null, brevo: null };

  if (!SETTLED.has(str(row.whatsapp_status))) {
    try {
      result.whatsapp = await runWhatsappStep(row, fields, deps);
    } catch (error) {
      deps.logger.error?.(`[crm-signup] whatsapp step threw: ${error?.message || String(error)}`);
      result.whatsapp = planRetry({
        attempts: Number(row.whatsapp_attempts) || 0,
        maxAttempts: deps.config.waMaxAttempts,
        retryable: true,
        now: deps.now(),
      });
      result.whatsapp.detail = "step threw";
      result.whatsapp.messageId = null;
    }
    await deps.saveWhatsapp(row.id, result.whatsapp);
  }

  if (!SETTLED.has(str(row.brevo_status))) {
    try {
      result.brevo = await runBrevoStep(row, fields, deps);
    } catch (error) {
      deps.logger.error?.(`[crm-signup] brevo step threw: ${error?.message || String(error)}`);
      result.brevo = planRetry({
        attempts: Number(row.brevo_attempts) || 0,
        maxAttempts: 3,
        retryable: true,
        now: deps.now(),
      });
      result.brevo.detail = "step threw";
    }
    await deps.saveBrevo(row.id, result.brevo);
  }

  return result;
}

function liveConfig() {
  return {
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
    sendWhatsapp: ({ apiKey, payload }) => sendWhatsappTemplate({ apiKey, payload }),
    upsertBrevo: ({ apiKey, contact }) => upsertBrevoContact({ apiKey, contact }),
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
        console.error(`[crm-signup] row ${row?.id} failed: ${error?.message || String(error)}`);
      }
    }
    return { processed: rows.length };
  } finally {
    sweeping = false;
  }
}

/** Fire and forget, used right after the 200 so the welcome is not a minute late. */
export function kickCrmSignupWorker() {
  setImmediate(() => {
    sweepOnce().catch((e) => console.error("[crm-signup] kick failed:", e?.message || String(e)));
  });
}

/**
 * The safety net, following startDocusignReconcileScheduler.
 *
 * setInterval rather than node-cron on purpose: the clock that matters lives
 * in next_attempt_at, so a recycle costs at most one interval.
 */
export function startCrmSignupWorker() {
  const enabled = String(process.env.CRM_SIGNUP_WORKER_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    console.log("[crm-signup] worker disabled by CRM_SIGNUP_WORKER_ENABLED=false");
    return null;
  }
  const intervalSeconds = Math.max(30, Number(process.env.CRM_SIGNUP_WORKER_INTERVAL_SECONDS || 60) || 60);
  const timer = setInterval(() => {
    sweepOnce().catch((e) => console.error("[crm-signup] sweep failed:", e?.message || String(e)));
  }, intervalSeconds * 1000);
  console.log(`[crm-signup] worker started (interval=${intervalSeconds}s)`);
  return { stop: () => clearInterval(timer), intervalSeconds };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run crmSignup/worker.test.js --reporter=verbose`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add crmSignup/worker.js crmSignup/worker.test.js
git commit -m "CRM signup: worker with per-action retries off a database clock"
```

---

## Task 7: The admin view

**Files:**
- Create: `crmSignup/adminRoute.js`
- Test: `crmSignup/adminRoute.test.js`
- Modify: `server.js` (register the route)

**Interfaces:**
- Consumes: `maskEmail`, `maskPhone` from `crmSignup/normalise.js`; `listRecentSignupEvents` from `crmSignup/store.js`.
- Produces: `makeCrmSignupAdminHandler({ canManage, listRecent, limit }): (req, res) => Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `crmSignup/adminRoute.test.js`:

```js
// @vitest-environment node
//
// "Did this client get their welcome message?" answered without a database
// query. Server-rendered on purpose: the React bundle has not deployed since
// 2026-09-25, so a settings page would be invisible.
import { describe, it, expect, vi } from "vitest";
import { makeCrmSignupAdminHandler } from "./adminRoute.js";

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    type(value) {
      this.headers["Content-Type"] = value;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

const ROWS = [
  {
    id: 7,
    crm_client_id: "88214",
    first_name: "Ali",
    last_name: "Khan",
    email: "ali.khan@example.com",
    phone: "+971507192185",
    record_type: "client",
    source: "NEW_SIGNUP",
    whatsapp_status: "sent",
    whatsapp_detail: "SENT",
    whatsapp_attempts: 1,
    brevo_status: "sent",
    brevo_detail: "http 201",
    brevo_attempts: 1,
    received_at: "2026-10-09T12:00:00Z",
  },
];

const ADMIN = { sub: "1", role: "admin" };
const VIEWER = { sub: "2", role: "viewer" };
const canManage = (auth) => auth?.role === "admin";

describe("access", () => {
  it("refuses a caller who cannot manage users", async () => {
    const listRecent = vi.fn(async () => ROWS);
    const res = fakeRes();
    await makeCrmSignupAdminHandler({ canManage, listRecent })({ auth: VIEWER }, res);
    expect(res.statusCode).toBe(403);
    expect(listRecent).not.toHaveBeenCalled();
  });

  it("refuses a request with no session payload at all", async () => {
    const res = fakeRes();
    await makeCrmSignupAdminHandler({ canManage, listRecent: vi.fn() })({}, res);
    expect(res.statusCode).toBe(403);
  });
});

describe("rendering", () => {
  it("shows both statuses for each event", async () => {
    const res = fakeRes();
    await makeCrmSignupAdminHandler({ canManage, listRecent: async () => ROWS })({ auth: ADMIN }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toMatch(/html/);
    expect(res.body).toContain("88214");
    expect(res.body).toContain("sent");
    expect(res.body).toContain("NEW_SIGNUP");
  });

  it("masks the email and the phone", async () => {
    const res = fakeRes();
    await makeCrmSignupAdminHandler({ canManage, listRecent: async () => ROWS })({ auth: ADMIN }, res);
    expect(res.body).not.toContain("ali.khan@example.com");
    expect(res.body).not.toContain("+971507192185");
    expect(res.body).toContain("a***@example.com");
  });

  it("escapes values rather than letting them become markup", async () => {
    const res = fakeRes();
    const nasty = [{ ...ROWS[0], source: '<script>alert(1)</script>' }];
    await makeCrmSignupAdminHandler({ canManage, listRecent: async () => nasty })({ auth: ADMIN }, res);
    expect(res.body).not.toContain("<script>");
    expect(res.body).toContain("&lt;script&gt;");
  });

  it("renders an empty state rather than failing on no rows", async () => {
    const res = fakeRes();
    await makeCrmSignupAdminHandler({ canManage, listRecent: async () => [] })({ auth: ADMIN }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/no signup events/i);
  });

  it("answers 500 as JSON when the store throws, and leaks nothing", async () => {
    const res = fakeRes();
    const listRecent = async () => {
      throw new Error("ER_NO_SUCH_TABLE: signup_events");
    };
    await makeCrmSignupAdminHandler({ canManage, listRecent })({ auth: ADMIN }, res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("ER_NO_SUCH_TABLE");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run crmSignup/adminRoute.test.js --reporter=verbose`
Expected: FAIL — `Failed to load url ./adminRoute.js`

- [ ] **Step 3: Write the implementation**

Create `crmSignup/adminRoute.js`:

```js
import { maskEmail, maskPhone } from "./normalise.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const TONE = {
  sent: "#16a34a",
  skipped: "#64748b",
  pending: "#0891b2",
  retrying: "#ca8a04",
  failed: "#dc2626",
  rejected: "#dc2626",
  invalid: "#dc2626",
};

function badge(status) {
  const value = String(status ?? "");
  const colour = TONE[value] || "#64748b";
  return `<span style="color:${colour};font-weight:600">${esc(value)}</span>`;
}

function renderRow(row) {
  return `<tr>
    <td>${esc(row.received_at)}</td>
    <td>${esc(row.crm_client_id)}</td>
    <td>${esc(row.first_name)} ${esc(row.last_name)}</td>
    <td>${esc(maskEmail(row.email))}</td>
    <td>${esc(maskPhone(row.phone))}</td>
    <td>${esc(row.record_type)}</td>
    <td>${esc(row.source)}</td>
    <td>${badge(row.whatsapp_status)}<br><small>${esc(row.whatsapp_detail)} (${esc(row.whatsapp_attempts)})</small></td>
    <td>${badge(row.brevo_status)}<br><small>${esc(row.brevo_detail)} (${esc(row.brevo_attempts)})</small></td>
  </tr>`;
}

/**
 * GET /api/crm-signup/events.
 *
 * Server-rendered rather than a React settings page: the frontend bundle has
 * not deployed since 2026-09-25, so a React page would not be visible.
 * Contacts here are client PII, so the listing masks email and phone and the
 * route sits behind authRequired + adminOnly in server.js.
 */
export function makeCrmSignupAdminHandler({ canManage, listRecent, limit = 100, logger = console }) {
  return async function crmSignupAdminHandler(req, res) {
    if (!canManage(req?.auth)) return res.status(403).json({ error: "forbidden" });

    let rows;
    try {
      rows = await listRecent(limit);
    } catch (error) {
      // The message can name internal schema, so it is logged, not returned.
      logger.error?.(`[crm-signup] admin view failed: ${error?.message || String(error)}`);
      return res.status(500).json({ error: "listing_failed" });
    }

    const body = rows.length
      ? `<table>
          <thead><tr>
            <th>Received</th><th>CRM id</th><th>Name</th><th>Email</th><th>Phone</th>
            <th>Type</th><th>Form</th><th>WhatsApp</th><th>Brevo</th>
          </tr></thead>
          <tbody>${rows.map(renderRow).join("")}</tbody>
        </table>`
      : `<p class="empty">No signup events recorded yet.</p>`;

    return res.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CRM signup events</title>
<style>
  body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 24px; color: #0f172a; background: #f8fafc; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { color: #64748b; margin: 0 0 20px; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { border-bottom: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #475569; }
  small { color: #64748b; }
  .empty { color: #64748b; }
</style></head><body>
<h1>CRM signup events</h1>
<p class="sub">Most recent ${esc(rows.length)}. Email and phone are masked.</p>
${body}
</body></html>`);
  };
}
```

- [ ] **Step 4: Register the route in server.js**

Add to the import block:

```js
import { makeCrmSignupAdminHandler } from "./crmSignup/adminRoute.js";
import { listRecentSignupEvents } from "./crmSignup/store.js";
```

Register it immediately after the `app.post('/api/crm-signup', ...)` line, behind both gates:

```js
app.get('/api/crm-signup/events', authRequired, adminOnly, makeCrmSignupAdminHandler({
  canManage: canManageUsers,
  listRecent: listRecentSignupEvents,
}));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run crmSignup/adminRoute.test.js auth/routeCoverage.test.js --reporter=verbose`
Expected: PASS. `/api/crm-signup/events` is guarded, so it must NOT appear in `PUBLIC_API_ROUTES`.

- [ ] **Step 6: Commit**

```bash
git add crmSignup/adminRoute.js crmSignup/adminRoute.test.js server.js
git commit -m "CRM signup: admin view of recent events, masked and admin-gated"
```

---

## Task 8: Configuration documentation and the full suite

**Files:**
- Modify: `.env.example`
- Create: `crmSignup/README.md`

- [ ] **Step 1: Document the variables**

Append to `.env.example`:

```
# --- CRM signup webhook (FXBO "Client registered" -> WhatsApp + Brevo) ---
# Required. The endpoint rejects every request when this is unset.
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CRM_WEBHOOK_SECRET=
# WhatsApp. Unset means WhatsApp is skipped silently; everything else still runs.
WA_API_KEY=
WA_TEMPLATE_NAME=registration_client_v3
WA_TEMPLATE_LANGUAGE=en
WA_TEMPLATE_BODY_PARAM=https://skylinkscapital.com/en/login/
WA_TEMPLATE_BUTTON_URL=https://skylinkscapital.com/en/login/
WA_FROM_NUMBER=+971507192185
WA_MAX_ATTEMPTS=3
# Brevo. BREVO_API_KEY is already set for the alert emails; the same key covers
# Contacts. 19 is the "All Clients" list.
BREVO_LIST_ID=19
# Comma-separated %custom_formname% values that must never be sent a WhatsApp
# message. This does NOT gate Brevo.
SKIP_SOURCES=
# The retry sweeper.
CRM_SIGNUP_WORKER_ENABLED=true
CRM_SIGNUP_WORKER_INTERVAL_SECONDS=60
```

- [ ] **Step 2: Write the module README**

Create `crmSignup/README.md`:

```markdown
# crmSignup

Receives FXBO's `Client registered` webhook, stores it once, then independently
sends a DoubleTick WhatsApp welcome and upserts the person into Brevo list 19.

Design: `../docs/superpowers/specs/2026-10-09-crm-signup-webhook-design.md`

## Routes

| Route | Guard |
|---|---|
| `POST /api/crm-signup` | `CRM_WEBHOOK_SECRET` in the `Authorization` header. On the `PUBLIC_API_ROUTES` allow-list because FXBO cannot carry a session. |
| `GET /api/crm-signup/events` | `authRequired` + `adminOnly`. |

## Three things that are easy to get wrong

**A 2xx from DoubleTick does not mean the message was sent.** It means the
request was accepted. The outcome is `messages[0].status`, and
`FAILED ERROR REJECTED UNDELIVERED UNDELIVERABLE INVALID` all mean it failed.
`classifyWhatsappOutcome` is the only place that decides this.

**The handler never returns 5xx because a provider failed.** It answers 200 the
moment the row is stored. A 5xx makes FXBO redeliver an event we already hold,
and FXBO has its own retry engine (up to 12 attempts) on top of ours.

**Retries live in `whatsapp_next_attempt_at` / `brevo_next_attempt_at`, never in
a timer.** node-cron and `setTimeout` die with the IIS worker on this host, and
a lost five-minute timer leaves a row stuck at `retrying` forever.

## Attributes

Nine Brevo attributes were created for this on 2026-10-09: `MIDDLE_NAME`,
`ENTITY`, `FORM_NAME`, `LANGUAGE`, `IS_IB`, `UTM_SOURCE`, `UTM_MEDIUM`,
`UTM_CAMPAIGN`, `REFERER`. Two existing ones are reused rather than duplicated:
`EXT_ID` for the CRM client id and `OPT_IN` for marketing consent. Posting an
attribute Brevo does not know returns 400, which is classified permanent — so a
new field needs the attribute created in Brevo first.
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, including the pre-existing suites. `auth/routeCoverage.test.js` must still pass with five allow-list entries.

- [ ] **Step 4: Lint**

Run: `npx eslint crmSignup/`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add .env.example crmSignup/README.md
git commit -m "CRM signup: document the configuration and the three easy mistakes"
```

---

## Task 9: Deployment and cutover (manual, outside this repo)

These steps change live systems and are **not** automated. Each one needs the
account owner present.

- [ ] **Step 1: Set the environment variables on the server**

There is no `.env` in the repo. Add the Task 8 block wherever the existing
variables live (Plesk → Node.js → Custom environment variables), then recycle
the app pool. Generate the secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- [ ] **Step 2: Deploy and confirm the table exists**

`server.js` is in the app root, so iisnode's `watchedFiles` covers it. After the
recycle, the startup log should carry `[crm-signup] worker started (interval=60s)`.
If it does not, `initCrmSignupStore()` threw — check `AUTH_DB_*`.

- [ ] **Step 3: Allow-list the endpoint in the CRM**

*CRM Configuration → Advanced → System Configuration → Assistant Webhooks List.*
Add `https://app.skylinkscapital.com/api/crm-signup`. It cannot be selected in a
rule until it appears here; today the list holds only two URLs.

- [ ] **Step 4: Create the FXBO rule**

*Configuration → Assistant → Rules → Add New Rule.* Event `Client registered`,
method `Outcoming webhook`, method `POST`. Leave rule 25 untouched.

Header: `Authorization` = the `CRM_WEBHOOK_SECRET` value. Not a query string —
the existing `hook.php` mirrors put their secret in the URL, where it is visible
in Webhook Stats and every proxy log.

Parameters, all with Type `string`:

| Name | Value |
|---|---|
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
| `unique_id` | `%unique_id%` |

Delivery & Retry: **"Update parameters' values on retry" OFF** (a redelivery must
carry an identical payload or our dedupe is reasoning about a different event),
and **401 excluded from the retry error codes** (retrying a rejected secret
never succeeds).

- [ ] **Step 5: Confirm what `%client_is_lead%` actually contains**

Press the rule's **Test webhook** button. The press itself is recognised and
stored as `invalid` (Task 5), so it creates no contact and sends no message —
read `raw_payload` for the newest row to see exactly what FXBO sent. Then
register one real test client and read `raw_payload` again for the real value. If the literal is not one of
`0 false no n off`, the record is treated as a lead and no message is sent —
which is the safe failure, but it means `deriveRecordType` in
`crmSignup/normalise.js` needs the real literal added.

- [ ] **Step 6: Acceptance test**

Register one real test client with a phone you hold. Confirm:
1. The message **arrives on the handset** — not merely that the endpoint
   returned 200, and not merely that DoubleTick returned 2xx.
2. The contact appears in Brevo list 19 with `EXT_ID` and `OPT_IN` populated.
3. Re-posting the identical webhook sends **no second message** and creates no
   second row.

- [ ] **Step 7: Disable the WordPress plugin's WhatsApp send**

In the other repo, `D:\Signup\Signup 2.0\slc-crm`. It currently sends the same
`registration_client_v3` template from the same number on website signup. Until
this is switched off, every website signup receives **two** messages —
`crm_client_id` uniqueness stops CRM redeliveries, not a second independent
sender.

---

## Self-Review

**Spec coverage.** §1 → Task 9 steps 3-4. §2 → Task 1 (+ Task 9 step 4's
parameter table). §3 → Tasks 3, 5, 9 step 7. §4 → the File Structure table. §5 →
Task 4. §6 → Tasks 5 and 6. §7 → Task 5. §8 → Tasks 2, 3, 6. §9 → Task 9 step 5
and the `raw_payload` column. §10 → Task 7. §11 → Task 8. §12 → the tests in
Tasks 1-7 plus Task 9 step 6. §13 → Task 9. §14 → not built, and Task 9 step 4
leaves rule 25 alone.

**Spec requirements deliberately altered,** both recorded under Global
Constraints: the single `attempts`/`next_attempt_at` pair is split per action,
and an empty `%client_is_lead%` resolves to lead rather than client.

**Beyond the spec, added while planning:** the spec does not mention FXBO's
*Test webhook* button as a hazard to this endpoint. It is one — a press sends
every parameter's label in place of its value, and "Client First Name" is a
non-empty string that would pass validation and reach Brevo. Task 5 reuses
`docusign/fxboPlaceholder.js`, which already solves exactly this for the
DocuSign rule.

**Spec requirement not met by any task:** none.

**Type consistency.** `Fields` keys are produced by `normaliseSignup` (Task 1),
reproduced by `rowToFields` (Task 6), and consumed by `buildBrevoContact`
(Task 3) — the same camelCase names in all three. Outcome objects from
`classifyWhatsappOutcome` and `classifyBrevoOutcome` both carry
`{ status, retryable, detail }`, with `messageId` on the WhatsApp one only, and
`planRetry` consumes exactly `retryable` and `status` (as `finalStatus`). Store
writers take `{ status, detail, attempts, nextAttemptAt }`, which is what
`planRetry` returns plus the detail each step attaches.
