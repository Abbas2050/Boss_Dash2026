// @vitest-environment node
//
// The rules behind GET /api/sales/commission, with no server, no database and
// no CRM token. Everything asserted here is a decision the approved design
// records (docs/superpowers/specs/2026-10-26-sales-commission-page-design.md)
// and that a plausible edit would silently reverse: the commission basis, who
// may see revenue, and what happens when the revenue join misses.
import { describe, it, expect } from "vitest";
import {
  COMMISSION_BASIS_FIELD,
  COMMISSION_USD_PER_CFD_LOT,
  MAX_RANGE_DAYS,
  SALES_MANAGERS,
  SALES_MANAGER_IDS,
  buildCommissionReport,
  clientVolumeQuery,
  dealMatchQuery,
  parseYmd,
  resolveCommissionScope,
  resolveRange,
  salesAccountsPayload,
  salesManagerName,
  salesUsersPayload,
  toLoginKey,
  toManagerId,
} from "./commissionCore.js";

const RANGE = { from: "2026-10-01", to: "2026-10-26" };

// Four of the roster's clients plus one belonging to a manager who is not on
// it, so "all" can be shown not to include him.
const CLIENTS = [
  { userId: 101, managerId: 28, name: "Alice Trader" },
  { userId: 102, managerId: 23, name: "Bob Trader" },
  { userId: 103, managerId: 20, name: "Carol Trader" },
  { userId: 104, managerId: 28, name: "Dormant Dan" },
  { userId: 105, managerId: 99, name: "Someone Else's Client" },
];

const ACCOUNTS = [
  { login: "5001", userId: 101 },
  { login: "5002", userId: 101 },
  { login: "5003", userId: 102 },
  { login: "5004", userId: 103 },
  { login: "5005", userId: 104 },
  { login: "5006", userId: 105 },
];

// Every metric is a different number on every row, so a mutation that pays on
// `lots` or `stocksLots` cannot coincidentally produce the right total.
const VOLUME_ROWS = [
  { login: "5001", lots: 200, stocksLots: 60, cfdLots: 10 },
  { login: 5002, lots: 100, stocksLots: 40, cfdLots: 5 }, // numeric login on purpose
  { login: "5003", lots: 20, stocksLots: 0, cfdLots: 7.5 },
  { login: "5004", lots: 60, stocksLots: 50, cfdLots: 0 }, // shares only: earns nothing
  { login: "5006", lots: 999, stocksLots: 999, cfdLots: 999 }, // manager 99
  { login: "9999", lots: 1, stocksLots: 1, cfdLots: 1 }, // no CRM account at all
];

// `dealLots` here is roughly double the realized lots in VOLUME_ROWS, which is
// what a round trip costs (§1). It is deliberately a different number from
// cfdLots so that paying on the wrong one shows up as a wrong dollar figure.
const REVENUE_ROWS = [
  { login: "5001", totalRevenueUsd: 1000.5, dealLots: 20.4 },
  { login: "5002", totalRevenueUsd: 300, dealLots: 10.2 }, // same client, second login
  { login: "5004", totalRevenueUsd: 200, dealLots: 4 },
  { login: "7777", totalRevenueUsd: 999, dealLots: 500 }, // matches nothing we know
  // Note there is NO row for 5003, which traded 7.5 CFD lots.
];

const ALL_SCOPE = { kind: "all", managerIds: [...SALES_MANAGER_IDS], includeRevenue: true };
const SELF_SCOPE = { kind: "self", managerIds: [28], includeRevenue: false };

function report(scope, { revenue = { available: true, rows: REVENUE_ROWS } } = {}) {
  return buildCommissionReport({
    scope,
    range: RANGE,
    clients: CLIENTS,
    accounts: ACCOUNTS,
    volumeRows: VOLUME_ROWS,
    revenue,
  });
}

const salesperson = (body, managerId) => body.salespeople.find((s) => s.managerId === managerId);
const client = (body, managerId, crmUserId) =>
  salesperson(body, managerId).clients.find((c) => c.crmUserId === crmUserId);

describe("the rate", () => {
  it("is $1 per realized CFD/FX lot", () => {
    expect(COMMISSION_USD_PER_CFD_LOT).toBe(1);
  });

  it("is paid on cfdLots, not on lots and not on stocksLots", () => {
    // docs/dealing-reporting.md §1: for one verified week the same book reports
    // 203,109 deal lots, 99,527 realized lots and 1,401 realized CFD/FX lots.
    // Paying on the wrong field overpays by one or two orders of magnitude.
    expect(COMMISSION_BASIS_FIELD).toBe("cfdLots");
  });

  it("is not reachable from the environment", async () => {
    const source = await import("fs").then((fs) => fs.readFileSync("sales/commissionCore.js", "utf8"));
    expect(source).not.toMatch(/process\.env/);
  });

  it("names the three salespeople the design names", () => {
    expect(SALES_MANAGERS.map((m) => m.managerId)).toEqual([28, 23, 20]);
    expect(salesManagerName(28)).toBe("Mitul Kapadia");
    expect(salesManagerName("23")).toBe("Aditya");
    expect(salesManagerName(20)).toBe("Smit");
    // Not on the roster, but still named rather than blank: a salesperson's own
    // view works from their crmManagerId alone.
    expect(salesManagerName(99)).toBe("Manager #99");
  });
});

describe("commission arithmetic", () => {
  it("sums cfdLots across a client's logins and pays $1 each", () => {
    const body = report(ALL_SCOPE);
    const alice = client(body, 28, 101);
    expect(alice.cfdLots).toBe(15); // 10 + 5
    expect(alice.commissionUsd).toBe(15);
    // The other two metrics ride along for the page, and are NOT the basis.
    expect(alice.lots).toBe(300);
    expect(alice.stocksLots).toBe(100);
    expect(alice.logins).toEqual(["5001", "5002"]);
  });

  it("totals only the clients in scope", () => {
    const body = report(ALL_SCOPE);
    expect(body.totals.cfdLots).toBe(22.5); // 15 + 7.5 + 0
    expect(body.totals.commissionUsd).toBe(22.5);
    // 999 (manager 99) and 1 (no CRM account) are both excluded.
    expect(body.totals.lots).toBe(380);
  });

  it("keeps a shares-only client on the page, earning nothing", () => {
    // The spec calls this out as the one consequence of the rate decision that
    // will surprise the sales team, so the row has to be visible to explain
    // itself rather than disappearing.
    const carol = client(report(ALL_SCOPE), 20, 103);
    expect(carol.stocksLots).toBe(50);
    expect(carol.cfdLots).toBe(0);
    expect(carol.commissionUsd).toBe(0);
  });

  it("counts a client who did nothing instead of listing them", () => {
    const body = report(ALL_SCOPE);
    expect(client(body, 28, 104)).toBeUndefined();
    expect(body.join.clientsWithNoActivity).toBe(1);
    // Still counted in the salesperson's book size.
    expect(salesperson(body, 28).clientCount).toBe(2);
    expect(salesperson(body, 28).tradingClientCount).toBe(1);
  });

  it("joins a numeric login to a string login", () => {
    // 5002 arrives as a number from ClientVolume and a string from FXBO. A Map
    // keyed on the raw value would put them in different buckets and halve
    // Alice's lots.
    expect(toLoginKey(5002)).toBe(toLoginKey("5002"));
    expect(client(report(ALL_SCOPE), 28, 101).cfdLots).toBe(15);
  });

  it("gives a salesperson with an empty book a zero rather than omitting them", () => {
    const body = buildCommissionReport({
      scope: ALL_SCOPE,
      range: RANGE,
      clients: [],
      accounts: [],
      volumeRows: [],
      revenue: { available: true, rows: [] },
    });
    expect(body.salespeople.map((s) => s.managerId).sort()).toEqual([20, 23, 28]);
    expect(body.totals.commissionUsd).toBe(0);
  });
});

describe("role scoping", () => {
  it("gives a Super Admin all three salespeople, with revenue", () => {
    const scope = resolveCommissionScope({ role: "Super Admin" });
    expect(scope).toEqual({ kind: "all", managerIds: [28, 23, 20], includeRevenue: true });
  });

  it("gives a user with a crmManagerId only themselves, and no revenue", () => {
    const scope = resolveCommissionScope({ role: "Analyst", crmManagerId: 28 });
    expect(scope).toEqual({ kind: "self", managerIds: [28], includeRevenue: false });
  });

  it("refuses a user who is neither", () => {
    expect(resolveCommissionScope({ role: "Manager", access: ["Sales"] }).kind).toBe("denied");
    expect(resolveCommissionScope({ role: "Analyst" }).kind).toBe("denied");
    expect(resolveCommissionScope(null).kind).toBe("denied");
    expect(resolveCommissionScope(undefined).kind).toBe("denied");
  });

  it("lets Super Admin win over a crmManagerId on the same record", () => {
    // Abbas is the only person who would hold both, and the role already
    // short-circuits every other permission check in the app.
    expect(resolveCommissionScope({ role: "Super Admin", crmManagerId: 28 }).kind).toBe("all");
  });

  it("does not let a sales caller see another manager's client", () => {
    const body = report(SELF_SCOPE);
    expect(body.salespeople).toHaveLength(1);
    expect(body.salespeople[0].managerId).toBe(28);
    expect(body.scope).toBe("self");
    expect(body.managerId).toBe(28);
    // Bob (23) and Carol (20) traded in this window and must be nowhere in it.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("Bob Trader");
    expect(serialised).not.toContain("Carol Trader");
    expect(serialised).not.toContain("5003");
    expect(body.totals.cfdLots).toBe(15); // not 22.5
  });

  it("never serialises a revenue figure for a sales caller", () => {
    // The point of doing this on the server. "The UI hides it" is exactly what
    // the design rejects: roles live in localStorage, so a UI filter is
    // tidiness, not confidentiality.
    const serialised = JSON.stringify(report(SELF_SCOPE));
    expect(serialised).not.toMatch(/revenue/i);
    expect(serialised).not.toMatch(/margin/i);
    // Deal lots ride in the same DealMatch payload as revenue and are gated on
    // the same scope, so they must not appear either -- and they match neither
    // regex above, which is why this line exists.
    expect(serialised).not.toMatch(/dealLots/i);
    // Not nulled and not zeroed either -- absent.
    expect(JSON.parse(serialised)).not.toHaveProperty("revenue");
    expect(Object.keys(JSON.parse(serialised).totals).sort()).toEqual([
      "cfdLots",
      "commissionUsd",
      "lots",
      "stocksLots",
    ]);
  });

  it("still hides revenue from a sales caller when revenue rows are supplied", () => {
    // A future caller might pass the rows in regardless; the scope, not the
    // argument, decides.
    const body = buildCommissionReport({
      scope: SELF_SCOPE,
      range: RANGE,
      clients: CLIENTS,
      accounts: ACCOUNTS,
      volumeRows: VOLUME_ROWS,
      revenue: { available: true, rows: REVENUE_ROWS },
    });
    expect(JSON.stringify(body)).not.toMatch(/revenue/i);
    expect(body.totals.commissionUsd).toBe(15);
  });

  it("excludes a client of a manager outside the roster from the all view", () => {
    const body = report(ALL_SCOPE);
    expect(JSON.stringify(body)).not.toContain("Someone Else's Client");
    expect(body.salespeople.map((s) => s.managerId).sort()).toEqual([20, 23, 28]);
  });
});

describe("crmManagerId is a number, whichever side it arrives as a string on", () => {
  it("coerces a usable value and rejects the rest", () => {
    expect(toManagerId(28)).toBe(28);
    expect(toManagerId("28")).toBe(28);
    expect(toManagerId(" 28 ")).toBe(28);
    expect(toManagerId("abc")).toBeNull();
    expect(toManagerId("")).toBeNull();
    expect(toManagerId(0)).toBeNull();
    expect(toManagerId(-5)).toBeNull();
    expect(toManagerId(2.5)).toBeNull();
    expect(toManagerId(null)).toBeNull();
    expect(toManagerId(undefined)).toBeNull();
  });

  it("matches a string id on the session against a number from FXBO", () => {
    const scope = resolveCommissionScope({ role: "Analyst", crmManagerId: "28" });
    expect(scope.managerIds).toEqual([28]);
    expect(report(scope).totals.cfdLots).toBe(15);
  });

  it("matches a number on the session against a string from FXBO", () => {
    const body = buildCommissionReport({
      scope: SELF_SCOPE,
      range: RANGE,
      clients: [{ userId: 101, managerId: "28", name: "Alice Trader" }],
      accounts: ACCOUNTS,
      volumeRows: VOLUME_ROWS,
      revenue: { available: false },
    });
    expect(body.totals.cfdLots).toBe(15);
  });
});

describe("the revenue join, which is unverified", () => {
  it("takes totalRevenueUsd as the backend gives it", () => {
    // Never rebuilt from markup + clientComm: that drops client swap, which on
    // 2026-09-16 was $20,313.91 of a $21,609.65 day (dealing-reporting §5).
    const alice = client(report(ALL_SCOPE), 28, 101);
    expect(alice.revenueUsd).toBe(1300.5); // 1000.5 + 300
    expect(alice.marginAfterCommissionUsd).toBe(1285.5); // 1300.5 - 15
  });

  it("reports deal lots beside revenue without ever paying on them", () => {
    // Deal lots are the volume the revenue was earned over, and run to roughly
    // double the realized figure. Commission must still be the 15 realized CFD
    // lots, not the 30.6 deal lots sitting in the next column.
    const body = report(ALL_SCOPE);
    const alice = client(body, 28, 101);
    expect(alice.dealLots).toBe(30.6); // 20.4 + 10.2, both of Alice's logins
    expect(alice.cfdLots).toBe(15);
    expect(alice.commissionUsd).toBe(15);
    // A revenue row matching no client of ours contributes neither (7777's 500).
    expect(body.totals.dealLots).toBe(34.6); // 30.6 + 4
    expect(body.totals.commissionUsd).toBe(body.totals.cfdLots);
  });

  it("keeps a client whose logins matched no revenue row, and flags it", () => {
    const bob = client(report(ALL_SCOPE), 23, 102);
    expect(bob).toBeDefined();
    expect(bob.cfdLots).toBe(7.5);
    expect(bob.commissionUsd).toBe(7.5); // paid in full
    expect(bob.revenueMatched).toBe(false);
    expect(bob.revenueUsd).toBe(0);
    expect(report(ALL_SCOPE).join.clientsMissingRevenue).toBe(1);
    expect(report(ALL_SCOPE).join.warnings.join(" ")).toMatch(/matched no revenue row/);
  });

  it("makes a revenue row that matched nothing visible as a count", () => {
    const { join } = report(ALL_SCOPE);
    expect(join.revenueRowCount).toBe(4);
    expect(join.revenueRowsMatched).toBe(3);
    expect(join.revenueRowsNotMatchedToScope).toBe(1);
    // The three numbers reconcile, which is what makes the count auditable.
    expect(join.revenueRowsMatched + join.revenueRowsNotMatchedToScope).toBe(join.revenueRowCount);
  });

  it("flags a client that matched more than one revenue row", () => {
    // §5 says the table is one row per CRM client, yet the row carries a login.
    // Alice has two logins and two rows here, which is the shape that question
    // is about.
    const { join } = report(ALL_SCOPE);
    expect(join.clientsWithMultipleRevenueRows).toBe(1);
    expect(client(report(ALL_SCOPE), 28, 101).revenueRowCount).toBe(2);
    expect(join.warnings.join(" ")).toMatch(/more than one revenue row/);
  });

  it("makes the volume rows it did not attribute visible too", () => {
    const { join } = report(ALL_SCOPE);
    expect(join.volumeRowCount).toBe(6);
    expect(join.volumeRowsMatched).toBe(4);
    expect(join.volumeRowsOutOfScope).toBe(2);
  });

  it("prints the window ClientVolume answered when it is not the one asked for", () => {
    // §2 records this endpoint returning six days for a seven-day week, open
    // question. A dropped day is a day of somebody's lots.
    const shortened = buildCommissionReport({
      scope: ALL_SCOPE,
      range: RANGE,
      clients: CLIENTS,
      accounts: ACCOUNTS,
      volumeRows: VOLUME_ROWS,
      volumeWindow: { fromDate: "2026-10-02", toDate: "2026-10-26", activeDays: 19 },
      revenue: { available: true, rows: REVENUE_ROWS },
    });
    expect(shortened.join.volumeWindow).toEqual({
      fromDate: "2026-10-02",
      toDate: "2026-10-26",
      activeDays: 19,
    });
    expect(shortened.join.warnings.join(" ")).toMatch(/2026-10-02\.\.2026-10-26 for a request of 2026-10-01/);
  });

  it("says nothing when the window answered is the window asked for", () => {
    const exact = buildCommissionReport({
      scope: ALL_SCOPE,
      range: RANGE,
      clients: CLIENTS,
      accounts: ACCOUNTS,
      volumeRows: VOLUME_ROWS,
      volumeWindow: { fromDate: RANGE.from, toDate: RANGE.to, activeDays: 20 },
      revenue: { available: true, rows: [] },
    });
    expect(exact.join.warnings.join(" ")).not.toMatch(/ClientVolume answered/);
    expect(exact.join.volumeWindow.activeDays).toBe(20);
  });

  it("pays exactly the same commission whether revenue arrived or not", () => {
    // The guarantee the design asks for: a broken revenue join must never
    // corrupt what a salesperson is owed.
    const withRevenue = report(ALL_SCOPE);
    const without = report(ALL_SCOPE, { revenue: { available: false, reason: "fetch_failed" } });

    expect(without.totals.commissionUsd).toBe(withRevenue.totals.commissionUsd);
    expect(without.totals.cfdLots).toBe(withRevenue.totals.cfdLots);
    for (const managerId of SALES_MANAGER_IDS) {
      expect(salesperson(without, managerId).commissionUsd).toBe(salesperson(withRevenue, managerId).commissionUsd);
    }
    expect(client(without, 28, 101).commissionUsd).toBe(15);
  });

  it("tells the elevated caller that revenue is missing, with a reason", () => {
    const body = report(ALL_SCOPE, { revenue: { available: false, reason: "fetch_failed" } });
    expect(body.revenue).toEqual({ available: false, reason: "fetch_failed" });
    expect(body.totals).not.toHaveProperty("revenueUsd");
    expect(body.join).not.toHaveProperty("revenueRowCount");
  });

  it("rounds money and lots once, at the edge", () => {
    const body = buildCommissionReport({
      scope: ALL_SCOPE,
      range: RANGE,
      clients: [{ userId: 1, managerId: 28, name: "Thirds" }],
      accounts: [{ login: "1", userId: 1 }],
      volumeRows: [{ login: "1", lots: 0, stocksLots: 0, cfdLots: 1 / 3 }],
      revenue: { available: true, rows: [{ login: "1", totalRevenueUsd: 10.005 }] },
    });
    expect(body.totals.cfdLots).toBe(0.33);
    expect(body.totals.commissionUsd).toBe(0.33);
    expect(body.totals.revenueUsd).toBe(10.01);
  });
});

describe("the window", () => {
  it("defaults to the current month in UTC", () => {
    expect(resolveRange({}, new Date("2026-10-26T09:00:00Z"))).toEqual({
      from: "2026-10-01",
      to: "2026-10-26",
    });
  });

  it("rejects half a range rather than guessing the other end", () => {
    expect(resolveRange({ from: "2026-10-01" }).error).toBe("from_and_to_required");
    expect(resolveRange({ to: "2026-10-26" }).error).toBe("from_and_to_required");
  });

  it("rejects a date that does not exist", () => {
    expect(parseYmd("2026-02-30")).toBeNull();
    expect(parseYmd("2026-13-01")).toBeNull();
    expect(parseYmd("26-10-01")).toBeNull();
    expect(resolveRange({ from: "2026-02-30", to: "2026-03-01" }).error).toBe("invalid_date");
  });

  it("rejects a backwards range and an absurd one", () => {
    expect(resolveRange({ from: "2026-10-26", to: "2026-10-01" }).error).toBe("from_after_to");
    expect(resolveRange({ from: "2020-01-01", to: "2026-10-01" }).error).toBe("range_too_long");
    expect(MAX_RANGE_DAYS).toBe(366);
  });

  it("accepts a single day and a full inclusive year", () => {
    expect(resolveRange({ from: "2026-10-26", to: "2026-10-26" })).toEqual({
      from: "2026-10-26",
      to: "2026-10-26",
    });
    expect(resolveRange({ from: "2026-01-01", to: "2026-12-31" }).error).toBeUndefined();
  });
});

describe("the upstream request shapes", () => {
  it("asks ClientVolume for YYYY-MM-DD dates and every group", () => {
    expect(clientVolumeQuery(RANGE)).toBe("from=2026-10-01&to=2026-10-26&group=*");
  });

  it("asks DealMatch for Unix seconds, inclusive of the last day, in lite mode", () => {
    // The two endpoints genuinely take different date formats
    // (dealing-reporting §2), and lite=false would download ~45 MB a month of
    // match rows this route never reads.
    const query = new URLSearchParams(dealMatchQuery(RANGE));
    expect(query.get("from")).toBe(String(Date.UTC(2026, 9, 1, 0, 0, 0) / 1000));
    expect(query.get("to")).toBe(String(Date.UTC(2026, 9, 26, 23, 59, 59) / 1000));
    expect(query.get("lite")).toBe("true");
    expect(query.get("group")).toBe("*");
  });

  it("sends only usable manager ids and client ids", () => {
    expect(salesUsersPayload({ managerIds: [28, "23", "abc", 0], limit: 10, offset: 0 })).toEqual({
      managerIds: [28, 23],
      segment: { limit: 10, offset: 0 },
    });
    expect(salesAccountsPayload({ userIds: [1, "2", "x", -3], limit: 5, offset: 5 })).toEqual({
      userIds: [1, 2],
      segment: { limit: 5, offset: 5 },
    });
  });
});
