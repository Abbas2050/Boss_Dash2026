import { describe, expect, it } from "vitest";
import { computeExcessFunds, EXCESS_LABELS, type ExcessFundsInputs } from "./excessFunds";

// The live figures on 2026-09-01, so the arithmetic is anchored to something
// real rather than to numbers chosen to make the test pass.
const LIVE: ExcessFundsInputs = {
  netDifference: -1190369.63,
  netCrypto: 500000,
  fabAndMbme: 250000,
  goldSouq: 100000,
  fabOperating: 300000,
  fabHolding: 200000,
};

const all = (over: Partial<ExcessFundsInputs> = {}): ExcessFundsInputs => ({ ...LIVE, ...over });

describe("the two formulas", () => {
  it("sums gross from its four terms", () => {
    const { gross } = computeExcessFunds(all());
    expect(gross.value).toBeCloseTo(-1190369.63 + 500000 + 250000 + 100000, 2);
    expect(gross.missing).toEqual([]);
  });

  it("adds the two FAB accounts on top of gross to make net", () => {
    const { gross, net } = computeExcessFunds(all());
    expect(net.value).toBeCloseTo((gross.value as number) + 300000 + 200000, 2);
    expect(net.missing).toEqual([]);
  });

  // netDifference is negative today: clients hold more withdrawable equity than
  // the LPs do. A result that came back positive would mean a sign error.
  it("keeps a negative result negative", () => {
    const { gross } = computeExcessFunds(all({ netCrypto: 0, fabAndMbme: 0, goldSouq: 0 }));
    expect(gross.value).toBeCloseTo(-1190369.63, 2);
    expect(gross.value as number).toBeLessThan(0);
  });
});

describe("a zero is a balance, not a gap", () => {
  it("computes normally when every input is a genuine zero", () => {
    const zeroes: ExcessFundsInputs = {
      netDifference: 0, netCrypto: 0, fabAndMbme: 0,
      goldSouq: 0, fabOperating: 0, fabHolding: 0,
    };
    const { gross, net } = computeExcessFunds(zeroes);
    expect(gross.value).toBe(0);
    expect(net.value).toBe(0);
    expect(gross.missing).toEqual([]);
    expect(net.missing).toEqual([]);
  });
});

describe("a missing input makes the figure unavailable, never a partial sum", () => {
  // One case per term. A partial sum here is the failure this whole design
  // exists to prevent: a treasury figure quietly short by a million dollars.
  for (const term of ["netDifference", "netCrypto", "fabAndMbme", "goldSouq"] as const) {
    it(`kills both figures when ${term} is missing`, () => {
      const { gross, net } = computeExcessFunds(all({ [term]: null }));
      expect(gross.value).toBeNull();
      expect(net.value).toBeNull();
      expect(gross.missing).toContain(EXCESS_LABELS[term]);
      expect(net.missing).toContain(EXCESS_LABELS[term]);
    });
  }

  // The two FAB accounts are additions on top of gross, so losing them must
  // cost the net figure only. This is the expected state whenever the new
  // workbook is unreachable, and gross must survive it.
  for (const term of ["fabOperating", "fabHolding"] as const) {
    it(`kills only net when ${term} is missing`, () => {
      const { gross, net } = computeExcessFunds(all({ [term]: null }));
      expect(gross.value).not.toBeNull();
      expect(gross.missing).toEqual([]);
      expect(net.value).toBeNull();
      expect(net.missing).toEqual([EXCESS_LABELS[term]]);
    });
  }

  it("names every missing input, not just the first", () => {
    const { net } = computeExcessFunds(all({ fabOperating: null, fabHolding: null }));
    expect(net.missing).toEqual([EXCESS_LABELS.fabOperating, EXCESS_LABELS.fabHolding]);
  });

  it("reports nothing at all when every source failed", () => {
    const none: ExcessFundsInputs = {
      netDifference: null, netCrypto: null, fabAndMbme: null,
      goldSouq: null, fabOperating: null, fabHolding: null,
    };
    const { gross, net } = computeExcessFunds(none);
    expect(gross.value).toBeNull();
    expect(net.value).toBeNull();
    expect(net.missing).toHaveLength(6);
  });
});

describe("a non-finite input is treated as missing", () => {
  // Number("") is 0 and Number(undefined) is NaN; neither may become a figure.
  it("rejects NaN and Infinity rather than propagating them", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { gross } = computeExcessFunds(all({ netCrypto: bad }));
      expect(gross.value).toBeNull();
      expect(gross.missing).toContain(EXCESS_LABELS.netCrypto);
    }
  });
});

describe("labels", () => {
  it("names every input in a way a reader would recognise on the card", () => {
    expect(EXCESS_LABELS).toEqual({
      netDifference: "Net LP Equity − Net Client Equity",
      netCrypto: "Net Crypto",
      fabAndMbme: "Net FAB & MBME",
      goldSouq: "Gold Souq",
      fabOperating: "FAB Operating Balance",
      fabHolding: "FAB Holding Balance",
    });
  });
});
