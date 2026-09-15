// @vitest-environment node
//
// node, not the suite's default, because the fetch tests at the bottom reach
// backendFetch(), which calls AbortSignal.timeout() -- the same reason
// backendFetch.test.js and volumeSection.test.js opt out.
//
// What this file is actually guarding, in order of how much it would cost to
// get wrong:
//
//   1. unrealizedSwap is a SNAPSHOT and must never land inside a period total.
//      The fixtures below are built so that folding it in changes a printed
//      figure, so the guard bites instead of merely agreeing with the code.
//   2. An LP with no uploaded statement renders a dash, and an LP whose
//      statement genuinely totals zero renders 0.00. Collapsing those two says
//      "MT5 and the LP agree" about a comparison that was never made.
//   3. A null clientTotals/lpTotals says so. Summing the rows instead would
//      invent a second answer to "what did we pay in swaps".
//   4. Partial success is visible. The backend answers 200 with skipped LPs and
//      per-LP errors set; unrendered, every figure silently covers a subset.
//   5. Nothing renders a class the shell does not define -- the bug that made
//      the volume section arrive as two bare headings on the reader's phone.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SWAPS_GUARD_KEYS,
  SWAPS_RECIPIENT_VARS,
  SWAPS_ROW_CAP,
  SWAPS_RUN_TIMEOUT_MS,
  buildSwapsEmailHtml,
  fetchSwapsReport,
  orderReconciliation,
  parseSwapsReport,
  reconcileLp,
  swapsSubject,
} from "./swapsReport.js";

// ── the fixture ──────────────────────────────────────────────────────────────
//
// Every figure here is chosen so that a wrong arithmetic choice produces a
// DIFFERENT printed string, not a coincidentally equal one:
//
//   client rows sum to  -8,500.00   but clientTotals says -12,345.67
//   LP rows sum to      -9,000.00   but lpTotals     says  -9,123.45
//     -> a total recomputed from rows is visible on sight.
//
//   client unrealized sums to -6,000.00; folded into the client total that is
//     -18,345.67, a string that must appear nowhere.
//   LP unrealized sums to -1,000.00; folded into the LP total that is
//     -10,123.45, likewise.
//
//   Xtb reconciles to a difference of -500.00. Folding its -700.00 unrealized
//     into the MT5 side would make it -1,200.00 instead.
const LPS = [
  // A full reconciliation: both books present, and they disagree by 500.
  { id: 1, login: 501, lpName: "Xtb", totalSwap: -5000, unrealizedSwap: -700, statementSwap: -4500, statementRowCount: 12 },
  // No statement uploaded at all. Unknown difference, not a zero one. Finalto
  // also exposes no unrealized figure, so that cell is a dash for its own
  // separate reason.
  { id: 2, login: 502, lpName: "Finalto", totalSwap: -3000, unrealizedSwap: null, statementSwap: null, statementRowCount: null },
  // A statement that exists and genuinely totals zero. This is the row that
  // must print 0.00 while Finalto prints a dash.
  { id: 3, login: 503, lpName: "Quiet LP", totalSwap: -1000, unrealizedSwap: -300, statementSwap: 0, statementRowCount: 3 },
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
  lpTotals: { totalSwap: -9123.45, accountCount: 3 },
  skippedApiLpCount: 0,
  clientPanelError: null,
  lpErrors: [],
};

const PERIOD = { fromYmd: "2026-08-24", toYmd: "2026-08-30" };

const html = (over = {}, { period = PERIOD, cadence = "weekly" } = {}) =>
  buildSwapsEmailHtml({ report: parseSwapsReport({ ...CLEAN, ...over }), period, cadence });

// ── HTML readers ─────────────────────────────────────────────────────────────

// Sections, so a figure rendered in the movers table is invisible to a reader
// pointed at the reconciliation. "Xtb" appears in both.
function section(out, startMarker, endMarker) {
  const from = out.indexOf(startMarker);
  expect(from).toBeGreaterThan(-1);
  const to = endMarker ? out.indexOf(endMarker, from) : -1;
  return out.slice(from, to === -1 ? out.length : to);
}
const reconciliationOf = (out) => section(out, "LP Reconciliation", "Top Movers");
const lpMoversOf = (out) => section(out, "Top Movers &mdash; LP Accounts", "Top Movers &mdash; Client Accounts");
const clientMoversOf = (out) => section(out, "Top Movers &mdash; Client Accounts");

// One table.data row, anchored on its first cell's VISIBLE VALUE -- never on a
// column label -- so "this LP is not in that table" stays a structural claim.
function row(out, key) {
  const at = out.indexOf(`<span class="val">${key}</span>`);
  if (at === -1) return null;
  const end = out.indexOf("</tr>", at);
  return out.slice(at, end === -1 ? out.length : end);
}

function cell(rowHtml, column) {
  if (rowHtml === null) return null;
  const idx = rowHtml.indexOf(`data-label="${column}"`);
  if (idx === -1) return null;
  const open = rowHtml.indexOf('<span class="val', idx);
  const gt = rowHtml.indexOf(">", open);
  return rowHtml.slice(gt + 1, rowHtml.indexOf("</span>", gt)).trim();
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

  it("prints the period it was handed in the header", () => {
    expect(html()).toMatch(/Period: <strong>2026-08-24<\/strong> to <strong>2026-08-30<\/strong>/);
  });
});

// ── the three swap figures ───────────────────────────────────────────────────

describe("the three swap figures render distinctly", () => {
  it("shows MT5, statement and unrealized as three separate columns", () => {
    const out = html();
    const recon = row(reconciliationOf(out), "Xtb");
    expect(cell(recon, "MT5 Swap")).toBe("-$5,000.00");
    expect(cell(recon, "Statement Swap")).toBe("-$4,500.00");
    expect(cell(recon, "Difference")).toBe("-$500.00");
    expect(cell(recon, "Statement Rows")).toBe("12");

    const mover = row(lpMoversOf(out), "Xtb");
    expect(cell(mover, "Swap (period)")).toBe("-$5,000.00");
    expect(cell(mover, "Unrealized (at send time)")).toBe("-$700.00");
  });

  it("names every unrealized cell as an at-send-time figure, never bare", () => {
    const out = html();
    expect(out).not.toMatch(/data-label="Unrealized"/);
    const labels = [...out.matchAll(/data-label="([^"]*Unrealized[^"]*)"/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label).toContain("at send time");
    // And the column heading a desktop reader sees says it too.
    expect(out).toMatch(/<th width="[^"]*">Unrealized \(at send time\)<\/th>/);
    expect(out).toMatch(/snapshot of accrued swap on positions open when this email was built/);
  });
});

describe("unrealizedSwap is never folded into a period total", () => {
  // The fixture is built so folding it in changes the printed string. If these
  // assertions can pass either way they are worthless, so the arithmetic is
  // spelled out here rather than left implicit.
  const CLIENT_UNREALIZED = -1000 + -2000 + -3000; // -6,000
  const LP_UNREALIZED = -700 + -300; // -1,000

  it("prints the backend's client total, not the total plus the snapshot", () => {
    const out = html();
    expect(CLEAN.clientTotals.totalSwap + CLIENT_UNREALIZED).toBe(-18345.67);
    expect(out).toContain("-$12,345.67");
    expect(out).not.toContain("-$18,345.67");
  });

  it("prints the backend's LP total, not the total plus the snapshot", () => {
    const out = html();
    expect(CLEAN.lpTotals.totalSwap + LP_UNREALIZED).toBe(-10123.45);
    expect(out).toContain("-$9,123.45");
    expect(out).not.toContain("-$10,123.45");
  });

  it("reconciles MT5 against the statement without the snapshot on either side", () => {
    const recon = row(reconciliationOf(html()), "Xtb");
    // -5000 - -4500 = -500. With the -700 snapshot on the MT5 side it would be -1200.
    expect(cell(recon, "Difference")).toBe("-$500.00");
    expect(reconciliationOf(html())).not.toContain("-$1,200.00");
  });

  it("says in the body that the snapshot belongs to no period", () => {
    const out = html();
    expect(out).toMatch(/never added into the period figures above/);
    expect(out).toMatch(/it is a snapshot, it covers no period, and it is never included in any total above/i);
  });
});

// ── dash versus zero ─────────────────────────────────────────────────────────

describe("a missing statement is a dash, a zero statement is 0.00", () => {
  const recon = () => reconciliationOf(html());

  it("renders a dash for an LP with no uploaded statement", () => {
    const r = row(recon(), "Finalto");
    expect(cell(r, "Statement Swap")).toBe("&mdash;");
    expect(cell(r, "Difference")).toBe("&mdash;");
    expect(cell(r, "Statement Rows")).toBe("&mdash;");
  });

  it("renders 0.00 for an LP whose statement genuinely totals zero", () => {
    const r = row(recon(), "Quiet LP");
    expect(cell(r, "Statement Swap")).toBe("$0.00");
    expect(cell(r, "Difference")).toBe("-$1,000.00");
    expect(cell(r, "Statement Rows")).toBe("3");
  });

  it("the two LPs do not render the same thing", () => {
    expect(cell(row(recon(), "Finalto"), "Statement Swap")).not.toBe(cell(row(recon(), "Quiet LP"), "Statement Swap"));
  });

  it("says WHY the unreconcilable LP is a dash, beside the dash", () => {
    const r = row(recon(), "Finalto");
    expect(r).toMatch(/No LP statement has been uploaded for this period/);
    expect(r).toMatch(/<strong>unknown<\/strong>/);
    expect(r).toMatch(/not zero/);
    // The reconcilable LP carries no such excuse.
    expect(row(recon(), "Quiet LP")).not.toMatch(/No LP statement has been uploaded/);
  });

  it("counts the unreconcilable LPs in the caption", () => {
    expect(recon()).toMatch(/<strong>1 of 3 LP\(s\) cannot be reconciled<\/strong>/);
  });

  it("says so plainly when every LP does have a statement", () => {
    const out = reconciliationOf(html({ lps: [LPS[0], LPS[2]], lpTotals: { totalSwap: -6000, accountCount: 2 } }));
    expect(out).toMatch(/All 2 LP\(s\) have a statement covering this week\./);
    expect(out).not.toMatch(/cannot be reconciled/);
  });

  it("puts the unreconcilable LPs first so the row cap cannot drop them", () => {
    const ordered = orderReconciliation(LPS.map(reconcileLp));
    expect(ordered[0].label).toBe("Finalto");
    expect(ordered.slice(1).every((r) => r.difference !== null)).toBe(true);
  });
});

// ── totals come from the backend ─────────────────────────────────────────────

describe("null totals say so rather than being recomputed from rows", () => {
  // The rows sum to a different number from the totals on purpose, so a
  // recomputation is visible rather than a coincidence.
  const ROW_SUM_CLIENTS = "-$8,500.00"; // -7000 + -4000 + 2500
  const ROW_SUM_LPS = "-$9,000.00"; // -5000 + -3000 + -1000

  it("renders the backend's figures when it sends them", () => {
    const out = html();
    expect(out).toContain("-$12,345.67");
    expect(out).toContain("-$9,123.45");
    expect(out).toMatch(/Client Swap \(period\)/);
    expect(out).toMatch(/LP Swap \(period\)/);
  });

  it("says Unavailable and names the missing field when clientTotals is null", () => {
    const out = html({ clientTotals: null });
    expect(out).toMatch(/Backend sent no clientTotals; rows are not summed here/);
    expect(out).toContain("Unavailable");
    expect(out).not.toContain(ROW_SUM_CLIENTS);
  });

  it("says Unavailable and names the missing field when lpTotals is null", () => {
    const out = html({ lpTotals: null });
    expect(out).toMatch(/Backend sent no lpTotals; rows are not summed here/);
    expect(out).not.toContain(ROW_SUM_LPS);
  });

  it("treats a NaN or non-numeric total as absent, not as a figure", () => {
    const out = html({ clientTotals: { totalSwap: "n/a", accountCount: 3 } });
    expect(out).toMatch(/Backend sent no clientTotals/);
    expect(out).not.toContain(ROW_SUM_CLIENTS);
    expect(out).not.toMatch(/NaN/);
  });

  it("neither total is ever a sum of the rows shown beneath it", () => {
    const out = html();
    expect(out).not.toContain(ROW_SUM_CLIENTS);
    expect(out).not.toContain(ROW_SUM_LPS);
  });
});

// ── partial success ──────────────────────────────────────────────────────────

describe("partial-success notes render visibly", () => {
  it("shows skipped API LPs as missing, not as zero", () => {
    const out = html({ skippedApiLpCount: 3 });
    expect(out).toMatch(/Report Completeness/);
    expect(out).toMatch(/API LPs skipped/);
    expect(out).toMatch(/3 API LP\(s\) were never queried/);
    expect(out).toMatch(/is MISSING from every figure below; it is not zero/);
    expect(out).toMatch(/This report is incomplete/);
  });

  it("shows every LP error message", () => {
    const out = html({ lpErrors: ["Xtb: credentials rejected", "Vendor B: socket closed"] });
    expect(out).toMatch(/LP queries failed/);
    expect(out).toMatch(/2 LP\(s\) failed/);
    expect(out).toMatch(/Xtb: credentials rejected; Vendor B: socket closed/);
  });

  it("shows a client panel failure", () => {
    const out = html({ clientPanelError: "MT5 manager timed out" });
    expect(out).toMatch(/Client panel failed/);
    expect(out).toMatch(/MT5 manager timed out/);
    expect(out).toMatch(/the client figures below are missing or incomplete/);
  });

  it("shows all three at once", () => {
    const out = html({ skippedApiLpCount: 2, lpErrors: ["Vendor B: socket closed"], clientPanelError: "MT5 manager timed out" });
    expect(out).toMatch(/API LPs skipped/);
    expect(out).toMatch(/LP queries failed/);
    expect(out).toMatch(/Client panel failed/);
  });

  it("states the all-clear explicitly, so a missing warning cannot pass for none", () => {
    const out = html();
    expect(out).toMatch(/Every LP was queried and both panels returned/);
    expect(out).not.toMatch(/This report is incomplete/);
  });

  it("puts the completeness section above the figures it qualifies", () => {
    const out = html({ skippedApiLpCount: 1 });
    expect(out.indexOf("Report Completeness")).toBeLessThan(out.indexOf("Headline Totals"));
  });
});

// ── the row cap ──────────────────────────────────────────────────────────────

describe("the row cap holds on a large fixture", () => {
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const BIG = {
    lps: many(400, (i) => ({
      id: i,
      login: 9000 + i,
      lpName: `LP ${i}`,
      totalSwap: -(i + 1) * 10,
      unrealizedSwap: -i,
      statementSwap: -(i + 1) * 10 + i,
      statementRowCount: 2,
    })),
    clients: many(600, (i) => ({ login: 20000 + i, name: `Client ${i}`, totalSwap: -(i + 1) * 7, unrealizedSwap: -i })),
  };

  it("caps at SWAPS_ROW_CAP in every table", () => {
    const out = html(BIG);
    expect(SWAPS_ROW_CAP).toBe(15);
    expect(countCells(reconciliationOf(out), "Statement Rows")).toBe(SWAPS_ROW_CAP);
    expect(countCells(lpMoversOf(out), "Unrealized (at send time)")).toBe(SWAPS_ROW_CAP);
    expect(countCells(clientMoversOf(out), "Unrealized (at send time)")).toBe(SWAPS_ROW_CAP);
  });

  it("says how many rows it dropped rather than dropping them silently", () => {
    const out = html(BIG);
    expect(reconciliationOf(out)).toMatch(/385 smaller LP\(s\) omitted/);
    expect(lpMoversOf(out)).toMatch(/Showing 15 of 400 accounts; 385 omitted/);
    expect(clientMoversOf(out)).toMatch(/Showing 15 of 600 accounts; 585 omitted/);
  });

  it("keeps the largest movers, not the first fifteen the backend happened to send", () => {
    const movers = lpMoversOf(html(BIG));
    expect(movers).toContain("LP 399"); // -4,000.00, the biggest
    expect(movers).not.toContain(`<span class="val">LP 0</span>`); // -10.00, the smallest
  });

  it("says so when nothing was dropped", () => {
    expect(lpMoversOf(html())).toMatch(/All 3 account\(s\) shown\./);
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
    expect(out).not.toMatch(/@media/);
    expect(out).not.toMatch(/::(before|after)/);
    expect(out).not.toMatch(/display\s*:\s*(flex|grid)/);
    expect(source).not.toMatch(/::(before|after)/);
  });

  it("emits the shell's document, its light palette and table.data", () => {
    const out = html();
    expect(out).toMatch(/^<!doctype html>/);
    expect(out).toMatch(/background:#f3f7fb/); // light page
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
    for (const out of [html(), html({ skippedApiLpCount: 2, clientPanelError: "boom", lpErrors: ["a & b"] }), html({ lps: [], clients: [] })]) {
      expect(out).not.toMatch(/&amp;(mdash|ndash|minus|nbsp|rsquo|Sigma|amp);/);
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
// names no shell stylesheet defined. A body class with no rule behind it is
// invisible until someone opens the email. This report introduces NO marker
// classes at all -- its two inline-styled cells reuse txt/lbl/val -- so the
// allowed-exception list is empty and must stay that way.
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
    ["with every partial-success note", () => html({ skippedApiLpCount: 2, lpErrors: ["boom"], clientPanelError: "boom" })],
    ["with both totals missing", () => html({ clientTotals: null, lpTotals: null })],
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
  it("keeps a genuinely zero statement and drops an absent one", () => {
    const parsed = parseSwapsReport({ lps: LPS });
    expect(reconcileLp(parsed.lps[1]).statement).toBeNull();
    expect(reconcileLp(parsed.lps[2]).statement).toBe(0);
  });

  it("normalises a junk payload without inventing figures", () => {
    const parsed = parseSwapsReport(null);
    expect(parsed).toEqual({
      clients: [],
      clientTotals: null,
      lps: [],
      lpTotals: null,
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
    expect(report.lps).toHaveLength(3);
    expect(report.clientTotals).toEqual({ totalSwap: -12345.67, accountCount: 3 });
  });
});

// ── nothing is scheduled yet ─────────────────────────────────────────────────

describe("the Swaps report is deliberately not on a cadence yet", () => {
  it("is absent from the scheduler module", () => {
    const schedulers = readFileSync(path.resolve("reports/schedulers.js"), "utf8");
    expect(schedulers).not.toMatch(/swaps/i);
  });
});
