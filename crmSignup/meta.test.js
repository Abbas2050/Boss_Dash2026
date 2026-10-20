// @vitest-environment node
//
// The Conversions API half. Two of the three failure modes here produce no
// error at all -- Meta accepts the event and silently fails to match it -- so
// the hashing and the fixed constants are pinned by test rather than by care.
import { describe, it, expect, vi } from "vitest";
import { describeSendTimeout, stalledBodyResponse } from "./sendTimeout.contract.js";
import {
  META_EVENT_NAMES,
  decideMetaSkip,
  hashEmail,
  hashPhone,
  hashName,
  hashExternalId,
  buildMetaPayload,
  metaValueFields,
  classifyMetaOutcome,
  sendMetaEvent,
} from "./meta.js";

describe("event names", () => {
  it("maps every stage, and maps them to Meta's own vocabulary", () => {
    // Written out in full rather than spot-checked: Meta accepts an event name
    // it will not keep, so a name crossed between two stages is invisible on
    // our side and arrives as the wrong conversion on theirs.
    expect(META_EVENT_NAMES).toEqual({
      lead: "Lead",
      registered: "CompleteRegistration",
      verified: "StartTrial",
      live_account: "SubmitApplication",
      first_deposit: "Purchase",
    });
  });

  it("sends only names from Meta's standard list, because a custom one is invisible", () => {
    // The invariant the 19 October experiment bought, and the one that would
    // have caught the original bug: a custom event name is accepted with a 200
    // and `events_received: 1`, then filed under `unverifiedEventNames` and
    // never shown. Proven 20 October -- one client, three stages, four minutes:
    // `SubmitApplication` and `Purchase` appeared, `ApprovedApplication` did
    // not, and the signals config listed it beside `TradingAccountOpened` and
    // `Client_Verified`. Nothing about the payload differed, so the name is the
    // whole mechanism.
    //
    // Meta's 17 standard events, in full. Anything outside this set is custom,
    // and custom is invisible -- so a new stage must pick from here, however
    // badly the name reads. The readable label is a Custom Conversion built on
    // top; it is not this string.
    const STANDARD_EVENTS = new Set([
      "AddPaymentInfo",
      "AddToCart",
      "AddToWishlist",
      "CompleteRegistration",
      "Contact",
      "CustomizeProduct",
      "Donate",
      "FindLocation",
      "InitiateCheckout",
      "Lead",
      "PageView",
      "Purchase",
      "Schedule",
      "Search",
      "StartTrial",
      "SubmitApplication",
      "Subscribe",
      "ViewContent",
    ]);
    const custom = Object.entries(META_EVENT_NAMES).filter(
      ([, name]) => !STANDARD_EVENTS.has(name),
    );
    expect(custom).toEqual([]);
  });
});

describe("decideMetaSkip", () => {
  const ALL_STAGES = ["lead", "registered", "verified", "live_account", "first_deposit"];

  it("skips every stage when there is no token", () => {
    for (const stage of ALL_STAGES) {
      expect(decideMetaSkip({ stage, accessToken: "" })).toEqual({ reason: "meta not configured" });
    }
  });

  it("names the missing token before the stage, so a misconfiguration is not read as a design choice", () => {
    // Both reasons are true for `registered` with no token. The configuration
    // one is the actionable one.
    expect(decideMetaSkip({ stage: "registered", accessToken: "   " })).toEqual({
      reason: "meta not configured",
    });
  });

  it("skips registered, because the website pixel still owns CompleteRegistration", () => {
    // 2026-10-14, user's call: the WordPress plugin keeps firing the
    // CompleteRegistration pixel event, so sending it from here too would
    // book the same conversion twice. Deduplicating instead would need the
    // browser's event_id carried through the CRM, which FXBO cannot do.
    expect(decideMetaSkip({ stage: "registered", accessToken: "tok" })).toEqual({
      reason: "registered is owned by the website pixel",
    });
  });

  it("sends the other four stages, which no pixel fires", () => {
    for (const stage of ALL_STAGES.filter((s) => s !== "registered")) {
      expect(decideMetaSkip({ stage, accessToken: "tok" })).toBeNull();
    }
  });

  it("still maps registered to an event name, so lifting the gate needs no second change", () => {
    expect(META_EVENT_NAMES.registered).toBe("CompleteRegistration");
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

describe("hashing a name", () => {
  // Checked against the three worked examples Meta publishes for `fn`, digests
  // and all, rather than against our own idea of the rule. These are the only
  // normalised-name digests we have from Meta's side, and the whole question is
  // whether our digest equals theirs -- a rule we agree with ourselves about is
  // worth nothing here, because a mismatch produces no error at either end.
  it("matches Meta's own published digests for its own examples", () => {
    expect(hashName("Mary")).toBe("6915771be1c5aa0c886870b6951b03d7eafc121fea0e80a5ea83beb7c449f4ec");
    // The accented example, which is why accents are lowercased and NOT folded:
    // `valery` would hash to something Meta never computes.
    expect(hashName("Valéry")).toBe("08e1996b5dd49e62a4b4c010d44e4345592a863bb9f8e3976219bac29417149c");
    // And a non-Roman name, hashed as UTF-8 and otherwise untouched.
    expect(hashName("정")).toBe("8fa8cd9c440be61d0151429310034083132b35975c4bea67fdd74158eb51db14");
  });

  it("strips punctuation, which is where the name rule parts from the email rule", () => {
    // "Lowercase only with no punctuation". Copying hashEmail would lowercase
    // and trim and stop, and every apostrophe and hyphen in the CRM would then
    // hash to a digest Meta cannot match -- with nothing to see on either side.
    expect(hashName("O'Brien")).toBe(hashName("obrien"));
    expect(hashName("Jean-Luc")).toBe(hashName("jeanluc"));
    expect(hashName("St. John")).toBe(hashName("st john"));
    // A curly apostrophe is punctuation too; FXBO's fields are free text and a
    // phone keyboard types this one.
    expect(hashName("O’Brien")).toBe(hashName("obrien"));
  });

  it("keeps an internal space, collapsed, because a space is not punctuation", () => {
    // Meta's rule says nothing about whitespace, so the least destructive
    // reading is the right one: "Mary Ann" is one first name, not "maryann".
    expect(hashName("  Mary   Ann  ")).toBe("343b97011010c3549fe7fcd6c226ed9431ea37b0b77ed78f6300a0098925faf1");
  });

  it("returns empty for a missing name rather than hashing the empty string", () => {
    // FXBO sends no last name for a good many leads. sha256("") would go out as
    // that client's surname, and as the SAME surname for every one of them: one
    // shared fake identity, which is worse than the missing field it replaces.
    for (const absent of ["", "   ", null, undefined]) {
      expect(hashName(absent), JSON.stringify(absent)).toBe("");
    }
    // And a value that is nothing but punctuation normalises to nothing, so it
    // must not sneak past the emptiness check either.
    expect(hashName("--")).toBe("");
  });
});

describe("hashing the external id", () => {
  it("hashes the id as the CRM holds it, normalising nothing", () => {
    // Meta states no normalisation for external_id, only consistency: the same
    // id, in the same format, everywhere we send it. Lowercasing or stripping
    // punctuation here would produce a digest nothing else can reproduce.
    expect(hashExternalId("88214")).toBe("07b4f89e5ffd3e063651bb366e38f9e416b4a971ea93d78a95d72241a6e90744");
    expect(hashExternalId("AB-882")).not.toBe(hashExternalId("ab882"));
    expect(hashExternalId("AB-882")).not.toBe(hashName("AB-882"));
  });

  it("trims transport whitespace, because that is not part of the id", () => {
    expect(hashExternalId("  88214 ")).toBe(hashExternalId("88214"));
  });

  it("returns empty for a missing id rather than hashing the empty string", () => {
    for (const absent of ["", "   ", null, undefined]) {
      expect(hashExternalId(absent), JSON.stringify(absent)).toBe("");
    }
  });
});

describe("buildMetaPayload", () => {
  const base = {
    stage: "verified",
    email: "ali.khan@example.com",
    phone: "+971507192185",
    firstName: "Ali",
    lastName: "Khan",
    crmClientId: "88214",
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
    expect(event.event_name).toBe("StartTrial");
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

  // The Event Match Quality parameters added 2026-10-20. Meta's panel for this
  // dataset reported `user_data` carrying only `em`, `ph` and `fbc`, and named
  // these three as the available gains -- the only recommended ones this service
  // can supply truthfully.
  it("carries exactly the six user_data parameters, and no invented one", () => {
    // Pinned as a whole set, in both directions. A dropped key is an uplift
    // silently not taken; an added one is the real hazard, because the four
    // Meta's panel also recommends -- IP, user agent, referrer, event source
    // URL -- are all fillable from the incoming request and all WRONG from it.
    const { user_data } = buildMetaPayload(base).data[0];
    expect(Object.keys(user_data).sort()).toEqual(["em", "external_id", "fbc", "fn", "ln", "ph"]);
  });

  it("sends nothing reconstructed from the incoming HTTP request", () => {
    // Our incoming request is FXBO's webhook from an Azure server, not the
    // client's browser, so each of these would carry FXBO's own identity --
    // identically for every client and every event. A uniform fake value
    // degrades matching while the panel's coverage figure reads as an
    // improvement, which is why this is forbidden by test and not by comment.
    //
    // Checked over the whole serialised payload rather than over one object:
    // `event_source_url` sits on the event and `client_ip_address` inside
    // `user_data`, and the mutation could add either in either place. The
    // `user_agent` substring covers Meta's own spelling, `client_user_agent`.
    const serialised = JSON.stringify(buildMetaPayload({ ...base, stage: "first_deposit" }));
    for (const forbidden of ["client_ip_address", "user_agent", "referrer_url", "event_source_url", "fbp"]) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });

  it("sends external_id as a hash of the CRM client id and nothing else", () => {
    // Derived from the client id, which is also what event_id is built from --
    // Meta's one stated rule for external_id is that the same id goes out in
    // the same format everywhere. Built from the email or the fbc instead it
    // would still be a plausible 64-hex digest in the right place.
    const { user_data } = buildMetaPayload(base).data[0];
    expect(user_data.external_id).toEqual([hashExternalId("88214")]);
    expect(user_data.external_id).not.toEqual([hashEmail(base.email)]);
    expect(user_data.external_id).not.toEqual([hashPhone(base.phone)]);
    // And it moves with the client id rather than with anything else on the row.
    const other = buildMetaPayload({ ...base, crmClientId: "88215" }).data[0].user_data;
    expect(other.external_id).not.toEqual(user_data.external_id);
    expect(other.em).toEqual(user_data.em);
  });

  it("hashes the external id rather than sending the client id in the clear", () => {
    // `user_data`, not the whole payload: `event_id` carries the same client id
    // unhashed and is meant to, being a dedupe key rather than a matcher.
    const { user_data } = buildMetaPayload({ ...base, eventId: "88214:verified" }).data[0];
    expect(JSON.stringify(user_data)).not.toContain("88214");
    expect(user_data.external_id[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends fn and ln as single-element arrays of hashes, never raw and never bare", () => {
    // `string or list<string>` on Meta's side, so the shape is a choice and the
    // choice is the one em and ph already use -- fbc is a bare string because
    // its type IS string. A bare string here, or a nested array, is a shape Meta
    // may take without comment and we would never know.
    const { user_data } = buildMetaPayload(base).data[0];
    for (const key of ["fn", "ln", "external_id"]) {
      expect(Array.isArray(user_data[key]), key).toBe(true);
      expect(user_data[key].length, key).toBe(1);
      expect(typeof user_data[key][0], key).toBe("string");
      expect(user_data[key][0], key).toMatch(/^[0-9a-f]{64}$/);
    }
    const serialised = JSON.stringify(buildMetaPayload(base));
    expect(serialised).not.toContain("Ali");
    expect(serialised).not.toContain("Khan");
  });

  it("hashes the NORMALISED name, not the name as the CRM typed it", () => {
    // The punctuation rule is the half a copied email helper would miss, and
    // the digest of "o'brien" is unrelated to the digest of "obrien".
    const { user_data } = buildMetaPayload({
      ...base,
      firstName: " Jean-Luc ",
      lastName: "O'Brien",
    }).data[0];
    expect(user_data.fn).toEqual([hashName("jeanluc")]);
    expect(user_data.ln).toEqual([hashName("obrien")]);
    expect(user_data.fn).not.toEqual([hashEmail(" Jean-Luc ")]);
    expect(user_data.ln).not.toEqual([hashEmail("O'Brien")]);
  });

  it("omits fn and ln when the name is missing instead of hashing the empty string", () => {
    // sha256("") is a valid digest, and it would be the SAME surname for every
    // client whose last name FXBO never sent.
    const { user_data } = buildMetaPayload({ ...base, firstName: "", lastName: "" }).data[0];
    expect("fn" in user_data).toBe(false);
    expect("ln" in user_data).toBe(false);
    expect(JSON.stringify(user_data)).not.toContain(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("omits external_id when there is no client id, rather than hashing nothing", () => {
    const { user_data } = buildMetaPayload({ ...base, crmClientId: "" }).data[0];
    expect("external_id" in user_data).toBe(false);
  });

  it("builds a scrubbed row's payload out of what survives, inventing no identity", () => {
    // The scrub NULLs first_name, last_name, email and phone, so rowToFields
    // hands this empty strings for all four; crm_client_id and fbc survive it
    // deliberately. processSignupEvent refuses a scrubbed row outright, so this
    // should never run -- and if some later change makes such a row claimable,
    // the degradation has to be omitted keys and not a hash of "" or of a
    // placeholder word, which would be one uniform fake identity shared by
    // every client in the table.
    const { user_data } = buildMetaPayload({
      ...base,
      email: "",
      phone: "",
      firstName: "",
      lastName: "",
    }).data[0];
    expect(Object.keys(user_data).sort()).toEqual(["external_id", "fbc"]);
    const serialised = JSON.stringify(user_data);
    for (const digest of [
      // sha256("")
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      // sha256("scrubbed"), the placeholder nobody should ever reach for
      "4848b001e417e7514a51465ecf92ee8631ccbb31ba5e8ba413ff5b3f6ca9ceac",
    ]) {
      expect(serialised, digest).not.toContain(digest);
    }
    // The literal word is not a name either, whatever a future scrub writes.
    expect(hashName("scrubbed")).not.toBe("");
    expect(serialised).not.toContain(hashName("scrubbed"));
  });

  it("sends the three new parameters at every stage, not only at the deposit", () => {
    // Read off META_EVENT_NAMES rather than a list written here, so a stage
    // added later is covered by this without anybody remembering to add it.
    for (const stage of Object.keys(META_EVENT_NAMES)) {
      const { user_data } = buildMetaPayload({ ...base, stage }).data[0];
      expect(Object.keys(user_data).sort(), stage).toEqual(["em", "external_id", "fbc", "fn", "ln", "ph"]);
    }
  });

  it("carries no value and no currency when the caller gives no deposit value", () => {
    // Every stage but the first deposit, where there is no amount to send.
    // custom_data then holds the two CRM constants and nothing else.
    for (const stage of ["registered", "verified", "live_account", "first_deposit"]) {
      for (const depositValue of [undefined, null]) {
        const { custom_data } = buildMetaPayload({ ...base, stage, depositValue }).data[0];
        expect(Object.keys(custom_data).sort(), stage).toEqual(["event_source", "lead_event_source"]);
      }
    }
  });

  // $129.99, chosen because the decimal and the minor-unit integer differ. A
  // round amount would pass with the two units crossed.
  const DEPOSIT = { currency: "USD", valueDecimal: 129.99, amountMinor: 12999 };

  it("sends the deposit's value and currency on the Purchase event", () => {
    // Superseding the 13 October decision to send neither (2026-10-19): Meta
    // answers 200 with events_received: 1 and then DISCARDS a Purchase with no
    // value, so the conversion never existed. Diagnostic
    // s2s_invalid_purchase_event_actions, raised 2026-10-16.
    const { custom_data } = buildMetaPayload({ ...base, stage: "first_deposit", depositValue: DEPOSIT }).data[0];
    expect(custom_data.value).toBe(129.99);
    expect(custom_data.currency).toBe("USD");
    expect(Object.keys(custom_data).sort()).toEqual(["currency", "event_source", "lead_event_source", "value"]);
  });

  it("puts the DECIMAL in value, never the minor-unit integer", () => {
    // ChatGPT Ads wants this same deposit as the integer 12999. The two differ
    // by a factor of a hundred and Meta would accept either without a word --
    // the only symptom of a swap is somebody else's dashboard reporting the
    // deposit a hundredfold.
    const { custom_data } = buildMetaPayload({ ...base, stage: "first_deposit", depositValue: DEPOSIT }).data[0];
    expect(custom_data.value).toBe(129.99);
    expect(custom_data.value).not.toBe(12999);
    expect(typeof custom_data.value).toBe("number");
  });

  it("sends both halves of the pair or neither, never one of them", () => {
    // "All purchase events must contain a value parameter AND a currency
    // parameter": a Purchase carrying one of them is the same defect in a new
    // shape, and Meta reports it the same way -- by accepting and discarding.
    const half = [
      { currency: "USD", valueDecimal: null },
      { currency: "USD", valueDecimal: 0 },
      { currency: "USD", valueDecimal: "abc" },
      { currency: "USD" },
      { currency: "", valueDecimal: 129.99 },
      { currency: "USDT", valueDecimal: 129.99 },
      { currency: "US", valueDecimal: 129.99 },
      { valueDecimal: 129.99 },
      {},
    ];
    for (const depositValue of half) {
      const { custom_data } = buildMetaPayload({ ...base, stage: "first_deposit", depositValue }).data[0];
      const keys = Object.keys(custom_data).sort();
      expect(keys, JSON.stringify(depositValue)).toEqual(["event_source", "lead_event_source"]);
    }
  });

  it("uppercases the currency and keeps value a number", () => {
    const { custom_data } = buildMetaPayload({
      ...base,
      stage: "first_deposit",
      depositValue: { currency: " usd ", valueDecimal: 129.99 },
    }).data[0];
    expect(custom_data.currency).toBe("USD");
    expect(JSON.stringify(custom_data)).toContain('"value":129.99');
  });

  it("builds both halves from one function, so neither can be attached alone", () => {
    // The guard is structural rather than a pair of ifs at the call site: two
    // conditions are what makes the half-filled event constructible.
    expect(metaValueFields(DEPOSIT)).toEqual({ value: 129.99, currency: "USD" });
    expect(metaValueFields({ currency: "USD" })).toEqual({});
    expect(metaValueFields({ valueDecimal: 129.99 })).toEqual({});
    expect(metaValueFields(null)).toEqual({});
    expect(metaValueFields()).toEqual({});
  });

  it("prices nothing in a currency the allowlist does not hold, crypto above all", () => {
    // **Defence in depth against the hole that was already found once.**
    // `/^[A-Z]{3}$/` let BTC through on this branch, and Meta then silently
    // ignores a currency it cannot read -- so a 0.4 BTC deposit was reported as
    // 0.40 of something. Nothing but a settled code should reach this function
    // today, but that is a fact about today's wiring, not about the function: a
    // new stage or a future caller would walk straight back into it.
    for (const currency of ["BTC", "ETH", "XRP", "LTC", "ADA", "SOL", "TRX", "BNB", "XBT", "ZZZ"]) {
      expect(
        metaValueFields({ currency, valueDecimal: 129.99, amountMinor: 12999 }),
        currency
      ).toEqual({});
    }
  });

  it("prices nothing in a stablecoin ticker, because settling is not its job", () => {
    // A pegged code arriving HERE has not been through settlementCurrency, so
    // its amount was never rescaled to USD's two places. Mapping it at this
    // point would relabel a number rather than convert it, which is why this
    // refuses rather than settles.
    for (const currency of ["USDT", "USDC", "USDTTRC20", "PAX", "TUSD"]) {
      expect(metaValueFields({ currency, valueDecimal: 100 }), currency).toEqual({});
    }
  });

  it("still prices an ordinary currency, so the allowlist is a gate and not a wall", () => {
    for (const currency of ["USD", "EUR", "GBP", "AED", "JPY", "KWD", "BRL", "ETB"]) {
      expect(metaValueFields({ currency, valueDecimal: 129.99 }), currency).toEqual({
        value: 129.99,
        currency,
      });
    }
    // Still normalised on the way through.
    expect(metaValueFields({ currency: " aed ", valueDecimal: 1 })).toEqual({ value: 1, currency: "AED" });
  });

  it("keeps both-or-neither when the currency is the half that is refused", () => {
    // The narrowing must not have turned into "send the value alone".
    const { custom_data } = buildMetaPayload({
      ...base,
      stage: "first_deposit",
      depositValue: { currency: "BTC", valueDecimal: 0.4 },
    }).data[0];
    expect(Object.keys(custom_data).sort()).toEqual(["event_source", "lead_event_source"]);
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

  it("retries a 408 Request Timeout, which is transient by definition", () => {
    expect(classifyMetaOutcome({ httpStatus: 408, body: {} })).toEqual({
      status: "failed",
      retryable: true,
      detail: "http 408",
    });
  });

  it("retries 408 alone among the 4xx, so its neighbours stay permanent", () => {
    // Guards the rule from widening into a range such as >= 408.
    for (const httpStatus of [400, 401, 403, 404, 405, 407, 409, 410, 422]) {
      const result = classifyMetaOutcome({ httpStatus, body: {} });
      expect(result.retryable, String(httpStatus)).toBe(false);
      expect(result.status, String(httpStatus)).toBe("rejected");
    }
  });

  it("tells Meta refusing the event from us giving up on it", () => {
    // planRetry writes `failed` the moment a retryable outcome runs out of
    // attempts, so `failed` has to mean exactly that. Spec section 12 lists
    // `rejected` as a counter for all three destinations, and with one word for
    // both, a dead access token reads as `failed 40` beside a transport outage.
    const refused = classifyMetaOutcome({
      httpStatus: 400,
      body: { error: { message: "Invalid OAuth access token", code: 190 } },
    });
    expect(refused.status).toBe("rejected");
    expect(refused.retryable).toBe(false);
    expect(classifyMetaOutcome({ transportError: new Error("ETIMEDOUT") }).status).toBe("failed");
  });

  it("treats other 4xx as permanent and keeps Meta's own message", () => {
    const result = classifyMetaOutcome({
      httpStatus: 400,
      body: { error: { message: "Invalid parameter", code: 100, error_subcode: 2804003 } },
    });
    expect(result.retryable).toBe(false);
    expect(result.status).toBe("rejected");
    expect(result.detail).toContain("Invalid parameter");
  });

  it("does not call a 2xx that received zero events a success", () => {
    // Meta answers 200 while reporting it took nothing.
    const result = classifyMetaOutcome({ httpStatus: 200, body: { events_received: 0 } });
    expect(result.status).toBe("rejected");
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
      status: "rejected",
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

describeSendTimeout("sendMetaEvent", {
  ok: () => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ events_received: 1 }) })),
  send: (fetchImpl) => sendMetaEvent({ fetchImpl, datasetId: "1", accessToken: "t", payload: {} }),
});

describe("sendMetaEvent when the response body times out", () => {
  // The timeout signal bounds reading the body as well as the headers, so a stall
  // after the status line ends in json() rejecting with a TimeoutError. The
  // sender swallows that like any unreadable body, and the outcome falls out of
  // the status alone. Pinned per sender because the three differ on purpose.
  const send = (fetchImpl) => sendMetaEvent({ fetchImpl, datasetId: "1", accessToken: "t", payload: {} });

  it("retries a 2xx whose body timed out: no count is an unknown outcome, and event_id makes a retry safe", async () => {
    const r = await send(vi.fn(async () => stalledBodyResponse(200)));
    expect(r).toEqual({ status: "failed", retryable: true, detail: "http 200 no events_received" });
  });

  it("retries a 400 whose body timed out, since a throttle and a rejection cannot be told apart", async () => {
    // Meta carries its throttle codes in the body (a 400 with code 4), so a body
    // that never arrives leaves a 400 that is either one. A readable throttle is
    // retried and a readable rejection is not; the unreadable one is retried,
    // because not retrying a throttle drops a conversion while retrying a
    // rejection only wastes a call, and event_id makes the retry safe.
    const readable = (error) =>
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error }) }));
    expect((await send(readable({ message: "(#4) Application request limit reached", code: 4 }))).retryable).toBe(true);
    expect((await send(readable({ message: "Invalid parameter", code: 100 }))).retryable).toBe(false);

    const r = await send(vi.fn(async () => stalledBodyResponse(400)));
    expect(r).toEqual({ status: "failed", retryable: true, detail: "http 400 body timed out" });
  });

  it("retries every non-2xx whose body timed out, and says the body timed out", async () => {
    for (const status of [400, 401, 403, 404, 422, 503]) {
      const r = await send(vi.fn(async () => stalledBodyResponse(status)));
      expect(r, String(status)).toEqual({ status: "failed", retryable: true, detail: `http ${status} body timed out` });
    }
  });

  it("does not retry a non-2xx whose body failed for any other reason", async () => {
    // Only a timeout is a body we never saw. A body that arrived and would not
    // parse is a different case, and so is anything thrown that is not an error.
    for (const thrown of [new SyntaxError("Unexpected token <"), new Error("socket hang up"), undefined, null, "oops"]) {
      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => {
          throw thrown;
        },
      }));
      expect(await send(fetchImpl), String(thrown)).toEqual({ status: "rejected", retryable: false, detail: "http 400" });
    }
  });

  it("leaves a 2xx whose body timed out as it was: an unknown outcome, retryable, no count", async () => {
    // The new rule is for a non-2xx. A 2xx keeps its own wording and its own rule.
    const r = await send(vi.fn(async () => stalledBodyResponse(201)));
    expect(r).toEqual({ status: "failed", retryable: true, detail: "http 201 no events_received" });
  });
});

describe("classifyMetaOutcome and a body that timed out", () => {
  it("retries a non-2xx only when told the body timed out, not for a missing body alone", () => {
    expect(classifyMetaOutcome({ httpStatus: 400, body: null, bodyTimedOut: true })).toEqual({
      status: "failed",
      retryable: true,
      detail: "http 400 body timed out",
    });
    expect(classifyMetaOutcome({ httpStatus: 400, body: null })).toEqual({
      status: "rejected",
      retryable: false,
      detail: "http 400",
    });
  });
});
