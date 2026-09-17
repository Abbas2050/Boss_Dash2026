// The swaps report is the slowest screen in the dashboard: /api/SwapsReport was
// measured today at over 45 seconds for a SINGLE day and answered 504
// proxy_timeout; commit 67d9f76 raised that route's proxy budget to 180s. Three
// things follow, and each is pinned here.
//
//   1. The `liveFinalto` flag has to reach the query in BOTH states. Off is not
//      "omit the parameter" -- the backend reads it as a cache-bypass switch and
//      a missing parameter is a different request from `liveFinalto=false`.
//   2. A timeout must render as "the report took too long", naming the range, and
//      NOT as a generic failure. An operator told "something went wrong" goes
//      looking for a bug; an operator told the window was too wide narrows it.
//   3. The totals must keep coming from the backend's own clientTotals/lpTotals.
//      A decoy figure is planted on the payload below precisely so a test that
//      merely finds "some number on screen" cannot pass.
//
// The drilldowns are asserted on their reference column names, because those
// names are the contract with temporay_for_reference_pages/swaps-report 1.html;
// and the three swap sources (MT5 closed-deal Storage, MT5 open-position accrued
// swap, LP Statement DB) must stay separately labelled, since the whole point of
// the panel is that they disagree.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { SwapsReportTab } from "./SwapsReportTab";
import { formatDubaiInstant } from "@/lib/dubaiTime";

const SESSION_KEY = "slc.session.v2";
const TOKEN = "test.session.jwt";

const CLIENT_ROW = {
  login: 101,
  name: "Alpha Client",
  source: "Live",
  totalSwap: -12.5,
  unrealizedSwap: -3.25,
  dealVolume: 3,
  realizedVolume: 2,
};

const LP_ROW = {
  id: 55,
  login: 900,
  lpName: "Finalto",
  source: "Api",
  totalSwap: 41.5,
  unrealizedSwap: 7.75,
  statementSwap: 39.25,
  statementRowCount: 4,
  dealVolume: 1,
  realizedVolume: 1,
};

const REPORT = {
  clients: [CLIENT_ROW],
  clientTotals: { totalSwap: -12.5, accountCount: 1 },
  lps: [LP_ROW],
  lpTotals: { totalSwap: 41.5, accountCount: 1 },
  // A decoy. If a totals line is ever rebuilt from a different LP figure, it
  // will land on one of these and the unchanged-totals test below stops passing.
  lpCommTotals: { totalSwap: 777.77, accountCount: 9 },
  statementTotals: { totalSwap: 888.88, accountCount: 8 },
};

const CLIENT_DETAIL = {
  isFinalto: false,
  totalSwap: -12.5,
  openSwapAccrued: -3.25,
  dealVolume: 3,
  realizedVolume: 2,
  positions: [
    {
      positionId: 5001,
      symbol: "EURUSD",
      dealCount: 2,
      totalSwap: -12.5,
      dealVolume: 3,
      realizedVolume: 2,
      firstDealUnixSec: 1756761755,
      lastDealUnixSec: 1756848155,
    },
  ],
  deals: [
    {
      dealId: 9001,
      timeUtc: "2026-09-01 21:22:35",
      positionId: 5001,
      symbol: "EURUSD",
      action: "Buy",
      entry: "Out",
      lots: 1.5,
      closedLegLots: 1.5,
      storage: -6.25,
    },
  ],
  openPositions: [
    { ticket: 7001, symbol: "XAUUSD", type: "Buy", lots: 0.5, timeCreateUtc: "2026-09-02 04:00:00", swap: -3.25, profit: 12.0 },
  ],
};

const LP_FINALTO_DETAIL = {
  isFinalto: true,
  totalSwap: 41.5,
  openSwapAccrued: 0,
  dealVolume: 0,
  realizedVolume: 0,
  positions: [],
  deals: [],
  openPositions: [],
  finaltoDailyCosts: [
    {
      subAccountId: 12,
      instrument: "GER40",
      tradeDate: "2026-09-01",
      longPosCost: 20.25,
      shortPosCost: 21.25,
      total: 41.5,
      eodRate: 0.000123,
    },
  ],
};

type Call = { url: string; init: RequestInit | undefined };

/**
 * Routes by URL rather than by call order: the report and the two drilldowns hit
 * different paths, and order-based stubs silently pass when a component fetches
 * the wrong one.
 */
function installFetch(opts: {
  report?: unknown;
  reportStatus?: number;
  reportBody?: string;
  clientDetail?: unknown;
  lpDetail?: unknown;
}): Call[] {
  const calls: Call[] = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.includes("/api/SwapsReport/client/")) {
      return { ok: true, status: 200, json: async () => opts.clientDetail ?? {}, text: async () => "" } as unknown as Response;
    }
    if (u.includes("/api/SwapsReport/lp-by-id/")) {
      return { ok: true, status: 200, json: async () => opts.lpDetail ?? {}, text: async () => "" } as unknown as Response;
    }
    const status = opts.reportStatus ?? 200;
    if (status !== 200) {
      return {
        ok: false,
        status,
        json: async () => ({}),
        text: async () => opts.reportBody ?? "",
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => opts.report ?? REPORT, text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function run() {
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
}

function reportCall(calls: Call[]): Call {
  const call = calls.find((c) => /\/api\/SwapsReport\?/.test(c.url));
  if (!call) throw new Error(`no /api/SwapsReport call was made; saw: ${calls.map((c) => c.url).join(", ")}`);
  return call;
}

beforeEach(() => {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      token: TOKEN,
      user: { id: "u1", name: "T", email: "t@t", role: "Super Admin", access: [], status: "active" },
      at: Date.now(),
    }),
  );
  // Every backend-triggering action on this tab confirms first. Auto-accepting
  // here keeps the assertions about the REQUEST, not about the dialog.
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the liveFinalto flag reaches the query", () => {
  it("sends liveFinalto=false when the box is unchecked", async () => {
    const calls = installFetch({});
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getAllByText("Alpha Client").length).toBeGreaterThan(0));
    expect(reportCall(calls).url).toContain("liveFinalto=false");
  });

  it("sends liveFinalto=true when the box is checked", async () => {
    const calls = installFetch({});
    render(<SwapsReportTab />);
    fireEvent.click(screen.getByLabelText("Raw Finalto (bypass DB cache)"));
    run();
    await waitFor(() => expect(screen.getAllByText("Alpha Client").length).toBeGreaterThan(0));
    expect(reportCall(calls).url).toContain("liveFinalto=true");
  });

  // The proxy prefix is not cosmetic: a bare /api/SwapsReport is answered by the
  // SPA catch-all with HTTP 200 and index.html, which renders as a blank report.
  it("goes through the same-origin proxy prefix and carries the session bearer", async () => {
    const calls = installFetch({});
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getAllByText("Alpha Client").length).toBeGreaterThan(0));
    const call = reportCall(calls);
    expect(call.url.startsWith("/api/backend/api/SwapsReport?")).toBe(true);
    expect((call.init?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  // Nothing fires until Run is pressed. A report that costs minutes of backend
  // work must not be spent by a tab becoming visible.
  it("does not fetch on mount", () => {
    const calls = installFetch({});
    render(<SwapsReportTab />);
    expect(calls).toEqual([]);
    expect(screen.getByText(/Not run yet/)).toBeTruthy();
  });
});

describe("a timeout is its own state, naming the range", () => {
  it("renders the slow-report state for a 504 proxy_timeout, not a generic error", async () => {
    installFetch({ reportStatus: 504, reportBody: "proxy_timeout" });
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getByText("The report took too long.")).toBeTruthy());

    // The range is what the operator has to change, so it has to be on screen.
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    expect(screen.getByText(new RegExp(`${fmt(monthStart)} → ${fmt(today)}`))).toBeTruthy();
    expect(screen.getByText(/180-second budget/)).toBeTruthy();
  });

  it("keeps not-authorised, timeout and other failures apart", async () => {
    installFetch({ reportStatus: 401, reportBody: "invalid_token" });
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getByText("Not authorised to read the swaps report.")).toBeTruthy());
    expect(screen.queryByText("The report took too long.")).toBeNull();

    cleanup();
    installFetch({ reportStatus: 500, reportBody: "boom" });
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getByText(/returned HTTP 500/)).toBeTruthy());
    expect(screen.queryByText("The report took too long.")).toBeNull();
    expect(screen.queryByText("Not authorised to read the swaps report.")).toBeNull();
  });

  it("a report that ran and found nothing is not a failure", async () => {
    installFetch({ report: { clients: [], clientTotals: { totalSwap: 0, accountCount: 0 }, lps: [], lpTotals: { totalSwap: 0, accountCount: 0 } } });
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getByText(/returned no swap activity/)).toBeTruthy());
    expect(screen.queryByText("The report took too long.")).toBeNull();
    expect(screen.queryByText("Not authorised to read the swaps report.")).toBeNull();
  });

  // No client-side retry: a second three-minute call is the same wait again.
  it("does not retry a timed-out report", async () => {
    const calls = installFetch({ reportStatus: 504, reportBody: "proxy_timeout" });
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getByText("The report took too long.")).toBeTruthy());
    expect(calls.filter((c) => /\/api\/SwapsReport\?/.test(c.url))).toHaveLength(1);
  });
});

describe("the three swap sources stay distinguishable", () => {
  it("labels MT5 closed-deal Storage, MT5 open-position accrual and the LP Statement DB separately", async () => {
    installFetch({});
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getAllByText("Finalto").length).toBeGreaterThan(0));

    expect(screen.getAllByText("Realized Swap (Coverage acc)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Unrealized Swap (Coverage acc)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Swap (Statement DB)").length).toBeGreaterThan(0);

    // and the three figures render as three different numbers
    expect(screen.getAllByText("$41.50").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$7.75").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$39.25").length).toBeGreaterThan(0);
  });
});

// The backend sends statementSwap: 0 with statementRowCount: 0 when no
// statement was uploaded -- never null. Observed live on 2026-09-17 on all 43
// LPs of the 2026-09-05..11 week. A null check alone printed "$0.00" in the
// Statement DB column for every one of them, which reads as "the statement says
// zero" when there is no statement at all.
describe("a statement exists only when statementRowCount > 0", () => {
  const lpWith = (statementSwap: number | null, statementRowCount: number | null) => ({
    ...REPORT,
    lps: [{ ...LP_ROW, statementSwap, statementRowCount }],
  });

  it("shows no statement figure for a zero with no rows behind it", async () => {
    installFetch({ report: lpWith(0, 0) });
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getAllByText("Finalto").length).toBeGreaterThan(0));
    // No other cell in this payload can print $0.00, so any occurrence is the
    // Statement DB column claiming a statement that does not exist.
    expect(screen.queryAllByText("$0.00")).toHaveLength(0);
  });

  it("shows no statement figure for a non-zero value with no rows behind it", async () => {
    installFetch({ report: lpWith(-500, null) });
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getAllByText("Finalto").length).toBeGreaterThan(0));
    expect(screen.queryAllByText("-$500.00")).toHaveLength(0);
  });

  it("shows a genuine zero statement as $0.00", async () => {
    installFetch({ report: lpWith(0, 2) });
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getAllByText("Finalto").length).toBeGreaterThan(0));
    expect(screen.getAllByText("$0.00").length).toBeGreaterThan(0);
  });
});

describe("the totals still come from the backend", () => {
  it("renders clientTotals and lpTotals unchanged, and not a neighbouring figure", async () => {
    installFetch({});
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getAllByText("Alpha Client").length).toBeGreaterThan(0));

    expect(screen.getAllByText("-$12.50").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$41.50").length).toBeGreaterThan(0);

    // The decoys planted on the payload must never surface.
    expect(screen.queryByText("$777.77")).toBeNull();
    expect(screen.queryByText("$888.88")).toBeNull();
  });

  it("says so when the backend omits a totals block, instead of deriving one", async () => {
    installFetch({ report: { clients: [CLIENT_ROW], lps: [LP_ROW] } });
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getAllByText(/Totals unavailable/).length).toBe(2));
  });
});

describe("the drilldowns render their reference columns", () => {
  it("a client row opens the per-position, per-deal and open-position breakdown", async () => {
    installFetch({ clientDetail: CLIENT_DETAIL });
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getAllByText("Alpha Client").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByText("Alpha Client")[0]);
    await waitFor(() => expect(screen.getByText(/Client 101/)).toBeTruthy());

    for (const label of ["Deal Count", "Deal Volume", "Realized Volume", "First (UTC)", "Last (UTC)"]) {
      expect(screen.getAllByText(label).length, `position column "${label}" is missing`).toBeGreaterThan(0);
    }
    for (const label of ["Closed-Leg Lots", "Storage (Swap)", "Time (UTC)"]) {
      expect(screen.getAllByText(label).length, `deal column "${label}" is missing`).toBeGreaterThan(0);
    }
    for (const label of ["Swap (accrued)", "Opened (UTC)"]) {
      expect(screen.getAllByText(label).length, `open-position column "${label}" is missing`).toBeGreaterThan(0);
    }
  });

  it("an LP row opens the Finalto per-instrument per-day breakdown", async () => {
    installFetch({ lpDetail: LP_FINALTO_DETAIL });
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getAllByText("Finalto").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByText("Finalto")[0]);
    await waitFor(() => expect(screen.getByText(/LP Finalto \(900\)/)).toBeTruthy());

    for (const label of ["Sub-account", "Instrument", "Trade Date (UTC)", "Long Pos Cost", "Short Pos Cost", "Total", "EOD Rate"]) {
      expect(screen.getAllByText(label).length, `Finalto column "${label}" is missing`).toBeGreaterThan(0);
    }
    // A calendar day, left exactly as the vendor booked it -- a timezone shift
    // here would move the cost into the neighbouring day's bucket.
    expect(screen.getAllByText("2026-09-01").length).toBeGreaterThan(0);
  });

  it("says when Finalto returned no cost rows, rather than showing an empty grid", async () => {
    installFetch({ lpDetail: { ...LP_FINALTO_DETAIL, finaltoDailyCosts: [] } });
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getAllByText("Finalto").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("Finalto")[0]);
    await waitFor(() => expect(screen.getAllByText(/check LP credentials/).length).toBeGreaterThan(0));
  });
});

describe("partial-success notes are surfaced", () => {
  it("reports skipped API LPs and per-LP failures", async () => {
    installFetch({
      report: { ...REPORT, skippedApiLpCount: 2, lpErrors: ["Xtb: bad credentials"], clientPanelError: "client query failed" },
    });
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getByText(/2 API LP\(s\) skipped/)).toBeTruthy());
    expect(screen.getByText(/Xtb: bad credentials/)).toBeTruthy();
    expect(screen.getByText(/client query failed/)).toBeTruthy();
  });
});

describe("instants render in Dubai wall-clock", () => {
  it("renders a zone-less MT5 deal time as a Dubai instant, not the viewer's local clock", async () => {
    installFetch({ clientDetail: CLIENT_DETAIL });
    render(<SwapsReportTab />);
    run();
    await waitFor(() => expect(screen.getAllByText("Alpha Client").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("Alpha Client")[0]);
    await waitFor(() => expect(screen.getByText(/Client 101/)).toBeTruthy());

    // 21:22:35 UTC on Sep 1 is 01:22:35 on Sep 2 in Dubai (UTC+4). The backend
    // sent that instant WITHOUT a zone marker, which is the case a naive
    // `new Date(str)` renders in the viewer's own timezone instead.
    const dubai = formatDubaiInstant("2026-09-01T21:22:35Z");
    expect(dubai).toContain("01:22:35");
    expect(screen.getAllByText(dubai).length).toBeGreaterThan(0);
  });
});
