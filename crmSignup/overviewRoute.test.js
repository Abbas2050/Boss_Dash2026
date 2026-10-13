// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { makeCrmEventsOverviewHandler } from "./overviewRoute.js";
import { readFileSync } from "fs";
import path from "path";
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

const ADMIN = { sub: "1", role: "admin" };
const VIEWER = { sub: "2", role: "viewer" };
const canManage = (auth) => auth?.role === "admin";

const ROWS = [
  {
    id: 1,
    crm_client_id: "88214",
    stage: "registered",
    first_name: "Ali",
    last_name: "Khan",
    email: "ali.khan@example.com",
    phone: "+971507192185",
    record_type: "client",
    source: "SVG",
    meta_status: "sent",
    meta_detail: "http 200",
    meta_attempts: 1,
    whatsapp_status: "sent",
    whatsapp_detail: "SENT",
    whatsapp_attempts: 1,
    brevo_status: "sent",
    brevo_detail: "http 201",
    brevo_attempts: 1,
    received_at: "2026-10-13T11:00:00Z",
  },
];

describe("access", () => {
  it("refuses a caller who cannot manage users, without reading anything", async () => {
    const listSince = vi.fn(async () => ROWS);
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince })({ auth: VIEWER, query: {} }, res);
    expect(res.statusCode).toBe(403);
    expect(listSince).not.toHaveBeenCalled();
  });

  it("refuses a request with no session payload at all", async () => {
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince: vi.fn() })({ query: {} }, res);
    expect(res.statusCode).toBe(403);
  });
});

describe("the payload", () => {
  const now = () => new Date("2026-10-13T12:00:00Z");

  it("returns health, funnel, destinations and the table together", async () => {
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince: async () => ROWS, now })(
      { auth: ADMIN, query: {} },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "destinations",
      "events",
      "funnel",
      "health",
      "windowDays",
    ]);
    expect(res.body.funnel.registered).toBe(1);
    expect(res.body.destinations.meta.sent).toBe(1);
    expect(res.body.events).toHaveLength(1);
  });

  it("masks PII in the table it returns", async () => {
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince: async () => ROWS, now })(
      { auth: ADMIN, query: {} },
      res
    );
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain("ali.khan@example.com");
    expect(serialised).not.toContain("+971507192185");
  });

  it("asks the store for the requested window", async () => {
    const listSince = vi.fn(async () => ROWS);
    await makeCrmEventsOverviewHandler({ canManage, listSince, now })(
      { auth: ADMIN, query: { days: "7" } },
      fakeRes()
    );
    const [since] = listSince.mock.calls[0];
    expect(since.toISOString()).toBe("2026-10-06T12:00:00.000Z");
  });

  it("clamps a silly window rather than trusting the query string", async () => {
    const listSince = vi.fn(async () => ROWS);
    const handler = makeCrmEventsOverviewHandler({ canManage, listSince, now });

    await handler({ auth: ADMIN, query: { days: "99999" } }, fakeRes());
    expect(listSince.mock.calls[0][0].toISOString()).toBe("2026-07-15T12:00:00.000Z"); // 90 days

    await handler({ auth: ADMIN, query: { days: "0" } }, fakeRes());
    expect(listSince.mock.calls[1][0].toISOString()).toBe("2026-10-12T12:00:00.000Z"); // 1 day

    await handler({ auth: ADMIN, query: { days: "nonsense" } }, fakeRes());
    expect(listSince.mock.calls[2][0].toISOString()).toBe("2026-09-13T12:00:00.000Z"); // 30, the default
  });

  it("caps the table without capping the counts", async () => {
    // The funnel must count the whole window even when the table shows a page.
    const many = Array.from({ length: 10 }, (_, i) => ({ ...ROWS[0], id: i + 1 }));
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince: async () => many, now, tableLimit: 3 })(
      { auth: ADMIN, query: {} },
      res
    );
    expect(res.body.events).toHaveLength(3);
    expect(res.body.funnel.registered).toBe(10);
  });

  it("answers 500 without leaking the database message", async () => {
    const res = fakeRes();
    const listSince = async () => {
      throw new Error("ER_NO_SUCH_TABLE: signup_events");
    };
    await makeCrmEventsOverviewHandler({ canManage, listSince, now })({ auth: ADMIN, query: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("ER_NO_SUCH_TABLE");
  });

  it("reports health from its own clock and the 72-hour threshold", async () => {
    const ninetySixHoursAgo = [{ ...ROWS[0], received_at: "2026-10-09T12:00:00Z" }];
    const old = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince: async () => ninetySixHoursAgo, now })(
      { auth: ADMIN, query: {} },
      old
    );
    expect(old.body.health.stale).toBe(true);
    expect(old.body.health.ageHours).toBeCloseTo(96, 3);

    const recent = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince: async () => ROWS, now })(
      { auth: ADMIN, query: {} },
      recent
    );
    expect(recent.body.health.stale).toBe(false);
    expect(recent.body.health.ageHours).toBeCloseTo(1, 3);
  });

  it("reports the window it actually used, after clamping", async () => {
    const handler = makeCrmEventsOverviewHandler({ canManage, listSince: async () => ROWS, now });
    const seven = fakeRes();
    await handler({ auth: ADMIN, query: { days: "7" } }, seven);
    expect(seven.body.windowDays).toBe(7);

    const clamped = fakeRes();
    await handler({ auth: ADMIN, query: { days: "99999" } }, clamped);
    expect(clamped.body.windowDays).toBe(90);
  });

  it("keeps the newest rows in the table, in the order the store gave them", async () => {
    // listEventsSince returns newest first, so the table is the head of the list.
    const many = Array.from({ length: 10 }, (_, i) => ({ ...ROWS[0], id: i + 1 }));
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince: async () => many, now, tableLimit: 3 })(
      { auth: ADMIN, query: {} },
      res
    );
    expect(res.body.events.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("caps the table at 200 rows by default, and still counts all of them", async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ ...ROWS[0], id: i + 1 }));
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince: async () => many, now })(
      { auth: ADMIN, query: {} },
      res
    );
    expect(res.body.events).toHaveLength(200);
    expect(res.body.funnel.registered).toBe(201);
  });

  it("reads the real clock when none is injected", async () => {
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({ canManage, listSince: async () => [{ ...ROWS[0], received_at: anHourAgo }] })(
      { auth: ADMIN, query: {} },
      res
    );
    expect(res.body.health.stale).toBe(false);
    expect(res.body.health.ageHours).toBeCloseTo(1, 1);
  });

  it("logs the database message to the console, and does not return it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = fakeRes();
      const listSince = async () => {
        throw new Error("ER_NO_SUCH_TABLE: signup_events");
      };
      await makeCrmEventsOverviewHandler({ canManage, listSince })({ auth: ADMIN, query: {} }, res);
      expect(spy.mock.calls.flat().join(" ")).toContain("ER_NO_SUCH_TABLE");
      expect(JSON.stringify(res.body)).not.toContain("ER_NO_SUCH_TABLE");
    } finally {
      spy.mockRestore();
    }
  });
  it("takes health from the whole table, so a short window cannot read as no events", async () => {
    // The newest event is 30 hours old: inside the 72-hour threshold, outside a one-day window.
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({
      canManage,
      listSince: async () => [],
      countSince: async () => [],
      latestReceivedAt: async () => new Date("2026-10-12T06:00:00Z"),
      now,
    })({ auth: ADMIN, query: { days: "1" } }, res);
    expect(res.body.health.lastReceivedAt).toBe("2026-10-12T06:00:00.000Z");
    expect(res.body.health.ageHours).toBeCloseTo(30, 3);
    expect(res.body.health.stale).toBe(false);
    expect(res.body.funnel.lead).toBe(0); // the counts still follow the window
  });

  it("counts from the grouped rows, so a window far past the table cap is counted in full", async () => {
    const groups = [
      { stage: "lead", meta_status: "sent", whatsapp_status: "sent", brevo_status: "sent", n: 1000 },
      { stage: "registered", meta_status: "failed", whatsapp_status: "skipped", brevo_status: "sent", n: 4000 },
    ];
    const threeRows = Array.from({ length: 3 }, (_, i) => ({ ...ROWS[0], id: i + 1 }));
    const res = fakeRes();
    await makeCrmEventsOverviewHandler({
      canManage,
      listSince: async () => threeRows,
      countSince: async () => groups,
      latestReceivedAt: async () => new Date("2026-10-13T11:00:00Z"),
      now,
      tableLimit: 3,
    })({ auth: ADMIN, query: {} }, res);
    expect(res.body.events).toHaveLength(3);
    expect(res.body.funnel.lead).toBe(1000);
    expect(res.body.funnel.registered).toBe(4000);
    expect(res.body.destinations.meta.sent).toBe(1000);
    expect(res.body.destinations.meta.failed).toBe(4000);
    expect(res.body.destinations.whatsapp.skipped).toBe(4000);
  });

  it("asks the store for no more rows than the table shows", async () => {
    const listSince = vi.fn(async () => ROWS);
    await makeCrmEventsOverviewHandler({ canManage, listSince, now, tableLimit: 3 })({ auth: ADMIN, query: {} }, fakeRes());
    expect(listSince.mock.calls[0][1]).toBe(3);
  });
});

describe("wiring in server.js", () => {
  // Nothing above reads server.js. Without these, a registration that lost the
  // admin gate, or one added to the public allow-list, would pass every test.
  const SERVER = readFileSync(path.resolve("server.js"), "utf8");

  it("imports the handler and the three store reads", () => {
    expect(SERVER).toMatch(/import \{ makeCrmEventsOverviewHandler \} from "\.\/crmSignup\/overviewRoute\.js";/);
    expect(SERVER).toMatch(/import \{[^}]*\blistEventsSince\b[^}]*\} from "\.\/crmSignup\/store\.js";/);
    expect(SERVER).toMatch(/import \{[^}]*\bcountEventsSince\b[^}]*\} from "\.\/crmSignup\/store\.js";/);
    expect(SERVER).toMatch(/import \{[^}]*\blatestEventReceivedAt\b[^}]*\} from "\.\/crmSignup\/store\.js";/);
  });

  it("registers it behind the session check and the admin check", () => {
    expect(SERVER).toMatch(/app\.get\('\/api\/crm-events\/overview',\s*authRequired,\s*adminOnly,\s*makeCrmEventsOverviewHandler\(\{/);
  });

  it("wires the admin predicate, the table read, the grouped count and the whole-table latest timestamp", () => {
    const block = SERVER.match(/app\.get\('\/api\/crm-events\/overview'[\s\S]*?\}\)\);/);
    expect(block, "the registration was not found").not.toBeNull();
    expect(block[0]).toMatch(/\bcanManage:\s*canManageUsers\s*,/);
    expect(block[0]).toMatch(/\blistSince:\s*listEventsSince\s*,/);
    expect(block[0]).toMatch(/\bcountSince:\s*countEventsSince\s*,/);
    expect(block[0]).toMatch(/\blatestReceivedAt:\s*latestEventReceivedAt\s*,/);
  });

  it("is not on the public allow-list, because it reads the database for an admin", () => {
    expect(PUBLIC_API_ROUTES.has("GET /api/crm-events/overview")).toBe(false);
  });
});
