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
import { buildInsertParams, INSERT_COLUMNS } from "./store.js";
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

// ---------------------------------------------------------------------------
// Everything below was added after mutation testing. The cases above leave each
// of these open: the comment on each names the mutant that survived without it.
// ---------------------------------------------------------------------------

describe("authentication, further", () => {
  it("rejects a request with no header when no secret is configured", async () => {
    // The fail-open this guards is "" meeting "": an unset secret and an absent
    // header. The case above sends a non-empty header, which the length check
    // rejects by itself, so it cannot tell a guard from an accident. Removing
    // both the `!expected` guard and the empty-buffer check survived without it.
    for (const secret of [undefined, null, ""]) {
      for (const headers of [{}, { authorization: "" }]) {
        const d = deps({ secret });
        const res = fakeRes();
        await makeCrmEventsHandler(d)(req(headers, VALID_BODY), res);
        expect(res.statusCode, `secret=${String(secret)} headers=${JSON.stringify(headers)}`).toBe(401);
        expect(d.insert).not.toHaveBeenCalled();
      }
    }
  });

  it("logs a rejection with what an operator needs to find the caller", async () => {
    // Deleting the log line, hard-wiring hasHeader, and dropping the ip all
    // survived: the existing test only checks the secret is absent from a log
    // that could be empty. hasHeader tells a rule with no header configured
    // apart from one with the wrong value.
    const wrong = deps();
    await makeCrmEventsHandler(wrong)(req({ authorization: "nope" }, VALID_BODY), fakeRes());
    const none = deps();
    await makeCrmEventsHandler(none)(req({}, VALID_BODY), fakeRes());

    expect(wrong.logger.warn).toHaveBeenCalledTimes(1);
    const line = wrong.logger.warn.mock.calls[0][0];
    expect(line).toContain("POST");
    expect(line).toContain("/api/crm-events");
    expect(line).toContain("1.2.3.4");
    expect(line).toContain("hasHeader=true");
    expect(none.logger.warn.mock.calls[0][0]).toContain("hasHeader=false");
  });
});

describe("a normaliser that throws", () => {
  it("stores nothing, says so, and answers 200 rather than crash", async () => {
    // The whole branch was unexercised: removing it, answering 500, dropping the
    // log, or falling through to store an empty event all survived.
    const d = deps({
      normalise: () => {
        throw new Error("boom");
      },
    });
    const res = fakeRes();
    await expect(
      makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res)
    ).resolves.toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, stored: false, valid: false });
    expect(d.insert).not.toHaveBeenCalled();
    expect(d.onStored).not.toHaveBeenCalled();
    expect(d.logger.error).toHaveBeenCalledTimes(1);
    expect(d.logger.error.mock.calls[0][0]).toContain("boom");
  });
});

describe("telling a test press from a broken rule", () => {
  const LABELS = {
    stage: "registered",
    client_id: "Client ID",
    first_name: "Client First Name",
    last_name: "Client Last Name",
    email: "Client Email",
    phone: "Client Phone",
  };

  it("keys on client_id: a real id is not a test press however odd the other fields look", async () => {
    // The press fixture above is labels in every field, so detecting on email or
    // first_name instead of client_id gave identical output. The id is the
    // dedupe key a placeholder would poison, which is why it is the one examined.
    const d = deps();
    await makeCrmEventsHandler(d)(
      req(
        { authorization: "s3cret" },
        { ...VALID_BODY, first_name: "Client First Name", last_name: "Client Last Name", email: "Client Email" }
      ),
      fakeRes()
    );
    expect(d.insert.mock.calls[0][3]).toBeNull();
    expect(d.onStored).toHaveBeenCalledTimes(1);
  });

  it("still names it a test press when the payload is also missing a required field", async () => {
    // Which of the two reasons wins decides whether an operator sees "somebody
    // pressed Test" or "the rule is broken", the distinction fxboPlaceholder.js
    // exists to keep. Letting the missing-fields text win survived.
    const { email, ...withoutEmail } = LABELS;
    const d = deps();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, withoutEmail), fakeRes());
    const reason = d.insert.mock.calls[0][3];
    expect(reason).toContain("placeholder_not_substituted");
    expect(reason).not.toContain("missing required fields");
  });

  it("logs a test press as one, and an invalid payload with the email masked", async () => {
    // The log is where an operator looks, and the spec forbids a full email in
    // it. Logging the raw address, deleting the line, and mislabelling a test
    // press as an invalid payload each survived.
    const press = deps();
    await makeCrmEventsHandler(press)(req({ authorization: "s3cret" }, LABELS), fakeRes());
    expect(press.logger.warn).toHaveBeenCalledTimes(1);
    expect(press.logger.warn.mock.calls[0][0]).toContain("test press");

    const bad = deps();
    await makeCrmEventsHandler(bad)(req({ authorization: "s3cret" }, { ...VALID_BODY, stage: "typo" }), fakeRes());
    expect(bad.logger.warn).toHaveBeenCalledTimes(1);
    const line = bad.logger.warn.mock.calls[0][0];
    expect(line).toContain("invalid payload");
    expect(line).toContain("a***@example.com");
    expect(line).not.toContain("ali.khan");
  });
});

describe("the click id lookup, further", () => {
  it("is keyed on the CRM client id", async () => {
    // findFbc is a stub that answers the same whatever it is asked, so looking a
    // client up by stage instead survived. The freeze depends on this key.
    const d = deps();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), fakeRes());
    expect(d.findFbc).toHaveBeenCalledWith("88214");
  });

  it("leaves the click id empty, and says why, when the lookup throws", async () => {
    // Empty, not derived. A failed lookup cannot tell us whether a frozen id
    // already exists, and deriving one here stamps this stage with a fresh
    // timestamp: a different click identity for the same person, which is the
    // quietly broken funnel the freeze exists to prevent. The landing URL below
    // does carry a fbclid, so a derived value would be non-empty. A missing
    // matcher is recoverable (Meta falls back to the hashed email and phone, and
    // a later event picks up the frozen value from an earlier row); an
    // inconsistent one is silently wrong. The event itself is still stored.
    const d = deps({
      findFbc: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res);
    expect(d.insert).toHaveBeenCalledTimes(1);
    expect(d.insert.mock.calls[0][1].fbc).toBe("");
    expect(res.body).toEqual({ ok: true, stored: true, duplicate: false });
    expect(d.logger.error).toHaveBeenCalledTimes(1);
    expect(d.logger.error.mock.calls[0][0]).toContain("db down");
  });
});

describe("what the handler hands the store", () => {
  // insertSignupEvent reads (fields, derived, rawPayload, invalidReason) by
  // position, and the mocked insert above accepts any order. Handing it the raw
  // body as the fields, no raw payload, or the fields as the raw payload all
  // survived. Running the real parameter builder over the call pins the seam.
  const column = (params, name) => params[INSERT_COLUMNS.indexOf(name)];

  it("fills the right columns for a valid event", async () => {
    const d = deps();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), fakeRes());
    const params = buildInsertParams(...d.insert.mock.calls[0]);
    expect(column(params, "crm_client_id")).toBe("88214");
    expect(column(params, "stage")).toBe("registered");
    expect(column(params, "email")).toBe("ali.khan@example.com");
    expect(column(params, "fbc")).toBe("fb.1.1791806400000.IwY2xjawUsILdI");
    expect(column(params, "whatsapp_request_id")).toBe("11111111-2222-4333-8444-555555555555");
    expect(column(params, "meta_status")).toBe("pending");
    expect(column(params, "whatsapp_status")).toBe("pending");
    expect(column(params, "brevo_status")).toBe("pending");
    expect(JSON.parse(column(params, "raw_payload"))).toEqual(VALID_BODY);
  });

  it("marks all three destinations invalid, with the reason, for a bad one", async () => {
    const d = deps();
    const body = { ...VALID_BODY, stage: "typo" };
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, body), fakeRes());
    const params = buildInsertParams(...d.insert.mock.calls[0]);
    for (const status of ["meta_status", "whatsapp_status", "brevo_status"]) {
      expect(column(params, status), status).toBe("invalid");
    }
    expect(column(params, "meta_detail")).toContain("missing required fields");
    expect(JSON.parse(column(params, "raw_payload"))).toEqual(body);
  });
});

describe("storing, further", () => {
  it("still says whether the payload was valid when the database throws", async () => {
    // Only `stored` was asserted, so reporting a constant valid survived.
    const failing = () =>
      deps({
        insert: vi.fn(async () => {
          throw new Error("ER_LOCK_WAIT_TIMEOUT");
        }),
      });
    const bad = fakeRes();
    await makeCrmEventsHandler(failing())(
      req({ authorization: "s3cret" }, { ...VALID_BODY, stage: "typo" }),
      bad
    );
    expect(bad.body).toEqual({ ok: true, stored: false, valid: false });
    const good = fakeRes();
    await makeCrmEventsHandler(failing())(req({ authorization: "s3cret" }, VALID_BODY), good);
    expect(good.body).toEqual({ ok: true, stored: false, valid: true });
  });

  it("reports a failed worker kick as a failed kick, not a failed store", async () => {
    // The row IS stored. Without its own catch the kick's exception fell into
    // the store handler's, which answered stored:false and logged "store failed".
    const d = deps({
      onStored: vi.fn(() => {
        throw new Error("worker exploded");
      }),
    });
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res);
    expect(res.body).toEqual({ ok: true, stored: true, duplicate: false });
    expect(d.logger.error).toHaveBeenCalledTimes(1);
    expect(d.logger.error.mock.calls[0][0]).toContain("worker kick failed");
  });

  it("works with no worker wired in", async () => {
    // onStored is optional. Removing its default made every stored event log a
    // spurious "worker kick failed".
    const d = deps();
    delete d.onStored;
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res);
    expect(res.body).toEqual({ ok: true, stored: true, duplicate: false });
    expect(d.logger.error).not.toHaveBeenCalled();
  });
});

describe("wiring in server.js, further", () => {
  const SERVER = readFileSync(path.resolve("server.js"), "utf8");

  it("hands the handler the secret, the lookup and the insert, each under its own name", () => {
    // The checks above find the route string and nothing about what is passed to
    // it. A misspelt env var rejects every FXBO delivery (it fails closed, so
    // loudly, but only after deploy); swapping the lookup and the insert
    // compiles. All of these survived.
    const registration = SERVER.match(/app\.post\('\/api\/crm-events',\s*makeCrmEventsHandler\(\{([\s\S]*?)\}\)\);/);
    expect(registration, "the registration block was not found").not.toBeNull();
    const wired = registration[1];
    expect(wired).toMatch(/\bsecret:\s*process\.env\.CRM_WEBHOOK_SECRET\s*,/);
    expect(wired).toMatch(/\bfindFbc:\s*findExistingFbc\s*,/);
    expect(wired).toMatch(/\binsert:\s*insertSignupEvent\s*,/);
  });

  it("initialises the store at boot, and a failure there cannot take the process down", () => {
    // An un-caught rejection is fatal on current Node, so a database that is
    // unreachable at start would stop the whole dashboard. Dropping the init and
    // dropping the catch both survived.
    const listen = SERVER.slice(SERVER.indexOf("server.listen(PORT"));
    expect(listen).toMatch(/initCrmSignupStore\(\)(?:\s*\.then\(.*\))*\s*\.catch\(/);
  });

  it("says at boot, naming the variable, that an unset secret rejects every webhook", () => {
    // The handler fails closed, which from FXBO's side is only a stream of 401s
    // after a deploy. The warning is the one place that says why. Dropping it,
    // inverting its condition, and dropping the variable's name all pass every
    // other test.
    const listen = SERVER.slice(SERVER.indexOf("server.listen(PORT"));
    const warning = listen.match(/if \(!process\.env\.CRM_WEBHOOK_SECRET\)\s*\{([^}]*)\}/);
    expect(warning, "no boot-time check of CRM_WEBHOOK_SECRET in the listen callback").not.toBeNull();
    expect(warning[1]).toContain("console.error(");
    expect(warning[1]).toContain("CRM_WEBHOOK_SECRET is not set");
    expect(warning[1]).toContain("rejected");
  });
});
