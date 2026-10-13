// @vitest-environment node
//
// The handler does five things and nothing else: authenticate, reject a test
// press, validate, store, answer 200. Everything a provider might do happens
// later, in the worker, because the CRM must never wait on us and our failure
// must never look like a CRM failure.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { makeCrmEventsHandler, readCrmWebhookSecret } from "./router.js";
import { buildInsertParams, INSERT_COLUMNS, insertSignupEvent } from "./store.js";
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

  it("answers 503, not 200, when the database throws", async () => {
    // Changed from the original "answers 200". The 200 rule protects against FXBO
    // redelivering an event we already HOLD, so it applies once the row exists.
    // When the insert throws we hold nothing: FXBO's retry is the only recovery
    // there is, and the unique (client, stage) key makes a redelivery harmless. A
    // 200 here dropped the event for good.
    const d = deps({
      insert: vi.fn(async () => {
        throw new Error("ER_LOCK_WAIT_TIMEOUT");
      }),
    });
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.stored).toBe(false);
    expect(res.body.ok).toBe(false);
    expect(d.onStored).not.toHaveBeenCalled();
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
    // iisnode does not timestamp its log, and the spec asks for one.
    expect(line).toContain("at=2026-10-12T12:00:00.000Z");
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

  it("names the event and the missing fields, as the other two lost-event paths do", async () => {
    // Without them an invalid payload whose email will not render carried no
    // stage, no client id and no unique_id at all -- and because a missing
    // client_id is stored as "", every such event after the first collides on
    // ("", stage) and is swallowed as a duplicate. Spec section 11 and CUTOVER
    // step 5 settle what %client_is_lead% contains by reading raw_payload off
    // exactly one of these rows, so finding it matters.
    const d = deps();
    await makeCrmEventsHandler(d)(
      req({ authorization: "s3cret" }, { ...VALID_BODY, stage: "typo", email: "", unique_id: "FX-9001" }),
      fakeRes()
    );
    const line = d.logger.warn.mock.calls[0][0];
    expect(line).toContain('client="88214"');
    // The stage did not validate, so it is logged as the empty string it became.
    expect(line).toContain('stage=""');
    expect(line).toContain('unique_id="FX-9001"');
    expect(line).toContain('missing="stage,email"');
    expect(line).toContain("(no email)");
  });

  it("names the event on a test press too, which is the row the cutover reads", async () => {
    const d = deps();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, LABELS), fakeRes());
    const line = d.logger.warn.mock.calls[0][0];
    expect(line).toContain("test press");
    expect(line).toContain('client="Client ID"');
    expect(line).toContain("unique_id=");
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
    // Only `stored` was asserted, so reporting a constant valid survived. A test
    // press is the sharp case: it validates (its labels are non-empty strings), so
    // the verdict from normalise alone says valid:true, and that is the response
    // the FXBO Test button displays.
    const failing = () =>
      deps({
        insert: vi.fn(async () => {
          throw new Error("ER_LOCK_WAIT_TIMEOUT");
        }),
      });
    const answer = async (body) => {
      const res = fakeRes();
      await makeCrmEventsHandler(failing())(req({ authorization: "s3cret" }, body), res);
      return res.body;
    };
    const failed = { ok: false, stored: false, error: "store_failed" };
    expect(await answer({ ...VALID_BODY, stage: "typo" })).toEqual({ ...failed, valid: false });
    expect(await answer(VALID_BODY)).toEqual({ ...failed, valid: true });
    expect(
      await answer({
        stage: "registered",
        client_id: "Client ID",
        first_name: "Client First Name",
        last_name: "Client Last Name",
        email: "Client Email",
        phone: "Client Phone",
      })
    ).toEqual({ ...failed, valid: false });
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
    expect(wired).toMatch(/\bsecret:\s*CRM_WEBHOOK_SECRET\s*,/);
    expect(wired).toMatch(/\bfindFbc:\s*findExistingFbc\s*,/);
    expect(wired).toMatch(/\binsert:\s*insertSignupEvent\s*,/);
    // ...and that constant is read from the environment through the trimming
    // reader, not from some other variable or a hand-rolled read.
    expect(SERVER).toMatch(/const CRM_WEBHOOK_SECRET = readCrmWebhookSecret\(process\.env\);/);
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
    const warning = listen.match(/if \(!CRM_WEBHOOK_SECRET\)\s*\{([^}]*)\}/);
    expect(warning, "no boot-time check of CRM_WEBHOOK_SECRET in the listen callback").not.toBeNull();
    expect(warning[1]).toContain("console.error(");
    expect(warning[1]).toContain("CRM_WEBHOOK_SECRET is not set");
    expect(warning[1]).toContain("rejected");
  });
});

// ---------------------------------------------------------------------------
// Added after review. Same rule as the section above: each of these pins
// something a surviving mutant showed to be open.
// ---------------------------------------------------------------------------

describe("the secret comparison, beyond length", () => {
  it("rejects every near miss, not just a wrong length", async () => {
    // Every wrong secret in the cases above differs in length from "s3cret", so
    // the comparison itself was pinned by nothing but a length check. Replacing
    // timingSafeEqual with `true`, comparing the first byte only, accepting a
    // prefix, ignoring case and stripping a "Bearer " prefix all survived.
    const nearMisses = [
      "s3cres", //          same length, last byte differs
      "x3cret", //          same length, first byte differs
      "S3CRET", //          case
      "s3cre", //           a prefix of the secret
      "s3cretx", //         the secret as a prefix
      "s3cret ", //         trailing space
      " s3cret", //         leading space
      "Bearer s3cret", //   the secret behind a scheme
    ];
    for (const authorization of nearMisses) {
      const d = deps();
      const res = fakeRes();
      await makeCrmEventsHandler(d)(req({ authorization }, VALID_BODY), res);
      expect(res.statusCode, JSON.stringify(authorization)).toBe(401);
      expect(d.insert, JSON.stringify(authorization)).not.toHaveBeenCalled();
    }
  });

  it("does not let the text 'undefined' or 'null' stand in for a missing value", async () => {
    // An unset secret and a header that merely SAYS "undefined" or "null" must not
    // meet. The reverse also holds: a secret that happens to read "undefined" must
    // not be matched by a request with no header at all.
    const cases = [
      { secret: undefined, headers: { authorization: "undefined" } },
      { secret: null, headers: { authorization: "null" } },
      { secret: "undefined", headers: {} },
      { secret: "null", headers: {} },
    ];
    for (const { secret, headers } of cases) {
      const d = deps({ secret });
      const res = fakeRes();
      await makeCrmEventsHandler(d)(req(headers, VALID_BODY), res);
      expect(res.statusCode, `secret=${String(secret)} headers=${JSON.stringify(headers)}`).toBe(401);
      expect(d.insert).not.toHaveBeenCalled();
    }
  });
});

describe("the configured secret", () => {
  it("is read from CRM_WEBHOOK_SECRET with its ends trimmed", () => {
    expect(readCrmWebhookSecret({ CRM_WEBHOOK_SECRET: "s3cret" })).toBe("s3cret");
    expect(readCrmWebhookSecret({ CRM_WEBHOOK_SECRET: "  s3cret \r\n" })).toBe("s3cret");
    // Only the ends: a secret with a space inside it is a different secret.
    expect(readCrmWebhookSecret({ CRM_WEBHOOK_SECRET: "two words" })).toBe("two words");
    expect(readCrmWebhookSecret({ CRM_WEBHOOK_SECRET: "a", CRM_WEBHOOK_SECRET_OLD: "b" })).toBe("a");
  });

  it("counts a blank, absent or null value as unset", () => {
    // Trimming is what makes a whitespace-only value warn at boot instead of
    // passing for configured and then matching nothing.
    for (const env of [
      { CRM_WEBHOOK_SECRET: "   " },
      { CRM_WEBHOOK_SECRET: "\r\n" },
      { CRM_WEBHOOK_SECRET: "" },
      { CRM_WEBHOOK_SECRET: undefined },
      { CRM_WEBHOOK_SECRET: null },
      { CRM_WEBHOOK_SECRET_OLD: "s3cret" },
      {},
      null,
    ]) {
      expect(readCrmWebhookSecret(env), JSON.stringify(env)).toBe("");
    }
  });
});

describe("the production defaults", () => {
  // server.js passes only { secret, findFbc, insert }, so production runs the
  // default now, newRequestId, logger and onStored. Every case above overrides
  // them, so a constant request id, a frozen clock and a logger that logs nothing
  // all survived.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const auth = { authorization: "s3cret" };

  it("mints a fresh UUID per row and stamps the click id with the current time", async () => {
    const insert = vi.fn(async () => ({ inserted: true, id: 1 }));
    const handler = makeCrmEventsHandler({ secret: "s3cret", findFbc: async () => "", insert });
    const before = Date.now();
    await handler(req(auth, VALID_BODY), fakeRes());
    await handler(req(auth, { ...VALID_BODY, stage: "verified" }), fakeRes());
    const after = Date.now();

    const derived = insert.mock.calls.map((call) => call[1]);
    expect(derived).toHaveLength(2);
    for (const { whatsappRequestId, fbc } of derived) {
      expect(whatsappRequestId).toMatch(UUID);
      const stamp = Number(fbc.split(".")[2]);
      expect(stamp).toBeGreaterThanOrEqual(before);
      expect(stamp).toBeLessThanOrEqual(after);
    }
    expect(derived[0].whatsappRequestId).not.toBe(derived[1].whatsappRequestId);
  });

  it("logs through the console, with a timestamp on a rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const handler = makeCrmEventsHandler({
        secret: "s3cret",
        findFbc: async () => "",
        insert: async () => {
          throw new Error("ER_LOCK_WAIT_TIMEOUT");
        },
      });
      await handler(req({ authorization: "wrong" }, VALID_BODY), fakeRes());
      await handler(req(auth, VALID_BODY), fakeRes());

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/rejected at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toContain("ER_LOCK_WAIT_TIMEOUT");
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe("the corroboration seam, further", () => {
  it("treats a lone label in client_id as a lone label, not a test press", async () => {
    // The 'one odd-looking field' case puts its label in last_name beside a real
    // client_id, so detection returns kind:null before corroboration is ever
    // reached; it cannot fail for the regression it names. Here the key field IS
    // a label and nothing corroborates it. Testing `detection.kind !== null`
    // instead of `detection.placeholder` survived.
    const d = deps();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, { ...VALID_BODY, client_id: "Client ID" }), fakeRes());
    expect(d.insert.mock.calls[0][3]).toBeNull();
    expect(d.onStored).toHaveBeenCalledTimes(1);
  });

  it("needs no corroboration for an unrendered token in client_id", async () => {
    // The other half of the same seam: a raw %token% is proof on its own, because
    // nothing real looks like one. Deciding on corroboration alone survived, and
    // would have stored a row keyed on the literal "%client_id%".
    const d = deps();
    await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, { ...VALID_BODY, client_id: "%client_id%" }), fakeRes());
    expect(d.insert.mock.calls[0][3]).toContain("placeholder_not_substituted");
    expect(d.onStored).not.toHaveBeenCalled();
  });
});

describe("the reason an operator reads", () => {
  // It lands in meta_detail, whatsapp_detail and brevo_detail, and it is the only
  // thing that says why a row was never sent. The cases above only check it
  // contains a fragment, so reporting the COUNT of missing fields, or dropping
  // the test-press explanation, survived.
  it("lists each missing field by name, in order", async () => {
    const d = deps();
    await makeCrmEventsHandler(d)(
      req({ authorization: "s3cret" }, { ...VALID_BODY, stage: "typo", first_name: "", email: "" }),
      fakeRes()
    );
    expect(d.insert.mock.calls[0][3]).toBe("missing required fields: stage, firstName, email");
  });

  it("explains a test press by the field and the evidence", async () => {
    const d = deps();
    await makeCrmEventsHandler(d)(
      req({ authorization: "s3cret" }, {
        stage: "registered",
        client_id: "Client ID",
        first_name: "Client First Name",
        last_name: "Client Last Name",
        email: "Client Email",
      }),
      fakeRes()
    );
    const reason = d.insert.mock.calls[0][3];
    expect(reason.startsWith("placeholder_not_substituted: ")).toBe(true);
    expect(reason).toContain('client_id arrived as "Client ID"');
    expect(reason).toContain("first_name, last_name, email");
    expect(reason).not.toContain("missing required fields");
  });
});

describe("a failed store, further", () => {
  it("names the event it could not store, quoted, and leaves the email out", async () => {
    // Today a lost event cannot be identified afterwards, let alone replayed. The
    // values are JSON-quoted so a client id cannot forge a second log line.
    const d = deps({
      insert: vi.fn(async () => {
        throw new Error("ER_LOCK_WAIT_TIMEOUT");
      }),
    });
    await makeCrmEventsHandler(d)(
      req({ authorization: "s3cret" }, { ...VALID_BODY, unique_id: "FX-9001" }),
      fakeRes()
    );
    expect(d.logger.error).toHaveBeenCalledTimes(1);
    const line = d.logger.error.mock.calls[0][0];
    expect(line).toContain('client="88214"');
    expect(line).toContain('stage="registered"');
    expect(line).toContain('unique_id="FX-9001"');
    expect(line).toContain("ER_LOCK_WAIT_TIMEOUT");
    expect(line).not.toContain("ali.khan");

    const forged = deps({
      insert: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    await makeCrmEventsHandler(forged)(
      req({ authorization: "s3cret" }, { ...VALID_BODY, client_id: "88214\n[crm-events] forged" }),
      fakeRes()
    );
    expect(forged.logger.error.mock.calls[0][0]).not.toContain("\n");
  });

  it("answers 200, not 503, for every other outcome", async () => {
    // The 503 is for the one case where nothing is held. A duplicate, an invalid
    // payload, a test press and a throwing normaliser are all answered 200 so that
    // FXBO does not redeliver something we already hold or can never accept.
    const answered = async (overrides, body) => {
      const res = fakeRes();
      await makeCrmEventsHandler(deps(overrides))(req({ authorization: "s3cret" }, body), res);
      return res.statusCode;
    };
    expect(await answered({ insert: vi.fn(async () => ({ inserted: false, id: null })) }, VALID_BODY)).toBe(200);
    expect(await answered({}, { ...VALID_BODY, stage: "typo" })).toBe(200);
    expect(await answered({}, { ...VALID_BODY, client_id: "%client_id%" })).toBe(200);
    expect(
      await answered(
        {
          normalise: () => {
            throw new Error("boom");
          },
        },
        VALID_BODY
      )
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Added after the second review: a payload that can never be stored, and the
// identifiers on the one path that still had none.
// ---------------------------------------------------------------------------

describe("a key that can never be stored", () => {
  // The REAL insertSignupEvent is used, not a hand-built error. It refuses an
  // over-width client id before any statement runs, so no database is needed, and
  // the code the store sets and the code the handler reads are checked against
  // each other. Collapsing the two outcomes survived without this.
  const OVER_WIDTH = "9".repeat(256);

  it("answers 200 and logs that the event is dropped, instead of asking FXBO to retry", async () => {
    // 503 means "try again", and FXBO would try up to twelve times, each failing
    // identically. The event is lost either way; the log is the honest record.
    const d = deps({ insert: insertSignupEvent });
    const res = fakeRes();
    await makeCrmEventsHandler(d)(
      req({ authorization: "s3cret" }, { ...VALID_BODY, client_id: OVER_WIDTH, unique_id: "FX-9001" }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: false, stored: false, valid: true, error: "key_unstorable" });
    expect(d.onStored).not.toHaveBeenCalled();
    expect(d.logger.error).toHaveBeenCalledTimes(1);
    const line = d.logger.error.mock.calls[0][0];
    expect(line).toContain("DROPPED");
    // The 256 characters are cut to 120 and marked; the store's own message in the
    // same line says how long the id really was.
    expect(line).toContain(`client="${"9".repeat(120)}..."`);
    expect(line).not.toContain("9".repeat(121));
    expect(line).toContain('stage="registered"');
    expect(line).toContain('unique_id="FX-9001"');
    expect(line).toContain("crm_client_id is 256 characters");
    expect(line).not.toContain("ali.khan");

    // `valid` still reports the payload's own verdict, not a constant.
    const invalid = fakeRes();
    await makeCrmEventsHandler(deps({ insert: insertSignupEvent }))(
      req({ authorization: "s3cret" }, { ...VALID_BODY, client_id: OVER_WIDTH, stage: "typo" }),
      invalid
    );
    expect(invalid.statusCode).toBe(200);
    expect(invalid.body).toEqual({ ok: false, stored: false, valid: false, error: "key_unstorable" });
  });

  it("still answers 503 for every genuine store failure", async () => {
    // The first case is the real store with no pool, an ordinary failure of the
    // moment that carries no code at all. The rest are the shapes a driver and a
    // careless throw produce. None of them may be read as "unstorable".
    const failures = [
      { insert: insertSignupEvent },
      { insert: vi.fn(async () => { throw Object.assign(new Error("Lock wait timeout"), { code: "ER_LOCK_WAIT_TIMEOUT" }); }) },
      { insert: vi.fn(async () => { throw Object.assign(new Error("gone"), { code: "PROTOCOL_CONNECTION_LOST" }); }) },
      { insert: vi.fn(async () => { throw new Error("plain"); }) },
      { insert: vi.fn(async () => { throw "a string was thrown"; }) },
      { insert: vi.fn(async () => { throw null; }) },
    ];
    for (const [index, failure] of failures.entries()) {
      const d = deps(failure);
      const res = fakeRes();
      await makeCrmEventsHandler(d)(req({ authorization: "s3cret" }, VALID_BODY), res);
      expect(res.statusCode, `failure ${index}`).toBe(503);
      expect(res.body, `failure ${index}`).toEqual({ ok: false, stored: false, valid: true, error: "store_failed" });
      expect(d.logger.error.mock.calls[0][0], `failure ${index}`).toContain("store failed");
      expect(d.logger.error.mock.calls[0][0], `failure ${index}`).not.toContain("DROPPED");
    }
  });
});

describe("a normaliser that throws, further", () => {
  const auth = { authorization: "s3cret" };
  const throwing = () =>
    deps({
      normalise: () => {
        throw new Error("boom");
      },
    });

  it("names the event, read off the raw body, and leaves the email out", async () => {
    // Without the identifiers a lost event on this path carries no client id at
    // all. Still 200: a payload our own normaliser cannot parse will not parse on
    // a retry either.
    const d = throwing();
    const res = fakeRes();
    await makeCrmEventsHandler(d)(req(auth, { ...VALID_BODY, unique_id: "FX-9001" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, stored: false, valid: false });
    expect(d.logger.error).toHaveBeenCalledTimes(1);
    const line = d.logger.error.mock.calls[0][0];
    expect(line).toContain('client="88214"');
    expect(line).toContain('stage="registered"');
    expect(line).toContain('unique_id="FX-9001"');
    expect(line).toContain("boom");
    expect(line).not.toContain("ali.khan");
  });

  it("treats every identifier as possibly absent or not a string", async () => {
    // Normalisation has just failed, so nothing about the body can be assumed.
    const none = "client=null stage=null unique_id=null";
    const cases = [
      [undefined, none],
      [null, none],
      ["a string body", none],
      [["an", "array"], none],
      [{}, none],
      [{ client_id: 88214, stage: ["registered"], unique_id: { id: 1 } }, 'client="88214" stage=null unique_id=null'],
      [{ client_id: true, stage: null, unique_id: undefined }, 'client="true" stage=null unique_id=null'],
    ];
    for (const [body, expected] of cases) {
      const d = throwing();
      const res = fakeRes();
      await expect(makeCrmEventsHandler(d)(req(auth, body), res)).resolves.toBeUndefined();
      expect(res.statusCode, JSON.stringify(body)).toBe(200);
      expect(d.logger.error, JSON.stringify(body)).toHaveBeenCalledTimes(1);
      expect(d.logger.error.mock.calls[0][0], JSON.stringify(body)).toContain(expected);
    }
  });

  it("cannot be made to forge a log line", async () => {
    const d = throwing();
    await makeCrmEventsHandler(d)(req(auth, { ...VALID_BODY, client_id: "88214\n[crm-events] forged" }), fakeRes());
    expect(d.logger.error.mock.calls[0][0]).not.toContain("\n");
  });
});

describe("a log line stays bounded, whatever the body carries", () => {
  // Only an authenticated caller can do it, but one request carrying a million-
  // character client_id used to produce a million-character log line. Each
  // identifier is cut at 120 characters and marked with "...".
  const auth = { authorization: "s3cret" };
  const throwingNormaliser = () =>
    deps({
      normalise: () => {
        throw new Error("boom");
      },
    });
  const failingInsert = () =>
    deps({
      insert: vi.fn(async () => {
        throw new Error("ER_LOCK_WAIT_TIMEOUT");
      }),
    });

  it("leaves 120 characters whole and cuts 121 with a visible ellipsis", async () => {
    // Head characters are H and the overflow is T, so keeping the tail instead of
    // the head cannot look the same.
    const value = (length) => "H".repeat(Math.min(length, 120)) + "T".repeat(Math.max(length - 120, 0));
    for (const [length, expected] of [
      [119, `client="${"H".repeat(119)}"`],
      [120, `client="${"H".repeat(120)}"`],
      [121, `client="${"H".repeat(120)}..."`],
      [5000, `client="${"H".repeat(120)}..."`],
    ]) {
      const d = throwingNormaliser();
      await makeCrmEventsHandler(d)(req(auth, { ...VALID_BODY, client_id: value(length) }), fakeRes());
      const line = d.logger.error.mock.calls[0][0];
      expect(line, `length ${length}`).toContain(expected);
      expect(line, `length ${length}`).not.toContain("TT");
    }
  });

  it("cuts every identifier on the normalise-throws path", async () => {
    // client_id, stage and unique_id are each cut, not just the first: a cap
    // applied to one of them survived the single-field case above.
    const d = throwingNormaliser();
    await makeCrmEventsHandler(d)(
      req(auth, { client_id: "a".repeat(1_000_000), stage: "b".repeat(1_000_000), unique_id: "c".repeat(1_000_000) }),
      fakeRes()
    );
    const line = d.logger.error.mock.calls[0][0];
    expect(line).toContain(`client="${"a".repeat(120)}..."`);
    expect(line).toContain(`stage="${"b".repeat(120)}..."`);
    expect(line).toContain(`unique_id="${"c".repeat(120)}..."`);
    expect(line.length).toBeLessThan(700);
  });

  it("cuts them on the failed-store path too", async () => {
    const d = failingInsert();
    await makeCrmEventsHandler(d)(
      req(auth, { ...VALID_BODY, client_id: "a".repeat(1_000_000), unique_id: "c".repeat(1_000_000) }),
      fakeRes()
    );
    const line = d.logger.error.mock.calls[0][0];
    expect(line).toContain(`client="${"a".repeat(120)}..."`);
    expect(line).toContain(`unique_id="${"c".repeat(120)}..."`);
    expect(line.length).toBeLessThan(700);
  });

  it("cuts them on the key-unstorable path, where the value is the whole problem", async () => {
    // The store's own message still says how long the id was.
    const d = deps({ insert: insertSignupEvent });
    await makeCrmEventsHandler(d)(
      req(auth, { ...VALID_BODY, client_id: "a".repeat(1_000_000), unique_id: "c".repeat(1_000_000) }),
      fakeRes()
    );
    const line = d.logger.error.mock.calls[0][0];
    expect(line).toContain(`client="${"a".repeat(120)}..."`);
    expect(line).toContain("crm_client_id is 1000000 characters");
    expect(line.length).toBeLessThan(700);
  });
});
