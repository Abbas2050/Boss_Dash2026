// @vitest-environment node
//
// The markup maths, tested on its own.
//
// This is the part of Market Watch with real-world consequences: `markup` is
// not a display preference, it is the number of points by which the client's
// quoted spread is widened. Bid is pushed DOWN and Ask is pushed UP, each by
// the same amount, so a markup of N points costs the client 2N points of
// spread in total. Getting the direction or the point size wrong would not
// look broken on screen -- the grid would keep rendering plausible prices --
// it would quietly misprice every client on that symbol.
//
// The point size is derived from the price's own magnitude, not from a symbol
// lookup, because the feed does not report digits and the desk trades broker
// suffixes (XAUUSD.f2, GOLD_ft2, EURUSD.xt) that no name-based table would
// match. These cases pin that derivation to the values the standalone
// market-watch.html page has been running with.
import { describe, expect, it } from "vitest";
import { digitsFor, pointSizeFor, markedBid, markedAsk } from "./MarketWatchTab";

describe("digitsFor", () => {
  it("uses 5 digits for sub-10 prices (FX majors)", () => {
    expect(digitsFor(1.0855)).toBe(5);
    expect(digitsFor(0.6421)).toBe(5);
  });

  it("uses 3 digits between 10 and 1000 (JPY pairs, silver)", () => {
    expect(digitsFor(157.25)).toBe(3);
    expect(digitsFor(31.4)).toBe(3);
  });

  it("uses 2 digits at 1000 and above (gold, indices)", () => {
    expect(digitsFor(4016.56)).toBe(2);
    expect(digitsFor(38500)).toBe(2);
  });

  it("is magnitude-based, so a negative price maps like its absolute value", () => {
    expect(digitsFor(-1.0855)).toBe(5);
  });

  it("derives point size from those digits", () => {
    expect(pointSizeFor(1.0855)).toBeCloseTo(0.00001, 10);
    expect(pointSizeFor(4016.56)).toBeCloseTo(0.01, 10);
  });
});

describe("markup widens the client-facing spread", () => {
  it("is a no-op at zero markup", () => {
    expect(markedBid(1.08550, 1.08570, 0)).toBeCloseTo(1.08550, 10);
    expect(markedAsk(1.08570, 0)).toBeCloseTo(1.08570, 10);
  });

  it("pushes bid DOWN and ask UP -- never the same direction", () => {
    const rawBid = 1.08550;
    const rawAsk = 1.08570;
    const bid = markedBid(rawBid, rawAsk, 10)!;
    const ask = markedAsk(rawAsk, 10)!;

    expect(bid).toBeLessThan(rawBid);
    expect(ask).toBeGreaterThan(rawAsk);
  });

  it("costs the client 2x the markup in total spread", () => {
    const rawBid = 1.08550;
    const rawAsk = 1.08570;
    const rawSpread = rawAsk - rawBid;

    const bid = markedBid(rawBid, rawAsk, 10)!;
    const ask = markedAsk(rawAsk, 10)!;

    // 10 points each side, at 0.00001 per point = 0.0002 added in total.
    expect(ask - bid - rawSpread).toBeCloseTo(20 * 0.00001, 10);
  });

  it("scales the point by magnitude, so gold moves in cents not pips", () => {
    // 4016.56 -> 2 digits -> 1 point = 0.01. A 5-point markup is 5 cents.
    expect(markedAsk(4016.56, 5)!).toBeCloseTo(4016.61, 10);
    expect(markedBid(4016.5, 4016.56, 5)!).toBeCloseTo(4016.45, 10);
  });

  it("sizes the bid's point from the ASK, so both sides move symmetrically", () => {
    // The two sides must widen by the same amount. Sizing the bid's point from
    // the bid itself would break that across a magnitude boundary -- a bid of
    // 999.99 (3 digits) against an ask of 1000.01 (2 digits) would otherwise
    // move the bid by a tenth of what the ask moved.
    const rawBid = 999.99;
    const rawAsk = 1000.01;
    const bidDelta = rawBid - markedBid(rawBid, rawAsk, 10)!;
    const askDelta = markedAsk(rawAsk, 10)! - rawAsk;
    expect(bidDelta).toBeCloseTo(askDelta, 10);
  });

  it("accepts a negative markup as a deliberate tightening", () => {
    const rawBid = 1.08550;
    const rawAsk = 1.08570;
    expect(markedBid(rawBid, rawAsk, -5)!).toBeGreaterThan(rawBid);
    expect(markedAsk(rawAsk, -5)!).toBeLessThan(rawAsk);
  });

  it("returns null when the feed has not produced a price yet", () => {
    // The row renders an em dash rather than a marked-up null, so an
    // unsubscribed or silent symbol can never show a fabricated price.
    expect(markedBid(null, null, 10)).toBeNull();
    expect(markedAsk(null, 10)).toBeNull();
  });
});
