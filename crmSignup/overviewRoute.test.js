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

const NOW = new Date("2026-10-13T12:00:00Z");

// The store, as the handler sees it: the four reads, each returning the shape the
// real query returns. They are computed from `rows` the way SQL would compute them,
// so a test that passes rows gets the same answer from every read.
function groupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = [r.stage, r.meta_status, r.whatsapp_status, r.brevo_status].join("|");
    const g = groups.get(key) ?? {
      stage: r.stage,
      meta_status: r.meta_status,
      whatsapp_status: r.whatsapp_status,
      brevo_status: r.brevo_status,
      n: 0,
    };
    g.n += 1;
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** What countResendableSends returns: per destination, the failures the requeue
 *  would match and the ones it no longer can. Computed from `rows` the way the
 *  statement computes it -- `failed` or `rejected`, split on `scrubbed_at` --
 *  so a test that passes rows gets an answer consistent with the counters. */
function resendableOf(rows) {
  const requeueable = new Set(["failed", "rejected"]);
  return Object.fromEntries(
    ["meta", "whatsapp", "brevo"].map((action) => {
      const failures = rows.filter((r) => requeueable.has(r[`${action}_status`]));
      return [
        action,
        {
          resendable: failures.filter((r) => !r.scrubbed_at).length,
          scrubbed: failures.filter((r) => r.scrubbed_at).length,
        },
      ];
    })
  );
}

function storeFor(rows) {
  const inWindow = (since) => rows.filter((r) => new Date(r.received_at) >= since);
  return {
    // Whole table, like health and unlike the counts: the resend is not windowed.
    countResendable: async () => resendableOf(rows),
    // Newest first, capped in SQL: the cap is applied by the read, not by the caller.
    listSince: async (since, cap) => inWindow(since).slice(0, cap),
    countSince: async (since) => groupRows(inWindow(since)),
    latestReceivedAt: async () =>
      rows.reduce((m, r) => {
        const t = new Date(r.received_at);
        return m === null || t > m ? t : m;
      }, null),
    latestByStage: async () => {
      const byStage = new Map();
      for (const r of rows) {
        const t = new Date(r.received_at);
        if (!byStage.has(r.stage) || t > byStage.get(r.stage)) byStage.set(r.stage, t);
      }
      return [...byStage].map(([stage, latest]) => ({ stage, latest }));
    },
  };
}

/** The handler, built the way production builds it. Any read can be overridden. */
function build(options = {}) {
  const { rows = ROWS, ...rest } = options;
  return makeCrmEventsOverviewHandler({ canManage, now: () => NOW, ...storeFor(rows), ...rest });
}

describe("access", () => {
  it("refuses a caller who cannot manage users, without reading anything", async () => {
    const listSince = vi.fn(async () => ROWS);
    const res = fakeRes();
    await build({ listSince })({ auth: VIEWER, query: {} }, res);
    expect(res.statusCode).toBe(403);
    expect(listSince).not.toHaveBeenCalled();
  });

  it("refuses a request with no session payload at all", async () => {
    const res = fakeRes();
    await build({ listSince: vi.fn() })({ query: {} }, res);
    expect(res.statusCode).toBe(403);
  });
});

describe("construction", () => {
  it("refuses to build without each read, rather than falling back to the rows it was given", () => {
    // A missing read would count the rows it was handed and undercount with no sign.
    const reads = storeFor(ROWS);
    for (const name of Object.keys(reads)) {
      const rest = { ...reads };
      delete rest[name];
      expect(() => makeCrmEventsOverviewHandler({ canManage, ...rest }), name).toThrow(name);
    }
  });
});

describe("the payload", () => {
  const now = () => new Date("2026-10-13T12:00:00Z");

  it("returns health, funnel, destinations and the table together", async () => {
    const res = fakeRes();
    await build({ now })({ auth: ADMIN, query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "destinations",
      "events",
      "funnel",
      "health",
      "requeue",
      "windowDays",
    ]);
    expect(res.body.funnel.registered).toBe(1);
    expect(res.body.destinations.meta.sent).toBe(1);
    expect(res.body.events).toHaveLength(1);
  });

  it("masks PII in the table it returns", async () => {
    const res = fakeRes();
    await build({ now })({ auth: ADMIN, query: {} }, res);
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain("ali.khan@example.com");
    expect(serialised).not.toContain("+971507192185");
  });

  it("asks the store for the requested window", async () => {
    const listSince = vi.fn(async () => ROWS);
    await build({ now, listSince })({ auth: ADMIN, query: { days: "7" } }, fakeRes());
    const [since] = listSince.mock.calls[0];
    expect(since.toISOString()).toBe("2026-10-06T12:00:00.000Z");
  });

  it("clamps a silly window rather than trusting the query string", async () => {
    const listSince = vi.fn(async () => ROWS);
    const handler = build({ now, listSince });

    await handler({ auth: ADMIN, query: { days: "99999" } }, fakeRes());
    expect(listSince.mock.calls[0][0].toISOString()).toBe("2026-07-15T12:00:00.000Z"); // 90 days

    await handler({ auth: ADMIN, query: { days: "0" } }, fakeRes());
    expect(listSince.mock.calls[1][0].toISOString()).toBe("2026-10-12T12:00:00.000Z"); // 1 day

    await handler({ auth: ADMIN, query: { days: "nonsense" } }, fakeRes());
    expect(listSince.mock.calls[2][0].toISOString()).toBe("2026-09-13T12:00:00.000Z"); // 30, the default
  });

  it("treats a blank days as absent rather than as a one-day window", async () => {
    // `?days=` arrives as "", Number("") is 0 and 0 is finite, so the clamp
    // raised it to the MINIMUM: the tab reported one day's funnel while saying
    // nothing about the window it had used.
    const listSince = vi.fn(async () => ROWS);
    const handler = build({ now, listSince });
    for (const days of ["", "   ", undefined, null]) {
      const res = fakeRes();
      await handler({ auth: ADMIN, query: { days } }, res);
      expect(res.body.windowDays, JSON.stringify(days)).toBe(30);
    }
    for (const [since] of listSince.mock.calls) {
      expect(since.toISOString()).toBe("2026-09-13T12:00:00.000Z");
    }
  });

  it("caps the table without capping the counts", async () => {
    // The funnel must count the whole window even when the table shows a page. The
    // store caps the table in SQL and counts the window in SQL, as it does in production.
    const many = Array.from({ length: 10 }, (_, i) => ({ ...ROWS[0], id: i + 1 }));
    const res = fakeRes();
    await build({ rows: many, now, tableLimit: 3 })({ auth: ADMIN, query: {} }, res);
    expect(res.body.events).toHaveLength(3);
    expect(res.body.funnel.registered).toBe(10);
  });

  it("answers 500 without leaking the database message", async () => {
    const res = fakeRes();
    const listSince = async () => {
      throw new Error("ER_NO_SUCH_TABLE: signup_events");
    };
    await build({ now, listSince })({ auth: ADMIN, query: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("ER_NO_SUCH_TABLE");
  });

  it("reports health from its own clock and the 72-hour threshold", async () => {
    const ninetySixHoursAgo = [{ ...ROWS[0], received_at: "2026-10-09T12:00:00Z" }];
    const old = fakeRes();
    await build({ rows: ninetySixHoursAgo, now })({ auth: ADMIN, query: {} }, old);
    expect(old.body.health.stale).toBe(true);
    expect(old.body.health.ageHours).toBeCloseTo(96, 3);

    const recent = fakeRes();
    await build({ now })({ auth: ADMIN, query: {} }, recent);
    expect(recent.body.health.stale).toBe(false);
    expect(recent.body.health.ageHours).toBeCloseTo(1, 3);
  });

  it("reports the window it actually used, after clamping", async () => {
    const handler = build({ now });
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
    await build({ rows: many, now, tableLimit: 3 })({ auth: ADMIN, query: {} }, res);
    expect(res.body.events.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("caps the table at 200 rows by default, and still counts all of them", async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ ...ROWS[0], id: i + 1 }));
    const res = fakeRes();
    await build({ rows: many, now })({ auth: ADMIN, query: {} }, res);
    expect(res.body.events).toHaveLength(200);
    expect(res.body.funnel.registered).toBe(201);
  });

  it("reads the real clock when none is injected", async () => {
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const res = fakeRes();
    await build({ now: undefined, rows: [{ ...ROWS[0], received_at: anHourAgo }] })({ auth: ADMIN, query: {} }, res);
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
      await build({ listSince })({ auth: ADMIN, query: {} }, res);
      expect(spy.mock.calls.flat().join(" ")).toContain("ER_NO_SUCH_TABLE");
      expect(JSON.stringify(res.body)).not.toContain("ER_NO_SUCH_TABLE");
    } finally {
      spy.mockRestore();
    }
  });

  it("takes health from the whole table, so a short window cannot read as no events", async () => {
    // The only event is 30 hours old: inside the 72-hour threshold, outside a one-day window.
    const thirtyHoursAgo = [{ ...ROWS[0], stage: "lead", received_at: "2026-10-12T06:00:00Z" }];
    const res = fakeRes();
    await build({ rows: thirtyHoursAgo, now })({ auth: ADMIN, query: { days: "1" } }, res);
    expect(res.body.health.lastReceivedAt).toBe("2026-10-12T06:00:00.000Z");
    expect(res.body.health.ageHours).toBeCloseTo(30, 3);
    expect(res.body.health.stale).toBe(false);
    expect(res.body.health.stages.lead).toMatchObject({ everSeen: true, stale: false });
    expect(res.body.funnel.lead).toBe(0); // the counts still follow the window
    expect(res.body.events).toHaveLength(0);
  });

  it("reports per-stage health from the whole table, so a dead stage cannot hide behind a live one", async () => {
    // Registrations are arriving; the verified rule last fired four days ago.
    const rows = [
      ROWS[0],
      { ...ROWS[0], id: 2, stage: "verified", received_at: "2026-10-09T12:00:00Z" },
    ];
    const res = fakeRes();
    await build({ rows, now })({ auth: ADMIN, query: {} }, res);
    expect(res.body.health.stale).toBe(false);
    expect(res.body.health.stages.verified).toMatchObject({ everSeen: true, stale: true });
    expect(res.body.health.stages.registered).toMatchObject({ everSeen: true, stale: false });
    expect(res.body.health.stages.lead).toEqual({ lastReceivedAt: null, ageHours: null, stale: false, everSeen: false });
  });

  it("counts from the grouped rows, so a window far past the table cap is counted in full", async () => {
    const groups = [
      { stage: "lead", meta_status: "sent", whatsapp_status: "sent", brevo_status: "sent", n: 1000 },
      { stage: "registered", meta_status: "failed", whatsapp_status: "skipped", brevo_status: "sent", n: 4000 },
    ];
    const threeRows = Array.from({ length: 3 }, (_, i) => ({ ...ROWS[0], id: i + 1 }));
    const res = fakeRes();
    await build({
      listSince: async () => threeRows,
      countSince: async () => groups,
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

  it("reports what each destination could resend, over the whole table and not the window", async () => {
    // The resend control's count cannot come from `destinations`: those counters
    // follow the period and they count scrubbed rows, which cannot be resent at
    // all. A button promising 40 and delivering 12 is worse than no button. So
    // the two numbers travel separately, and this one ignores the window exactly
    // as health does.
    const rows = [
      // Inside a one-day window: one Brevo failure that can still be resent.
      { ...ROWS[0], id: 1, brevo_status: "failed", scrubbed_at: null },
      // Outside it, and scrubbed: a failure the thirty-day backstop has taken.
      { ...ROWS[0], id: 2, received_at: "2026-09-20T11:00:00Z", brevo_status: "failed", scrubbed_at: "2026-10-20T11:00:00Z" },
      // Outside it, not scrubbed: still resendable, and still counted.
      { ...ROWS[0], id: 3, received_at: "2026-09-21T11:00:00Z", whatsapp_status: "rejected", scrubbed_at: null },
    ];
    const res = fakeRes();
    await build({ rows, now })({ auth: ADMIN, query: { days: "1" } }, res);
    expect(res.body.requeue).toEqual({
      meta: { resendable: 0, scrubbed: 0 },
      whatsapp: { resendable: 1, scrubbed: 0 },
      brevo: { resendable: 1, scrubbed: 1 },
    });
    // And the window still governs everything else, so the two cannot be read
    // as the same number.
    expect(res.body.events).toHaveLength(1);
    expect(res.body.destinations.brevo.failed).toBe(1);
  });

  it("asks the resendable count for no window at all", async () => {
    const countResendable = vi.fn(async () => ({
      meta: { resendable: 0, scrubbed: 0 },
      whatsapp: { resendable: 0, scrubbed: 0 },
      brevo: { resendable: 0, scrubbed: 0 },
    }));
    await build({ now, countResendable })({ auth: ADMIN, query: { days: "7" } }, fakeRes());
    expect(countResendable).toHaveBeenCalledTimes(1);
    expect(countResendable.mock.calls[0]).toEqual([]);
  });

  it("answers 500 when the resendable count fails, rather than a page with a control that promises zero", async () => {
    // A zero disables the control and says there is nothing to resend. Reporting
    // that because a read failed would hide forty failures behind a calm page.
    const res = fakeRes();
    await build({
      now,
      countResendable: async () => {
        throw new Error("ER_NO_SUCH_TABLE: signup_events");
      },
    })({ auth: ADMIN, query: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("ER_NO_SUCH_TABLE");
  });

  it("asks the store for no more rows than the table shows", async () => {
    const listSince = vi.fn(async () => ROWS);
    await build({ listSince, now, tableLimit: 3 })({ auth: ADMIN, query: {} }, fakeRes());
    expect(listSince.mock.calls[0][1]).toBe(3);
  });

  it("shows no more rows than the table holds, even if the store hands back more", async () => {
    // The store caps the table in SQL. The route keeps its own cap too, so a read that
    // ignores the cap still cannot push the table past its size.
    const many = Array.from({ length: 10 }, (_, i) => ({ ...ROWS[0], id: i + 1 }));
    const res = fakeRes();
    await build({ now, tableLimit: 3, listSince: async () => many })({ auth: ADMIN, query: {} }, res);
    expect(res.body.events.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("counts every group, even when there are more groups than the table shows", async () => {
    // Five stages of 1,000 events each. The table shows three rows; the counts show all five.
    const stages = ["lead", "registered", "verified", "live_account", "first_deposit"];
    const groups = stages.map((stage) => ({ stage, meta_status: "sent", whatsapp_status: "sent", brevo_status: "sent", n: 1000 }));
    const res = fakeRes();
    await build({ now, tableLimit: 3, countSince: async () => groups })({ auth: ADMIN, query: {} }, res);
    for (const stage of stages) expect(res.body.funnel[stage], stage).toBe(1000);
    expect(res.body.destinations.meta.sent).toBe(5000);
  });
});

describe("wiring in server.js", () => {
  // Nothing above reads server.js. Without these, a registration that lost the
  // admin gate, or one added to the public allow-list, would pass every test.
  const SERVER = readFileSync(path.resolve("server.js"), "utf8");

  it("imports the handler and the store reads", () => {
    expect(SERVER).toMatch(/import \{ makeCrmEventsOverviewHandler \} from "\.\/crmSignup\/overviewRoute\.js";/);
    expect(SERVER).toMatch(/import \{[^}]*\blistEventsSince\b[^}]*\} from "\.\/crmSignup\/store\.js";/);
    expect(SERVER).toMatch(/import \{[^}]*\bcountEventsSince\b[^}]*\} from "\.\/crmSignup\/store\.js";/);
    expect(SERVER).toMatch(/import \{[^}]*\blatestEventReceivedAt\b[^}]*\} from "\.\/crmSignup\/store\.js";/);
    expect(SERVER).toMatch(/import \{[^}]*\blatestReceivedAtByStage\b[^}]*\} from "\.\/crmSignup\/store\.js";/);
  });

  it("registers it behind the session check and the admin check", () => {
    expect(SERVER).toMatch(/app\.get\('\/api\/crm-events\/overview',\s*authRequired,\s*adminOnly,\s*makeCrmEventsOverviewHandler\(\{/);
  });

  it("wires the admin predicate and all four reads", () => {
    const block = SERVER.match(/app\.get\('\/api\/crm-events\/overview'[\s\S]*?\}\)\);/);
    expect(block, "the registration was not found").not.toBeNull();
    expect(block[0]).toMatch(/\bcanManage:\s*canManageUsers\s*,/);
    expect(block[0]).toMatch(/\blistSince:\s*listEventsSince\s*,/);
    expect(block[0]).toMatch(/\bcountSince:\s*countEventsSince\s*,/);
    expect(block[0]).toMatch(/\blatestReceivedAt:\s*latestEventReceivedAt\s*,/);
    expect(block[0]).toMatch(/\blatestByStage:\s*latestReceivedAtByStage\s*,/);
  });

  it("is not on the public allow-list, because it reads the database for an admin", () => {
    expect(PUBLIC_API_ROUTES.has("GET /api/crm-events/overview")).toBe(false);
  });
});
