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
});
