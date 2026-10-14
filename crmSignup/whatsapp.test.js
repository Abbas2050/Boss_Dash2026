// @vitest-environment node
//
// The trap: DoubleTick answers 200 to a message it then rejects. The HTTP
// status says the request was accepted. messages[0].status says what happened
// to the message. Only the second one is the outcome.
import { describe, it, expect, vi } from "vitest";
import { describeSendTimeout, stalledBodyResponse } from "./sendTimeout.contract.js";
import {
  WHATSAPP_FAILURE_STATUSES,
  parseSkipSources,
  decideWhatsappSkip,
  buildWhatsappPayload,
  classifyWhatsappOutcome,
  sendWhatsappTemplate,
} from "./whatsapp.js";

// No recordType: since 2026-10-14 the gate does not take one (see the case
// below). The remaining facts about the person are the phone and the source.
const base = {
  stage: "registered",
  apiKey: "k",
  source: "SVG",
  phone: "+971507192185",
  skipSources: new Set(),
};

describe("skip decisions", () => {
  it("sends for a registered person with a valid phone from an allowed source", () => {
    expect(decideWhatsappSkip(base)).toBeNull();
  });

  it("sends nothing at any stage but registration", () => {
    for (const stage of ["lead", "verified", "live_account", "first_deposit"]) {
      expect(decideWhatsappSkip({ ...base, stage }), stage).toEqual({
        reason: "stage not applicable",
      });
    }
  });

  // This case used to pin the opposite: a lead was skipped with the reason
  // "lead, not client". The gate is gone (2026-10-14, user's call) -- a lead gets
  // the same template as a client, and the user was told the login link in its
  // body and button does not work for a lead and chose to send anyway. The reason
  // string moved to decideBrevoSkip, which had no lead gate at all before today.
  it("sends to a lead as well as a client, and reads no record type at all", () => {
    // Every value the old gate would have skipped on, including the ones
    // deriveRecordType resolves to "lead" when it cannot tell. Restoring
    // `recordType !== "client"` fails on all but the first.
    for (const recordType of ["client", "lead", "", "   ", "maybe", null, undefined]) {
      expect(decideWhatsappSkip({ ...base, recordType }), String(recordType)).toBeNull();
    }
  });

  it("skips an invalid phone without trying to repair it", () => {
    expect(decideWhatsappSkip({ ...base, phone: "00971507192185" })).toEqual({
      reason: "invalid phone number",
    });
    expect(decideWhatsappSkip({ ...base, phone: "" })).toEqual({ reason: "invalid phone number" });
    // A lead's phone is checked exactly as a client's. Dropping the lead gate
    // dropped one condition, not the two that are still facts about the person:
    // a lead with no usable number is a skip, not a send to nothing.
    expect(decideWhatsappSkip({ ...base, recordType: "lead", phone: "00971507192185" })).toEqual({
      reason: "invalid phone number",
    });
    expect(decideWhatsappSkip({ ...base, recordType: "lead", phone: "" })).toEqual({
      reason: "invalid phone number",
    });
  });

  it("excludes a lead's source exactly as a client's", () => {
    const skipSources = parseSkipSources("manual");
    expect(decideWhatsappSkip({ ...base, recordType: "lead", source: "manual", skipSources })).toEqual({
      reason: "source excluded",
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
    expect(decideWhatsappSkip({ ...base, source: "SVG", skipSources })).toBeNull();
  });

  it("matches the webhook's source case-insensitively, not only the configured list", () => {
    const skipSources = parseSkipSources("manual");
    expect(decideWhatsappSkip({ ...base, source: "MANUAL", skipSources })).toEqual({
      reason: "source excluded",
    });
  });

  it("reports an unconfigured key before anything about the client", () => {
    // An unconfigured environment is our problem, not a fact about the person.
    // Re-pointed from the record type, which this gate no longer reads, at the
    // two facts about them it does: the phone and the source.
    const skipSources = parseSkipSources("manual");
    expect(decideWhatsappSkip({ ...base, apiKey: "", phone: "", source: "manual", skipSources })).toEqual({
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

  it("treats every blank or missing key as unconfigured", () => {
    // The same four values decideBrevoSkip is held to, so the two cannot drift apart.
    for (const apiKey of ["", "   ", undefined, null]) {
      expect(decideWhatsappSkip({ ...base, apiKey }), String(apiKey)).toEqual({
        reason: "whatsapp not configured",
      });
    }
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

  it("retries 408 alone among the 4xx, so its neighbours stay permanent", () => {
    // Guards the rule from widening into a range such as >= 408.
    for (const httpStatus of [400, 401, 403, 404, 405, 407, 409, 410, 422]) {
      const r = classifyWhatsappOutcome({ httpStatus, body: {} });
      expect(r.retryable, String(httpStatus)).toBe(false);
      expect(r.status, String(httpStatus)).toBe("rejected");
    }
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

describeSendTimeout("sendWhatsappTemplate", {
  ok: () =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ status: "SENT", messageId: "m-30" }] }),
    })),
  send: (fetchImpl) => sendWhatsappTemplate({ fetchImpl, apiKey: "k", payload: {} }),
});

describe("sendWhatsappTemplate when the response body times out", () => {
  // The timeout signal bounds reading the body as well as the headers, so a stall
  // after the status line ends in json() rejecting with a TimeoutError. The
  // sender swallows that like any unreadable body, and the outcome falls out of
  // the status alone. Pinned per sender because the three differ on purpose.
  const send = (fetchImpl) => sendWhatsappTemplate({ fetchImpl, apiKey: "k", payload: {} });

  it("does not retry a 2xx whose body timed out, and says the body timed out", async () => {
    // A 2xx means the request was accepted and the message may well have gone
    // out. A retry would be a second welcome, so this stays terminal.
    const r = await send(vi.fn(async () => stalledBodyResponse(200)));
    expect(r).toEqual({
      status: "failed",
      retryable: false,
      detail: "body timed out in a 2xx response",
      messageId: null,
    });
  });

  it("keeps the old detail when the body failed to read for any other reason", async () => {
    for (const thrown of [new SyntaxError("Unexpected token <"), new Error("socket hang up"), undefined, null, "oops"]) {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw thrown;
        },
      }));
      const r = await send(fetchImpl);
      expect(r, String(thrown)).toEqual({
        status: "failed",
        retryable: false,
        detail: "no message status in a 2xx response",
        messageId: null,
      });
    }
  });

  it("still retries a 5xx and rejects a 4xx whose body timed out, since the status decides first", async () => {
    expect(await send(vi.fn(async () => stalledBodyResponse(503)))).toEqual({
      status: "failed",
      retryable: true,
      detail: "http 503",
      messageId: null,
    });
    expect(await send(vi.fn(async () => stalledBodyResponse(400)))).toEqual({
      status: "rejected",
      retryable: false,
      detail: "http 400",
      messageId: null,
    });
  });

  it("names a body timeout only when the sender reports one", () => {
    expect(classifyWhatsappOutcome({ httpStatus: 200, body: null, bodyTimedOut: true }).detail).toBe(
      "body timed out in a 2xx response"
    );
    expect(classifyWhatsappOutcome({ httpStatus: 200, body: null }).detail).toBe(
      "no message status in a 2xx response"
    );
  });
});
