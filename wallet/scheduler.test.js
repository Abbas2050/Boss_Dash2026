import { describe, expect, it } from "vitest";
import {
  buildChangeItems,
  decideChangeItems,
  extractSnapshot,
  filterIgnoredChangeItems,
  sanitizeState,
  snapshotHash,
} from "./scheduler.js";

// The alert that these tests exist for fired on 2026-09-03 saying
// "LetKnow Pay $191.37 (+$0.05)". Nobody deposited five cents. ETH moved.
//
// Everything here is a pure comparison of two snapshots, the same two the
// scheduler compares between polls, so nothing below opens a socket, writes a
// state file or waits on a timer.

// LetKnow Pay as production actually reports it: mostly dollar-pegged, with a
// sliver of ETH that gets marked to market every five minutes.
const LETKNOWPAY_HOLDINGS = {
  USD: 130.95,
  USDC: 53.498525,
  ETH: 0.00288773,
  USDCSOL: 0.001932,
  USDTTRC20: 0.006487,
};

// Every tracked provider, in the shape checkAllBalances() hands the scheduler.
// The sheet rows carry `currencies: {}` because a sheet cell is a dollar figure
// with nothing behind it; FAB is the one sheet row that names its two pots.
const BASE_WIDGETS = {
  bitpace: { balance: 0.44, currencies: { USDT: 0.437722 } },
  letknowpay: { balance: 191.32, currencies: LETKNOWPAY_HOLDINGS },
  ownbit: { balance: 1000, currencies: { "USDT TRC20": 1000 } },
  ownbitnew: { balance: 37570, currencies: { "USDT TRC20": 37570 } },
  heropayment: { balance: 500, currencies: { USDT: 500 } },
  googlesheets_match2pay: { balance: 10, currencies: {} },
  googlesheets_deusxpay: { balance: 20, currencies: {} },
  googlesheets_openpayed: { balance: 30, currencies: {} },
  googlesheets_goldsouq: { balance: 50694.96, currencies: {} },
  googlesheets_fab: { balance: 245.5, currencies: { "FAB AED": 200, "FAB USD": 45.5 } },
  googlesheets_mbme: { balance: 40, currencies: {} },
};

// Builds the report the scheduler snapshots. total_balance is summed from the
// widgets rather than passed in, so a fixture cannot accidentally describe a
// total that its own rows do not add up to -- which is the whole subject of the
// total_balance accounting test.
function reportWith(overrides = {}) {
  const widgets = { ...BASE_WIDGETS };
  for (const [id, patch] of Object.entries(overrides)) {
    widgets[id] = { ...widgets[id], ...patch };
  }
  const entries = Object.entries(widgets).map(([id, w]) => ({ id, ...w }));
  const total = entries.reduce((sum, w) => sum + Number(w.balance || 0), 0);
  return { data: { total_balance: Number(total.toFixed(2)), widgets: entries } };
}

const snapshotWith = (overrides) => extractSnapshot(reportWith(overrides));

// Production sums total_balance from the providers' UNROUNDED balances and
// rounds the sum once at the end, so the total can move a cent while every
// rounded provider row stays byte-identical. reportWith() adds up the rounded
// rows and can never produce that, so these fixtures set the total directly --
// which is the only honest way to reproduce the alert of 2026-09-03.
function snapshotWithTotal(total, overrides = {}) {
  const report = reportWith(overrides);
  report.data.total_balance = total;
  return extractSnapshot(report);
}

const keysOf = (changeItems) => changeItems.map((item) => item.key).sort();

describe("wallet alert: a price move is not a balance change", () => {
  it("says nothing when LetKnow Pay drifts $191.32 -> $191.37 on unchanged holdings", () => {
    // The reported bug, at the values it was reported with.
    const before = snapshotWith({});
    const after = snapshotWith({ letknowpay: { balance: 191.37 } });

    const decision = decideChangeItems(before, after);

    expect(decision.rebaseline).toBe(false);
    expect(decision.changeItems).toEqual([]);
  });

  it("says nothing when a failed rate lookup takes $6.81 of ETH off the row", () => {
    // The larger false alarm: ETH falls out of `valued` and back into
    // `unvalued`, so the dollar figure collapses while the ETH is still there.
    const before = snapshotWith({ letknowpay: { balance: 191.37 } });
    const after = snapshotWith({ letknowpay: { balance: 184.56 } });

    expect(decideChangeItems(before, after).changeItems).toEqual([]);
  });

  it("alerts on a real crypto deposit even though it is worth about $2", () => {
    const before = snapshotWith({});
    const after = snapshotWith({
      letknowpay: {
        balance: 193.68,
        currencies: { ...LETKNOWPAY_HOLDINGS, ETH: 0.00388773 },
      },
    });

    expect(keysOf(decideChangeItems(before, after).changeItems)).toEqual([
      "letknowpay",
      "total_balance",
    ]);
  });

  it("alerts on a real dollar deposit", () => {
    const before = snapshotWith({});
    const after = snapshotWith({
      letknowpay: {
        balance: 560.37,
        currencies: { ...LETKNOWPAY_HOLDINGS, USD: 500 },
      },
    });

    expect(keysOf(decideChangeItems(before, after).changeItems)).toEqual([
      "letknowpay",
      "total_balance",
    ]);
  });

  it("still alerts on a Gold Souq edit, which has no holdings to compare", () => {
    // A sheet cell publishes `currencies: {}`. Someone typing a new number into
    // it is a deliberate human action and is exactly what the alert is for.
    const before = snapshotWith({});
    const after = snapshotWith({ googlesheets_goldsouq: { balance: 50000 } });

    expect(keysOf(decideChangeItems(before, after).changeItems)).toEqual([
      "googlesheets_goldsouq",
      "total_balance",
    ]);
  });

  it("leaves the API-failure noise to the filter that already absorbs it", () => {
    // Asserted against filterIgnoredChangeItems() directly, not through the new
    // code, because a provider dropping to $0 and recovering must keep being
    // absorbed by the same filter, for the same reason, after this change.
    const apiFailure = [
      { key: "total_balance", label: "Total Combined", before: 40000, after: 39999.56, delta: -0.44 },
      { key: "bitpace", label: "Bitpace", before: 0.44, after: 0, delta: -0.44 },
    ];
    const apiRecovery = [
      { key: "total_balance", label: "Total Combined", before: 39999.56, after: 40000, delta: 0.44 },
      { key: "bitpace", label: "Bitpace", before: 0, after: 0.44, delta: 0.44 },
    ];

    expect(filterIgnoredChangeItems(apiFailure)).toEqual([]);
    expect(filterIgnoredChangeItems(apiRecovery)).toEqual([]);
  });

  it("reports only the genuine row when a drift and an edit land in one poll", () => {
    const before = snapshotWith({});
    const after = snapshotWith({
      letknowpay: { balance: 191.37 },
      googlesheets_goldsouq: { balance: 50000 },
    });

    const { changeItems } = decideChangeItems(before, after);

    expect(keysOf(changeItems)).toEqual(["googlesheets_goldsouq", "total_balance"]);
    // The email is built from these items, so LetKnow Pay must not be in them.
    expect(keysOf(changeItems)).not.toContain("letknowpay");
  });

  it("drops the total only while every dollar of its move is explained", () => {
    const before = snapshotWith({});

    const priceOnly = decideChangeItems(before, snapshotWith({ letknowpay: { balance: 191.37 } }));
    expect(keysOf(priceOnly.changeItems)).not.toContain("total_balance");

    const partlyReal = decideChangeItems(
      before,
      snapshotWith({ letknowpay: { balance: 191.37 }, googlesheets_mbme: { balance: 90 } }),
    );
    const total = partlyReal.changeItems.find((item) => item.key === "total_balance");
    expect(total).toBeDefined();
    // The delta shown is the real one, drift included -- the email keeps
    // reporting market value; only the decision to send ignores price.
    expect(total.delta).toBe(50.05);
  });

  it("re-baselines silently against a saved snapshot that predates holdings", () => {
    // Exactly what storage/wallet_report_state.json holds on the running
    // server: USD figures and nothing else. Comparing across that boundary
    // cannot prove anything is price-only, so nothing may be sent.
    const oldShape = { total_balance: snapshotWith({}).total_balance, widgets: snapshotWith({}).widgets };
    const current = snapshotWith({ letknowpay: { balance: 191.37 } });

    const decision = decideChangeItems(oldShape, current);

    expect(decision.rebaseline).toBe(true);
    expect(decision.changeItems).toEqual([]);
  });

  it("stores a crypto holding at full precision, not rounded to cents", () => {
    const snapshot = snapshotWith({});

    expect(snapshot.holdings.letknowpay.ETH).toBe(0.00288773);
    expect(snapshot.holdings.letknowpay.ETH).not.toBe(0);
    // A sheet row has no breakdown and must keep comparing dollars.
    expect(snapshot.holdings.googlesheets_goldsouq).toBeNull();
    // And the USD figures the email reads are untouched by any of this.
    expect(snapshot.widgets.letknowpay).toBe(191.32);
  });

  it("keeps a snapshot hash that sanitizeState still recognises", () => {
    // sanitizeState() sniffs the hash string for "total_balance" and "widgets".
    // Renaming either key would quietly reset the channel dedupe and re-send
    // the last alert, so the shape is pinned here rather than assumed.
    const hash = snapshotHash(snapshotWith({}));
    expect(hash).toContain('"total_balance"');
    expect(hash).toContain('"widgets"');

    const state = sanitizeState({
      channels: { email: { lastSentHash: hash }, telegram: { lastSentHash: hash } },
      lastNotifiedHash: hash,
      lastSnapshotHash: null,
      lastSnapshot: null,
      updatedAt: null,
    });

    expect(state.channels.email.lastSentHash).toBe(hash);
    expect(state.channels.telegram.lastSentHash).toBe(hash);
    expect(state.lastNotifiedHash).toBe(hash);
  });

  it("says nothing when Total Combined alone slips $650,866.09 -> $650,866.08", () => {
    // The alert production actually sent, verbatim: one line, no provider row
    // under it. A sub-cent price drift tipped the single end-of-sum rounding.
    const before = snapshotWithTotal(650866.09);
    const after = snapshotWithTotal(650866.08);

    // The email really would have had nothing else in it.
    expect(keysOf(buildChangeItems(before, after))).toEqual(["total_balance"]);

    const decision = decideChangeItems(before, after);
    expect(decision.rebaseline).toBe(false);
    expect(decision.changeItems).toEqual([]);
  });

  it("alerts on the same cent when the ETH behind it is a different amount", () => {
    // A deposit far too small to shift LetKnow Pay's rounded row, so the total
    // is again the only change item -- but the holding moved, so this is money,
    // not price, and it must not be swallowed by the rule above.
    const before = snapshotWithTotal(650866.09);
    const after = snapshotWithTotal(650866.08, {
      letknowpay: { currencies: { ...LETKNOWPAY_HOLDINGS, ETH: 0.00288874 } },
    });

    expect(keysOf(buildChangeItems(before, after))).toEqual(["total_balance"]);
    expect(keysOf(decideChangeItems(before, after).changeItems)).toEqual(["total_balance"]);
  });

  it("alerts when a sheet row moves while the total moves", () => {
    // Gold Souq has no holdings to compare, so the total-only rule must never
    // reach the point of deciding anything here: its own row survives.
    const before = snapshotWithTotal(650866.09);
    const after = snapshotWithTotal(650171.13, { googlesheets_goldsouq: { balance: 50000 } });

    const { changeItems } = decideChangeItems(before, after);

    expect(keysOf(changeItems)).toEqual(["googlesheets_goldsouq", "total_balance"]);
  });

  it("still drops a total whose whole move is explained by a dropped row", () => {
    // The accounting that already worked, kept honest: Bitpace's holdings move
    // (its rounded row does not), so the new total-only rule declines this one
    // and the total has to be dropped the old way -- by its delta matching the
    // dropped LetKnow Pay row exactly.
    const before = snapshotWith({});
    const after = snapshotWith({
      letknowpay: { balance: 191.37 },
      bitpace: { currencies: { USDT: 0.437999 } },
    });

    expect(keysOf(buildChangeItems(before, after))).toEqual(["letknowpay", "total_balance"]);
    expect(decideChangeItems(before, after).changeItems).toEqual([]);
  });

  it("re-baselines a total-only move when neither side records holdings", () => {
    // The saved state on the running server has no holdings at all. A total
    // that moved across that boundary cannot be shown to be price, so the rule
    // must not fire -- the migration path takes it instead.
    const shape = snapshotWith({});
    const oldBefore = { total_balance: 650866.09, widgets: shape.widgets };
    const oldAfter = { total_balance: 650866.08, widgets: shape.widgets };

    const decision = decideChangeItems(oldBefore, oldAfter);

    expect(decision.rebaseline).toBe(true);
    expect(decision.changeItems).toEqual([]);
  });

  it("still builds the dollar deltas the email prints", () => {
    // buildChangeItems() is untouched by this change and must stay untouched:
    // the before/after figures in the email come from here.
    const items = buildChangeItems(
      snapshotWith({}),
      snapshotWith({ googlesheets_goldsouq: { balance: 50000 } }),
    );
    const goldSouq = items.find((item) => item.key === "googlesheets_goldsouq");

    expect(goldSouq).toMatchObject({ before: 50694.96, after: 50000, delta: -694.96 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A disconnected provider is not a provider holding zero.
//
// The alert of 2026-09-03 -- "[WALLET] Closing Balance - Total: $638034.14" --
// was sent by two OwnBits losing their connection. Their balances read as $0.00,
// the total fell by what they hold, and the email said money left the treasury.
// Nothing moved.
// ─────────────────────────────────────────────────────────────────────────────

// walletMonitor stamps every widget with a status. BASE_WIDGETS above predates
// that and leaves the field off, which the scheduler reads as healthy; these
// fixtures stamp it explicitly, so a test can say "this one was connected and
// that one was not" instead of leaning on the absence of a field.
const DISCONNECTED = { balance: 0, currencies: {}, status: "error", error: "request timed out" };

// The sum of BASE_WIDGETS, which every total below is expressed relative to.
const BASE_TOTAL = 90302.22;

function connectedReport(overrides = {}, total = null) {
  const widgets = {};
  for (const [id, widget] of Object.entries(BASE_WIDGETS)) widgets[id] = { ...widget, status: "ok" };
  for (const [id, patch] of Object.entries(overrides)) widgets[id] = { ...widgets[id], ...patch };
  const entries = Object.entries(widgets).map(([id, w]) => ({ id, ...w }));
  const summed = entries.reduce((sum, w) => sum + Number(w.balance || 0), 0);
  return {
    data: {
      // Production sums the providers' UNROUNDED balances and rounds once at
      // the end, so the total can land a cent away from the sum of the rounded
      // rows. `total` overrides the fixture's own sum to reproduce that.
      total_balance: total === null ? Number(summed.toFixed(2)) : total,
      widgets: entries,
    },
  };
}

const connectedSnapshot = (overrides = {}, total = null) => extractSnapshot(connectedReport(overrides, total));

describe("wallet alert: a disconnected provider is not a balance of zero", () => {
  it("says nothing when two providers drop off while LetKnow Pay drifts on price", () => {
    // The reported email, reconstructed. Two OwnBits lose their connection in
    // the same poll that ETH moves LetKnow Pay five cents.
    //
    // The one cent between the after-total and the sum of the rounded rows is
    // not decoration: it is why the old delta-matching rule failed to account
    // the total against the rows it had dropped, and why this email was sent.
    const before = connectedSnapshot({}, BASE_TOTAL);
    const after = connectedSnapshot(
      { ownbit: DISCONNECTED, ownbitnew: DISCONNECTED, letknowpay: { balance: 191.37 } },
      51732.28,
    );

    // Every row really did move, so there is plenty for the filters to refuse.
    expect(keysOf(buildChangeItems(before, after))).toEqual([
      "letknowpay",
      "ownbit",
      "ownbitnew",
      "total_balance",
    ]);

    const decision = decideChangeItems(before, after);

    expect(decision.rebaseline).toBe(false);
    expect(decision.totalUnavailable).toBe(true);
    expect(decision.changeItems).toEqual([]);
  });

  it("drops a disconnected provider whose balance did not become exactly zero", () => {
    // The zero-inference fallback cannot see this one: HeroPayment reports
    // status:'error' while still carrying a stale non-zero figure, so there is
    // no zero to infer a failure from.
    const before = connectedSnapshot({});
    const after = connectedSnapshot({
      heropayment: { balance: 480, currencies: { USDT: 480 }, status: "error", error: "HTTP 502" },
    });

    expect(keysOf(buildChangeItems(before, after))).toEqual(["heropayment", "total_balance"]);
    expect(decideChangeItems(before, after).changeItems).toEqual([]);
  });

  it("still reports a genuine deposit on a healthy provider while OwnBit is down", () => {
    // Money really did arrive in Gold Souq. OwnBit being unreachable is a
    // separate fact and must not swallow it. The total goes, because there is
    // no total while a provider is silent -- but the row that moved survives.
    const before = connectedSnapshot({}, BASE_TOTAL);
    const after = connectedSnapshot(
      { ownbit: DISCONNECTED, googlesheets_goldsouq: { balance: 60000 } },
      99307.27,
    );

    const decision = decideChangeItems(before, after);

    expect(decision.totalUnavailable).toBe(true);
    expect(keysOf(decision.changeItems)).toEqual(["googlesheets_goldsouq"]);
  });

  it("does not treat a provider that genuinely reads $0.00 as disconnected", () => {
    // Match2Pay's sheet cell is legitimately empty on both sides and its status
    // is 'ok'. A real zero is a balance, so the total stays knowable and the
    // Gold Souq deposit reports with it.
    const before = connectedSnapshot({ googlesheets_match2pay: { balance: 0 } });
    const after = connectedSnapshot({
      googlesheets_match2pay: { balance: 0 },
      googlesheets_goldsouq: { balance: 60000 },
    });

    const decision = decideChangeItems(before, after);

    expect(decision.totalUnavailable).toBe(false);
    expect(keysOf(decision.changeItems)).toEqual(["googlesheets_goldsouq", "total_balance"]);
  });

  it("says nothing when a provider reconnects", () => {
    // Recovery is the same event running backwards and is just as much not
    // money. The cent of mismatch again denies the delta-matching rule the
    // exact equality it needs, so only the status rule can absorb this.
    const before = connectedSnapshot({ ownbit: DISCONNECTED }, 89302.22);
    const after = connectedSnapshot({}, 90302.23);

    expect(keysOf(buildChangeItems(before, after))).toEqual(["ownbit", "total_balance"]);
    expect(decideChangeItems(before, after).changeItems).toEqual([]);
  });

  it("re-baselines silently against a saved snapshot that records no statuses", () => {
    // The state file on the running server has holdings but no statuses. It
    // cannot say which providers were connected when it was written, so nothing
    // compared against it can be shown to be a connection event.
    const current = connectedSnapshot({});
    const noStatuses = {
      total_balance: current.total_balance,
      widgets: current.widgets,
      holdings: current.holdings,
    };
    const after = connectedSnapshot({ ownbit: DISCONNECTED });

    const decision = decideChangeItems(noStatuses, after);

    expect(decision.rebaseline).toBe(true);
    expect(decision.changeItems).toEqual([]);
  });

  it("keeps the price-noise filter working while a provider is disconnected", () => {
    // The two rules are independent: LetKnow Pay drifting on price is still
    // price, whether or not OwnBit happens to be answering.
    const before = connectedSnapshot({}, BASE_TOTAL);
    const after = connectedSnapshot(
      { ownbit: DISCONNECTED, letknowpay: { balance: 191.37 } },
      89302.28,
    );

    expect(decideChangeItems(before, after).changeItems).toEqual([]);
  });
});
