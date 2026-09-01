import { describe, expect, it } from "vitest";
import { excessFundsCards } from "./ExcessFundsSection";
import type { ExcessFundsInputs } from "@/lib/excessFunds";

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
