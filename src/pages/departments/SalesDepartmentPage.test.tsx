// The Sales commission page. jsdom is the project default, so no environment
// comment, and Express is never booted -- `fetch` is mocked.
//
// What these tests are really defending:
//
//   1. The page renders from the `scope` the SERVER sent, never from the local
//      role. Roles live in localStorage, so a page that read one would hand a
//      salesperson every figure the response happened to carry. The self-scope
//      payloads below are therefore POLLUTED with revenue fields the real
//      server never sends, and the session is set to Super Admin while they are
//      rendered: a page that trusts either one fails here.
//   2. Commission is CFD lots and nothing else. The payloads carry a 300 in
//      `lots` and a 240 in `stocksLots` beside a 30.5 in `cfdLots`, so paying
//      on the wrong field shows up as a wrong dollar figure rather than as a
//      subtly different one.
//   3. A failed revenue fetch is NOT zero revenue, an unjoined client's margin
//      is marked, and the backend's own warnings reach the screen.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SalesDepartmentPage } from "./SalesDepartmentPage";

const SESSION_KEY = "slc.session.v2";

const RANGE = { from: "2026-10-01", to: "2026-10-26" };
const RATE = { usdPerCfdLot: 1, basis: "cfdLots" };
const WINDOW = { fromDate: "2026-10-01", toDate: "2026-10-26", activeDays: 20 };

/** Mitul's one client: 300 lots, 240 of them stocks, 30.5 CFD. Only the 30.5 is paid. */
const DAWEI = {
  crmUserId: 4211,
  name: "Dawei Huang",
  logins: ["10218", "10377"],
  lots: 300,
  stocksLots: 240,
  cfdLots: 30.5,
  commissionUsd: 30.5,
  revenueUsd: 3120.44,
  marginAfterCommissionUsd: 3089.94,
  revenueMatched: true,
  revenueRowCount: 1,
};

/** Aditya's one client: traded CFD lots, matched no revenue row. */
const UNJOINED = {
  crmUserId: 5120,
  name: "Priya Shah",
  logins: ["10500"],
  lots: 40,
  stocksLots: 0,
  cfdLots: 11.25,
  commissionUsd: 11.25,
  revenueUsd: 0,
  marginAfterCommissionUsd: -11.25,
  revenueMatched: false,
  revenueRowCount: 0,
};

const MISSING_REVENUE_WARNING =
  "1 client(s) traded CFD lots but matched no revenue row; their revenue reads 0 and the margin beside it is understated.";

const SUPER_ADMIN_REPORT = {
  scope: "all",
  range: RANGE,
  rate: RATE,
  totals: {
    lots: 340,
    stocksLots: 240,
    cfdLots: 41.75,
    commissionUsd: 41.75,
    revenueUsd: 3120.44,
    marginAfterCommissionUsd: 3078.69,
  },
  salespeople: [
    {
      managerId: 28,
      name: "Mitul Kapadia",
      clientCount: 1,
      tradingClientCount: 1,
      lots: 300,
      stocksLots: 240,
      cfdLots: 30.5,
      commissionUsd: 30.5,
      revenueUsd: 3120.44,
      marginAfterCommissionUsd: 3089.94,
      clients: [DAWEI],
    },
    {
      managerId: 23,
      name: "Aditya",
      clientCount: 1,
      tradingClientCount: 1,
      lots: 40,
      stocksLots: 0,
      cfdLots: 11.25,
      commissionUsd: 11.25,
      revenueUsd: 0,
      marginAfterCommissionUsd: -11.25,
      clients: [UNJOINED],
    },
    // An empty book. The server always sends all three, and this one must
    // render as zeros rather than vanish.
    {
      managerId: 20,
      name: "Smit",
      clientCount: 0,
      tradingClientCount: 0,
      lots: 0,
      stocksLots: 0,
      cfdLots: 0,
      commissionUsd: 0,
      revenueUsd: 0,
      marginAfterCommissionUsd: 0,
      clients: [],
    },
  ],
  join: {
    volumeRowCount: 3,
    volumeRowsMatched: 3,
    volumeRowsOutOfScope: 0,
    clientsWithNoActivity: 0,
    warnings: [MISSING_REVENUE_WARNING],
    volumeWindow: WINDOW,
    revenueRowCount: 1,
    revenueRowsMatched: 1,
    revenueRowsNotMatchedToScope: 0,
    clientsMissingRevenue: 1,
    clientsWithMultipleRevenueRows: 0,
  },
  revenue: { available: true },
  degraded: [],
};

/**
 * A salesperson's payload, with every revenue key the real server strips put
 * back as a decoy -- including `revenue.available` and a six-figure revenue
 * total. The server never sends these. They are here so that a page which
 * renders "whatever arrived", or which decides from the local role, prints a
 * figure this caller may not see and fails the test.
 */
const SELF_REPORT_WITH_DECOY_REVENUE = {
  scope: "self",
  managerId: 23,
  range: RANGE,
  rate: RATE,
  totals: {
    lots: 40,
    stocksLots: 240,
    cfdLots: 11.25,
    commissionUsd: 11.25,
    revenueUsd: 999999.99,
    marginAfterCommissionUsd: 888888.88,
  },
  salespeople: [
    {
      managerId: 23,
      name: "Aditya",
      clientCount: 2,
      tradingClientCount: 1,
      lots: 40,
      stocksLots: 240,
      cfdLots: 11.25,
      commissionUsd: 11.25,
      revenueUsd: 999999.99,
      marginAfterCommissionUsd: 888888.88,
      clients: [
        {
          ...UNJOINED,
          revenueUsd: 777777.77,
          marginAfterCommissionUsd: 666666.66,
        },
      ],
    },
  ],
  join: {
    volumeRowCount: 3,
    volumeRowsMatched: 1,
    volumeRowsOutOfScope: 2,
    clientsWithNoActivity: 1,
    warnings: [],
    volumeWindow: WINDOW,
  },
  revenue: { available: true },
  degraded: [],
};

/** Revenue fetch failed: every revenue key absent, commission untouched. */
const DEGRADED_REPORT = {
  scope: "all",
  range: RANGE,
  rate: RATE,
  totals: { lots: 340, stocksLots: 240, cfdLots: 41.75, commissionUsd: 41.75 },
  salespeople: [
    {
      managerId: 28,
      name: "Mitul Kapadia",
      clientCount: 1,
      tradingClientCount: 1,
      lots: 300,
      stocksLots: 240,
      cfdLots: 30.5,
      commissionUsd: 30.5,
      clients: [
        {
          crmUserId: 4211,
          name: "Dawei Huang",
          logins: ["10218"],
          lots: 300,
          stocksLots: 240,
          cfdLots: 30.5,
          commissionUsd: 30.5,
        },
      ],
    },
  ],
  join: {
    volumeRowCount: 3,
    volumeRowsMatched: 3,
    volumeRowsOutOfScope: 0,
    clientsWithNoActivity: 0,
    warnings: [],
    volumeWindow: WINDOW,
  },
  revenue: { available: false, reason: "fetch_failed" },
  degraded: ["revenue"],
};

const urls: string[] = [];

function installFetch(payload: unknown = SUPER_ADMIN_REPORT, status = 200) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** The session is irrelevant to this page by design, which is exactly why every
 *  test sets one: Super Admin unless a test says otherwise. */
function setSession(role: string, crmManagerId?: number) {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      token: "test.session.jwt",
      user: { id: "u1", name: "T", email: "t@t", role, access: [], status: "active", crmManagerId },
      at: Date.now(),
    }),
  );
}

const money = (text: string) => screen.queryAllByText(text);

beforeEach(() => {
  urls.length = 0;
  setSession("Super Admin");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the range picker", () => {
  it("defaults to the current month and asks the server for it", async () => {
    installFetch();
    render(<SalesDepartmentPage />);
    await screen.findByText(/per salesperson/i);

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const first = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    expect(urls[0]).toContain(`from=${first}`);
    expect(urls[0]).toContain(`to=${today}`);
    expect(urls[0]).toContain("/api/sales/commission");
  });

  it("refetches for the dates typed into it, and only on Apply", async () => {
    installFetch();
    render(<SalesDepartmentPage />);
    await screen.findByText(/per salesperson/i);
    expect(urls).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-30" } });
    // Typing alone must not launch a 40-second report.
    expect(urls).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /apply/i }));
    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[1]).toContain("from=2026-09-01");
    expect(urls[1]).toContain("to=2026-09-30");
  });
});

describe('a Super Admin (scope: "all")', () => {
  it("shows all three salespeople, the empty book included", async () => {
    installFetch();
    render(<SalesDepartmentPage />);
    await screen.findByText("Mitul Kapadia");
    expect(screen.getByText("Aditya")).toBeInTheDocument();
    expect(screen.getByText("Smit")).toBeInTheDocument();
  });

  it("renders an empty book as zeros rather than leaving it out", async () => {
    installFetch();
    render(<SalesDepartmentPage />);
    const card = await screen.findByTestId("sales-card-20");
    expect(within(card).getAllByText("0.00").length).toBeGreaterThan(0);
    expect(within(card).getAllByText("$0.00").length).toBeGreaterThan(0);
  });

  it("shows revenue earned and margin after commission", async () => {
    installFetch();
    render(<SalesDepartmentPage />);
    await screen.findByText("Mitul Kapadia");
    expect(screen.getAllByText(/revenue earned/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/margin after commission/i).length).toBeGreaterThan(0);
    expect(money("$3,120.44").length).toBeGreaterThan(0);
    expect(money("$3,089.94").length).toBeGreaterThan(0);
  });

  it("expands a salesperson to their client rows", async () => {
    installFetch();
    render(<SalesDepartmentPage />);
    await screen.findByText("Mitul Kapadia");
    expect(screen.queryByTestId("sales-client-4211")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /show mitul kapadia's clients/i }));
    const row = await screen.findByTestId("sales-client-4211");
    expect(within(row).getByText("Dawei Huang")).toBeInTheDocument();
    // The logins are the join key, and a multi-account client has more than one.
    expect(within(row).getByText(/10218, 10377/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /hide mitul kapadia's clients/i }));
    expect(screen.queryByTestId("sales-client-4211")).toBeNull();
  });
});

describe("commission is CFD lots and nothing else", () => {
  it("pays on cfdLots, not on lots or stocksLots", async () => {
    installFetch();
    render(<SalesDepartmentPage />);
    await screen.findByText("Mitul Kapadia");
    // 30.5 CFD lots at $1 is $30.50, beside 300 lots and 240 stocks lots.
    expect(money("$30.50").length).toBeGreaterThan(0);
    expect(money("$300.00")).toHaveLength(0);
    expect(money("$240.00")).toHaveLength(0);
    // Totals too: 41.75 CFD lots, not 340 lots.
    expect(within(screen.getByTestId("total-commission")).getByText("$41.75")).toBeInTheDocument();
    expect(money("$340.00")).toHaveLength(0);
  });

  it("labels the unpaid lot columns as unpaid, in text", async () => {
    installFetch();
    render(<SalesDepartmentPage />);
    await screen.findByText("Mitul Kapadia");
    // Someone reading a 240 in stocks lots as $240 owed is the misreading this
    // wording exists to stop, so it is on the page and not in a tooltip.
    expect(screen.getAllByText(/all lots \(not paid\)/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/stocks lots \(not paid\)/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/cfd lots \(paid on\)/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/never paid on/i)).toBeInTheDocument();
  });

  it("prints the server's commissionUsd rather than recomputing one", async () => {
    // A decoy: the server is the only authority on the figure, and a page that
    // multiplied lots by the rate itself would print $30.50 here.
    installFetch({
      ...SUPER_ADMIN_REPORT,
      totals: { ...SUPER_ADMIN_REPORT.totals, commissionUsd: 99.99 },
      salespeople: [{ ...SUPER_ADMIN_REPORT.salespeople[0], commissionUsd: 77.77 }],
    });
    render(<SalesDepartmentPage />);
    await screen.findByText("Mitul Kapadia");
    expect(within(screen.getByTestId("total-commission")).getByText("$99.99")).toBeInTheDocument();
    expect(money("$77.77").length).toBeGreaterThan(0);
  });
});

describe('a salesperson (scope: "self")', () => {
  it("is shown no revenue figure at all, even when the payload carries one and the local role says Super Admin", async () => {
    setSession("Super Admin");
    installFetch(SELF_REPORT_WITH_DECOY_REVENUE);
    render(<SalesDepartmentPage />);
    await screen.findByText(/your clients/i);

    // Not one of the decoys reaches the screen.
    expect(money("$999,999.99")).toHaveLength(0);
    expect(money("$888,888.88")).toHaveLength(0);
    expect(money("$777,777.77")).toHaveLength(0);
    expect(money("$666,666.66")).toHaveLength(0);
    // Nor does the word, in a column header, a card label or a banner.
    expect(screen.queryAllByText(/revenue/i)).toHaveLength(0);
    expect(screen.queryAllByText(/margin/i)).toHaveLength(0);
  });

  it("shows their own clients and their own total", async () => {
    installFetch(SELF_REPORT_WITH_DECOY_REVENUE);
    render(<SalesDepartmentPage />);
    await screen.findByText(/your clients/i);
    expect(screen.getByTestId("sales-client-5120")).toBeInTheDocument();
    expect(within(screen.getByTestId("total-commission")).getByText("$11.25")).toBeInTheDocument();
    expect(within(screen.getByTestId("total-cfd-lots")).getByText("11.25")).toBeInTheDocument();
  });

  it("says nothing about any other salesperson", async () => {
    installFetch(SELF_REPORT_WITH_DECOY_REVENUE);
    render(<SalesDepartmentPage />);
    await screen.findByText(/your clients/i);
    // The server sends one entry; the page has no roster of its own to fill in
    // the other two from.
    expect(screen.queryByText("Mitul Kapadia")).toBeNull();
    expect(screen.queryByText("Smit")).toBeNull();
    expect(screen.queryByText("Dawei Huang")).toBeNull();
    expect(screen.queryByTestId("sales-card-28")).toBeNull();
    expect(screen.queryByTestId("sales-clients-28")).toBeNull();
  });

  it("shows the all-salespeople view when the SERVER says so, whatever the local role is", async () => {
    // The mirror image of the test above: a local role of "Analyst" must not
    // suppress what the server decided to send.
    setSession("Analyst", 23);
    installFetch();
    render(<SalesDepartmentPage />);
    await screen.findByText("Mitul Kapadia");
    expect(screen.getByText("Smit")).toBeInTheDocument();
    expect(screen.getAllByText(/revenue earned/i).length).toBeGreaterThan(0);
  });
});

describe('degraded: ["revenue"]', () => {
  it("says commission is still exact and revenue is missing, not zero", async () => {
    installFetch(DEGRADED_REPORT);
    render(<SalesDepartmentPage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/revenue could not be loaded/i);
    expect(alert).toHaveTextContent(/commission below is still exact/i);
    expect(alert).toHaveTextContent(/missing, not zero/i);
  });

  it("renders no revenue figure as zero", async () => {
    installFetch(DEGRADED_REPORT);
    render(<SalesDepartmentPage />);
    await screen.findByText("Mitul Kapadia");
    // $0.00 revenue would read as "we earned nothing from this client", which
    // makes the commission look like a pure loss. There is no revenue figure.
    expect(within(screen.getByTestId("total-revenue")).getByText(/unavailable/i)).toBeInTheDocument();
    expect(within(screen.getByTestId("total-revenue")).queryByText("$0.00")).toBeNull();
    expect(within(screen.getByTestId("total-margin")).getByText(/unavailable/i)).toBeInTheDocument();
    expect(within(screen.getByTestId("total-margin")).queryByText("$0.00")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /show mitul kapadia's clients/i }));
    const row = await screen.findByTestId("sales-client-4211");
    expect(within(row).getAllByText(/unavailable/i).length).toBe(2);
    expect(within(row).queryByText("$0.00")).toBeNull();
    // And the commission beside it is untouched.
    expect(within(row).getByText("$30.50")).toBeInTheDocument();
  });
});

describe("revenueMatched: false", () => {
  it("marks the client whose margin is understated", async () => {
    installFetch();
    render(<SalesDepartmentPage />);
    await screen.findByText("Aditya");
    fireEvent.click(screen.getByRole("button", { name: /show aditya's clients/i }));
    const row = await screen.findByTestId("sales-client-5120");
    expect(within(row).getByText(/revenue not matched/i)).toBeInTheDocument();
    expect(within(row).getByText(/margin understated/i)).toBeInTheDocument();
  });

  it("leaves a matched client unmarked", async () => {
    installFetch();
    render(<SalesDepartmentPage />);
    await screen.findByText("Mitul Kapadia");
    fireEvent.click(screen.getByRole("button", { name: /show mitul kapadia's clients/i }));
    const row = await screen.findByTestId("sales-client-4211");
    expect(within(row).queryByText(/revenue not matched/i)).toBeNull();
  });
});

describe("what the backend said about its own answer", () => {
  it("surfaces join.warnings verbatim", async () => {
    installFetch();
    render(<SalesDepartmentPage />);
    // Plain English written for a human; it is not summarised or swallowed.
    expect(await screen.findByText(MISSING_REVENUE_WARNING)).toBeInTheDocument();
  });

  it("prints the window the lots actually cover", async () => {
    installFetch();
    render(<SalesDepartmentPage />);
    expect(await screen.findByText(/lots cover 2026-10-01 → 2026-10-26 \(20 active days\)/i)).toBeInTheDocument();
  });

  it("says so when that window is not the one asked for", async () => {
    // §2 records ClientVolume answering six days for a seven-day week. A
    // dropped day is a day of somebody's lots.
    installFetch({
      ...SUPER_ADMIN_REPORT,
      join: {
        ...SUPER_ADMIN_REPORT.join,
        volumeWindow: { fromDate: "2026-10-02", toDate: "2026-10-25", activeDays: 18 },
      },
    });
    render(<SalesDepartmentPage />);
    expect(await screen.findByText(/a different window from the one asked for/i)).toBeInTheDocument();
    expect(screen.getByText(/lots cover 2026-10-02 → 2026-10-25/i)).toBeInTheDocument();
  });
});

describe("when the server refuses or fails", () => {
  it("explains a 403 instead of showing an empty page", async () => {
    installFetch({ error: "forbidden" }, 403);
    render(<SalesDepartmentPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/will not release commission figures/i);
    expect(screen.queryByTestId("total-commission")).toBeNull();
  });

  it("explains a dead volume service rather than printing zeros", async () => {
    installFetch({ error: "volume_unavailable" }, 502);
    render(<SalesDepartmentPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/rather than a page of zeroes/i);
    expect(screen.queryByTestId("total-commission")).toBeNull();
  });

  it("explains a range the server rejected", async () => {
    installFetch({ error: "range_too_long" }, 400);
    render(<SalesDepartmentPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/longer than 366 days/i);
  });

  it("treats a body that is not a commission report as a failed load", async () => {
    // A proxy's empty body rendered as a report would build a calm-looking page
    // of zeroes out of nothing, and a zero here is a wage.
    installFetch({ ok: true });
    render(<SalesDepartmentPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);
    expect(screen.queryByTestId("total-commission")).toBeNull();
  });
});
