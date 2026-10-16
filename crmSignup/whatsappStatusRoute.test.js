// @vitest-environment node
//
// POST /api/crm-events/whatsapp-status, tested with a fake `res` and a fake
// store. Express is never booted here, as everywhere else in this module.
//
// **This endpoint takes no shared secret, so its contract IS its security.**
// Every assertion below is one clause of that contract:
//
//   it may only ever write the delivery columns of the row whose frozen
//   `whatsapp_request_id` matches the incoming `messageId`;
//   it may not return anything read from the row;
//   it must answer identically for a known and an unknown id, so it cannot be
//   used to find out which ids exist;
//   it must answer 200 and never throw.
//
// A test here that merely checked "it records the status" would pass for a
// handler that also returned the client's stage, or that answered 404 for an
// unknown id -- either of which turns the id from a capability into a puzzle
// with a hint.
import { describe, it, expect, vi } from "vitest";
import { makeWhatsappStatusHandler } from "./whatsappStatusRoute.js";
import { readFileSync } from "fs";
import path from "path";
import { PUBLIC_API_ROUTES } from "../auth/requireSession.js";

const ID = "6d0c7f2e-0d3a-4a6f-9b3e-1f2c3d4e5f60";

function fakeRes() {
  const sent = { status: null, body: undefined, calls: 0 };
  return {
    sent,
    status(code) {
      sent.status = code;
      return this;
    },
    json(body) {
      sent.body = body;
      sent.calls += 1;
      return this;
    },
  };
}

const silent = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** A handler over a store that reports `matched` rows, and the calls it made. */
function handlerOver(matched = 1, logger = silent()) {
  const record = vi.fn(async () => matched);
  return {
    record,
    logger,
    handler: makeWhatsappStatusHandler({ record, logger, now: () => new Date("2026-10-16T09:00:00.000Z") }),
  };
}

const post = async (handler, body) => {
  const res = fakeRes();
  await handler({ method: "POST", path: "/api/crm-events/whatsapp-status", body }, res);
  return res.sent;
};

describe("what it writes", () => {
  it("records the status against the id that arrived, and nothing else", async () => {
    const { handler, record } = handlerOver();
    await post(handler, { messageId: ID, status: "DELIVERED", statusTimestamp: 1760000000000 });

    expect(record).toHaveBeenCalledTimes(1);
    const [messageId, update] = record.mock.calls[0];
    expect(messageId).toBe(ID);
    // Exactly three fields reach the store, and they are the three delivery
    // columns. A status, an attempt count or a clock among them would be the
    // worker's own state, writable by an unauthenticated caller.
    expect(Object.keys(update).sort()).toEqual(["at", "detail", "status"]);
  });

  it("passes the status verbatim, so an undocumented read value is stored as itself", async () => {
    const { handler, record } = handlerOver();
    await post(handler, { messageId: ID, status: "SeenByRecipient" });
    expect(record.mock.calls[0][1].status).toBe("SeenByRecipient");
  });

  it("carries failMessage into the detail, and null when there is none", async () => {
    const { handler, record } = handlerOver();
    await post(handler, { messageId: ID, status: "FAILED", failMessage: "number not on WhatsApp" });
    expect(record.mock.calls[0][1].detail).toBe("number not on WhatsApp");

    await post(handler, { messageId: ID, status: "DELIVERED" });
    expect(record.mock.calls[1][1].detail).toBeNull();
  });

  it("writes nothing at all for a payload it could not read", async () => {
    // No messageId means no row to reach; no status means nothing to say about
    // one. Either way the store is not called, so a malformed body cannot blank
    // a delivery column that already holds a real value.
    const { handler, record } = handlerOver();
    for (const body of [undefined, null, {}, { messageId: ID }, { status: "DELIVERED" }, [{ messageId: ID }]]) {
      await post(handler, body);
    }
    expect(record).not.toHaveBeenCalled();
  });
});

describe("what it answers", () => {
  it("answers 200 with a bare acknowledgement", async () => {
    const { handler } = handlerOver();
    const sent = await post(handler, { messageId: ID, status: "DELIVERED" });
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ ok: true });
    expect(sent.calls).toBe(1);
  });

  it("answers a known and an unknown id identically, so it cannot be used to find an id", async () => {
    // The id IS the capability (no shared secret). An endpoint that answered
    // differently when a guess landed would be an oracle: one request per guess,
    // and a visible hit. Status, body and shape all have to match.
    const known = await post(handlerOver(1).handler, { messageId: ID, status: "DELIVERED" });
    const unknown = await post(handlerOver(0).handler, { messageId: ID, status: "DELIVERED" });
    expect(unknown).toEqual(known);
  });

  it("answers the same thing to a malformed body and to a store that threw", async () => {
    // Every other way of being wrong has to look the same too, or the
    // differences add up to the same oracle.
    const ok = await post(handlerOver(1).handler, { messageId: ID, status: "DELIVERED" });

    const malformed = await post(handlerOver(1).handler, { nonsense: true });

    const record = vi.fn(async () => {
      throw new Error("Table 'crm.signup_events' doesn't exist");
    });
    const broken = await post(makeWhatsappStatusHandler({ record, logger: silent() }), {
      messageId: ID,
      status: "DELIVERED",
    });

    expect(malformed).toEqual(ok);
    expect(broken).toEqual(ok);
  });

  it("returns nothing read from the row -- no client data, no row count, no id", async () => {
    // The store is asked for a count and the handler has it; the answer must not
    // carry it. Nor may it echo the messageId back, which would confirm a guess.
    const { handler } = handlerOver(1);
    const sent = await post(handler, { messageId: ID, status: "DELIVERED" });
    const body = JSON.stringify(sent.body);
    expect(Object.keys(sent.body)).toEqual(["ok"]);
    for (const leak of [ID, "matched", "delivered", "stage", "crm", "client", "1"]) {
      expect(body.toLowerCase(), leak).not.toContain(leak.toLowerCase());
    }
  });

  it("never throws, whatever the store does", async () => {
    for (const boom of [new Error("down"), "a string", null, undefined]) {
      const record = vi.fn(async () => {
        throw boom;
      });
      const handler = makeWhatsappStatusHandler({ record, logger: silent() });
      await expect(post(handler, { messageId: ID, status: "SENT" })).resolves.toMatchObject({ status: 200 });
    }
  });

  it("resolves to nothing, not to the response object", async () => {
    // `res.json()` returns `res`, so a handler written as `return
    // res.status(200).json(..)` resolves to it. The declared contract is
    // Promise<void> and router.js has the same note.
    const { handler } = handlerOver();
    await expect(handler({ body: { messageId: ID, status: "SENT" } }, fakeRes())).resolves.toBeUndefined();
    await expect(handler({ body: {} }, fakeRes())).resolves.toBeUndefined();
  });
});

describe("the two questions the documentation leaves open", () => {
  it("logs a status that matched no row, with a running count, rather than swallowing it", async () => {
    // This is how an operator learns that `messageId` on DoubleTick's event is
    // THEIRS and not the one we supplied -- the thing their documentation does
    // not say. Silence here would leave the question open for ever.
    const logger = silent();
    const { handler } = handlerOver(0, logger);
    await post(handler, { messageId: ID, status: "DELIVERED" });
    await post(handler, { messageId: ID, status: "DELIVERED" });

    const lines = logger.warn.mock.calls.map(([line]) => String(line));
    expect(lines.some((l) => /id we never issued/.test(l))).toBe(true);
    expect(lines.some((l) => /unmatched=1/.test(l))).toBe(true);
    // The count is the whole value of it: once is a shape surprise, every time
    // is the answer.
    expect(lines.some((l) => /unmatched=2/.test(l))).toBe(true);
    expect(lines.some((l) => /messageId is theirs/.test(l))).toBe(true);
  });

  it("never logs the id in full, because the id is the capability", async () => {
    // A log line carrying a whole frozen id hands it to anyone who can read the
    // iisnode stdout log -- the hook.php mistake, moved into our own log.
    const logger = silent();
    const { handler } = handlerOver(0, logger);
    await post(handler, { messageId: ID, status: "DELIVERED" });
    const all = [...logger.warn.mock.calls, ...logger.log.mock.calls, ...logger.error.mock.calls]
      .map(([line]) => String(line))
      .join("\n");
    expect(all).not.toContain(ID);
    expect(all).toContain(ID.slice(0, 8));
  });

  it("says so once when an id DOES match, which answers the same question the other way", async () => {
    const logger = silent();
    const { handler } = handlerOver(1, logger);
    await post(handler, { messageId: ID, status: "DELIVERED" });
    await post(handler, { messageId: ID, status: "READ" });

    expect(logger.log.mock.calls.map(([l]) => String(l)).join("\n")).toMatch(/echoes our messageId/);
    // Once. A line per delivered message would be a line on every registration.
    expect(logger.log).toHaveBeenCalledTimes(1);
  });

  it("logs an unrecognised status, naming it, so the real read value gets found", async () => {
    // The exact read string is not documented. It is stored verbatim either way;
    // this is what makes it findable without anyone opening the tab.
    const logger = silent();
    const { handler } = handlerOver(1, logger);
    await post(handler, { messageId: ID, status: "SeenByRecipient" });
    const line = logger.warn.mock.calls.map(([l]) => String(l)).join("\n");
    expect(line).toMatch(/not recognised/);
    expect(line).toContain("SeenByRecipient");
    expect(line).toMatch(/whatsappStatus\.js/);
  });

  it("logs nothing about recognition when the status is one of the known ones", async () => {
    const logger = silent();
    const { handler } = handlerOver(1, logger);
    await post(handler, { messageId: ID, status: "delivered" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs a body whose shape it could not read, without printing the body", async () => {
    // The payload shape comes from documentation rather than from traffic, so a
    // difference shows up here. The body is a third party's and we have not
    // understood it, so it is not echoed into the log.
    const logger = silent();
    const { handler } = handlerOver(1, logger);
    await post(handler, { data: { messageId: ID, status: "DELIVERED", secret: "hunter2" } });
    const line = logger.warn.mock.calls.map(([l]) => String(l)).join("\n");
    expect(line).toMatch(/no messageId and status it could read/);
    expect(line).not.toContain("hunter2");
  });
});

describe("construction", () => {
  it("refuses to be built without the one thing it may do", () => {
    expect(() => makeWhatsappStatusHandler({})).toThrow(/record is required/);
  });
});

describe("wiring in server.js", () => {
  // Nothing above reads server.js. Without these, a route wired to a sender, or
  // one that quietly gained the session gate it cannot satisfy, would pass every
  // test in this file.
  const SERVER = readFileSync(path.resolve("server.js"), "utf8");
  const block = SERVER.match(/app\.post\('\/api\/crm-events\/whatsapp-status'[\s\S]*?\}\)\);/);

  it("registers the route and imports the handler", () => {
    expect(SERVER).toMatch(/import \{ makeWhatsappStatusHandler \} from "\.\/crmSignup\/whatsappStatusRoute\.js";/);
    expect(block, "the registration was not found").not.toBeNull();
  });

  it("wires it to the delivery writer and to nothing else", () => {
    // The whole point of the design: this endpoint can reach one statement. A
    // sender, a requeue or a store read passed in here would be reachable by an
    // unauthenticated caller.
    expect(block[0]).toMatch(/\brecord:\s*recordWhatsappDelivery\s*,/);
    expect(SERVER).toMatch(/import \{[^}]*\brecordWhatsappDelivery\b[^}]*\} from "\.\/crmSignup\/store\.js";/);
    for (const name of ["requeueFailedSends", "kickCrmEventsWorker", "listEventsSince", "insertSignupEvent"]) {
      expect(block[0], name).not.toContain(name);
    }
  });

  it("is on the public allow-list, because DoubleTick cannot carry a session", () => {
    expect(PUBLIC_API_ROUTES.has("POST /api/crm-events/whatsapp-status")).toBe(true);
  });

  it("carries no secret of its own, in the path or in the handler's options", () => {
    // Their webhook has no signature and no secret header to send. A secret in
    // the path or the query string would be worse than none: the hook.php
    // mirrors do that and theirs is readable in the CRM's own webhook log.
    expect(block[0]).not.toMatch(/secret|token|bearer/i);
    expect(SERVER).not.toMatch(/whatsapp-status\/[^']*'/);
    expect(SERVER).not.toMatch(/whatsapp-status\?/);
  });

  it("takes neither authRequired nor adminOnly, which it could never satisfy", () => {
    expect(block[0]).not.toMatch(/authRequired|adminOnly/);
  });
});
