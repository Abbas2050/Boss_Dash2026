import { describe, expect, it } from "vitest";
import { unwrapFabAccounts } from "./excessFundsApi";

const ok = {
  ok: true,
  fabOperating: 1234567.89,
  fabHolding: 987654.32,
  fetchedAt: "2026-09-01T06:00:00Z",
  source: { spreadsheetId: "abc", tab: "Sheet1", cells: { fabOperating: "B2", fabHolding: "B3" } },
};

describe("unwrapFabAccounts", () => {
  it("returns both balances and the source that produced them", () => {
    const out = unwrapFabAccounts(ok);
    expect(out.fabOperating).toBe(1234567.89);
    expect(out.fabHolding).toBe(987654.32);
    expect(out.source.tab).toBe("Sheet1");
  });

  // A cell the server could not read arrives as null and stays null. It is not a
  // balance of zero, and the card must say unavailable rather than show 0.00.
  it("passes a null balance through untouched", () => {
    const out = unwrapFabAccounts({ ...ok, fabOperating: null });
    expect(out.fabOperating).toBeNull();
    expect(out.fabHolding).toBe(987654.32);
  });

  it("keeps a genuine zero as zero", () => {
    expect(unwrapFabAccounts({ ...ok, fabHolding: 0 }).fabHolding).toBe(0);
  });

  // The failure the Revenue Share page had: a wrong shape rendered as empty with
  // no error. Every rejection below must name the endpoint and what arrived.
  it("throws naming the endpoint and the keys present when a balance key is absent", () => {
    const { fabOperating, ...missing } = ok;
    expect(() => unwrapFabAccounts(missing)).toThrow(/\/api\/fab-accounts/);
    expect(() => unwrapFabAccounts(missing)).toThrow(/fabOperating/);
    expect(() => unwrapFabAccounts(missing)).toThrow(/fabHolding/);
  });

  it("throws when a balance is a non-numeric, non-null value", () => {
    expect(() => unwrapFabAccounts({ ...ok, fabHolding: "987654.32" })).toThrow(/fabHolding/);
    expect(() => unwrapFabAccounts({ ...ok, fabHolding: Number.NaN })).toThrow(/fabHolding/);
  });

  it("throws on a bare array, on null, and on an error envelope", () => {
    expect(() => unwrapFabAccounts([])).toThrow(/\/api\/fab-accounts/);
    expect(() => unwrapFabAccounts(null)).toThrow(/\/api\/fab-accounts/);
    expect(() => unwrapFabAccounts({ ok: false, error: "fab_sheet_unavailable" }))
      .toThrow(/fab_sheet_unavailable/);
  });
});
