import { describe, expect, it } from "vitest";
import { assertDashboardPayload } from "./equityOverviewApi";

// The second silent-zero route into a treasury figure. toNumber returns 0 for a
// missing or garbage field, so a 200 that simply does not carry netDifference
// used to produce netDifference = 0 with equityLoaded = true, and the Excess
// Funds section printed a complete, confident, wrong Gross. Rejecting the
// payload sends the caller down its catch, which leaves equityLoaded false and
// the figure honestly unavailable.

const good = {
  netDifference: -1190369.63,
  lps: { netWithdrawableEquity: 3275567.91, liveWithdrawableEquity: 1, bonusWithdrawableEquity: 2 },
  clients: { netWithdrawableEquity: 4465937.54 },
};

describe("assertDashboardPayload", () => {
  it("accepts the real shape", () => {
    expect(() => assertDashboardPayload(good)).not.toThrow();
  });

  // A zero netDifference is a legitimate answer and must survive the guard --
  // the whole point is to tell it apart from an absent one.
  it("accepts a genuine zero on every guarded field", () => {
    expect(() =>
      assertDashboardPayload({
        netDifference: 0,
        lps: { netWithdrawableEquity: 0 },
        clients: { netWithdrawableEquity: 0 },
      }),
    ).not.toThrow();
  });

  it("accepts numeric strings, which this backend has sent before", () => {
    expect(() =>
      assertDashboardPayload({
        netDifference: "-1190369.63",
        lps: { netWithdrawableEquity: "1" },
        clients: { netWithdrawableEquity: "2" },
      }),
    ).not.toThrow();
  });

  it("rejects a 200 that does not carry netDifference at all", () => {
    const { netDifference, ...withoutIt } = good;
    expect(() => assertDashboardPayload(withoutIt)).toThrow(/netDifference/);
  });

  it("rejects a missing lps or clients group", () => {
    expect(() => assertDashboardPayload({ ...good, lps: undefined })).toThrow(
      /lps\.netWithdrawableEquity/,
    );
    expect(() => assertDashboardPayload({ ...good, clients: {} })).toThrow(
      /clients\.netWithdrawableEquity/,
    );
  });

  it("rejects garbage where a number belongs, rather than defaulting it to zero", () => {
    for (const bad of [null, "", "   ", "n/a", true, {}, [], NaN, Infinity]) {
      expect(() => assertDashboardPayload({ ...good, netDifference: bad })).toThrow(/netDifference/);
    }
  });

  it("rejects a non-object body, naming what arrived", () => {
    expect(() => assertDashboardPayload(null)).toThrow(/expected an object/);
    expect(() => assertDashboardPayload("<!doctype html>")).toThrow(/expected an object/);
    expect(() => assertDashboardPayload([])).toThrow(/expected an object/);
  });

  // Whoever reads the console needs to know which endpoint and which field.
  it("names the endpoint and every missing field in one message", () => {
    let message = "";
    try {
      assertDashboardPayload({ lps: {}, clients: {} });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("EquityOverview/dashboard");
    expect(message).toContain("netDifference");
    expect(message).toContain("lps.netWithdrawableEquity");
    expect(message).toContain("clients.netWithdrawableEquity");
  });
});
