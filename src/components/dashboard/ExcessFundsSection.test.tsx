import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { excessFundsCards, ExcessFundsSection } from "./ExcessFundsSection";
import type { ExcessFundsInputs } from "@/lib/excessFunds";

afterEach(cleanup);

const INPUTS: ExcessFundsInputs = {
  netDifference: -1190369.63,
  netCrypto: 500000,
  fabAndMbme: 250000,
  goldSouq: 100000,
  fabOperating: 300000,
  fabHolding: 200000,
};

const cards = (over: Partial<ExcessFundsInputs> = {}, lp: number | null = 3275567.91, cl: number | null = 4465937.54) =>
  excessFundsCards({ inputs: { ...INPUTS, ...over }, lpEquity: lp, clientEquity: cl });

const byLabel = (list: ReturnType<typeof excessFundsCards>, label: string) =>
  list.find((c) => c.label === label);

describe("the nine cards", () => {
  it("renders exactly nine, in the order of the note", () => {
    expect(cards().map((c) => c.label)).toEqual([
      "Net LP Equity",
      "Net Client Equity",
      "Net Crypto",
      "Net FAB & MBME",
      "Gold Souq",
      "FAB Operating Balance",
      "FAB Holding Balance",
      "Gross Excess Fund",
      "Net Excess Fund",
    ]);
  });

  it("formats money to two decimals with a thousands separator", () => {
    expect(byLabel(cards(), "Net LP Equity")?.value).toBe("$3,275,567.91");
  });

  it("shows the two results", () => {
    // -1,190,369.63 + 500,000 + 250,000 + 100,000 = -340,369.63
    expect(byLabel(cards(), "Gross Excess Fund")?.value).toBe("-$340,369.63");
    // and the two FAB accounts carry it back over zero: -340,369.63 + 500,000
    expect(byLabel(cards(), "Net Excess Fund")?.value).toBe("$159,630.37");
  });

  // Gross negative and net positive from the same inputs is the realistic case
  // today, and the two tones must differ accordingly.
  it("tones the two results independently", () => {
    expect(byLabel(cards(), "Gross Excess Fund")?.tone).toBe("negative");
    expect(byLabel(cards(), "Net Excess Fund")?.tone).toBe("positive");
  });

  // netDifference is negative today, so a negative result is the normal case and
  // must read as one rather than being clamped or relabelled.
  it("tones a negative result as negative", () => {
    expect(byLabel(cards(), "Gross Excess Fund")?.tone).toBe("negative");
  });

  it("tones a positive result as positive", () => {
    expect(byLabel(cards({ netCrypto: 5000000 }), "Gross Excess Fund")?.tone).toBe("positive");
  });
});

describe("unavailable is not zero", () => {
  it("shows a dash and names the missing source on a result that cannot be computed", () => {
    const list = cards({ fabOperating: null });
    const net = byLabel(list, "Net Excess Fund");
    expect(net?.value).toBe("—");
    expect(net?.note).toContain("FAB Operating Balance");
    // Gross does not need it, so gross survives.
    expect(byLabel(list, "Gross Excess Fund")?.value).not.toBe("—");
  });

  it("shows a dash on an input card whose own source failed", () => {
    expect(byLabel(cards({ goldSouq: null }), "Gold Souq")?.value).toBe("—");
  });

  it("shows a dash for equity when the equity call failed", () => {
    const list = cards({}, null, null);
    expect(byLabel(list, "Net LP Equity")?.value).toBe("—");
    expect(byLabel(list, "Net Client Equity")?.value).toBe("—");
  });

  it("renders a genuine zero as money, never as a dash", () => {
    expect(byLabel(cards({ goldSouq: 0 }), "Gold Souq")?.value).toBe("$0.00");
  });
});

describe("the results say what they include", () => {
  // The page already carries lpPlusPspDifference, which also reads as "spare
  // cash" and will give a different number. Both stay, so both must say what
  // they count or neither can be trusted.
  it("notes the scope of Gross Excess Fund", () => {
    const note = byLabel(cards(), "Gross Excess Fund")?.note ?? "";
    expect(note).toMatch(/crypto/i);
    expect(note).toMatch(/gold souq/i);
  });
});

describe("a zero result is not a surplus", () => {
  // "positive" renders green, which reads across this dashboard as "there is
  // money here to move". Break-even is not that, and rounding to exactly zero on
  // a treasury figure is precisely when a confident green is most misleading.
  it("tones exactly zero as neutral, not positive", () => {
    const list = excessFundsCards({
      inputs: { netDifference: 0, netCrypto: 0, fabAndMbme: 0, goldSouq: 0, fabOperating: 0, fabHolding: 0 },
      lpEquity: 0,
      clientEquity: 0,
    });
    expect(byLabel(list, "Gross Excess Fund")?.value).toBe("$0.00");
    expect(byLabel(list, "Gross Excess Fund")?.tone).toBe("neutral");
    expect(byLabel(list, "Net Excess Fund")?.tone).toBe("neutral");
  });

  // These are sums of floats, so an arithmetically-zero result is almost never
  // literally 0. It still prints as $0.00 and still must not read as a surplus.
  it("tones a float-residue zero as neutral too", () => {
    // -1,190,369.63 + 500,000 + 590,369.63 + 100,000 = 0, bar the IEEE residue
    const list = cards({ fabAndMbme: 590369.63 });
    expect(byLabel(list, "Gross Excess Fund")?.value).toBe("$0.00");
    expect(byLabel(list, "Gross Excess Fund")?.tone).toBe("neutral");
  });

  // Half a cent still shows as $0.00 and is not a surplus either.
  it("tones a sub-cent amount as neutral, matching what it prints", () => {
    expect(byLabel(cards({ goldSouq: 0.004 }), "Gold Souq")?.value).toBe("$0.00");
    expect(byLabel(cards({ goldSouq: 0.004 }), "Gold Souq")?.tone).toBe("neutral");
  });

  it("tones one whole cent as a real amount", () => {
    expect(byLabel(cards({ goldSouq: 0.01 }), "Gold Souq")?.tone).toBe("positive");
    expect(byLabel(cards({ goldSouq: -0.01 }), "Gold Souq")?.tone).toBe("negative");
  });

  it("tones a zero input card as neutral too", () => {
    expect(byLabel(cards({ goldSouq: 0 }), "Gold Souq")?.tone).toBe("neutral");
  });

  it("still tones a non-zero result", () => {
    expect(byLabel(cards({ netCrypto: 5000000 }), "Gross Excess Fund")?.tone).toBe("positive");
    expect(byLabel(cards(), "Gross Excess Fund")?.tone).toBe("negative");
  });
});

describe("the FAB cards say which cell they came from", () => {
  // The spec's promise: a wrong figure can be traced to the cell it was read
  // from without opening the server.
  it("notes tab and cell on both FAB cards", () => {
    const list = excessFundsCards({
      inputs: INPUTS,
      lpEquity: 1,
      clientEquity: 2,
      fabSource: { tab: "Sheet1", cells: { fabOperating: "B2", fabHolding: "B3" } },
    });
    expect(byLabel(list, "FAB Operating Balance")?.note).toBe("Sheet1!B2");
    expect(byLabel(list, "FAB Holding Balance")?.note).toBe("Sheet1!B3");
  });

  it("leaves the note off when the FAB read failed and there is no source", () => {
    expect(byLabel(cards(), "FAB Operating Balance")?.note).toBeUndefined();
  });
});

describe("the section renders", () => {
  const renderSection = (props: Partial<Parameters<typeof ExcessFundsSection>[0]> = {}) =>
    render(
      <ExcessFundsSection
        inputs={INPUTS}
        lpEquity={3275567.91}
        clientEquity={4465937.54}
        {...props}
      />,
    );

  it("puts all nine labels on the page", () => {
    renderSection();
    for (const label of [
      "Net LP Equity",
      "Net Client Equity",
      "Net Crypto",
      "Net FAB & MBME",
      "Gold Souq",
      "FAB Operating Balance",
      "FAB Holding Balance",
      "Gross Excess Fund",
      "Net Excess Fund",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("shows the dash and the naming note for an unavailable figure", () => {
    renderSection({ inputs: { ...INPUTS, fabHolding: null } });
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText(/Unavailable — could not read .*FAB Holding Balance/)).toBeTruthy();
    // Gross does not need it, so it is still a real figure.
    expect(screen.getByText("-$340,369.63")).toBeTruthy();
  });

  // An arithmetically complete figure says nothing about how old its inputs are.
  it("says so on itself when a source failed to refresh", () => {
    renderSection({ walletError: "HTTP 502", equityError: "EquityOverview 500" });
    const warning = screen.getByText(/may be stale/);
    expect(warning.textContent).toContain("HTTP 502");
    expect(warning.textContent).toContain("EquityOverview 500");
  });

  it("says nothing about staleness when both sources are current", () => {
    renderSection({ walletUpdated: "Sep 01, 14:22:05" });
    expect(screen.queryByText(/may be stale/)).toBeNull();
    expect(screen.getByText(/Sources read:/).textContent).toContain("Sep 01, 14:22:05");
  });
});
