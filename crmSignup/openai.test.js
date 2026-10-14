// @vitest-environment node
//
// The ChatGPT Ads half. Three of the failure modes here produce no error at all
// -- OpenAI accepts the event and silently fails to match it -- and one of them
// is invisible to realistic test data on purpose: OpenAI's phone normalisation
// differs from Meta's only for a phone with leading zeroes, which `PHONE_RE`
// cannot currently produce. So the hashes, the data families and the event id
// are pinned by test rather than by care, and the phone is pinned with a number
// that actually has the zeroes.
import { describe, it, expect, vi } from "vitest";
import { describeSendTimeout, stalledBodyResponse } from "./sendTimeout.contract.js";
import { PHONE_RE } from "./normalise.js";
// Meta's own helpers, imported ONLY to be compared against. The email rule is
// the same rule today and the phone rule is not, and both of those facts are
// asserted below rather than assumed: this import is the alarm that rings if
// either side's normalisation is ever changed on its own.
import { hashEmail as metaHashEmail, hashPhone as metaHashPhone } from "./meta.js";
import {
  OPENAI_EVENTS,
  OPENAI_EVENT_FAMILIES,
  OPENAI_EVENTS_URL,
  PIXEL_OWNED_STAGE,
  openaiEventFor,
  openaiDataType,
  openaiEventId,
  openaiTimestampMs,
  decideOpenaiSkip,
  hashEmail,
  hashPhone,
  buildOpenaiPayload,
  readOpenaiError,
  classifyOpenaiOutcome,
  sendOpenaiEvent,
} from "./openai.js";

const ALL_STAGES = ["lead", "registered", "verified", "live_account", "first_deposit"];

// One instant, written two ways: the column as it reads and the milliseconds it
// is. The literal is computed by hand rather than from Date.parse of the string
// beside it, so a `timestamp_ms` built by dividing -- or by multiplying back up
// from seconds -- fails here instead of agreeing with itself.
const RECEIVED_AT = "2026-10-14T18:11:00.000Z";
const RECEIVED_MS = 1792001460000;
const RECEIVED_SECONDS = 1792001460;

// sha256 digests computed independently with node's crypto, not read back out of
// the implementation: a digest the code produced would pin nothing.
const SHA_EMAIL = "cefa37b4e787d579251247cab9b2ed08cf8e83e514c6cd887559baf6a9171870"; // "ali.khan@example.com"
const SHA_PHONE = "0449fd30f3348d64f7cd0fe7ffcf90c2b045494a653446c41204fe723587751b"; // "971507192185"
const SHA_PHONE_WITH_ZEROES = "edede86b9903165dc4ebf51f00016648ca0e9a45cd3bf5961af5fb1d2d1a1fdc"; // "00971507192185"
const SHA_PHONE_ONE_ZERO = "91f26993029b17a5a6a7c2db162eac5ad54eb333e7bc4b77818d6b0ed96875fe"; // "0971507192185"
const SHA_EIGHT_DIGITS = "ef797c8118f02dfb649607dd5d3f8c7623048c9c063d532cc95c5ed7a898a64f"; // "12345678"

describe("the event taxonomy", () => {
  it("lists all thirteen event names with the one data family each requires", () => {
    // `data.type` is the data FAMILY, not the event name, and a mismatched pair
    // is rejected outright. This table is the only place the pairing is written.
    expect(OPENAI_EVENT_FAMILIES).toEqual({
      app_installed: "customer_action",
      app_opened: "customer_action",
      appointment_scheduled: "customer_action",
      lead_created: "customer_action",
      registration_completed: "customer_action",
      checkout_started: "contents",
      contents_viewed: "contents",
      items_added: "contents",
      order_created: "contents",
      page_viewed: "contents",
      subscription_created: "plan_enrollment",
      trial_started: "plan_enrollment",
      custom: "custom",
    });
  });

  it("names only the four families OpenAI recognises", () => {
    expect([...new Set(Object.values(OPENAI_EVENT_FAMILIES))].sort()).toEqual([
      "contents",
      "custom",
      "customer_action",
      "plan_enrollment",
    ]);
  });

  it("has no family for a name outside the taxonomy, rather than guessing one", () => {
    expect(openaiDataType("Purchase")).toBe("");
    expect(openaiDataType("client_verified")).toBe("");
    expect(openaiDataType("")).toBe("");
    expect(openaiDataType(undefined)).toBe("");
    // Not Object.prototype, which a plain index would return as a truthy object.
    expect(openaiDataType("__proto__")).toBe("");
  });
});

describe("event names", () => {
  it("maps every stage, and maps them to OpenAI's own vocabulary", () => {
    expect(OPENAI_EVENTS).toEqual({
      lead: { name: "lead_created" },
      registered: { name: "registration_completed" },
      verified: { name: "custom", customEventName: "client_verified" },
      live_account: { name: "custom", customEventName: "live_account_opened" },
      first_deposit: { name: "order_created" },
    });
  });

  it("maps every stage in the funnel, so no stage silently has no event", () => {
    for (const stage of ALL_STAGES) {
      expect(openaiEventFor(stage), stage).not.toBeNull();
      expect(openaiEventFor(stage).name, stage).toBeTruthy();
    }
  });

  it("gives every mapped event the family its name requires", () => {
    // The pairing that OpenAI rejects when it is wrong. Swapping two families
    // in the taxonomy table fails here as well as in the table's own test.
    expect(
      Object.fromEntries(
        ALL_STAGES.map((stage) => [stage, openaiDataType(openaiEventFor(stage).name)])
      )
    ).toEqual({
      lead: "customer_action",
      registered: "customer_action",
      verified: "custom",
      live_account: "custom",
      first_deposit: "contents",
    });
  });

  it("routes verified and live_account through custom, because the taxonomy has neither", () => {
    // There is no verification event and no account-opened event anywhere in
    // the thirteen. The only route is `custom` with a custom_event_name, and
    // approximating one with a built-in that means something else would book a
    // conversion of the wrong kind.
    for (const stage of ["verified", "live_account"]) {
      expect(openaiEventFor(stage).name, stage).toBe("custom");
      expect(openaiDataType("custom"), stage).toBe("custom");
      expect(openaiEventFor(stage).customEventName, stage).toBeTruthy();
    }
    expect(openaiEventFor("verified").customEventName).toBe("client_verified");
    expect(openaiEventFor("live_account").customEventName).toBe("live_account_opened");
  });

  it("gives a custom event name only to the custom events", () => {
    for (const stage of ["lead", "registered", "first_deposit"]) {
      expect(openaiEventFor(stage).customEventName, stage).toBeUndefined();
    }
  });

  it("keeps every custom event name inside what OpenAI accepts", () => {
    // 1-64 characters, lowercase letters, numbers, underscores or dashes, and
    // not reusing a built-in name. Any of those three is a rejection.
    for (const stage of ALL_STAGES) {
      const name = openaiEventFor(stage).customEventName;
      if (!name) continue;
      expect(name, stage).toMatch(/^[a-z0-9_-]{1,64}$/);
      expect(Object.hasOwn(OPENAI_EVENT_FAMILIES, name), stage).toBe(false);
    }
  });

  it("does not implement appointment_scheduled, which has no CRM stage behind it", () => {
    // It is in the taxonomy, and the brief's table listed it, but there is no
    // such CRM stage and no FXBO rule for one. Omitted rather than faked.
    expect(OPENAI_EVENT_FAMILIES.appointment_scheduled).toBe("customer_action");
    expect(Object.values(OPENAI_EVENTS).map((e) => e.name)).not.toContain("appointment_scheduled");
  });

  it("has no mapping for a stage that is not one, and does not inherit one", () => {
    expect(openaiEventFor("Purchase")).toBeNull();
    expect(openaiEventFor("")).toBeNull();
    expect(openaiEventFor(undefined)).toBeNull();
    // A plain index would return Object.prototype here: truthy, and read as a
    // mapping with no name and no family.
    expect(openaiEventFor("__proto__")).toBeNull();
    expect(openaiEventFor("toString")).toBeNull();
  });
});

describe("decideOpenaiSkip", () => {
  const configured = { apiKey: "sk-test", pixelId: "px_1" };

  it("skips every stage when there is no key", () => {
    for (const stage of ALL_STAGES) {
      expect(decideOpenaiSkip({ stage, apiKey: "", pixelId: "px_1" }), stage).toEqual({
        reason: "openai not configured",
      });
    }
  });

  it("skips every stage when there is no pixel id", () => {
    // Without one there is no URL to post to, so nothing was attempted and
    // nothing refused: a skip, exactly as for the other three destinations.
    for (const stage of ALL_STAGES) {
      expect(decideOpenaiSkip({ stage, apiKey: "sk-test", pixelId: "  " }), stage).toEqual({
        reason: "openai pixel id not configured",
      });
    }
  });

  it("names the missing key before the missing pixel id, and both before the stage", () => {
    // With nothing configured, every reason below is also true for `registered`.
    // The configuration ones are the actionable ones, and they name which
    // variable to look at because the two sit on different lines of .env.
    expect(decideOpenaiSkip({ stage: "registered", apiKey: "   ", pixelId: "   " })).toEqual({
      reason: "openai not configured",
    });
    expect(decideOpenaiSkip({ stage: "registered", apiKey: "sk-test", pixelId: "" })).toEqual({
      reason: "openai pixel id not configured",
    });
  });

  it("skips registered, because the website pixel owns registration_completed", () => {
    // 2026-10-14, user's call. OpenAI merges a browser and a server event into
    // one conversion only when the pixel id, the event name and the id all
    // match -- and the pixel's id lives in the page, while ours comes from FXBO,
    // which has no field that could carry it across. One owner per stage.
    expect(decideOpenaiSkip({ stage: "registered", ...configured })).toEqual({
      reason: "registered is owned by the website pixel",
    });
    expect(PIXEL_OWNED_STAGE).toBe("registered");
  });

  it("sends the other four stages, which no pixel fires", () => {
    for (const stage of ALL_STAGES.filter((s) => s !== "registered")) {
      expect(decideOpenaiSkip({ stage, ...configured }), stage).toBeNull();
    }
  });

  it("still maps registered to an event name, so lifting the gate needs no second change", () => {
    expect(OPENAI_EVENTS.registered).toEqual({ name: "registration_completed" });
    expect(openaiDataType("registration_completed")).toBe("customer_action");
  });

  it("skips a stage the taxonomy has no event for, rather than sending a nameless one", () => {
    // The guard, not a decision: an event with no name and no family is the one
    // thing OpenAI rejects outright, and the reason belongs in the row.
    for (const stage of ["appointment", "__proto__", "", undefined]) {
      expect(decideOpenaiSkip({ stage, ...configured }), String(stage)).toEqual({
        reason: "stage not in the OpenAI taxonomy",
      });
    }
  });
});

describe("openaiTimestampMs", () => {
  // The field is `timestamp_ms` and Meta's `event_time` is in seconds, one field
  // apart on the same row. A factor of 1000 puts the event in 1970, which OpenAI
  // reports as nothing at all -- it refuses the event for being outside the
  // window -- so the units are pinned here rather than trusted.
  it("reads the column as milliseconds, with no division anywhere", () => {
    expect(openaiTimestampMs(RECEIVED_AT)).toBe(RECEIVED_MS);
    expect(openaiTimestampMs(new Date(RECEIVED_AT))).toBe(RECEIVED_MS);
    expect(openaiTimestampMs(RECEIVED_MS)).toBe(RECEIVED_MS);
    // What worker.js's eventTimeSeconds would have produced, which is not this.
    expect(openaiTimestampMs(RECEIVED_AT)).not.toBe(RECEIVED_SECONDS);
    expect(openaiTimestampMs(RECEIVED_AT)).toBe(RECEIVED_SECONDS * 1000);
  });

  it("returns an integer, truncated rather than rounded up", () => {
    expect(openaiTimestampMs(RECEIVED_MS + 0.9)).toBe(RECEIVED_MS);
    expect(Number.isInteger(openaiTimestampMs(RECEIVED_AT))).toBe(true);
  });

  it("returns null for anything that is not a time, never NaN", () => {
    // NaN in a required field serialises to null: present and empty, which is
    // the one shape worse than missing.
    for (const value of ["", "   ", "not a date", undefined, null, new Date("nonsense"), NaN, Infinity]) {
      expect(openaiTimestampMs(value), String(value)).toBeNull();
    }
  });
});

describe("hashing", () => {
  it("normalises the email before hashing, not after", () => {
    expect(hashEmail("  Ali.Khan@Example.COM ")).toBe(hashEmail("ali.khan@example.com"));
  });

  it("is a real SHA-256, checked against a known digest", () => {
    expect(hashEmail("ali.khan@example.com")).toBe(SHA_EMAIL);
    expect(hashEmail("  Ali.Khan@Example.COM ")).toBe(SHA_EMAIL);
  });

  it("produces a 64-character lowercase hex digest", () => {
    expect(hashEmail("a@b.com")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPhone("+971507192185")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the email exactly as Meta does, which is this test's whole job", () => {
    // The rule genuinely IS Meta's rule today (trim, lowercase), so the helper
    // here is a deliberate second copy rather than a shared import: a change to
    // Meta's normalisation would otherwise travel here silently and break
    // matching with no error anywhere. This assertion is the alarm -- if it
    // ever fails, a person decides which side changed, instead of one
    // inheriting the other.
    for (const email of ["ali.khan@example.com", "  Ali.Khan@Example.COM ", "a+b@c.co", "", "   "]) {
      expect(hashEmail(email), JSON.stringify(email)).toBe(metaHashEmail(email));
    }
  });

  it("returns empty for an empty email rather than hashing the empty string", () => {
    // sha256("") is a valid digest and would be sent as if it were a real
    // address, poisoning match quality.
    expect(hashEmail("")).toBe("");
    expect(hashEmail("   ")).toBe("");
    expect(hashEmail(undefined)).toBe("");
    expect(hashEmail(null)).toBe("");
  });

  it("removes the punctuation OpenAI names, keeping the country code", () => {
    expect(hashPhone("+971 (50) 719.21-85")).toBe(SHA_PHONE);
    expect(hashPhone("+971507192185")).toBe(SHA_PHONE);
    expect(hashPhone("971507192185")).toBe(SHA_PHONE);
  });

  it("strips leading zeroes, which is OpenAI's rule and not Meta's", () => {
    // The whole reason this helper exists. Both of these normalise to
    // "971507192185" for OpenAI; Meta would keep the zeroes and hash a
    // different string.
    expect(hashPhone("0097150719 2185")).toBe(SHA_PHONE);
    expect(hashPhone("0971507192185")).toBe(SHA_PHONE);
    expect(hashPhone("+00971507192185")).toBe(SHA_PHONE);
  });

  it("takes the plus off before the zeroes, not after", () => {
    // "+00971..." has both. Stripping zeroes first would leave the plus sitting
    // in front of them and the value would fail the digit range entirely.
    expect(hashPhone("+00971507192185")).toBe(SHA_PHONE);
    expect(hashPhone("+0971507192185")).toBe(SHA_PHONE);
  });

  it("differs from Meta's hash for a phone that has leading zeroes", () => {
    // The difference the spec says testing would not catch, exercised on purpose
    // with a number that HAS the zeroes. Using Meta's hashPhone here would make
    // every one of these fail.
    expect(hashPhone("00971507192185")).toBe(SHA_PHONE);
    expect(metaHashPhone("00971507192185")).toBe(SHA_PHONE_WITH_ZEROES);
    expect(hashPhone("00971507192185")).not.toBe(metaHashPhone("00971507192185"));

    expect(hashPhone("0971507192185")).toBe(SHA_PHONE);
    expect(metaHashPhone("0971507192185")).toBe(SHA_PHONE_ONE_ZERO);
    expect(hashPhone("0971507192185")).not.toBe(metaHashPhone("0971507192185"));
  });

  it("agrees with Meta's hash for every phone PHONE_RE can currently produce", () => {
    // The trap itself, stated as a test: a stored phone always begins with a
    // plus and a NON-ZERO digit, so there are never zeroes to strip and the two
    // rules coincide. This is why reusing Meta's helper would have passed every
    // realistic test and broken silently the day PHONE_RE was loosened -- and
    // why the test above is the one that matters.
    for (const phone of [
      "+971507192185",
      "+447911123456",
      "+12025550123",
      "+6591234567",
      "+8613800138000",
    ]) {
      expect(PHONE_RE.test(phone), phone).toBe(true);
      expect(hashPhone(phone), phone).toBe(metaHashPhone(phone));
    }
  });

  it("removes only the characters OpenAI names, not every non-digit", () => {
    // Meta strips all non-digits. OpenAI documents removing whitespace,
    // parentheses, periods and hyphens -- so anything else leaves a value that
    // is not 8-15 digits, and there is nothing OpenAI could have hashed to meet
    // it. A digest of a guess is worse than no digest.
    expect(hashPhone("+971/507192185")).toBe("");
    expect(metaHashPhone("+971/507192185")).toBe(SHA_PHONE);
    expect(hashPhone("+971507192185 ext 4")).toBe("");
  });

  it("hashes 8 to 15 digits and nothing outside that range", () => {
    // OpenAI's own range, which is also exactly what PHONE_RE enforces.
    expect(hashPhone("12345678")).toBe(SHA_EIGHT_DIGITS);
    expect(hashPhone("1234567")).toBe("");
    expect(hashPhone("+1234567890123456")).toBe("");
  });

  it("returns empty for anything that is not a phone number at all", () => {
    expect(hashPhone("")).toBe("");
    expect(hashPhone("   ")).toBe("");
    expect(hashPhone(undefined)).toBe("");
    expect(hashPhone(null)).toBe("");
    expect(hashPhone("not a number")).toBe("");
    // All zeroes normalises to nothing, which must not become sha256("").
    expect(hashPhone("0000")).toBe("");
    expect(hashPhone("+0")).toBe("");
  });
});

describe("openaiEventId", () => {
  it("is the CRM record and the stage, so a retry carries the same id", () => {
    expect(openaiEventId({ crmClientId: "42", stage: "verified" })).toBe("42:verified");
    // Called twice with the same inputs, which is what a retry is. Pinned to
    // the literal rather than to itself, so an id derived from the clock or a
    // random value fails here rather than passing whenever two calls land in
    // the same millisecond.
    expect(openaiEventId({ crmClientId: "42", stage: "verified" })).toBe("42:verified");
  });

  it("gives each stage of one client its own id", () => {
    expect(openaiEventId({ crmClientId: "42", stage: "first_deposit" })).toBe("42:first_deposit");
    expect(openaiEventId({ crmClientId: "43", stage: "verified" })).toBe("43:verified");
  });

  it("returns no id at all when there is no client id to build one from", () => {
    // ":verified" would not merely lose the deduplication -- it would be the
    // SAME id for every such client, merging different people's conversions
    // into one. No id costs only the dedup of a retry.
    expect(openaiEventId({ crmClientId: "", stage: "verified" })).toBe("");
    expect(openaiEventId({ crmClientId: "  ", stage: "verified" })).toBe("");
    expect(openaiEventId({ crmClientId: undefined, stage: "verified" })).toBe("");
    expect(openaiEventId({ crmClientId: "42", stage: "" })).toBe("");
    expect(openaiEventId()).toBe("");
  });
});

describe("buildOpenaiPayload", () => {
  const base = {
    stage: "verified",
    crmClientId: "42",
    email: "ali.khan@example.com",
    phone: "+971507192185",
    oppref: "abc123XYZ",
    // Required: `timestamp_ms` has no default and no fallback, and a payload
    // built without one would be invalid by construction.
    receivedAt: RECEIVED_AT,
  };

  it("sends exactly one event per request, in the batch envelope", () => {
    // Up to 1,000 are allowed, and batching is deliberately not used: one bad
    // event fails the whole batch and there is no per-event error reporting, so
    // one malformed row would destroy a whole sweep's conversions silently.
    const payload = buildOpenaiPayload(base);
    expect(Array.isArray(payload.events)).toBe(true);
    expect(payload.events).toHaveLength(1);
  });

  it("puts the event name in `type`, where OpenAI's event object carries it", () => {
    // **There is no `event_name` field on an OpenAI event.** The reference calls
    // the field `type` and uses the phrase "event name" only when describing the
    // dedupe key, so a payload with `event_name` names nothing and the event is
    // refused. `data.type` is the data FAMILY -- a different field that happens
    // to share a name, which is exactly how the two got confused.
    const event = buildOpenaiPayload(base).events[0];
    expect(event.type).toBe("custom");
    expect(event.data).toEqual({ type: "custom" });
    expect("event_name" in event).toBe(false);
    // The quotes are load-bearing: `custom_event_name` is a real field and
    // carries the bare word, so only the quoted key can be looked for.
    expect(JSON.stringify(buildOpenaiPayload(base))).not.toContain('"event_name"');
    for (const stage of ALL_STAGES) {
      expect("event_name" in buildOpenaiPayload({ ...base, stage }).events[0], stage).toBe(false);
    }
  });

  it("gives each stage the right name and family pair", () => {
    const pairs = ALL_STAGES.map((stage) => {
      const event = buildOpenaiPayload({ ...base, stage }).events[0];
      return [stage, `${event.type}/${event.data.type}`];
    });
    expect(Object.fromEntries(pairs)).toEqual({
      lead: "lead_created/customer_action",
      registered: "registration_completed/customer_action",
      verified: "custom/custom",
      live_account: "custom/custom",
      first_deposit: "order_created/contents",
    });
  });

  it("carries custom_event_name on a custom event, which is rejected without one", () => {
    expect(buildOpenaiPayload({ ...base, stage: "verified" }).events[0].custom_event_name).toBe(
      "client_verified"
    );
    expect(buildOpenaiPayload({ ...base, stage: "live_account" }).events[0].custom_event_name).toBe(
      "live_account_opened"
    );
  });

  it("omits custom_event_name on a built-in event, where it means nothing", () => {
    for (const stage of ["lead", "registered", "first_deposit"]) {
      const event = buildOpenaiPayload({ ...base, stage }).events[0];
      expect("custom_event_name" in event, stage).toBe(false);
    }
  });

  it("sends the hashed identifier lists, never a raw value", () => {
    const serialised = JSON.stringify(buildOpenaiPayload(base));
    expect(serialised).not.toContain("ali.khan@example.com");
    expect(serialised).not.toContain("971507192185");
    const { user } = buildOpenaiPayload(base).events[0];
    expect(user.emails_sha256).toEqual([SHA_EMAIL]);
    expect(user.phone_numbers_sha256).toEqual([SHA_PHONE]);
  });

  it("hashes the normalised values in the payload, not the raw input", () => {
    // Messy input on purpose, including the leading zeroes Meta's rule would
    // keep. OpenAI hashes the normalised value on its side, so the payload must
    // carry the digest of the lowercased address and of the plus-and-zero-free
    // digits, never a digest of the raw strings.
    const { user } = buildOpenaiPayload({
      ...base,
      email: "  Ali.Khan@Example.COM ",
      phone: "+00971 (50) 719-2185",
    }).events[0];
    expect(user.emails_sha256).toEqual([SHA_EMAIL]);
    expect(user.phone_numbers_sha256).toEqual([SHA_PHONE]);
  });

  it("sends no names and no external ids", () => {
    // 2026-10-14, user's call: the two hashed lists Meta already receives, and
    // nothing else. Nothing identifying leaves in readable form either way.
    const { user } = buildOpenaiPayload(base).events[0];
    expect(Object.keys(user).sort()).toEqual(["emails_sha256", "phone_numbers_sha256"]);
  });

  it("omits an absent matcher instead of sending an empty list", () => {
    const { user } = buildOpenaiPayload({ ...base, phone: "" }).events[0];
    expect("phone_numbers_sha256" in user).toBe(false);
    expect(user.emails_sha256).toBeDefined();

    const noEmail = buildOpenaiPayload({ ...base, email: "" }).events[0].user;
    expect("emails_sha256" in noEmail).toBe(false);
  });

  it("omits a phone OpenAI's own rule cannot normalise, rather than hashing a guess", () => {
    const { user } = buildOpenaiPayload({ ...base, phone: "+971507192185 ext 4" }).events[0];
    expect("phone_numbers_sha256" in user).toBe(false);
  });

  it("passes oppref through raw, with no wrapper and no timestamp", () => {
    // Unlike fbc there is nothing to freeze beyond the value itself.
    expect(buildOpenaiPayload(base).events[0].oppref).toBe("abc123XYZ");
    expect(buildOpenaiPayload({ ...base, oppref: " abc123XYZ " }).events[0].oppref).toBe("abc123XYZ");
  });

  it("carries oppref on every stage, because it is frozen on the client not the row", () => {
    // The first deposit is a different row arriving weeks later with its own
    // empty full_link; the stored value is what reaches it.
    for (const stage of ALL_STAGES) {
      expect(buildOpenaiPayload({ ...base, stage }).events[0].oppref, stage).toBe("abc123XYZ");
    }
  });

  it("still sends the event when there is no oppref, simply unattributed", () => {
    for (const oppref of ["", "   ", undefined, null]) {
      const event = buildOpenaiPayload({ ...base, oppref }).events[0];
      expect("oppref" in event, String(oppref)).toBe(false);
      expect(event.type, String(oppref)).toBe("custom");
    }
  });

  it("emits the event id, identical on every retry of the same funnel event", () => {
    expect(buildOpenaiPayload(base).events[0].id).toBe("42:verified");
    expect(buildOpenaiPayload(base).events[0].id).toBe("42:verified");
    expect(buildOpenaiPayload({ ...base, stage: "first_deposit" }).events[0].id).toBe("42:first_deposit");
  });

  it("builds nothing when there is no client id, rather than an event with no id", () => {
    // **`id` is required**, so it cannot be attached behind a condition: that
    // would make a payload invalid by construction merely unlikely. And the id
    // is genuinely unavailable here rather than merely awkward -- openaiEventId
    // returns "" on purpose, because ":verified" would be the SAME id for every
    // client with no id and would merge different people's conversions into one.
    // So the invalid payload is unconstructable, which is what this used to
    // assert as an absent `id` on a payload that would have been refused.
    for (const crmClientId of ["", "   ", undefined, null]) {
      expect(buildOpenaiPayload({ ...base, crmClientId }), String(crmClientId)).toBeNull();
    }
  });

  it("stamps timestamp_ms in milliseconds, which is required and is not Meta's units", () => {
    // Without it every event is rejected. Meta's `event_time` is in SECONDS and
    // is built from the same column by a helper that divides by 1000; this field
    // divides by nothing, and the two are one field apart on the same row.
    const event = buildOpenaiPayload(base).events[0];
    expect(event.timestamp_ms).toBe(RECEIVED_MS);
    expect(event.timestamp_ms).not.toBe(RECEIVED_SECONDS);
    expect(Number.isInteger(event.timestamp_ms)).toBe(true);
    // Thirteen digits, not ten: the shape of the mistake, independently of the
    // instant chosen.
    expect(String(event.timestamp_ms)).toHaveLength(13);
  });

  it("takes the timestamp from the row, never from the clock", () => {
    // The row exists to say when the conversion happened. A resend must not
    // re-stamp it with today, which is the thing the 7-day window tempts.
    const event = buildOpenaiPayload({ ...base, receivedAt: new Date(RECEIVED_MS - 3 * 86400000) }).events[0];
    expect(event.timestamp_ms).toBe(RECEIVED_MS - 3 * 86400000);
    expect(buildOpenaiPayload(base).events[0].timestamp_ms).toBe(RECEIVED_MS);
  });

  it("carries timestamp_ms on every stage", () => {
    for (const stage of ALL_STAGES) {
      expect(buildOpenaiPayload({ ...base, stage }).events[0].timestamp_ms, stage).toBe(RECEIVED_MS);
    }
  });

  it("builds nothing when received_at is not a time, rather than a null in a required field", () => {
    for (const receivedAt of ["", "   ", "not a date", undefined, null, new Date("nonsense")]) {
      expect(buildOpenaiPayload({ ...base, receivedAt }), String(receivedAt)).toBeNull();
    }
  });

  it("sends action_source offline, because no browser and no page produced these", () => {
    // 2026-10-14, user's call. The brief said `web`, but that described the
    // registration event, which the pixel owns and we do not send. The stages we
    // do send happen inside the CRM: the counterpart of the `system_generated`
    // Meta already receives for these same events.
    for (const stage of ALL_STAGES) {
      expect(buildOpenaiPayload({ ...base, stage }).events[0].action_source, stage).toBe("offline");
    }
  });

  it("uses one of the values OpenAI lists, and not web", () => {
    const valid = ["web", "mobile_app", "offline", "physical_store", "phone_call", "email", "other"];
    const { action_source } = buildOpenaiPayload(base).events[0];
    expect(valid).toContain(action_source);
    expect(action_source).not.toBe("web");
  });

  it("sends no source_url, which is required only for web events", () => {
    // There is no URL to send: a plausible register-page URL on an event no
    // browser produced would be a fact we made up and then reported. Since
    // `action_source` is not `web`, the reference does not ask for one.
    for (const stage of ALL_STAGES) {
      const event = buildOpenaiPayload({ ...base, stage }).events[0];
      expect("source_url" in event, stage).toBe(false);
      expect(JSON.stringify(event), stage).not.toContain("source_url");
      expect(JSON.stringify(event), stage).not.toContain("http");
    }
  });

  it("emits exactly the event fields the reference defines, and no others", () => {
    // The whole event object in one assertion, so a field invented later has to
    // be defended here rather than appearing quietly. Every required field --
    // `id`, `type`, `timestamp_ms`, `data` -- is present unconditionally.
    expect(buildOpenaiPayload(base).events[0]).toEqual({
      id: "42:verified",
      type: "custom",
      custom_event_name: "client_verified",
      timestamp_ms: RECEIVED_MS,
      data: { type: "custom" },
      action_source: "offline",
      oppref: "abc123XYZ",
      user: { emails_sha256: [SHA_EMAIL], phone_numbers_sha256: [SHA_PHONE] },
    });
    // A built-in event, where the only difference is the absent custom name.
    expect(buildOpenaiPayload({ ...base, stage: "first_deposit" }).events[0]).toEqual({
      id: "42:first_deposit",
      type: "order_created",
      timestamp_ms: RECEIVED_MS,
      data: { type: "contents" },
      action_source: "offline",
      oppref: "abc123XYZ",
      user: { emails_sha256: [SHA_EMAIL], phone_numbers_sha256: [SHA_PHONE] },
    });
  });

  it("puts validate_only at the top level, beside events and never inside one", () => {
    // It is a REQUEST field. Inside the event it would be ignored, the request
    // would record real conversions, and the dry run would look like it worked.
    const payload = buildOpenaiPayload({ ...base, validateOnly: true });
    expect(payload.validate_only).toBe(true);
    expect("validate_only" in payload.events[0]).toBe(false);
    expect(Object.keys(payload).sort()).toEqual(["events", "validate_only"]);
  });

  it("omits validate_only entirely when it is off", () => {
    for (const validateOnly of [false, undefined, "", 0]) {
      const payload = buildOpenaiPayload({ ...base, validateOnly });
      expect("validate_only" in payload, String(validateOnly)).toBe(false);
      expect(Object.keys(payload), String(validateOnly)).toEqual(["events"]);
    }
  });

  it("never carries an amount or a currency, at any stage", () => {
    // Decided 2026-10-14, mirroring Meta's Purchase: OpenAI learns that a
    // deposit happened, not what it was worth, so there is no return-on-ad-spend
    // on either platform. Both fields are optional and currency is required only
    // beside an amount, so the event is valid without the pair.
    for (const stage of ALL_STAGES) {
      const serialised = JSON.stringify(buildOpenaiPayload({ ...base, stage }));
      expect(serialised, stage).not.toContain("amount");
      expect(serialised, stage).not.toContain("currency");
    }
    const { data } = buildOpenaiPayload({ ...base, stage: "first_deposit" }).events[0];
    expect(Object.keys(data)).toEqual(["type"]);
  });

  it("builds nothing for a stage the taxonomy has no event for", () => {
    // The second half of decideOpenaiSkip's last test rather than a separate
    // opinion: an event with no name, or a family that is not the one its name
    // requires, is rejected outright.
    expect(buildOpenaiPayload({ ...base, stage: "appointment" })).toBeNull();
    expect(buildOpenaiPayload({ ...base, stage: "" })).toBeNull();
    expect(buildOpenaiPayload({ ...base, stage: "__proto__" })).toBeNull();
    expect(buildOpenaiPayload()).toBeNull();
  });
});

describe("readOpenaiError", () => {
  it("finds an error however the undocumented body carries it", () => {
    expect(readOpenaiError({ error: "bad request" })).toEqual({ message: "bad request" });
    expect(readOpenaiError({ error: { message: "bad data.type" } })).toEqual({ message: "bad data.type" });
    expect(readOpenaiError({ error: { code: "invalid_event", message: "nope" } })).toEqual({
      message: "invalid_event: nope",
    });
    expect(readOpenaiError({ errors: [{ message: "first" }, { message: "second" }] })).toEqual({
      message: "first",
    });
    expect(readOpenaiError({ error: { detail: "a detail" } })).toEqual({ message: "a detail" });
  });

  it("reads a body with no error as no error", () => {
    expect(readOpenaiError({})).toBeNull();
    expect(readOpenaiError({ ok: true })).toBeNull();
    expect(readOpenaiError(null)).toBeNull();
    expect(readOpenaiError(undefined)).toBeNull();
    expect(readOpenaiError("not an object")).toBeNull();
  });

  it("treats an explicitly empty error as no error, not as a nameless one", () => {
    // A body saying "error": null is saying there was none.
    expect(readOpenaiError({ error: null })).toBeNull();
    expect(readOpenaiError({ error: false })).toBeNull();
    expect(readOpenaiError({ error: "" })).toBeNull();
    expect(readOpenaiError({ errors: [] })).toBeNull();
  });

  it("reports an error that carries no message, rather than losing it", () => {
    expect(readOpenaiError({ error: {} })).toEqual({ message: "" });
  });

  it("bounds the message, since it lands in a stored and logged detail", () => {
    expect(readOpenaiError({ error: "x".repeat(500) }).message).toHaveLength(200);
  });
});

describe("classifyOpenaiOutcome", () => {
  it("treats a 2xx with no error in its body as sent", () => {
    expect(classifyOpenaiOutcome({ httpStatus: 200, body: {} })).toEqual({
      status: "sent",
      retryable: false,
      detail: "http 200",
    });
    expect(classifyOpenaiOutcome({ httpStatus: 202, body: { error: null } }).status).toBe("sent");
  });

  it("does not call a 2xx carrying an error a success", () => {
    // A 200 is not proof. One bad event fails the whole request, and the
    // response shape is undocumented, so the body is where a refusal shows up
    // and nothing in the status says so.
    const refused = classifyOpenaiOutcome({
      httpStatus: 200,
      body: { error: { code: "invalid_event", message: "data.type does not match event_name" } },
    });
    expect(refused.status).toBe("rejected");
    expect(refused.retryable).toBe(false);
    expect(refused.detail).toContain("data.type does not match event_name");

    expect(classifyOpenaiOutcome({ httpStatus: 200, body: { errors: [{ message: "nope" }] } }).status).toBe(
      "rejected"
    );
  });

  it("retries transport errors, 429 and 5xx", () => {
    expect(classifyOpenaiOutcome({ transportError: new Error("ETIMEDOUT") })).toEqual({
      status: "failed",
      retryable: true,
      detail: "transport: ETIMEDOUT",
    });
    for (const httpStatus of [429, 500, 502, 503]) {
      const result = classifyOpenaiOutcome({ httpStatus, body: {} });
      expect(result.retryable, String(httpStatus)).toBe(true);
      expect(result.status, String(httpStatus)).toBe("failed");
    }
  });

  it("retries a 408 Request Timeout, which is transient by definition", () => {
    expect(classifyOpenaiOutcome({ httpStatus: 408, body: {} })).toEqual({
      status: "failed",
      retryable: true,
      detail: "http 408",
    });
  });

  it("retries 408 alone among the 4xx, so its neighbours stay permanent", () => {
    for (const httpStatus of [400, 401, 403, 404, 405, 407, 409, 410, 422]) {
      const result = classifyOpenaiOutcome({ httpStatus, body: {} });
      expect(result.retryable, String(httpStatus)).toBe(false);
      expect(result.status, String(httpStatus)).toBe("rejected");
    }
  });

  it("tells OpenAI refusing the event from us giving up on it", () => {
    // planRetry writes `failed` the moment a retryable outcome runs out of
    // attempts, so `failed` has to mean exactly that. With one word for both, a
    // key paired with the wrong ad account would read on the destination card
    // exactly like a transport outage.
    expect(classifyOpenaiOutcome({ httpStatus: 401, body: { error: "invalid key" } }).status).toBe(
      "rejected"
    );
    expect(classifyOpenaiOutcome({ transportError: new Error("ENOTFOUND") }).status).toBe("failed");
  });

  it("keeps OpenAI's own message on a rejection", () => {
    const result = classifyOpenaiOutcome({
      httpStatus: 400,
      body: { error: { code: "invalid_custom_event_name", message: "reuses a built-in name" } },
    });
    expect(result.detail).toBe("http 400 invalid_custom_event_name: reuses a built-in name");
  });

  it("keeps OpenAI's own message on a retryable 429 or 5xx too", () => {
    for (const httpStatus of [429, 502]) {
      const result = classifyOpenaiOutcome({ httpStatus, body: { error: "upstream timed out" } });
      expect(result.retryable, String(httpStatus)).toBe(true);
      expect(result.detail, String(httpStatus)).toContain("upstream timed out");
    }
  });

  it("says so when an error arrived with no message at all", () => {
    expect(classifyOpenaiOutcome({ httpStatus: 400, body: { error: {} } }).detail).toBe(
      "http 400 error reported with no message"
    );
  });

  it("takes a 2xx whose body it could not read as sent, and records that it read none", () => {
    // NOT how Meta treats one, deliberately. Meta's success body always carries
    // events_received, so its absence means a proxy answered instead of Meta.
    // OpenAI's response shape is not documented at all, so an empty, non-JSON or
    // 204 body is the API behaving as documented -- as nothing. Calling that
    // unknown would make every event of a healthy integration spend its whole
    // retry budget and settle `failed`.
    expect(classifyOpenaiOutcome({ httpStatus: 200, body: null, bodyUnreadable: true })).toEqual({
      status: "sent",
      retryable: false,
      detail: "http 200 unreadable body",
    });
    expect(classifyOpenaiOutcome({ httpStatus: 204, body: null, bodyUnreadable: true }).status).toBe("sent");
  });

  it("says the body timed out in preference to calling it unreadable", () => {
    // A timeout IS an unreadable body, and "it never arrived" is the more useful
    // of the two things to be told.
    expect(
      classifyOpenaiOutcome({ httpStatus: 200, body: null, bodyTimedOut: true, bodyUnreadable: true })
    ).toEqual({ status: "sent", retryable: false, detail: "http 200 body timed out" });
  });

  it("keeps a non-2xx whose body never arrived permanent, which parts company with Meta", () => {
    // Meta carries its throttle codes in the body, so an unreadable 400 might be
    // a throttle and is retried. OpenAI documents no error codes and no rate
    // limit, so there is nothing an unreadable body might have said that would
    // change the verdict, and the status is the whole of what decides.
    expect(classifyOpenaiOutcome({ httpStatus: 400, body: null, bodyTimedOut: true })).toEqual({
      status: "rejected",
      retryable: false,
      detail: "http 400 body timed out",
    });
    expect(classifyOpenaiOutcome({ httpStatus: 400, body: null, bodyUnreadable: true })).toEqual({
      status: "rejected",
      retryable: false,
      detail: "http 400 unreadable body",
    });
  });

  it("still retries a 5xx whose body never arrived, since the status already decided", () => {
    expect(classifyOpenaiOutcome({ httpStatus: 503, body: null, bodyUnreadable: true })).toEqual({
      status: "failed",
      retryable: true,
      detail: "http 503 unreadable body",
    });
  });

  it("treats a response we never understood at all as a rejection, not a send", () => {
    expect(classifyOpenaiOutcome({ httpStatus: 0 }).status).toBe("rejected");
    expect(classifyOpenaiOutcome({}).status).toBe("rejected");
  });

  it("bounds a transport message, since the detail is stored and logged", () => {
    const result = classifyOpenaiOutcome({ transportError: new Error("x".repeat(500)) });
    expect(result.detail).toHaveLength("transport: ".length + 200);
  });
});

describe("sendOpenaiEvent", () => {
  const ok = () => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));

  it("posts to the events endpoint with the pixel id on the query string", async () => {
    const fetchImpl = ok();
    await sendOpenaiEvent({ fetchImpl, pixelId: "px_1", apiKey: "sk-test", payload: { events: [] } });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://bzr.openai.com/v1/events?pid=px_1");
    expect(OPENAI_EVENTS_URL).toBe("https://bzr.openai.com/v1/events");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("sends the key as a Bearer token in a header, never on the query string", async () => {
    // Structural: no part of the request line can carry the key anywhere.
    const fetchImpl = ok();
    await sendOpenaiEvent({ fetchImpl, pixelId: "px_1", apiKey: "sk-test", payload: {} });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(url).not.toContain("sk-test");
  });

  it("percent-encodes the pixel id, and it reads back intact", async () => {
    const fetchImpl = ok();
    await sendOpenaiEvent({ fetchImpl, pixelId: "a&b c", apiKey: "sk-test", payload: {} });
    const [url] = fetchImpl.mock.calls[0];
    expect(new URL(url).searchParams.get("pid")).toBe("a&b c");
  });

  it("posts to the endpoint it is given, so a dry run can be pointed elsewhere", async () => {
    const fetchImpl = ok();
    await sendOpenaiEvent({
      fetchImpl,
      eventsUrl: "https://example.test/v1/events",
      pixelId: "px_1",
      apiKey: "sk-test",
      payload: {},
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://example.test/v1/events?pid=px_1");
  });

  it("sends the payload as JSON in the body", async () => {
    const payload = {
      events: [{ id: "42:verified", type: "custom", timestamp_ms: RECEIVED_MS }],
      validate_only: true,
    };
    const fetchImpl = ok();
    await sendOpenaiEvent({ fetchImpl, pixelId: "px_1", apiKey: "sk-test", payload });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(payload);
  });

  it("turns a thrown fetch into a retryable outcome rather than an exception", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    const result = await sendOpenaiEvent({ fetchImpl, pixelId: "px_1", apiKey: "sk-test", payload: {} });
    expect(result).toEqual({ status: "failed", retryable: true, detail: "transport: ENOTFOUND" });
  });

  it("treats a thrown falsy value as a transport failure, not as something that falls through", async () => {
    for (const thrown of [undefined, null, ""]) {
      const fetchImpl = vi.fn(async () => {
        throw thrown;
      });
      const result = await sendOpenaiEvent({ fetchImpl, pixelId: "px_1", apiKey: "sk-test", payload: {} });
      expect(result.status, String(thrown)).toBe("failed");
      expect(result.retryable, String(thrown)).toBe(true);
      expect(result.detail, String(thrown)).toBe("transport: unknown");
    }
  });

  it("never puts the API key in the returned detail", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid key" }),
    }));
    const result = await sendOpenaiEvent({
      fetchImpl,
      pixelId: "px_1",
      apiKey: "sk-s3cret-key",
      payload: {},
    });
    expect(result.detail).not.toContain("sk-s3cret-key");
  });

  it("keeps the key out of the detail when a transport error echoes the header", async () => {
    // Native fetch does not echo the headers, but an injected fetchImpl can, and
    // the detail is both logged and stored.
    const key = "sk-s3cret-key";
    const fetchImpl = vi.fn(async (url, init) => {
      throw new Error(`request failed with ${init.headers.Authorization}`);
    });
    const result = await sendOpenaiEvent({ fetchImpl, pixelId: "px_1", apiKey: key, payload: {} });
    expect(result.retryable).toBe(true);
    expect(result.detail).not.toContain(key);
    expect(result.detail).toBe("transport: request failed with Bearer [redacted]");
  });

  it("redacts a Bearer token whose form we did not build", async () => {
    // Structural, like Meta's access_token= pass: whatever follows "Bearer " is
    // the key, in whatever form the thrower wrote it. Only this pass can catch a
    // value something else re-encoded.
    const fetchImpl = vi.fn(async () => {
      throw new Error("Authorization: Bearer c2stczNjcmV0 rejected");
    });
    const result = await sendOpenaiEvent({ fetchImpl, pixelId: "px_1", apiKey: "sk-s3cret", payload: {} });
    expect(result.detail).not.toContain("c2stczNjcmV0");
    expect(result.detail).toBe("transport: Authorization: Bearer [redacted] rejected");
  });

  it("leaves no residue when the key is a substring of its own encoded form", async () => {
    // "%25" encodes to "%2525", which contains "%25". Replacing the raw form
    // first would leave "[redacted]25" behind, so the encoded form goes first.
    const key = "%25";
    const fetchImpl = vi.fn(async () => {
      throw new Error(`rejected ${encodeURIComponent(key)} now`);
    });
    const result = await sendOpenaiEvent({ fetchImpl, pixelId: "px_1", apiKey: key, payload: {} });
    expect(result.detail).toBe("transport: rejected [redacted] now");
  });

  it("redacts every occurrence of the key, not only the first", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("first sk-s3cret, then sk-s3cret again");
    });
    const result = await sendOpenaiEvent({ fetchImpl, pixelId: "px_1", apiKey: "sk-s3cret", payload: {} });
    expect(result.detail).toBe("transport: first [redacted], then [redacted] again");
  });

  it("does not throw on a response whose body is not JSON", async () => {
    // A load balancer answering with an HTML page is ordinary. A 2xx is still a
    // send; a non-2xx is still a rejection.
    const html = (status) =>
      vi.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
          throw new SyntaxError("Unexpected token '<'");
        },
      }));
    const send = (fetchImpl) => sendOpenaiEvent({ fetchImpl, pixelId: "px_1", apiKey: "sk-test", payload: {} });

    expect(await send(html(200))).toEqual({
      status: "sent",
      retryable: false,
      detail: "http 200 unreadable body",
    });
    expect(await send(html(204))).toEqual({
      status: "sent",
      retryable: false,
      detail: "http 204 unreadable body",
    });
    expect((await send(html(503))).retryable).toBe(true);
    expect((await send(html(400))).status).toBe("rejected");
  });

  it("reports a 2xx carrying an error as a rejection, not a send", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: { message: "custom_event_name is required" } }),
    }));
    const result = await sendOpenaiEvent({ fetchImpl, pixelId: "px_1", apiKey: "sk-test", payload: {} });
    expect(result.status).toBe("rejected");
    expect(result.detail).toContain("custom_event_name is required");
  });
});

describeSendTimeout("sendOpenaiEvent", {
  ok: () => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
  send: (fetchImpl) => sendOpenaiEvent({ fetchImpl, pixelId: "px_1", apiKey: "sk-test", payload: {} }),
});

describe("sendOpenaiEvent when the response body times out", () => {
  // The timeout signal bounds reading the body as well as the headers, so a
  // stall after the status line ends in json() rejecting with a TimeoutError.
  // The sender swallows that like any unreadable body, and the outcome falls out
  // of the status alone. Pinned per sender because the four differ on purpose.
  const send = (fetchImpl) => sendOpenaiEvent({ fetchImpl, pixelId: "px_1", apiKey: "sk-test", payload: {} });

  it("takes a 2xx whose body timed out as sent, because the body proves nothing either way", async () => {
    const r = await send(vi.fn(async () => stalledBodyResponse(200)));
    expect(r).toEqual({ status: "sent", retryable: false, detail: "http 200 body timed out" });
  });

  it("keeps a non-2xx whose body timed out permanent, unlike Meta", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const r = await send(vi.fn(async () => stalledBodyResponse(status)));
      expect(r, String(status)).toEqual({
        status: "rejected",
        retryable: false,
        detail: `http ${status} body timed out`,
      });
    }
  });

  it("still retries a transient status whose body timed out", async () => {
    for (const status of [408, 429, 503]) {
      const r = await send(vi.fn(async () => stalledBodyResponse(status)));
      expect(r, String(status)).toEqual({
        status: "failed",
        retryable: true,
        detail: `http ${status} body timed out`,
      });
    }
  });
});
