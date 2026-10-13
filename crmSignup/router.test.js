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

  it("stores an unknown stage as invalid in the insert itself, and stops", async () => {
    // One statement, not two. A separate UPDATE would leave the row briefly
    // readable with three pending statuses, and a sweep landing in that window
    // would send an invalid payload.
    const d = deps();
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, { ...VALID_BODY, stage: "typo" }), res);
    expect(res.statusCode).toBe(200);
    expect(d.insert).toHaveBeenCalledTimes(1);
    expect(d.insert.mock.calls[0][3]).toContain("missing required fields");
    expect(d.onStored).not.toHaveBeenCalled();
    expect(res.body.valid).toBe(false);
  });

  it("passes no reason at all for a valid payload", async () => {
    const d = deps();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), fakeRes());
    expect(d.insert.mock.calls[0][3]).toBeNull();
  });

  it("leaves an existing row untouched when a malformed redelivery arrives", async () => {
    // The INSERT is a no-op once the row exists, so a later invalid delivery of
    // a stage cannot overwrite the statuses an earlier valid one set -- it
    // cannot cancel a welcome that is queued or already sent.
    const d = deps({ insert: vi.fn(async () => ({ inserted: false, id: null })) });
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, { ...VALID_BODY, stage: "typo" }), res);
    expect(res.body).toEqual({ ok: true, stored: true, duplicate: true, valid: false });
    expect(d.onStored).not.toHaveBeenCalled();
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
    expect(d.insert).toHaveBeenCalledTimes(1);
    expect(d.insert.mock.calls[0][3]).toContain("placeholder_not_substituted");
  });

  it("leaves a real payload alone", async () => {
    const d = deps();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), fakeRes());
    expect(d.insert.mock.calls[0][3]).toBeNull();
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
    expect(d.insert.mock.calls[0][3]).toBeNull();
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
