import { describe, expect, it } from "vitest";
import { treasuryTiles, treasuryNotice } from "./TreasuryPanel";

const LIVE = {
  bankReceivable: 0,
  cryptoReceivable: 0,
  toLpsBank: 250000,
  toLpsCrypto: 0,
  netAllCurrentBalance: 279185.91,
  netAfterExpectedFunds: 559079.62,
  differenceActualVsExpected: -250000,
  creditByLps: 0,
  failedProviders: [] as string[],
};

describe("the eight tiles", () => {
  it("renders all eight, in the order the sheet lists them", () => {
    expect(treasuryTiles(LIVE).map((t) => t.label)).toEqual([
      "To be received in bank",
      "To be received in crypto",
      "To deposit into LPs, bank",
      "To deposit into LPs, crypto",
      "Net all current balance",
      "Net after expected funds",
      "Actual versus expected",
      "Credit by LPs",
    ]);
  });

  it("formats the live figures", () => {
    const tiles = treasuryTiles(LIVE);
    expect(tiles.find((t) => t.label === "Net all current balance")?.value).toBe("$279,185.91");
    expect(tiles.find((t) => t.label === "Actual versus expected")?.value).toBe("-$250,000.00");
  });

  it("tones a negative tile as negative and a zero as neutral", () => {
    const tiles = treasuryTiles(LIVE);
    expect(tiles.find((t) => t.label === "Actual versus expected")?.tone).toBe("negative");
    expect(tiles.find((t) => t.label === "Credit by LPs")?.tone).toBe("neutral");
  });
});

describe("the understatement notice", () => {
  // netAllCurrentBalance counts a failed provider as zero. Saying so is the
  // whole point: on 2026-09-01 two rate-limited wallets took $11,840.66 out of
  // it with nothing on screen to indicate it.
  it("says nothing when every provider reported", () => {
    expect(treasuryNotice(LIVE)).toBeNull();
  });

  it("names the failed providers when any did not", () => {
    const notice = treasuryNotice({ ...LIVE, failedProviders: ["OwnBit", "OwnBit New"] });
    expect(notice).toContain("OwnBit");
    expect(notice).toContain("OwnBit New");
    expect(notice).toMatch(/understat/i);
  });

  it("does not change any tile's value when a provider failed", () => {
    const before = treasuryTiles(LIVE);
    const after = treasuryTiles({ ...LIVE, failedProviders: ["OwnBit"] });
    expect(after).toEqual(before);
  });
});
