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

  it("reports an unconfigured key before anything about the client", () => {
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
    // to reject, and nesting them wrong is the same as omitting.
    expect(payload.messages[0].from).toBeTruthy();
    expect(payload.messages[0].messageId).toBeTruthy();
    expect(payload.from).toBeUndefined();
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
});
