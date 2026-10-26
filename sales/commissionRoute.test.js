// @vitest-environment node
//
// The HTTP behaviour of GET /api/sales/commission, with fakes for the three
// fetches. No Express is booted: the handler is an ordinary (req, res) function
// and the assertions are on the object handed to res.json.
import { describe, it, expect, vi } from "vitest";
import { makeSalesCommissionHandler } from "./commissionRoute.js";

const SUPER_ADMIN = { sub: "1", role: "Super Admin", name: "Abbas" };
const SALESPERSON = { sub: "7", role: "Analyst", crmManagerId: 28, name: "Mitul" };
const NOBODY = { sub: "9", role: "Manager", access: ["Sales"], name: "A Manager" };

const CLIENTS = {
  clients: [
    { userId: 101, managerId: 28, name: "Alice Trader" },
    { userId: 102, managerId: 23, name: "Bob Trader" },
  ],
  accounts: [
    { login: "5001", userId: 101 },
    { login: "5002", userId: 102 },
  ],
};
const VOLUME = {
  rows: [
    { login: "5001", lots: 100, stocksLots: 40, cfdLots: 12.5 },
    { login: "5002", lots: 10, stocksLots: 0, cfdLots: 3 },
  ],
};
const REVENUE = {
  rows: [
    { login: "5001", totalRevenueUsd: 900.25 },
    { login: "5002", totalRevenueUsd: 100 },
  ],
};

function makeRes() {
  const sent = { status: 200, body: undefined };
  return {
    sent,
    status(code) {
      sent.status = code;
      return this;
    },
    json(body) {
      sent.body = body;
      return this;
    },
  };
}

const QUIET = { warn: () => {}, error: () => {} };

function handlerWith(overrides = {}) {
  return makeSalesCommissionHandler({
    fetchSalesClients: vi.fn(async () => CLIENTS),
    fetchClientVolume: vi.fn(async () => VOLUME),
    fetchClientRevenue: vi.fn(async () => REVENUE),
    now: () => new Date("2026-10-26T09:00:00Z"),
    logger: QUIET,
    ...overrides,
  });
}

async function call(handler, req) {
  const res = makeRes();
  await handler(req, res);
  return res.sent;
}

const RANGE_QUERY = { from: "2026-10-01", to: "2026-10-26" };

describe("the factory", () => {
  it("refuses to be built without all three fetches", () => {
    expect(() => makeSalesCommissionHandler({})).toThrow(/fetchSalesClients is required/);
    expect(() =>
      makeSalesCommissionHandler({ fetchSalesClients: () => {}, fetchClientVolume: () => {} }),
    ).toThrow(/fetchClientRevenue is required/);
  });
});

describe("who gets served", () => {
  it("answers 403 to a caller with neither Super Admin nor a crmManagerId", async () => {
    const fetchSalesClients = vi.fn();
    const sent = await call(handlerWith({ fetchSalesClients }), { auth: NOBODY, query: RANGE_QUERY });
    expect(sent.status).toBe(403);
    expect(sent.body).toEqual({ error: "forbidden" });
    // Nothing is fetched for a caller who may not see any of it.
    expect(fetchSalesClients).not.toHaveBeenCalled();
  });

  it("answers 403 when there is no session at all", async () => {
    expect((await call(handlerWith(), { query: RANGE_QUERY })).status).toBe(403);
  });

  it("takes the manager id from the session, never from the request", async () => {
    // The request shouts a different manager id in three places. The only one
    // that counts is the crmManagerId authRequired read out of the database.
    const fetchSalesClients = vi.fn(async () => CLIENTS);
    const sent = await call(handlerWith({ fetchSalesClients }), {
      auth: SALESPERSON,
      query: { ...RANGE_QUERY, managerId: "23", crmManagerId: "23", scope: "all" },
    });
    expect(fetchSalesClients).toHaveBeenCalledWith({ managerIds: [28] });
    expect(sent.body.managerId).toBe(28);
    expect(sent.body.scope).toBe("self");
    expect(JSON.stringify(sent.body)).not.toContain("Bob Trader");
  });

  it("never fetches revenue for a sales caller, let alone returns it", async () => {
    const fetchClientRevenue = vi.fn(async () => REVENUE);
    const sent = await call(handlerWith({ fetchClientRevenue }), { auth: SALESPERSON, query: RANGE_QUERY });
    expect(fetchClientRevenue).not.toHaveBeenCalled();
    expect(sent.status).toBe(200);
    expect(JSON.stringify(sent.body)).not.toMatch(/revenue/i);
    expect(JSON.stringify(sent.body)).not.toMatch(/margin/i);
    expect(sent.body.totals.commissionUsd).toBe(12.5);
  });

  it("gives a Super Admin every salesperson, with revenue and margin", async () => {
    const sent = await call(handlerWith(), { auth: SUPER_ADMIN, query: RANGE_QUERY });
    expect(sent.status).toBe(200);
    expect(sent.body.scope).toBe("all");
    expect(sent.body.totals.commissionUsd).toBe(15.5);
    expect(sent.body.totals.revenueUsd).toBe(1000.25);
    expect(sent.body.totals.marginAfterCommissionUsd).toBe(984.75);
    expect(sent.body.degraded).toEqual([]);
  });
});

describe("the window", () => {
  it("rejects an unusable range before spending a 40-second fetch on it", async () => {
    const fetchClientRevenue = vi.fn();
    const sent = await call(handlerWith({ fetchClientRevenue }), {
      auth: SUPER_ADMIN,
      query: { from: "2026-10-26", to: "2026-10-01" },
    });
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ error: "from_after_to" });
    expect(fetchClientRevenue).not.toHaveBeenCalled();
  });

  it("defaults to the current month and passes the same window to both backends", async () => {
    const fetchClientVolume = vi.fn(async () => VOLUME);
    const fetchClientRevenue = vi.fn(async () => REVENUE);
    const sent = await call(handlerWith({ fetchClientVolume, fetchClientRevenue }), {
      auth: SUPER_ADMIN,
      query: {},
    });
    const expected = { from: "2026-10-01", to: "2026-10-26" };
    expect(fetchClientVolume).toHaveBeenCalledWith(expected);
    expect(fetchClientRevenue).toHaveBeenCalledWith(expected);
    expect(sent.body.range).toEqual(expected);
  });
});

describe("the three fetches run concurrently", () => {
  it(
    "starts all three before awaiting any of them",
    async () => {
      // DealMatch/Run costs ~40s regardless of range, so serialising these adds
      // that 40s to the other two rather than hiding behind it. The barrier
      // below only opens once all three have been entered: a handler that
      // awaited them in turn would never reach three and this test would time
      // out rather than pass slowly.
      let started = 0;
      let open;
      const barrier = new Promise((resolve) => {
        open = resolve;
      });
      const leg = (value) => async () => {
        started += 1;
        if (started === 3) open();
        await barrier;
        return value;
      };

      const sent = await call(
        handlerWith({
          fetchSalesClients: leg(CLIENTS),
          fetchClientVolume: leg(VOLUME),
          fetchClientRevenue: leg(REVENUE),
        }),
        { auth: SUPER_ADMIN, query: RANGE_QUERY },
      );

      expect(started).toBe(3);
      expect(sent.status).toBe(200);
    },
    2000,
  );
});

describe("when a leg fails", () => {
  it("still pays commission when the revenue fetch dies, and says so", async () => {
    const sent = await call(
      handlerWith({ fetchClientRevenue: vi.fn(async () => { throw new Error("DealMatch/Run HTTP 504"); }) }),
      { auth: SUPER_ADMIN, query: RANGE_QUERY },
    );
    expect(sent.status).toBe(200);
    expect(sent.body.degraded).toEqual(["revenue"]);
    expect(sent.body.revenue).toEqual({ available: false, reason: "fetch_failed" });
    // The figure a salesperson is owed is untouched by the outage.
    expect(sent.body.totals.commissionUsd).toBe(15.5);
    expect(sent.body.totals).not.toHaveProperty("revenueUsd");
  });

  it("does not echo the upstream failure to the browser", async () => {
    const warn = vi.fn();
    const sent = await call(
      handlerWith({
        fetchClientRevenue: vi.fn(async () => { throw new Error("connect ECONNREFUSED 10.0.0.4:443"); }),
        logger: { warn },
      }),
      { auth: SUPER_ADMIN, query: RANGE_QUERY },
    );
    expect(JSON.stringify(sent.body)).not.toContain("10.0.0.4");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("fails the request when the CRM leg dies, rather than reporting zero", async () => {
    // Without the CRM there is no way to know whose clients these are, and a
    // page of zeroes reads as "nobody traded".
    const sent = await call(
      handlerWith({ fetchSalesClients: vi.fn(async () => { throw new Error("CRM /rest/users HTTP 401"); }) }),
      { auth: SUPER_ADMIN, query: RANGE_QUERY },
    );
    expect(sent.status).toBe(502);
    expect(sent.body).toEqual({ error: "crm_unavailable" });
  });

  it("fails the request when the volume leg dies, because that IS the basis", async () => {
    const sent = await call(
      handlerWith({ fetchClientVolume: vi.fn(async () => { throw new Error("ClientVolume/Run HTTP 500"); }) }),
      { auth: SUPER_ADMIN, query: RANGE_QUERY },
    );
    expect(sent.status).toBe(502);
    expect(sent.body).toEqual({ error: "volume_unavailable" });
  });

  it("reports a CRM failure even when the revenue leg also failed", async () => {
    const sent = await call(
      handlerWith({
        fetchSalesClients: vi.fn(async () => { throw new Error("crm down"); }),
        fetchClientRevenue: vi.fn(async () => { throw new Error("dealmatch down"); }),
      }),
      { auth: SUPER_ADMIN, query: RANGE_QUERY },
    );
    expect(sent.status).toBe(502);
    expect(sent.body).toEqual({ error: "crm_unavailable" });
  });

  it("gives a sales caller an empty degraded list, not a missing key", async () => {
    // One shape for the page to render, whichever caller it is.
    const sent = await call(handlerWith(), { auth: SALESPERSON, query: RANGE_QUERY });
    expect(sent.body.degraded).toEqual([]);
  });
});
