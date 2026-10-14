// @vitest-environment node
//
// The one action a person takes in this module, and the only one that ends in
// messages going out to clients. So what is tested here is mostly what it
// REFUSES: a caller who cannot manage users, a destination it does not know, and
// a `sent` row -- that last one lives in the statement and is pinned in
// store.sql.test.js, because a route cannot be the thing that protects it.
//
// No Express. The handler is called directly with a fake `res`, the pattern in
// overviewRoute.test.js, and the registration is checked by reading server.js,
// the pattern in auth/routeCoverage.test.js.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { makeCrmEventsRequeueHandler } from "./requeueRoute.js";
import { DESTINATIONS } from "./store.js";
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

const ADMIN = { sub: 7, email: "ops.manager@skylinkscapital.com", role: "admin" };
const VIEWER = { sub: 8, email: "reader@skylinkscapital.com", role: "viewer" };
const canManage = (auth) => auth?.role === "admin";

const COUNTS = {
  meta: { resendable: 1, scrubbed: 2 },
  whatsapp: { resendable: 3, scrubbed: 4 },
  brevo: { resendable: 12, scrubbed: 28 },
};

function build(options = {}) {
  return makeCrmEventsRequeueHandler({
    canManage,
    requeue: vi.fn(async () => 12),
    count: vi.fn(async () => COUNTS),
    kick: vi.fn(),
    logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
    ...options,
  });
}

/** The handler, plus the spies it was built with, so a case can read both. */
function withSpies(options = {}) {
  const spies = {
    requeue: vi.fn(async () => 12),
    count: vi.fn(async () => COUNTS),
    kick: vi.fn(),
    logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
    ...options,
  };
  return { handler: build(spies), ...spies };
}

const post = (destination, auth = ADMIN) => ({ auth, body: { destination } });

describe("access", () => {
  it("refuses a caller who cannot manage users, without requeueing anything", async () => {
    const { handler, requeue, kick } = withSpies();
    const res = fakeRes();
    await handler(post("brevo", VIEWER), res);
    expect(res.statusCode).toBe(403);
    expect(requeue).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
  });

  it("refuses a request with no session payload at all", async () => {
    const { handler, requeue } = withSpies();
    const res = fakeRes();
    await handler({ body: { destination: "brevo" } }, res);
    expect(res.statusCode).toBe(403);
    expect(requeue).not.toHaveBeenCalled();
  });
});

describe("construction", () => {
  it("refuses to build without each collaborator", () => {
    // A missing `kick` would leave the sends to the sweeper silently; a missing
    // `count` would report every shortfall as unknown. Neither should be a thing
    // that is discovered in production.
    for (const name of ["canManage", "requeue", "count", "kick"]) {
      const args = { canManage, requeue: vi.fn(), count: vi.fn(), kick: vi.fn() };
      delete args[name];
      expect(() => makeCrmEventsRequeueHandler(args), name).toThrow(name);
    }
  });
});

describe("the destination", () => {
  it("requeues the one it was given, and answers with the count", async () => {
    const { handler, requeue } = withSpies();
    const res = fakeRes();
    await handler(post("brevo"), res);
    expect(requeue).toHaveBeenCalledTimes(1);
    expect(requeue).toHaveBeenCalledWith("brevo");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ destination: "brevo", requeued: 12, alreadyScrubbed: 28 });
  });

  it("takes each of the three, and requeues only that one", async () => {
    for (const destination of DESTINATIONS) {
      const { handler, requeue } = withSpies();
      const res = fakeRes();
      await handler(post(destination), res);
      expect(requeue.mock.calls, destination).toEqual([[destination]]);
      expect(res.body.destination, destination).toBe(destination);
    }
  });

  it("refuses one it does not know rather than defaulting to a destination", async () => {
    // Defaulting is the failure that matters: the operator's own destination
    // stays failed while the answer says something was resent, and some other
    // destination's rows go out.
    for (const bad of ["", "   ", "mailchimp", "META", "meta_status", undefined, null, 7, { destination: "meta" }]) {
      const { handler, requeue, kick } = withSpies();
      const res = fakeRes();
      await handler(post(bad), res);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.body.error, JSON.stringify(bad)).toBe("unknown_destination");
      expect(requeue, JSON.stringify(bad)).not.toHaveBeenCalled();
      expect(kick, JSON.stringify(bad)).not.toHaveBeenCalled();
    }
  });

  it("names the three it will take, so the refusal is actionable", async () => {
    const res = fakeRes();
    await build()(post("mailchimp"), res);
    expect(res.body.destinations).toEqual(DESTINATIONS);
  });

  it("reads the destination from the body and never from the path", async () => {
    // The same reason the webhook's stage is a body parameter: the public
    // allow-list is matched against actual request paths, and this route's own
    // path has to stay one string.
    const { handler, requeue } = withSpies();
    await handler({ auth: ADMIN, body: { destination: "meta" }, params: { destination: "brevo" } }, fakeRes());
    expect(requeue).toHaveBeenCalledWith("meta");
  });

  it("accepts a destination with whitespace around it, rather than 400ing a trailing newline", async () => {
    const { handler, requeue } = withSpies();
    const res = fakeRes();
    await handler(post(" brevo\n"), res);
    expect(res.statusCode).toBe(200);
    expect(requeue).toHaveBeenCalledWith("brevo");
  });
});

describe("what the answer has to say", () => {
  it("reports the rows it could not resend, so a shortfall needs no guessing", async () => {
    // The operator sees 40 failures on the Brevo card -- the counters count
    // scrubbed rows -- and gets 12 resends. The other 28 are rows the thirty-day
    // backstop has already scrubbed, and no requeue will ever reach them.
    const res = fakeRes();
    await build()(post("brevo"), res);
    expect(res.body).toMatchObject({ requeued: 12, alreadyScrubbed: 28 });
  });

  it("reads the count for its own destination, not another's", async () => {
    const res = fakeRes();
    await build({ requeue: async () => 3 })(post("whatsapp"), res);
    expect(res.body).toEqual({ destination: "whatsapp", requeued: 3, alreadyScrubbed: 4 });
  });

  it("counts after the requeue, which cannot have changed the scrubbed half", async () => {
    // The statement only touches rows where `scrubbed_at IS NULL`, so the number
    // of scrubbed failures is the same before and after. Asking afterwards means
    // one fewer read on the path that matters.
    const order = [];
    const res = fakeRes();
    await build({
      requeue: vi.fn(async () => void order.push("requeue") || 12),
      count: vi.fn(async () => (order.push("count"), COUNTS)),
    })(post("brevo"), res);
    expect(order).toEqual(["requeue", "count"]);
  });

  it("still reports the requeue when the count read fails, rather than calling it a failure", async () => {
    // The rows ARE pending and the sends are about to go out. A 500 here would
    // tell the operator nothing happened, and they would press it again.
    const { handler, kick, logger } = withSpies({
      count: async () => {
        throw new Error("ER_LOCK_WAIT_TIMEOUT");
      },
    });
    const res = fakeRes();
    await handler(post("brevo"), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ destination: "brevo", requeued: 12, alreadyScrubbed: null });
    expect(kick).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls.flat().join(" ")).toContain("ER_LOCK_WAIT_TIMEOUT");
  });

  it("reports an unknown shortfall as null rather than as none", async () => {
    const res = fakeRes();
    await build({ count: async () => ({}) })(post("meta"), res);
    expect(res.body.alreadyScrubbed).toBeNull();
  });

  it("answers 500 without leaking the database message when the requeue itself fails", async () => {
    const { handler, kick, logger } = withSpies({
      requeue: async () => {
        throw new Error("ER_NO_SUCH_TABLE: signup_events");
      },
    });
    const res = fakeRes();
    await handler(post("brevo"), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "requeue_failed" });
    expect(JSON.stringify(res.body)).not.toContain("ER_NO_SUCH_TABLE");
    expect(logger.error.mock.calls.flat().join(" ")).toContain("ER_NO_SUCH_TABLE");
    // Nothing was requeued, so nothing is kicked.
    expect(kick).not.toHaveBeenCalled();
  });
});

describe("the audit line", () => {
  const lineFrom = (logger) => logger.log.mock.calls.flat().join(" ");

  it("says who asked, for which destination, and how many rows", async () => {
    // This triggers outbound messages to clients, so the record of who pressed it
    // is part of the action. It goes to the iisnode stdout log CUTOVER step 2
    // reads.
    const { handler, logger } = withSpies();
    await handler(post("brevo"), fakeRes());
    const line = lineFrom(logger);
    expect(line).toContain("[crm-events] requeue");
    expect(line).toContain("user=7");
    expect(line).toContain("destination=brevo");
    expect(line).toContain("requeued=12");
    expect(line).toContain("already_scrubbed=28");
  });

  it("masks the actor's address and never prints a whole one", async () => {
    // Spec section 13: no full email address in plain text anywhere. The rule is
    // not about whose address it is.
    const { handler, logger } = withSpies();
    await handler(post("brevo"), fakeRes());
    const line = lineFrom(logger);
    expect(line).not.toContain("ops.manager@skylinkscapital.com");
    expect(line).toContain("o***@skylinkscapital.com");
  });

  it("carries no client data at all", async () => {
    // There is none to carry -- the handler never reads a row -- and this is what
    // keeps it that way. A line naming the clients a resend is about to message
    // would be the one place in this module that leaked a set of them at once.
    const { handler, logger } = withSpies();
    await handler(post("whatsapp"), fakeRes());
    const line = lineFrom(logger);
    // Every address in the line is masked -- which here means the actor's, the
    // only one the handler can see.
    const addresses = [...line.matchAll(/(.{3})@/g)].map(([, before]) => before);
    expect(addresses).toEqual(["***"]);
    // And nothing long enough to be a phone number or an account id.
    expect(line).not.toMatch(/\d{7,}/);
  });

  it("logs a session with no id and no address without inventing either", async () => {
    const { handler, logger } = withSpies();
    await handler({ auth: { role: "admin" }, body: { destination: "meta" } }, fakeRes());
    const line = lineFrom(logger);
    expect(line).toContain("user=unknown");
    expect(line).toContain("no address");
  });

  it("logs the refusals it makes, by not logging a requeue for them", async () => {
    // A 403 and a 400 requeue nothing, so there is nothing to audit; what must
    // not happen is an audit line for an action that did not take place.
    for (const request of [post("brevo", VIEWER), post("mailchimp")]) {
      const { handler, logger } = withSpies();
      await handler(request, fakeRes());
      expect(lineFrom(logger)).toBe("");
    }
  });
});

describe("kicking the worker", () => {
  it("kicks it, so the sends go now rather than at the next sweep", async () => {
    // The operator is watching the tab. The sweeper is a 60-second timer, and the
    // clocks are columns, so nothing is lost either way -- but a control that
    // appears to do nothing for a minute is one people press twice.
    const { handler, kick } = withSpies();
    await handler(post("brevo"), fakeRes());
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("kicks after the requeue, never before it", async () => {
    const order = [];
    await build({
      requeue: async () => (order.push("requeue"), 1),
      kick: () => order.push("kick"),
    })(post("brevo"), fakeRes());
    expect(order).toEqual(["requeue", "kick"]);
  });

  it("does not kick when the statement matched no row", async () => {
    const { handler, kick } = withSpies({ requeue: async () => 0 });
    const res = fakeRes();
    await handler(post("brevo"), res);
    expect(kick).not.toHaveBeenCalled();
    expect(res.body.requeued).toBe(0);
  });

  it("still kicks when the store reported no count, which is not the same as none", async () => {
    // matchedRows returns null when the driver did not say how many rows it
    // matched. Reading that as nothing-to-send would leave real rows for the
    // timer with nothing anywhere saying why.
    const { handler, kick } = withSpies({ requeue: async () => null });
    const res = fakeRes();
    await handler(post("brevo"), res);
    expect(kick).toHaveBeenCalledTimes(1);
    expect(res.body.requeued).toBeNull();
  });

  it("answers the operator even when the kick throws", async () => {
    const { handler, logger } = withSpies({
      kick: () => {
        throw new Error("setImmediate unavailable");
      },
    });
    const res = fakeRes();
    await handler(post("brevo"), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.requeued).toBe(12);
    expect(logger.error.mock.calls.flat().join(" ")).toMatch(/could not kick/i);
  });
});

describe("wiring in server.js", () => {
  // Nothing above reads server.js. Without these, a registration that lost the
  // admin gate, or one added to the public allow-list, would pass every test in
  // this file -- and this is the route that sends messages to clients.
  const SERVER = readFileSync(path.resolve("server.js"), "utf8");

  it("imports the handler and both store calls", () => {
    expect(SERVER).toMatch(/import \{ makeCrmEventsRequeueHandler \} from "\.\/crmSignup\/requeueRoute\.js";/);
    expect(SERVER).toMatch(/import \{[^}]*\brequeueFailedSends\b[^}]*\} from "\.\/crmSignup\/store\.js";/);
    expect(SERVER).toMatch(/import \{[^}]*\bcountResendableSends\b[^}]*\} from "\.\/crmSignup\/store\.js";/);
  });

  it("registers it as a POST behind the session check and the admin check", () => {
    expect(SERVER).toMatch(
      /app\.post\('\/api\/crm-events\/requeue',\s*authRequired,\s*adminOnly,\s*makeCrmEventsRequeueHandler\(\{/
    );
  });

  it("wires the admin predicate, the statement, the count and the kick", () => {
    const block = SERVER.match(/app\.post\('\/api\/crm-events\/requeue'[\s\S]*?\}\)\);/);
    expect(block, "the registration was not found").not.toBeNull();
    expect(block[0]).toMatch(/\bcanManage:\s*canManageUsers\s*,/);
    expect(block[0]).toMatch(/\brequeue:\s*requeueFailedSends\s*,/);
    expect(block[0]).toMatch(/\bcount:\s*countResendableSends\s*,/);
    expect(block[0]).toMatch(/\bkick:\s*kickCrmEventsWorker\s*,/);
  });

  it("is not on the public allow-list, and the list is still the size it is capped at", () => {
    // That list is for FXBO, which cannot carry a session. This route is
    // session-gated by design, and routeCoverage.test.js caps the list at six.
    expect(PUBLIC_API_ROUTES.has("POST /api/crm-events/requeue")).toBe(false);
    expect(PUBLIC_API_ROUTES.size).toBeLessThanOrEqual(6);
  });

  it("gives the overview the resendable count too, so the control can show one", () => {
    const block = SERVER.match(/app\.get\('\/api\/crm-events\/overview'[\s\S]*?\}\)\);/);
    expect(block[0]).toMatch(/\bcountResendable:\s*countResendableSends\s*,/);
  });
});
