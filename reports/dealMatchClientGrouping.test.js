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
