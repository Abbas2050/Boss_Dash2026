// @vitest-environment node
//
// THIS DIRECTIVE IS REQUIRED AND MUST BE THE FIRST LINE. The project's vitest
// config defaults to jsdom, where AbortSignal.timeout does not exist -- the CRM
// helper throws before it ever reaches fetch, and every Task 2 test fails for a
// reason that has nothing to do with the code. Verified: under jsdom the stub
// fetch is never called; under node it is.
import { describe, it, expect } from "vitest";

// CRM_API_TOKEN is captured when the module first loads, so the environment has
// to be set BEFORE the import. A static import would be hoisted above this line
// and the token would be empty, sending Task 2's functions down their no-token
// path. Hence the dynamic import.
process.env.API_TOKEN = "stub";
const mod = await import("./dealMatchWeeklyReport.js");
const { groupRowsByClient } = mod;

// Shaped like clientRevenueSummaries[]: one entry per MT5 account.
const ROWS = [
  { login: "102244", name: "Dawei Huang", lots: 1.94, markup: 467.5, clientComm: 0, lpComm: 6.3, totalRev: 461.2 },
  { login: "102233", name: "Dawei Huang", lots: 1.92, markup: 528, clientComm: 0, lpComm: 6.2, totalRev: 521.8 },
  { login: "101499", name: "Gaurav Sharma", lots: 5, markup: 100, clientComm: 10, lpComm: 4, totalRev: 106 },
  { login: "109999", name: "No CRM Record", lots: 0.5, markup: 20, clientComm: 0, lpComm: 1, totalRev: 19 },
];
const IDS = new Map([
  ["102244", 9001],
  ["102233", 9001],
  ["101499", 9002],
  ["109999", null],
]);

describe("groupRowsByClient", () => {
  it("merges a client's accounts into one row", () => {
    const out = groupRowsByClient(ROWS, IDS);
    const dawei = out.find((r) => r.userId === 9001);
    expect(dawei.accounts).toEqual(["102233", "102244"]);
    expect(dawei.lots).toBeCloseTo(3.86, 10);
    expect(dawei.markup).toBeCloseTo(995.5, 10);
    expect(dawei.lpComm).toBeCloseTo(12.5, 10);
    expect(dawei.totalRev).toBeCloseTo(983, 10);
  });

  it("keeps a login with no CRM user as its own row", () => {
    const out = groupRowsByClient(ROWS, IDS);
    const orphan = out.find((r) => r.clientKey === "login:109999");
    expect(orphan.userId).toBeNull();
    expect(orphan.accounts).toEqual(["109999"]);
    expect(orphan.lots).toBeCloseTo(0.5, 10);
  });

  it("names the client from its largest account", () => {
    const mixed = [
      { login: "1", name: "", lots: 1, markup: 0, clientComm: 0, lpComm: 0, totalRev: 0 },
      { login: "2", name: "Real Name", lots: 9, markup: 0, clientComm: 0, lpComm: 0, totalRev: 0 },
    ];
    const out = groupRowsByClient(mixed, new Map([["1", 5], ["2", 5]]));
    expect(out[0].name).toBe("Real Name");
  });

  it("sorts by lots descending and preserves totals", () => {
    const out = groupRowsByClient(ROWS, IDS);
    expect(out.map((r) => r.clientKey)).toEqual(["user:9002", "user:9001", "login:109999"]);
    const sum = (k) => out.reduce((s, r) => s + r[k], 0);
    expect(sum("lots")).toBeCloseTo(9.36, 10);
    expect(sum("totalRev")).toBeCloseTo(1108, 10);
  });

  it("starts rebate and net at zero for later tasks to fill", () => {
    const out = groupRowsByClient(ROWS, IDS);
    expect(out.every((r) => r.rebateWithdrawn === 0 && r.netRev === 0)).toBe(true);
  });

  // Mian Ali Khalid held four accounts in the week of 8-14 Aug, the worst case
  // in the live data and a 4x rebate overcharge before this change.
  it("collapses a four-account client into one row", () => {
    const four = [1, 2, 3, 4].map((n) => ({
      login: `20000${n}`,
      name: "Mian Ali Khalid",
      lots: n,
      markup: n * 10,
      clientComm: 0,
      lpComm: n,
      totalRev: n * 9,
    }));
    const ids = new Map(four.map((r) => [r.login, 9500]));
    const out = groupRowsByClient(four, ids);
    expect(out).toHaveLength(1);
    expect(out[0].accounts).toEqual(["200001", "200002", "200003", "200004"]);
    expect(out[0].lots).toBeCloseTo(10, 10);
    expect(out[0].markup).toBeCloseTo(100, 10);
    expect(out[0].totalRev).toBeCloseTo(90, 10);
  });
});

import { afterEach } from "vitest";

// Reuses the module namespace imported at the top of the file, which was loaded
// after VITE_API_TOKEN was set. Do NOT add a static import here.
const { resolveClientIds, attachRebateWithdrawn } = mod;

const PERIOD = { from: new Date("2026-08-08T00:00:00Z"), to: new Date("2026-08-14T23:59:59Z") };
const LOGIN_TO_USER = { "102244": 9001, "102233": 9001, "101499": 9002, "109999": 0 };
let calls;
const realFetch = globalThis.fetch;

function stubCrm({ failTransactionsFor = null, notIb = [] } = {}) {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : {};
    const ok = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => "" });
    if (u.includes("/rest/ib/tree")) {
      const id = Number(u.split("ibId=")[1]);
      calls.push({ kind: "tree", id });
      return ok(notIb.includes(id) ? [] : [{ id: 1 }]);
    }
    if (u.includes("/rest/accounts")) {
      calls.push({ kind: "account", login: body.login });
      return ok([{ userId: LOGIN_TO_USER[String(body.login)] ?? 0 }]);
    }
    if (u.includes("/rest/transactions")) {
      calls.push({ kind: "tx", id: body.fromUserId });
      if (body.fromUserId === failTransactionsFor) throw new Error("CRM down");
      return ok([{ processedAmount: -646 }]);
    }
    return ok([]);
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("resolveClientIds", () => {
  it("maps logins to CRM users and counts the ones that fail", async () => {
    stubCrm();
    const { userIdByLogin, unresolved } = await resolveClientIds(["102244", "102233", "109999"]);
    expect(userIdByLogin.get("102244")).toBe(9001);
    expect(userIdByLogin.get("102233")).toBe(9001);
    expect(userIdByLogin.get("109999")).toBeNull();
    expect(unresolved).toBe(1);
  });
});

describe("attachRebateWithdrawn", () => {
  it("charges a client once, not once per account", async () => {
    stubCrm();
    const clients = [
      { clientKey: "user:9001", userId: 9001, accounts: ["102233", "102244"], lots: 3.86, rebateWithdrawn: 0 },
      { clientKey: "user:9002", userId: 9002, accounts: ["101499"], lots: 5, rebateWithdrawn: 0 },
    ];
    const res = await attachRebateWithdrawn(clients, PERIOD);
    expect(clients[0].rebateWithdrawn).toBeCloseTo(646, 10);
    expect(clients[1].rebateWithdrawn).toBeCloseTo(646, 10);
    expect(res.failed).toBe(0);
    expect(res.clients).toBe(2);
    // One IB check and one transaction lookup per CLIENT, never per account.
    expect(calls.filter((c) => c.kind === "tree").length).toBe(2);
    expect(calls.filter((c) => c.kind === "tx").length).toBe(2);
  });

  it("charges a non-IB nothing and skips the transaction lookup", async () => {
    stubCrm({ notIb: [9002] });
    const clients = [{ clientKey: "user:9002", userId: 9002, accounts: ["101499"], lots: 5, rebateWithdrawn: 0 }];
    await attachRebateWithdrawn(clients, PERIOD);
    expect(clients[0].rebateWithdrawn).toBe(0);
    expect(calls.filter((c) => c.kind === "tx").length).toBe(0);
  });

  it("records zero for a failed lookup and counts it for the footer", async () => {
    stubCrm({ failTransactionsFor: 9001 });
    const clients = [{ clientKey: "user:9001", userId: 9001, accounts: ["102244"], lots: 1.94, rebateWithdrawn: 0 }];
    const res = await attachRebateWithdrawn(clients, PERIOD);
    expect(clients[0].rebateWithdrawn).toBe(0);
    expect(res.failed).toBe(1);
  });

  it("charges an unresolved login nothing without calling the CRM", async () => {
    stubCrm();
    const clients = [{ clientKey: "login:109999", userId: null, accounts: ["109999"], lots: 0.5, rebateWithdrawn: 0 }];
    const res = await attachRebateWithdrawn(clients, PERIOD);
    expect(clients[0].rebateWithdrawn).toBe(0);
    expect(res.clients).toBe(0);
    expect(calls.length).toBe(0);
  });
});

describe("net revenue on grouped rows", () => {
  it("subtracts the rebate once per client", () => {
    const rows = groupRowsByClient(ROWS, IDS);
    const dawei = rows.find((r) => r.userId === 9001);
    dawei.rebateWithdrawn = 646;
    const netRev = (dawei.markup + dawei.clientComm) - (dawei.lpComm + dawei.rebateWithdrawn);
    // 995.50 + 0 - (12.50 + 646) = 337.00
    expect(netRev).toBeCloseTo(337, 10);
  });
});
