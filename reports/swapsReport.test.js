// @vitest-environment node
//
// node, not the suite's default, because the fetch tests at the bottom reach
// backendFetch(), which calls AbortSignal.timeout() -- the same reason
// backendFetch.test.js and volumeSection.test.js opt out.
//
// What this file is actually guarding, in order of how much it would cost to
// get wrong:
//
//   1. Rule 4 (backend team, 2026-09-16): each LP's figure is chosen by its
//      type, and the Api fallback fires on a MISSING LP record and never on a
//      real zero. The email no longer prints the type or the source (the user
//      asked for one plain figure per LP), so nothing on the page would reveal
//      a wrong pick. These tests are that check now: they assert the NUMBER
//      each type displays, on rows whose two candidate figures differ.
//   2. The LP headline is the sum of the rule-4 figures, all or nothing. The
//      unresolved fixture is built so a partial sum would print a plausible
//      number, so the guard bites.
//   3. Rule 1: every figure says cost or revenue, and the two sides are
//      OPPOSITE -- a negative LP swap is our cost, a negative client swap is our
//      revenue (confirmed by the user, 2026-09-16).
//   4. Rule 6: excludeFromSwaps rows leave the tables AND the totals.
//   5. Rule 5: skipped API LPs are not "incomplete"; only LPs the endpoint never
//      returned get a note, and it says exactly that.
//   6. unrealizedSwap is a SNAPSHOT and must never land inside a period total.
//   7. Nothing renders a class the shell does not define -- the bug that made
//      the volume section arrive as two bare headings on the reader's phone.
//   8. A statement exists only when statementRowCount > 0. The backend sends
//      statementSwap: 0 with statementRowCount: 0 for "no statement", never
//      null (live, 2026-09-17). The fixture that shipped modelled it as null,
//      which is why nothing caught every Manager LP rendering as $0.00; the
//      real week's LP rows are now the regression fixture.
//   9. Every LP is on the page. The LP table was once capped at 15 with
//      unresolved LPs first, and on the real week that printed 15 Manager
//      dashes and cut off every LP with a figure (Amana 1, Scope Prime,
//      Infinox, XTB Direct API). LPs with a figure now lead, and LPs without
//      are named under their reason, stated once. Only client movers are capped.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REAL_WEEK } from "./swapsReport.realWeek.fixture.js";
import {
  SWAPS_GUARD_KEYS,
  SWAPS_RECIPIENT_VARS,
  SWAPS_ROW_CAP,
  SWAPS_RUN_TIMEOUT_MS,
  buildSwapsEmailHtml,
  effectiveLpSwap,
  fetchSwapsReport,
  hasStatement,
  lpSwapTotal,
  orderLpRows,
  parseSwapsReport,
  swapEffect,
  swapsSubject,
} from "./swapsReport.js";

// ── the fixture ──────────────────────────────────────────────────────────────
//
// Every figure is chosen so a wrong choice prints a DIFFERENT string:
//
//   Rule-4 LP figures: Xtb -5000 (LP) + Finalto -2000 (fallback) + Quiet 0 (LP)
//     + Book -1200 (statement) + Term +900 (LP)            = -7,300.00
//   If Quiet LP's real 0 fell back to its -800 statement   = -8,100.00
//   If Book LP used totalSwap (-1500) instead of statement = -7,600.00
//   Raw totalSwap over the rows (null as 0)                = -5,600.00
//   The backend's lpTotals (not rule-4 aware)              = -9,123.45
//   LP unrealized (-700 -300 +150) folded into -7,300      = -8,150.00
//     (LP unrealized is no longer displayed, but must still not reach a total)
//
//   client rows sum to -8,500.00 but clientTotals says -12,345.67; client
//   unrealized (-6,000) folded in would be -18,345.67.
const LPS = [
  // Api with an LP record: uses it. Both books present, disagreeing by 500.
  { id: 1, login: 501, lpName: "Xtb", source: "Api", totalSwap: -5000, unrealizedSwap: -700, statementSwap: -4500, statementRowCount: 12 },
  // Api with no LP record: falls back to our statement.
  { id: 2, login: 502, lpName: "Finalto", source: "Api", totalSwap: null, unrealizedSwap: null, statementSwap: -2000, statementRowCount: 4 },
  // Api whose LP record is a genuine zero: must NOT fall back to -800.
  { id: 3, login: 503, lpName: "Quiet LP", source: "Api", totalSwap: 0, unrealizedSwap: -300, statementSwap: -800, statementRowCount: 3 },
  // Manager: our statement, even though a totalSwap is present.
  { id: 4, login: 504, lpName: "Book LP", source: "Manager", totalSwap: -1500, unrealizedSwap: null, statementSwap: -1200, statementRowCount: 6 },
  // Terminal: the LP's own figure, positive, so revenue.
  { id: 5, login: 505, lpName: "Term LP", source: "Terminal", totalSwap: 900, unrealizedSwap: 150, statementSwap: null, statementRowCount: null },
];

const CLIENTS = [
  { login: 10218, name: "Acme Ltd", totalSwap: -7000, unrealizedSwap: -1000 },
  { login: 10219, name: "Beta FZE", totalSwap: -4000, unrealizedSwap: -2000 },
  { login: 10220, name: "Gamma Holdings", totalSwap: 2500, unrealizedSwap: -3000 },
];

const CLEAN = {
  clients: CLIENTS,
  clientTotals: { totalSwap: -12345.67, accountCount: 3 },
  lps: LPS,
  lpTotals: { totalSwap: -9123.45, accountCount: 5 },
  skippedApiLpCount: 0,
  clientPanelError: null,
  lpErrors: [],
};

// A Manager LP with no statement. With it the LP total must be unavailable; a
// partial sum would print -7,300.00, the same plausible figure the clean
// report shows, and nothing on the page would give it away.
//
// Shaped as the backend actually sends "no statement" (observed 2026-09-17): a
// ZERO statementSwap with zero rows behind it, not null.
// No statement, but MT5 DID report a figure. Since 2026-09-25 this resolves to
// that figure rather than to null -- see the Manager branch of effectiveLpSwap.
const UNFILED_MANAGER = { id: 6, login: 506, lpName: "Unfiled Mgr", source: "Manager", totalSwap: -400, unrealizedSwap: null, statementSwap: 0, statementRowCount: 0 };
// Neither a statement nor an MT5 figure. This is what "unresolvable" means for
// a Manager LP now, and it is the only shape that still produces no figure.
const UNRESOLVABLE_MANAGER = { id: 7, login: 507, lpName: "Silent Mgr", source: "Manager", totalSwap: null, unrealizedSwap: null, statementSwap: 0, statementRowCount: 0 };

const PERIOD = { fromYmd: "2026-08-24", toYmd: "2026-08-30" };

const html = (over = {}, { period = PERIOD, cadence = "weekly" } = {}) =>
  buildSwapsEmailHtml({ report: parseSwapsReport({ ...CLEAN, ...over }), period, cadence });

// ── HTML readers ─────────────────────────────────────────────────────────────

function section(out, startMarker, endMarker) {
  const from = out.indexOf(startMarker);
  expect(from).toBeGreaterThan(-1);
  const to = endMarker ? out.indexOf(endMarker, from) : -1;
  return out.slice(from, to === -1 ? out.length : to);
}
const headlineOf = (out) => section(out, "Headline Totals", "LP Swap &mdash; All LPs");
const lpTableOf = (out) => section(out, "LP Swap &mdash; All LPs", "Top Movers &mdash; Client Accounts");
const clientMoversOf = (out) => section(out, "Top Movers &mdash; Client Accounts");

// One table.data row, anchored on its first cell's VISIBLE VALUE -- never on a
// column label -- so "this LP is not in that table" stays a structural claim.
function row(out, key) {
  const at = out.indexOf(`<span class="val">${key}</span>`);
  if (at === -1) return null;
  const end = out.indexOf("</tr>", at);
  return out.slice(at, end === -1 ? out.length : end);
}

// The whole <tr>, opening tag included, for counting a row's cells.
function fullRow(out, key) {
  const at = out.indexOf(`<span class="val">${key}</span>`);
  if (at === -1) return null;
  const start = out.lastIndexOf("<tr>", at);
  const end = out.indexOf("</tr>", at);
  return out.slice(start, end === -1 ? out.length : end);
}

function cell(rowHtml, column) {
  if (rowHtml === null) return null;
  const idx = rowHtml.indexOf(`data-label="${column}"`);
  if (idx === -1) return null;
  const open = rowHtml.indexOf('<span class="val', idx);
  const gt = rowHtml.indexOf(">", open);
  return rowHtml.slice(gt + 1, rowHtml.indexOf("</span>", gt)).trim();
}

// LPs with no figure are not cards: each distinct reason is printed once and
// followed by the names it applies to. unresolvedGroups returns them in page
// order as [{ reason, count, names }], so a test can say which LP sits under
// which reason.
const NAME_SPAN = /<span style="white-space:nowrap;">([^<]*)<\/span>/g;
function unresolvedGroups(out) {
  return [...out.matchAll(/<p class="note"[^>]*><strong>(.*?)<\/strong> (\d+) LP\(s\):<\/p>\s*<p [^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => ({ reason: m[1], count: Number(m[2]), names: [...m[3].matchAll(NAME_SPAN)].map((n) => n[1]) }));
}

// Every LP name the LP section prints -- as a card or under a reason -- in
// page order.
function lpNamesShown(out) {
  return [...lpTableOf(out).matchAll(/<span class="lbl">LP<\/span><span class="val">([^<]*)<\/span>|<span style="white-space:nowrap;">([^<]*)<\/span>/g)]
    .map((m) => m[1] ?? m[2]);
}

// A rendered figure back as a number: "-$12,277.45 (cost)" -> -12277.45.
const figureOf = (text) => Number(text.replace(/\s*\((cost|revenue)\)$/, "").replace(/[$,]/g, ""));

const NO_STATEMENT = "No statement uploaded for this period, so there is no figure &mdash; not zero.";
const NO_RECORD = "No swap record for this period, so there is no figure &mdash; not zero.";

// A KPI card by its label: { cls, value, note }.
function kpi(out, label) {
  const esc = label.replace(/[()]/g, "\\$&");
  // `[^>]*` after each class: a headline card may carry inline styles as well
  // as its class (the shared rptHero does, since inline is what survives the
  // mail clients). Anchoring on the class alone keeps this helper about WHICH
  // card it found rather than about how that card happens to be painted.
  const m = new RegExp(`<p class="kpi-label"[^>]*>${esc}</p>\\s*<p class="kpi-value([^"]*)"[^>]*>([^<]*)</p>(?:\\s*<p class="kpi-note-sm"[^>]*>([^<]*)</p>)?`).exec(out);
  return m ? { cls: m[1].trim(), value: m[2], note: m[3] ?? null } : null;
}

const countCells = (out, column) => [...out.matchAll(new RegExp(`data-label="${column.replace(/[()]/g, "\\$&")}"`, "g"))].length;

// ── guard keys and recipients ────────────────────────────────────────────────

describe("swaps guard keys", () => {
  it("gives each cadence its own key", () => {
    expect(SWAPS_GUARD_KEYS).toEqual({
      daily: "swaps-daily",
      weekly: "swaps",
      monthly: "swaps-monthly",
    });
    expect(new Set(Object.values(SWAPS_GUARD_KEYS)).size).toBe(3);
  });

  it("collides with no existing report's keys", async () => {
    const { SLIPPAGE_GUARD_KEYS } = await import("./slippageWeeklyReport.js");
    const overlap = Object.values(SWAPS_GUARD_KEYS).filter((k) => Object.values(SLIPPAGE_GUARD_KEYS).includes(k));
    expect(overlap).toEqual([]);
  });
});

describe("swaps recipient variables", () => {
  // Same shape as SLIPPAGE_RECIPIENT_VARS so the later scheduling commit is a
  // cron line and nothing else.
  it("gives each cadence its own variable with one shared fallback", () => {
    expect(SWAPS_RECIPIENT_VARS).toEqual({
      daily: ["DAILY_SWAPS_RECIPIENTS", "SWAPS_ALERT_RECIPIENTS"],
      weekly: ["SWAPS_ALERT_RECIPIENTS"],
      monthly: ["MONTHLY_SWAPS_RECIPIENTS", "SWAPS_ALERT_RECIPIENTS"],
    });
  });
});

// ── cadences ─────────────────────────────────────────────────────────────────

describe("all three cadences produce their own period and wording", () => {
  it("names a single day once, not as a range of one", () => {
    expect(swapsSubject("daily", "2026-08-31", "2026-08-31")).toBe("Daily Swaps Report (2026-08-31)");
  });

  it("names a week and a month as ranges", () => {
    expect(swapsSubject("weekly", "2026-08-24", "2026-08-30")).toBe("Weekly Swaps Report (2026-08-24 to 2026-08-30)");
    expect(swapsSubject("monthly", "2026-08-01", "2026-08-31")).toBe("Monthly Swaps Report (2026-08-01 to 2026-08-31)");
  });

  it("drives the h1 from the cadence, never a hardcoded Weekly", () => {
    expect(html({}, { cadence: "daily" })).toMatch(/<h1 class="title">Daily Swaps Report<\/h1>/);
    expect(html({}, { cadence: "weekly" })).toMatch(/<h1 class="title">Weekly Swaps Report<\/h1>/);
    expect(html({}, { cadence: "monthly" })).toMatch(/<h1 class="title">Monthly Swaps Report<\/h1>/);
  });

  it("uses the cadence's own noun in the prose, and no other cadence's", () => {
    const daily = html({ lps: [], clients: [] }, { period: { fromYmd: "2026-08-31", toYmd: "2026-08-31" }, cadence: "daily" });
    expect(daily).toMatch(/No LP rows for this day\./);
    expect(daily).not.toMatch(/week|month/i);

    const monthly = html({ lps: [], clients: [] }, { period: { fromYmd: "2026-08-01", toYmd: "2026-08-31" }, cadence: "monthly" });
    expect(monthly).toMatch(/No LP rows for this month\./);
    expect(monthly).not.toMatch(/week/i);

    expect(html()).toMatch(/for this week/);
  });

  it("takes the window as sent, with no rollover or timezone hedging (rule 2)", () => {
    const out = html({}, { cadence: "daily", period: { fromYmd: "2026-08-31", toYmd: "2026-08-31" } });
    expect(out).not.toMatch(/rollover|timezone|time zone/i);
  });

  it("prints the period it was handed in the header", () => {
    expect(html()).toMatch(/Period: <strong>2026-08-24<\/strong> to <strong>2026-08-30<\/strong>/);
  });
});

// ── rule 4: which figure counts ──────────────────────────────────────────────

describe("rule 4 picks each LP's figure by its type", () => {
  it("Manager uses our statement, even when the LP sent a figure", () => {
    expect(effectiveLpSwap(LPS[3])).toEqual({ value: -1200, source: "statement", type: "Manager", reason: null });
  });

  it("Terminal uses the LP's figure, even when a statement exists", () => {
    const r = effectiveLpSwap({ source: "Terminal", totalSwap: 900, statementSwap: -50 });
    expect(r).toEqual({ value: 900, source: "lp", type: "Terminal", reason: null });
  });

  it("Api uses the LP's figure when there is one", () => {
    expect(effectiveLpSwap(LPS[0])).toEqual({ value: -5000, source: "lp", type: "Api", reason: null });
  });

  it("Api falls back to the statement when the LP record is null or absent", () => {
    expect(effectiveLpSwap(LPS[1])).toEqual({ value: -2000, source: "statement-fallback", type: "Api", reason: null });
    expect(effectiveLpSwap({ source: "Api", statementSwap: -2000, statementRowCount: 1 })).toMatchObject({ value: -2000, source: "statement-fallback" });
  });

  it("Api does NOT fall back when the LP record is a real zero", () => {
    expect(effectiveLpSwap(LPS[2])).toEqual({ value: 0, source: "lp", type: "Api", reason: null });
  });

  it("a Manager statement of zero WITH statement rows is a figure, and renders $0.00", () => {
    const genuine = { lpName: "Zero Book", source: "Manager", totalSwap: -10, statementSwap: 0, statementRowCount: 2 };
    expect(effectiveLpSwap(genuine)).toMatchObject({ value: 0, source: "statement" });
    const out = html({ lps: [genuine] });
    expect(cell(row(lpTableOf(out), "Zero Book"), "LP Swap (period)")).toBe("$0.00");
    expect(kpi(headlineOf(out), "LP Swap (period)").value).toBe("$0.00");
  });

  it("Manager falls back to the MT5 figure when no statement was uploaded", () => {
    // The 2026-09-25 reversal. Before it, this returned null and a day with no
    // statements uploaded printed a dash for the whole LP headline while the
    // Swaps Report tab showed a total for the same day.
    expect(effectiveLpSwap(UNFILED_MANAGER)).toEqual({ value: -400, source: "mt5-fallback", type: "Manager", reason: null });
  });

  it("a Manager statement still wins over the MT5 figure when one exists", () => {
    // The fallback must not override an uploaded statement -- LPS[3] has both.
    expect(effectiveLpSwap(LPS[3]).source).toBe("statement");
  });

  it("an unresolvable LP has no value and says why", () => {
    const mgr = effectiveLpSwap(UNRESOLVABLE_MANAGER);
    expect(mgr.value).toBeNull();
    expect(mgr.source).toBeNull();
    expect(mgr.reason).toMatch(/no statement uploaded and no MT5 figure/);

    const term = effectiveLpSwap({ source: "Terminal", totalSwap: null, statementSwap: -50 });
    expect(term.value).toBeNull();

    const api = effectiveLpSwap({ source: "Api", totalSwap: null, statementSwap: null });
    expect(api.value).toBeNull();
    expect(api.reason).toMatch(/no LP record and no statement/);
  });

  it("matches the type case-insensitively but never guesses an unknown one", () => {
    expect(effectiveLpSwap({ source: " api ", totalSwap: -1 })).toMatchObject({ value: -1, type: "Api" });
    const unknown = effectiveLpSwap({ source: "Hybrid", totalSwap: -1, statementSwap: -1 });
    expect(unknown.value).toBeNull();
    expect(unknown.type).toBeNull();
    expect(unknown.reason).toMatch(/Unknown LP type "Hybrid"/);
    expect(effectiveLpSwap({ totalSwap: -1, statementSwap: -1 }).reason).toMatch(/LP type is missing/);
    // LPManagerPage maps 1/2 to Terminal/Api for its dropdown; a number here is
    // not one of the three strings and is not guessed.
    expect(effectiveLpSwap({ source: 2, totalSwap: -1 }).value).toBeNull();
  });
});

describe("the LP table is one plain list: every LP, one figure, nothing else", () => {
  const table = () => lpTableOf(html());

  it("has exactly two columns, LP and LP Swap (period)", () => {
    const heads = [...table().matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(heads).toEqual(["LP", "LP Swap (period)"]);
  });

  it("has no LP Type, Source or Unrealized column, while the client table keeps Unrealized", () => {
    const t = table();
    for (const col of ["LP Type", "Source", "Unrealized (at send time)"]) {
      expect(t).not.toContain(`data-label="${col}"`);
      expect(t).not.toContain(`>${col}</th>`);
    }
    expect(countCells(clientMoversOf(html()), "Unrealized (at send time)")).toBe(CLIENTS.length);
    expect(clientMoversOf(html())).toMatch(/<th width="[^"]*">Unrealized \(at send time\)<\/th>/);
  });

  it("shows every LP, nothing skipped", () => {
    for (const lp of LPS) expect(row(table(), lp.lpName)).not.toBeNull();
    expect(countCells(table(), "LP Swap (period)")).toBe(LPS.length);
  });

  it("gives each LP row exactly one swap figure and no cross-check line", () => {
    const t = table();
    for (const lp of LPS) {
      const r = fullRow(t, lp.lpName);
      expect(r.match(/<td /g)).toHaveLength(2);
      expect(r.match(/\$[\d,]+\.\d\d/g)).toHaveLength(1);
    }
    expect(html()).not.toMatch(/cross-check/i);
    expect(t).not.toMatch(/\bgap\b/i);
    // Xtb's and Quiet LP's other candidate figures, which the cross-check used to print.
    expect(t).not.toContain("4,500.00");
    expect(t).not.toContain("800.00");
  });

  it("lists an LP with no figure by name under its reason, never as 0.00", () => {
    const t = lpTableOf(html({ lps: [...LPS, UNRESOLVABLE_MANAGER] }));
    expect(row(t, "Silent Mgr")).toBeNull(); // a name under a reason, not a card
    expect(unresolvedGroups(t)).toEqual([{ reason: NO_RECORD, count: 1, names: ["Silent Mgr"] }]);
    expect(t).not.toMatch(/Manager|\btype\b|source/i);
  });

  it("lists an unclassified LP under a reason that names no type", () => {
    const odd = { id: 9, login: 509, lpName: "Odd LP", source: "Hybrid", totalSwap: -250, statementSwap: -250 };
    const t = lpTableOf(html({ lps: [...LPS, odd] }));
    expect(unresolvedGroups(t)).toEqual([
      { reason: "This LP is not set up for swap reporting, so there is no figure &mdash; not zero.", count: 1, names: ["Odd LP"] },
    ]);
    expect(t).not.toContain("250.00");
    expect(t).not.toMatch(/Hybrid|\btype\b/i);
  });

  it("puts LPs with a figure first, largest first, and LPs with none after", () => {
    const ordered = orderLpRows([UNRESOLVABLE_MANAGER, ...LPS]);
    expect(ordered.map((r) => r.label)).toEqual(["Xtb", "Finalto", "Book LP", "Term LP", "Quiet LP", "Silent Mgr"]);
  });

  it("counts the unresolved LPs under the table", () => {
    expect(lpTableOf(html({ lps: [...LPS, UNRESOLVABLE_MANAGER] }))).toMatch(/<strong>1 of 6 LP\(s\) have no figure<\/strong>/);
    expect(lpTableOf(html())).toMatch(/All 5 LP\(s\) have a figure\./);
  });
});

// With no type or source label on the page, a wrong rule-4 pick would print a
// plausible number and nothing else. Each case below gives the LP two candidate
// figures that differ, and asserts the one the reader actually sees.
describe("rule 4 still decides the number each LP displays, with no label to lean on", () => {
  const shownFor = (lp) => {
    const t = lpTableOf(html({ lps: [lp] }));
    return { value: cell(row(t, lp.lpName), "LP Swap (period)"), table: t };
  };

  it("a Manager LP whose totalSwap and statementSwap differ displays the statement", () => {
    const { value, table } = shownFor({ lpName: "Mgr LP", source: "Manager", totalSwap: -1500, statementSwap: -1200, statementRowCount: 5 });
    expect(value).toBe("-$1,200.00 (cost)");
    expect(table).not.toContain("1,500.00");
  });

  it("a Terminal LP displays totalSwap", () => {
    const { value, table } = shownFor({ lpName: "Term LP", source: "Terminal", totalSwap: 900, statementSwap: -350 });
    expect(value).toBe("$900.00 (revenue)");
    expect(table).not.toContain("350.00");
  });

  it("an Api LP with totalSwap: null displays the statement", () => {
    const { value } = shownFor({ lpName: "Api Null", source: "Api", totalSwap: null, statementSwap: -2000, statementRowCount: 2 });
    expect(value).toBe("-$2,000.00 (cost)");
  });

  it("an Api LP with a totalSwap displays it, not the statement", () => {
    const { value, table } = shownFor({ lpName: "Api Rec", source: "Api", totalSwap: -5000, statementSwap: -4500 });
    expect(value).toBe("-$5,000.00 (cost)");
    expect(table).not.toContain("4,500.00");
  });

  it("an Api LP with totalSwap: 0 displays 0.00, not the statement", () => {
    const { value, table } = shownFor({ lpName: "Api Zero", source: "Api", totalSwap: 0, statementSwap: -800 });
    expect(value).toBe("$0.00");
    expect(table).not.toContain("800.00");
  });

  it("the full fixture shows each LP's rule-4 figure", () => {
    const t = lpTableOf(html());
    const shown = Object.fromEntries(LPS.map((lp) => [lp.lpName, cell(row(t, lp.lpName), "LP Swap (period)")]));
    expect(shown).toEqual({
      Xtb: "-$5,000.00 (cost)",
      Finalto: "-$2,000.00 (cost)",
      "Quiet LP": "$0.00",
      "Book LP": "-$1,200.00 (cost)",
      "Term LP": "$900.00 (revenue)",
    });
  });
});

describe("no LP type or source terminology reaches the reader", () => {
  it.each([
    ["the clean report", () => html()],
    ["with every note", () => html({ skippedApiLpCount: 4, lpErrors: ["Vendor B: socket closed"], clientPanelError: "Client panel timed out" })],
    ["with an unresolved and an unclassified LP", () => html({ lps: [...LPS, UNFILED_MANAGER, { lpName: "Odd", source: "Hybrid", totalSwap: -1 }] })],
    ["with an LP the endpoint did not return", () => html({ skippedApiLpCount: 3 })],
    ["daily, with no rows", () => html({ lps: [], clients: [] }, { cadence: "daily", period: { fromYmd: "2026-08-31", toYmd: "2026-08-31" } })],
  ])("%s", (_label, build) => {
    // The one sanctioned use of the word: the reason under a Manager LP's dash
    // names the missing statement, because that is what the reader must chase
    // (user, 2026-09-17). It still names no type and no source.
    const out = build().replaceAll("No statement uploaded for this period, so there is no figure &mdash; not zero.", "");
    for (const word of ["Manager", "Terminal", "Api", "Source", "Statement (fallback", "LP Type"]) {
      expect(out).not.toContain(word);
    }
    // And the same ideas in any case or spelling.
    expect(out).not.toMatch(/\bapi\b|\bsource\b|statement|by type|type rule|\bLP type\b|cross-check|fallback/i);
  });
});

// ── a missing statement is a zero with no rows, not a null ───────────────────

describe("statementRowCount > 0 is the only sign a statement exists", () => {
  it("hasStatement reads the row count and ignores the value", () => {
    expect(hasStatement({ statementSwap: 0, statementRowCount: 0 })).toBe(false);
    expect(hasStatement({ statementSwap: -500, statementRowCount: 0 })).toBe(false);
    expect(hasStatement({ statementSwap: -500, statementRowCount: null })).toBe(false);
    expect(hasStatement({ statementSwap: -500 })).toBe(false);
    expect(hasStatement({ statementSwap: 0, statementRowCount: 2 })).toBe(true);
  });

  it("an Api LP with totalSwap: null and no statement rows is unresolved", () => {
    const r = effectiveLpSwap({ source: "Api", totalSwap: null, statementSwap: 0, statementRowCount: 0 });
    expect(r.value).toBeNull();
    expect(r.reason).toMatch(/no LP record and no statement/);
  });

  it("the same Api LP with statementRowCount: 3 uses the statement", () => {
    expect(effectiveLpSwap({ source: "Api", totalSwap: null, statementSwap: -640, statementRowCount: 3 }))
      .toEqual({ value: -640, source: "statement-fallback", type: "Api", reason: null });
  });

  it("an Api LP's real zero still wins over its statement", () => {
    expect(effectiveLpSwap({ source: "Api", totalSwap: 0, statementSwap: -640, statementRowCount: 3 })).toMatchObject({ value: 0, source: "lp" });
  });
});

describe("the real week of 2026-09-05..2026-09-11 (live payload, 2026-09-17)", () => {
  const MANAGERS = REAL_WEEK.lps.filter((lp) => lp.source === "Manager");
  const realOut = () => html(REAL_WEEK, { period: { fromYmd: "2026-09-05", toYmd: "2026-09-11" } });

  it("is the payload the bug was proven on", () => {
    expect(REAL_WEEK.lps).toHaveLength(43);
    expect(MANAGERS).toHaveLength(27);
    expect(REAL_WEEK.lps.every((lp) => lp.statementSwap === 0 && lp.statementRowCount === 0)).toBe(true);
    expect(REAL_WEEK.lpErrors).toHaveLength(2);
    const sum = REAL_WEEK.lps.reduce((a, lp) => a + lp.totalSwap, 0);
    expect(sum).toBeCloseTo(REAL_WEEK.lpTotals.totalSwap, 2);
  });

  // Was "FX Edge Coverage has no figure, not a confident zero". Until the
  // 2026-09-25 reversal this Manager LP resolved to null because no statement
  // was uploaded, even though MT5 had -11,059.16 for it. Showing that figure is
  // the entire point of the change, so the fixture now asserts it.
  it("FX Edge Coverage shows its MT5 figure now that Manager falls back", () => {
    const fxEdge = REAL_WEEK.lps.find((lp) => lp.lpName.trim() === "FX Edge Coverage");
    expect(fxEdge.totalSwap).toBe(-11059.16);
    expect(effectiveLpSwap(fxEdge)).toMatchObject({ value: -11059.16, source: "mt5-fallback", type: "Manager" });

    const t = lpTableOf(realOut());
    expect(cell(row(t, "FX Edge Coverage"), "LP Swap (period)")).toBe("-$11,059.16 (cost)");
  });

  // The defect: with a 15-row cap and unresolved LPs sorted first, the real
  // week's email printed 15 Manager dashes and none of these four figures.
  it("shows all 43 LPs by name, each exactly once", () => {
    const names = lpNamesShown(realOut());
    expect(names).toHaveLength(43);
    expect(new Set(names).size).toBe(43);
    expect([...names].sort()).toEqual(REAL_WEEK.lps.map((lp) => lp.lpName.trim()).sort());
  });

  it("shows every LP with a figure, Manager ones included", () => {
    const t = lpTableOf(realOut());
    expect(cell(row(t, "Amana 1"), "LP Swap (period)")).toBe("-$12,277.45 (cost)");
    expect(cell(row(t, "Scope Prime"), "LP Swap (period)")).toBe("-$9,883.71 (cost)");
    expect(cell(row(t, "Infinox"), "LP Swap (period)")).toBe("-$3,358.94 (cost)");
    expect(cell(row(t, "XTB Direct API"), "LP Swap (period)")).toBe("-$2,122.34 (cost)");
    // Manager LPs, which printed no figure at all before the reversal.
    expect(cell(row(t, "FXCM 2 Coverage"), "LP Swap (period)")).toBe("-$3,813.72 (cost)");
    expect(countCells(t, "LP Swap (period)")).toBe(43);
  });

  it("orders every LP by magnitude, now that all 43 resolve", () => {
    const resolved = REAL_WEEK.lps.filter((lp) => effectiveLpSwap(lp).value !== null);
    expect(resolved).toHaveLength(43); // was 16 before the Manager fallback

    const names = lpNamesShown(realOut());
    const t = lpTableOf(realOut());
    const sizes = names.map((n) => Math.abs(figureOf(cell(row(t, n), "LP Swap (period)"))));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
    // Managers now interleave with the rest instead of being exiled to the end.
    expect(names.slice(0, 7)).toEqual([
      "Amana 1", "FX Edge Coverage", "Scope Prime", "Finalto 2nd acc 33758 - Coverage",
      "FXCM 2 Coverage", "Infinox", "EdgeWaterMark Coverage ACC",
    ]);

    const ordered = orderLpRows(REAL_WEEK.lps);
    expect(ordered.every((r) => r.swap.value !== null)).toBe(true);
  });

  // Was "states the no-statement reason once for all 27 Manager LPs". Those 27
  // all resolve now, so that grouping has nothing to group and the no-statement
  // wording should appear nowhere on the page.
  it("no longer groups the 27 Manager LPs under a no-statement reason", () => {
    for (const lp of MANAGERS) expect(effectiveLpSwap(lp).value).not.toBeNull();
    const t = lpTableOf(realOut());
    expect(t).not.toContain("No statement uploaded for this period");
    expect(unresolvedGroups(t)).toEqual([]);
    expect(countCells(t, "LP Swap (period)")).toBe(43);
    expect(t).not.toMatch(/<span class="val[^"]*">&mdash;<\/span>/);
    expect(t).toMatch(/All 43 LP\(s\) have a figure\./);
    // The two fetch failures are a separate matter and still surface.
    expect(t).toMatch(/2 LP\(s\) failed and are not in this table/);
  });

  it("with two distinct reasons, states each once with its own LPs under it", () => {
    const noRecordApi = { id: 90, lpName: "Silent Api LP", login: 90, source: "Api", totalSwap: null, statementSwap: 0, statementRowCount: 0 };
    const noRecordTerm = { id: 91, lpName: "Silent Terminal LP", login: 91, source: "Terminal", totalSwap: null, statementSwap: 0, statementRowCount: 0 };
    const out = html({ ...REAL_WEEK, lps: [...REAL_WEEK.lps, noRecordApi, noRecordTerm] }, { period: { fromYmd: "2026-09-05", toYmd: "2026-09-11" } });
    const t = lpTableOf(out);

    // One reason survives the Manager fallback: an Api/Terminal LP that sent
    // nothing at all. The 27 Managers resolve and are not grouped.
    expect(t).not.toContain("No statement uploaded for this period");
    expect(t.split("No swap record for this period").length - 1).toBe(1);

    expect(unresolvedGroups(t)).toEqual([
      { reason: NO_RECORD, count: 2, names: ["Silent Api LP", "Silent Terminal LP"] },
    ]);
    expect(lpNamesShown(out)).toHaveLength(45);
  });

  it("keeps the client section capped at SWAPS_ROW_CAP", () => {
    const t = clientMoversOf(realOut());
    expect(REAL_WEEK.clients.length).toBeGreaterThan(SWAPS_ROW_CAP);
    expect(countCells(t, "Swap (period)")).toBe(SWAPS_ROW_CAP);
    expect(t).toMatch(/Showing 15 of 22 accounts; 7 omitted\./);
  });

  it("the LP total is a dash, and the partial sum appears nowhere in the email", () => {
    // Still a dash for this week, but for ONE reason now instead of two: every
    // LP resolves, and two LPs failed to fetch at all. A sum over 43 of 45 is
    // still a partial sum.
    expect(lpSwapTotal(REAL_WEEK.lps, REAL_WEEK.lpErrors)).toEqual({ value: null, count: 43, unresolved: 0, failed: 2 });
    const out = realOut();
    const card = kpi(headlineOf(out), "LP Swap (period)");
    expect(card.value).toBe("&mdash;");
    expect(card.note).toBe("2 LP(s) failed; no partial sum");
    expect(out).not.toContain("27,767.27");
  });

  // The inverse of what this case proved before 2026-09-25. The real week had
  // two independent reasons for a dash -- 27 statement-less Manager LPs AND two
  // failed LPs -- and the statement rule used to hold the line on its own. With
  // the Manager fallback in place only the failures do, so removing them yields
  // a real total: the full -48,265.24 over all 43 LPs, and NOT the -27,767.27
  // sixteen-LP partial the old rule existed to keep off the page.
  it("with the two failures removed, every LP resolves and the total is the full sum", () => {
    const out = html({ ...REAL_WEEK, lpErrors: [] }, { period: { fromYmd: "2026-09-05", toYmd: "2026-09-11" } });
    // toBeCloseTo, not toEqual: summing 43 floats lands on -48265.24000000001.
    // The card formats to 2dp so the reader never sees the tail, and pinning the
    // exact double would make this fail if one LP's figure changed in the last
    // decimal for reasons that do not matter.
    const total = lpSwapTotal(REAL_WEEK.lps, []);
    expect(total.value).toBeCloseTo(-48265.24, 2);
    expect(total).toMatchObject({ count: 43, unresolved: 0, failed: 0 });
    const card = kpi(headlineOf(out), "LP Swap (period)");
    expect(card.value).toBe("-$48,265.24 (cost)");
    expect(card.note).toBe("43 LPs");
    expect(out).not.toContain("27,767.27");
  });

  it("still surfaces both LP failures", () => {
    const out = realOut();
    expect(out).toMatch(/LP queries failed/);
    expect(out).toMatch(/2 LP\(s\) failed: AIDI \(56720794\)/);
    expect(out).toContain("Broctagon2 (101824)");
  });
});

// ── the LP headline ──────────────────────────────────────────────────────────

describe("the LP total is the sum of rule-4 figures, all or nothing", () => {
  it("sums each LP's rule-4 figure", () => {
    expect(lpSwapTotal(LPS)).toEqual({ value: -7300, count: 5, unresolved: 0, failed: 0 });
    const card = kpi(headlineOf(html()), "LP Swap (period)");
    expect(card.value).toBe("-$7,300.00 (cost)");
    expect(card.note).toBe("5 LPs");
  });

  it("is not the backend's lpTotals, nor a raw sum of totalSwap", () => {
    const out = html();
    expect(out).not.toContain("-$9,123.45");
    expect(out).not.toContain("-$5,600.00");
  });

  it("is a dash with the unresolved count when any LP is unresolved, never the partial sum", () => {
    // The five resolved LPs still sum to -7,300 -- a perfectly plausible
    // figure. It must appear nowhere.
    expect(lpSwapTotal([...LPS, UNRESOLVABLE_MANAGER])).toEqual({ value: null, count: 6, unresolved: 1, failed: 0 });
    const out = html({ lps: [...LPS, UNRESOLVABLE_MANAGER] });
    const card = kpi(headlineOf(out), "LP Swap (period)");
    expect(card.value).toBe("&mdash;");
    expect(card.note).toBe("1 of 6 LP(s) unresolved; no partial sum");
    expect(out).not.toContain("$7,300.00");
    expect(out).not.toContain("$7,700.00");
  });

  it("is a dash when every returned LP resolves but an LP failed, never the sum of the rest", () => {
    // The failed LP is not in lps[] at all -- exactly as AIDI and Broctagon2
    // were in the live week -- so -7,300.00 is a sum over an incomplete list.
    expect(lpSwapTotal(LPS, ["Vendor B: socket closed"])).toEqual({ value: null, count: 5, unresolved: 0, failed: 1 });
    const out = html({ lpErrors: ["Vendor B: socket closed"] });
    const card = kpi(headlineOf(out), "LP Swap (period)");
    expect(card.value).toBe("&mdash;");
    expect(card.note).toBe("1 LP(s) failed; no partial sum");
    expect(out).not.toContain("7,300.00");
    expect(lpTableOf(out)).toMatch(/1 LP\(s\) failed and are not in this table \(see Report Notes\), so the LP total is unavailable\./);
    // and the error itself is still surfaced
    expect(out).toMatch(/LP queries failed/);
    expect(out).toMatch(/Vendor B: socket closed/);
  });

  it("still shows the summed total when every LP resolves and none failed", () => {
    const out = html({ lpErrors: [] });
    expect(kpi(headlineOf(out), "LP Swap (period)")).toEqual({ cls: "neg", value: "-$7,300.00 (cost)", note: "5 LPs" });
    expect(lpTableOf(out)).not.toMatch(/failed/);
  });

  it("is a dash, not 0.00, when there are no LP rows", () => {
    const card = kpi(headlineOf(html({ lps: [] })), "LP Swap (period)");
    expect(card.value).toBe("&mdash;");
    expect(card.note).toBe("No LP rows to total");
  });
});

// ── rule 1: sign convention ──────────────────────────────────────────────────

describe("rule 1: clients and LPs read a sign in opposite directions", () => {
  it("swapEffect: client negative is revenue, client positive is cost; LP negative is cost, LP positive is revenue", () => {
    expect(swapEffect(-100, "client")).toBe("revenue");
    expect(swapEffect(100, "client")).toBe("cost");
    expect(swapEffect(-100, "lp")).toBe("cost");
    expect(swapEffect(100, "lp")).toBe("revenue");
  });

  it("swapEffect calls zero, and anything that prints as $0.00, neither", () => {
    for (const side of ["client", "lp"]) {
      expect(swapEffect(0, side)).toBeNull();
      expect(swapEffect(-0.004, side)).toBeNull();
      expect(swapEffect(0.004, side)).toBeNull();
      expect(swapEffect(null, side)).toBeNull();
      expect(swapEffect(-0.005, side)).not.toBeNull();
    }
  });

  it("swapEffect refuses to guess a side", () => {
    expect(() => swapEffect(-1, "vendor")).toThrow(/unknown side/);
    expect(() => swapEffect(-1)).toThrow(/unknown side/);
  });

  // One fixture, both sides, both directions: the same signed amounts must read
  // opposite ways in the client half and the LP half of the same email.
  const MIRROR = {
    clients: [
      { login: 1, name: "Charged Client", totalSwap: -300, unrealizedSwap: -60 },
      { login: 2, name: "Paid Client", totalSwap: 200, unrealizedSwap: 40 },
    ],
    clientTotals: { totalSwap: -100, accountCount: 2 },
    lps: [
      { lpName: "Charging LP", source: "Terminal", totalSwap: -300 },
      { lpName: "Paying LP", source: "Terminal", totalSwap: 200 },
    ],
  };

  it("renders the opposition in one email, rows and headlines, words and colours", () => {
    const out = html(MIRROR);
    const movers = clientMoversOf(out);
    const lps = lpTableOf(out);

    expect(cell(row(movers, "Charged Client"), "Swap (period)")).toBe("-$300.00 (revenue)");
    expect(cell(row(lps, "Charging LP"), "LP Swap (period)")).toBe("-$300.00 (cost)");
    expect(cell(row(movers, "Paid Client"), "Swap (period)")).toBe("$200.00 (cost)");
    expect(cell(row(lps, "Paying LP"), "LP Swap (period)")).toBe("$200.00 (revenue)");

    expect(row(movers, "Charged Client")).toMatch(/<span class="val pos">-\$300\.00 \(revenue\)/);
    expect(row(lps, "Charging LP")).toMatch(/<span class="val neg">-\$300\.00 \(cost\)/);
    expect(row(movers, "Paid Client")).toMatch(/<span class="val neg">\$200\.00 \(cost\)/);
    expect(row(lps, "Paying LP")).toMatch(/<span class="val pos">\$200\.00 \(revenue\)/);

    // Client unrealized follows the client convention too.
    expect(cell(row(movers, "Charged Client"), "Unrealized (at send time)")).toBe("-$60.00 (revenue)");
    expect(cell(row(movers, "Paid Client"), "Unrealized (at send time)")).toBe("$40.00 (cost)");

    expect(kpi(out, "Client Swap (period)")).toMatchObject({ value: "-$100.00 (revenue)", cls: "pos" });
    expect(kpi(out, "LP Swap (period)")).toMatchObject({ value: "-$100.00 (cost)", cls: "neg" });
  });

  it("renders a genuine zero as a bare, muted $0.00 on both sides", () => {
    const out = html({
      clients: [{ login: 3, name: "Flat Client", totalSwap: 0, unrealizedSwap: -0.001 }],
      clientTotals: { totalSwap: 0, accountCount: 1 },
    });
    expect(row(clientMoversOf(out), "Flat Client")).toMatch(/<span class="val muted">\$0\.00<\/span>/);
    expect(cell(row(clientMoversOf(out), "Flat Client"), "Unrealized (at send time)")).toBe("$0.00");
    expect(kpi(out, "Client Swap (period)")).toMatchObject({ value: "$0.00", cls: "muted" });
    expect(row(lpTableOf(out), "Quiet LP")).toMatch(/<span class="val muted">\$0\.00<\/span>/);
    expect(out).not.toContain("-$0.00");
  });

  it("says nothing about the client sign being unconfirmed, and states the convention", () => {
    const out = html();
    expect(out).not.toMatch(/not yet confirmed|unconfirmed|signed swap only/i);
    expect(headlineOf(out)).toMatch(/Negative client swap is charged to the client, so it is our revenue; positive is given to the client, so it is our cost\./);
    expect(clientMoversOf(out)).toMatch(/Negative client swap is charged to the client \(revenue\); positive is given to the client \(cost\)\./);
  });

  it("the fixture's client headline reads as revenue", () => {
    expect(kpi(html(), "Client Swap (period)")).toEqual({ cls: "pos", value: "-$12,345.67 (revenue)", note: "3 accounts" });
  });
});

// ── the snapshot ─────────────────────────────────────────────────────────────

describe("unrealized is labelled as a snapshot wherever it is shown", () => {
  it("names every unrealized cell as an at-send-time figure, never bare", () => {
    const out = html();
    expect(out).not.toMatch(/data-label="Unrealized"/);
    const labels = [...out.matchAll(/data-label="([^"]*Unrealized[^"]*)"/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label).toContain("at send time");
    expect(out).toMatch(/<th width="[^"]*">Unrealized \(at send time\)<\/th>/);
    expect(out).toMatch(/snapshot of accrued swap on positions open when this email was built/);
  });

  it("does not print any LP's unrealized figure", () => {
    const t = lpTableOf(html());
    expect(t).not.toContain("700.00");
    expect(t).not.toContain("150.00");
    expect(t).not.toMatch(/unrealized/i);
  });
});

describe("unrealizedSwap is never folded into a period total", () => {
  const CLIENT_UNREALIZED = -1000 + -2000 + -3000; // -6,000
  const LP_UNREALIZED = -700 + -300 + 150; // -850

  it("prints the backend's client total, not the total plus the snapshot", () => {
    const out = html();
    expect(CLEAN.clientTotals.totalSwap + CLIENT_UNREALIZED).toBe(-18345.67);
    expect(out).toContain("-$12,345.67");
    expect(out).not.toContain("-$18,345.67");
  });

  it("prints the rule-4 LP total, not the total plus the snapshot", () => {
    const out = html();
    expect(-7300 + LP_UNREALIZED).toBe(-8150);
    expect(out).toContain("-$7,300.00 (cost)");
    expect(out).not.toContain("-$8,150.00");
  });

  it("says in the body that the snapshot belongs to no period", () => {
    const out = html();
    expect(out).toMatch(/never added into the period figures above/);
    expect(out).toMatch(/it is a snapshot, it covers no period, and it is never included in any total above/i);
  });
});

// ── client totals come from the backend ──────────────────────────────────────

describe("a null client total says so rather than being recomputed from rows", () => {
  const ROW_SUM_CLIENTS = "-$8,500.00"; // -7000 + -4000 + 2500

  it("renders the backend's figure when it sends one", () => {
    expect(kpi(html(), "Client Swap (period)")).toEqual({ cls: "pos", value: "-$12,345.67 (revenue)", note: "3 accounts" });
  });

  it("says Unavailable and names the missing field when clientTotals is null", () => {
    const out = html({ clientTotals: null });
    expect(out).toMatch(/Backend sent no clientTotals; rows are not summed here/);
    expect(kpi(out, "Client Swap (period)").value).toBe("Unavailable");
    expect(out).not.toContain(ROW_SUM_CLIENTS);
  });

  it("treats a NaN or non-numeric total as absent, not as a figure", () => {
    const out = html({ clientTotals: { totalSwap: "n/a", accountCount: 3 } });
    expect(out).toMatch(/Backend sent no clientTotals/);
    expect(out).not.toContain(ROW_SUM_CLIENTS);
    expect(out).not.toMatch(/NaN/);
  });

  it("a missing lpTotals changes nothing, because it is not the LP total", () => {
    expect(kpi(html({ lpTotals: null }), "LP Swap (period)").value).toBe("-$7,300.00 (cost)");
  });
});

// ── rule 6: excludeFromSwaps ─────────────────────────────────────────────────

describe("excludeFromSwaps removes a row from the tables and the totals", () => {
  const HIDDEN_LP = { id: 7, login: 507, lpName: "Hidden LP", source: "Terminal", totalSwap: -10000, unrealizedSwap: -50, statementSwap: null, excludeFromSwaps: true };
  const HIDDEN_CLIENT = { login: 10299, name: "Hidden Client", totalSwap: -1000, unrealizedSwap: 0, excludeFromSwaps: true };
  // The backend's clientTotals is taken to include the flagged row.
  const withExcluded = () =>
    html({
      lps: [...LPS, HIDDEN_LP],
      clients: [...CLIENTS, HIDDEN_CLIENT],
      clientTotals: { totalSwap: -12345.67, accountCount: 4 },
    });

  it("leaves the excluded LP out of the table and the LP total", () => {
    const out = withExcluded();
    expect(row(lpTableOf(out), "Hidden LP")).toBeNull();
    expect(kpi(out, "LP Swap (period)").value).toBe("-$7,300.00 (cost)");
    expect(out).not.toContain("-$17,300.00");
    expect(lpTableOf(out)).toMatch(/1 LP\(s\) marked excluded from swaps are left out of this table and the LP total\./);
  });

  it("an excluded unresolved LP does not make the total unavailable", () => {
    const out = html({ lps: [...LPS, { ...UNFILED_MANAGER, excludeFromSwaps: true }] });
    expect(kpi(out, "LP Swap (period)").value).toBe("-$7,300.00 (cost)");
  });

  it("leaves the excluded client out of the movers and takes it out of the client total", () => {
    const out = withExcluded();
    expect(row(clientMoversOf(out), "Hidden Client")).toBeNull();
    expect(kpi(out, "Client Swap (period)")).toEqual({ cls: "pos", value: "-$11,345.67 (revenue)", note: "3 accounts, after removing 1 excluded" });
  });

  it("makes the client total unavailable when an excluded row has nothing to subtract", () => {
    const out = html({ clients: [...CLIENTS, { ...HIDDEN_CLIENT, totalSwap: null }] });
    expect(kpi(out, "Client Swap (period)").value).toBe("Unavailable");
    expect(out).not.toContain("-$12,345.67");
  });

  it("keeps a row whose flag is absent or not exactly true", () => {
    const out = html({
      lps: [...LPS, { ...HIDDEN_LP, lpName: "Kept False", excludeFromSwaps: false }, { ...HIDDEN_LP, lpName: "Kept Absent", excludeFromSwaps: undefined }],
    });
    expect(row(lpTableOf(out), "Kept False")).not.toBeNull();
    expect(row(lpTableOf(out), "Kept Absent")).not.toBeNull();
    // -7300 + -10000 + -10000
    expect(kpi(out, "LP Swap (period)").value).toBe("-$27,300.00 (cost)");
  });
});

// ── report notes (rule 5) ────────────────────────────────────────────────────

describe("report notes", () => {
  it("names LPs the endpoint did not return, without calling the report incomplete", () => {
    // Finalto is a skipped Api LP that DID come back (no LP record); the other
    // two of the three never arrived.
    const out = html({ skippedApiLpCount: 3 });
    expect(out).toMatch(/Report Notes/);
    expect(out).toMatch(/>LPs not returned</);
    expect(out).toMatch(/2 LP\(s\) were not returned by the endpoint, so no swap figure could be shown for them/);
    expect(headlineOf(out)).toMatch(/does not include the 2 LP\(s\) the endpoint did not return/);
    expect(out).not.toMatch(/incomplete/i);
    expect(out).not.toMatch(/never queried|MISSING/);
  });

  it("adds no note when every skipped API LP came back and used the fallback", () => {
    const out = html({ skippedApiLpCount: 1 });
    expect(out).not.toMatch(/LPs not returned/);
    expect(out).toMatch(/No LP errors, the client panel returned/);
    expect(cell(row(lpTableOf(out), "Finalto"), "LP Swap (period)")).toBe("-$2,000.00 (cost)");
  });

  it("shows every LP error message", () => {
    const out = html({ lpErrors: ["Xtb: credentials rejected", "Vendor B: socket closed"] });
    expect(out).toMatch(/LP queries failed/);
    expect(out).toMatch(/2 LP\(s\) failed/);
    expect(out).toMatch(/Xtb: credentials rejected; Vendor B: socket closed/);
    expect(out).toMatch(/Some figures below are affected by the failures listed here/);
  });

  it("shows a client panel failure", () => {
    const out = html({ clientPanelError: "MT5 manager timed out" });
    expect(out).toMatch(/Client panel failed/);
    expect(out).toMatch(/MT5 manager timed out/);
    expect(out).toMatch(/the client figures below are missing or incomplete/);
  });

  it("shows all three at once", () => {
    const out = html({ skippedApiLpCount: 4, lpErrors: ["Vendor B: socket closed"], clientPanelError: "MT5 manager timed out" });
    expect(out).toMatch(/LPs not returned/);
    expect(out).toMatch(/LP queries failed/);
    expect(out).toMatch(/Client panel failed/);
  });

  it("states the all-clear explicitly, so a missing warning cannot pass for none", () => {
    const out = html();
    expect(out).toMatch(/No LP errors, the client panel returned, and every LP the backend counted is in the table below/);
    expect(out).not.toMatch(/Some figures below are affected/);
  });

  it("puts the notes above the figures they qualify", () => {
    const out = html({ skippedApiLpCount: 3 });
    expect(out.indexOf("Report Notes")).toBeLessThan(out.indexOf("Headline Totals"));
  });
});

// ── the row cap ──────────────────────────────────────────────────────────────

// The cap is for client movers only. The LP list is always whole: the user's
// rule (2026-09-16) is "show all LPs", and capping it hid every real LP figure
// in the week of 2026-09-05..11.
describe("the row cap holds for clients, and never applies to LPs", () => {
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const BIG = {
    lps: many(400, (i) => ({
      id: i,
      login: 9000 + i,
      lpName: `LP ${i}`,
      source: "Api",
      totalSwap: -(i + 1) * 10,
      unrealizedSwap: -i,
      statementSwap: -(i + 1) * 10 + i,
      statementRowCount: 2,
    })),
    clients: many(600, (i) => ({ login: 20000 + i, name: `Client ${i}`, totalSwap: -(i + 1) * 7, unrealizedSwap: -i })),
  };

  it("caps the client movers at SWAPS_ROW_CAP and prints every LP", () => {
    const out = html(BIG);
    expect(SWAPS_ROW_CAP).toBe(15);
    expect(countCells(clientMoversOf(out), "Unrealized (at send time)")).toBe(SWAPS_ROW_CAP);
    expect(countCells(lpTableOf(out), "LP Swap (period)")).toBe(400);
  });

  it("says how many client rows it dropped, and never says an LP was omitted", () => {
    const out = html(BIG);
    expect(clientMoversOf(out)).toMatch(/Showing 15 of 600 accounts; 585 omitted/);
    expect(lpTableOf(out)).not.toMatch(/omitted|Showing \d+ of/);
  });

  it("keeps the largest clients, not the first fifteen the backend happened to send", () => {
    const movers = clientMoversOf(html(BIG));
    expect(movers).toContain("Client 599");
    expect(movers).not.toContain(`<span class="val">Client 0</span>`);
  });

  it("orders the LPs largest first", () => {
    const names = lpNamesShown(html(BIG));
    expect(names[0]).toBe("LP 399");
    expect(names[399]).toBe("LP 0");
  });

  it("still totals every LP, not just the rows shown", () => {
    // Σ -(i+1)*10 for i in 0..399 = -10 * 400*401/2 = -802,000
    expect(kpi(html(BIG), "LP Swap (period)").value).toBe("-$802,000.00 (cost)");
  });

  it("says so when nothing was dropped", () => {
    expect(clientMoversOf(html())).toMatch(/All 3 account\(s\) shown\./);
  });
});

// ── the shell ────────────────────────────────────────────────────────────────

describe("the Swaps email is built through the shared light shell", () => {
  const source = readFileSync(path.resolve("reports/swapsReport.js"), "utf8");

  it("defines no shell of its own", () => {
    expect(source).not.toMatch(/<style>/);
    expect(source).not.toMatch(/<!doctype/i);
    expect(source).not.toMatch(/<body>/);
    expect(source).not.toMatch(/^function (dataCell|spanCell|emailShell)\(/m);
  });

  it("uses none of the constructions Zoho strips or that break on a phone", () => {
    const out = html();
    expect(out).not.toMatch(/::(before|after)/);
    expect(out).not.toMatch(/display\s*:\s*(flex|grid)/);
    expect(source).not.toMatch(/::(before|after)/);
  });

  // Narrowed from a flat "no @media anywhere" on 2026-09-25.
  //
  // The point of that rule is that Zoho strips @media, so LAYOUT must never
  // depend on one -- which is why it sat beside ::before and display:flex. The
  // shared card system honours that: .rpt-cell's column width is an inline px
  // max-width, and when the cap exceeds the viewport the cells stack on their
  // own, in every client, with no query involved. The one query that ships only
  // widens an already-stacked card from its cap to the full screen, so a client
  // that drops it loses a tidy right edge and nothing else.
  //
  // The guard is kept sharp rather than removed: exactly one @media may exist
  // and it must be that override, so a second one -- or a load-bearing first
  // one -- still fails here.
  it("ships at most the one documented phone override, and no other @media", () => {
    const out = html();
    expect((out.match(/@media/g) || []).length).toBe(1);
    expect(out).toMatch(/@media[^{]*\{\s*\.rpt-cell/);
  });

  it("emits the shell's document, its light palette and table.data", () => {
    const out = html();
    expect(out).toMatch(/^<!doctype html>/);
    // THEMES.light.pageBg. Updated from #f3f7fb when the report palette moved
    // to the Risk Analysis Report's slate/cyan scheme; the assertion's point is
    // that the LIGHT theme rendered rather than the dark one, not this hex.
    expect(out).toMatch(/background:#eef1f6/); // light page
    expect(out).toMatch(/background:#ffffff/); // light card
    expect(out).toMatch(/<table class="data/);
    expect(out).toMatch(/<div class="tscroll">/);
  });

  it("contains none of the dark theme's colours", () => {
    for (const hex of ["#0b1220", "#111a2c", "#1f2a44", "#101c33", "#16233f"]) {
      expect(html()).not.toContain(hex);
    }
  });

  it("writes HTML entities once, not twice", () => {
    const odd = { lpName: "Odd & Co", source: 'Hy"brid', totalSwap: -1 };
    for (const out of [html(), html({ skippedApiLpCount: 4, clientPanelError: "boom", lpErrors: ["a & b"] }), html({ lps: [...LPS, odd] }), html({ lps: [], clients: [] })]) {
      expect(out).not.toMatch(/&amp;(mdash|ndash|minus|nbsp|rsquo|Sigma|amp|quot);/);
    }
  });

  it("depends on no hover anywhere", () => {
    expect(html()).not.toMatch(/\stitle\s*=/i);
  });
});

// ── class coverage ───────────────────────────────────────────────────────────
//
// The regression this exists for: on 2026-09-04 the volume section reached the
// reader's phone as two headings and no figures, because its markup used class
// names no shell stylesheet defined. This report introduces NO marker classes
// at all -- its inline-styled cells reuse txt/lbl/val -- so the allowed-exception
// list is empty and must stay that way.
const MARKER_CLASSES = [];

function classesUsed(out) {
  const used = new Set();
  for (const m of out.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].trim().split(/\s+/)) if (c) used.add(c);
  }
  return used;
}

function classesDefined(out) {
  const style = /<style>([\s\S]*?)<\/style>/.exec(out);
  expect(style).not.toBeNull();
  return new Set([...style[1].matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
}

describe("every class in the Swaps body has a rule in the stylesheet that ships with it", () => {
  it.each([
    ["the clean report", () => html()],
    ["with every note", () => html({ skippedApiLpCount: 4, lpErrors: ["boom"], clientPanelError: "boom" })],
    ["with an unresolved and an unknown-type LP", () => html({ lps: [...LPS, UNFILED_MANAGER, { lpName: "Odd", source: "Hybrid" }] })],
    ["with the client total missing", () => html({ clientTotals: null })],
    ["with no rows at all", () => html({ lps: [], clients: [] })],
  ])("%s", (_label, build) => {
    const out = build();
    const defined = classesDefined(out);
    const undefinedClasses = [...classesUsed(out)].filter((c) => !defined.has(c) && !MARKER_CLASSES.includes(c)).sort();
    expect(undefinedClasses).toEqual([]);
  });

  it("introduces no marker classes of its own", () => {
    expect(MARKER_CLASSES).toEqual([]);
  });
});

// ── parsing ──────────────────────────────────────────────────────────────────

describe("parseSwapsReport", () => {
  it("keeps a genuinely zero figure and drops an absent one", () => {
    const parsed = parseSwapsReport({ lps: LPS });
    expect(effectiveLpSwap(parsed.lps[1]).source).toBe("statement-fallback");
    expect(effectiveLpSwap(parsed.lps[2]).value).toBe(0);
  });

  it("splits excluded rows out of the lists and keeps them aside", () => {
    const parsed = parseSwapsReport({
      lps: [LPS[0], { ...LPS[1], excludeFromSwaps: true }],
      clients: [CLIENTS[0], { ...CLIENTS[1], excludeFromSwaps: true }],
    });
    expect(parsed.lps.map((r) => r.lpName)).toEqual(["Xtb"]);
    expect(parsed.excludedLps.map((r) => r.lpName)).toEqual(["Finalto"]);
    expect(parsed.clients.map((r) => r.name)).toEqual(["Acme Ltd"]);
    expect(parsed.excludedClients.map((r) => r.name)).toEqual(["Beta FZE"]);
  });

  it("normalises a junk payload without inventing figures", () => {
    const parsed = parseSwapsReport(null);
    expect(parsed).toEqual({
      clients: [],
      clientTotals: null,
      lps: [],
      lpTotals: null,
      excludedClients: [],
      excludedLps: [],
      skippedApiLpCount: 0,
      clientPanelError: null,
      lpErrors: [],
    });
  });

  it("drops a blank clientPanelError and blank lpErrors rather than rendering empty warnings", () => {
    const parsed = parseSwapsReport({ clientPanelError: "   ", lpErrors: ["", "  ", "real"] });
    expect(parsed.clientPanelError).toBeNull();
    expect(parsed.lpErrors).toEqual(["real"]);
  });
});

// ── the fetch ────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  const { resetBackendTokenState } = await import("../wallet/backendToken.js");
  resetBackendTokenState();
  process.env.BACKEND_API_KEY = "unit-test-key";
  process.env.BACKEND_CLIENT_ID = "4071";
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  process.env = { ...realEnv };
  const { resetBackendTokenState } = await import("../wallet/backendToken.js");
  resetBackendTokenState();
});

const FROM = new Date(Date.UTC(2026, 7, 24));
const TO = new Date(Date.UTC(2026, 7, 30, 23, 59, 59));

function stubFetch(responder) {
  const urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/oauth/token")) return json({ access_token: "issued-token", expires_in: 300 });
    return responder(u);
  };
  return urls;
}

describe("the SwapsReport call", () => {
  // A one-day range answered 200 in 67.2 seconds. reportShared's 45s default
  // would abort that before it returned, so the budget is not a nicety.
  it("gets the same long-route budget the proxy grants it", () => {
    expect(SWAPS_RUN_TIMEOUT_MS).toBe(180_000);
  });

  it("asks for liveFinalto=false, because a cron job is not an operator watching a spinner", async () => {
    const urls = stubFetch(() => json(CLEAN));
    await fetchSwapsReport(FROM, TO);
    const call = urls.find((u) => u.includes("/api/SwapsReport"));
    expect(call).toMatch(/liveFinalto=false/);
    expect(call).toMatch(/from=\d+&to=\d+/);
  });

  it("fails loudly and names the range on an HTTP error, rather than returning a half-empty report", async () => {
    stubFetch((u) => (u.includes("/api/SwapsReport") ? json({ error: "proxy_timeout" }, 504) : json({})));
    await expect(fetchSwapsReport(FROM, TO)).rejects.toThrow(/SwapsReport 2026-08-24\.\.2026-08-30 HTTP 504/);
  });

  it("names the range and the budget when the call is aborted", async () => {
    stubFetch((u) => {
      if (u.includes("/api/SwapsReport")) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      return json({});
    });
    await expect(fetchSwapsReport(FROM, TO)).rejects.toThrow(/SwapsReport 2026-08-24\.\.2026-08-30 failed after up to 180s/);
  });

  it("returns a parsed report on success", async () => {
    stubFetch(() => json(CLEAN));
    const report = await fetchSwapsReport(FROM, TO);
    expect(report.lps).toHaveLength(5);
    expect(report.clientTotals).toEqual({ totalSwap: -12345.67, accountCount: 3 });
  });
});
