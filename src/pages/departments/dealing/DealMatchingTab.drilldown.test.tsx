// The Client LP Allocation Detail table's per-symbol drilldown, exercised
// through the tab itself: a chevron only where the report actually carried
// per-symbol rows, an expansion that adds child rows without moving the TOTAL,
// and an expansion that is still open after the report is re-run.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { DealMatchingTab } from "./DealMatchingTab";

const BASE = "http://backend.test";

const REPORT = {
  fromDate: "2026-09-01",
  toDate: "2026-09-07",
  totalClientDeals: 2,
  totalCentroidOrders: 2,
  matchedCount: 2,
  clientRevenueSummaries: [
    {
      login: "9001",
      name: "ClientOne",
      group: "real\\A",
      system: "Client",
      lots: 40,
      markupRevenueUsd: 700,
      clientCommissionUsd: 150,
      grossRevenueUsd: 850,
      lpCommissionUsd: 60,
      clientMillionsUsd: 6,
      lpCommPerMillionRateUsd: 10,
      lpCommPerMillionUsd: 60,
      totalRevenueUsd: 790,
    },
  ],
  // S1/Finalto has two symbols; S2/CFH has none, so only S1 gets a chevron.
  clientLpSymbolCommissions: [
    {
      login: "9001",
      lpsid: "S1",
      lpName: "Finalto",
      symbol: "EURUSD",
      tradeCount: 8,
      clientLots: 25,
      clientMillionsUsd: 3,
      coverageSymbolCommissionUsd: 300,
      netLpCommUsd: 34,
      grossRevenueUsd: 500,
    },
    {
      login: "9001",
      lpsid: "S1",
      lpName: "Finalto",
      symbol: "AAPL",
      tradeCount: 4,
      clientLots: 5,
      clientMillionsUsd: 1,
      coverageSymbolCommissionUsd: 0,
      isStock: true,
      netLpCommUsd: 0,
      grossRevenueUsd: 100,
    },
  ],
};

const DETAIL_ROWS = [
  {
    login: "9001",
    lpsid: "S1",
    lpName: "Finalto",
    tradeCount: 12,
    symbols: "EURUSD, AAPL",
    clientLotsPlaced: 30,
    clientMillionsUsd: 4,
    lpLotsSent: 28,
    allocationPct: 60,
    markupRevenueUsd: 500,
    clientCommissionUsd: 100,
    grossRevenueUsd: 600,
    lpCommissionUsd: 40,
  },
  {
    login: "9001",
    lpsid: "S2",
    lpName: "CFH",
    tradeCount: 5,
    symbols: "GBPUSD",
    clientLotsPlaced: 10,
    clientMillionsUsd: 2,
    lpLotsSent: 9,
    allocationPct: 40,
    markupRevenueUsd: 200,
    clientCommissionUsd: 50,
    grossRevenueUsd: 250,
    lpCommissionUsd: 20,
  },
];

function stubFetch() {
  const fetchMock = vi.fn(async (input: any) => {
    const url = String(input);
    const body = url.includes("/DealMatch/ClientRevenueDetail") ? DETAIL_ROWS : REPORT;
    return { ok: true, json: async () => body, text: async () => "" } as any;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Run the report, then open client 9001's LP allocation detail. */
async function runAndOpenClient() {
  fireEvent.click(screen.getByRole("button", { name: "Run Match" }));
  await waitFor(() => screen.getByText("ClientOne"));
  fireEvent.click(screen.getByText("ClientOne").closest("tr")!);
  await waitFor(() => screen.getByLabelText(/per-symbol detail for S1/));
}

/** The detail table's TOTAL bar -- the last of the two on the page (Revenue by
 *  Client renders its own above it). Each bar is identified by its TOTAL badge. */
function totalsBar(): HTMLElement {
  const badges = screen.getAllByText("Total");
  return badges[badges.length - 1].closest("div") as HTMLElement;
}

describe("DealMatchingTab per-symbol drilldown", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("offers a chevron only for a parent that has per-symbol rows", async () => {
    stubFetch();
    render(<DealMatchingTab baseUrl={BASE} />);
    await runAndOpenClient();

    expect(screen.getByLabelText("Expand per-symbol detail for S1")).toBeTruthy();
    // S2 has no rows in clientLpSymbolCommissions, so no control at all.
    expect(screen.queryByLabelText(/per-symbol detail for S2/)).toBeNull();
  });

  it("expands into the per-symbol rows and labels the parent Mixed", async () => {
    stubFetch();
    render(<DealMatchingTab baseUrl={BASE} />);
    await runAndOpenClient();

    expect(screen.queryByText("EURUSD")).toBeNull();
    fireEvent.click(screen.getByLabelText("Expand per-symbol detail for S1"));

    // Symbol cells for the two children, and the chevron flipped to collapse.
    expect(screen.getByText("EURUSD")).toBeTruthy();
    expect(screen.getByText("AAPL")).toBeTruthy();
    expect(screen.getByLabelText("Collapse per-symbol detail for S1")).toBeTruthy();

    // Actual + Stock under one parent, so the parent reads Mixed.
    expect(screen.getByText("Mixed")).toBeTruthy();
    expect(screen.getByText("Actual")).toBeTruthy();
    expect(screen.getByText("Stock")).toBeTruthy();
  });

  it("does not move the TOTAL when a row is expanded", async () => {
    stubFetch();
    render(<DealMatchingTab baseUrl={BASE} />);
    await runAndOpenClient();

    // 30 + 10 client lots, 600 + 250 gross -- parents only.
    expect(within(totalsBar()).getByText("40.00")).toBeTruthy();
    expect(within(totalsBar()).getByText("$850.00")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Expand per-symbol detail for S1"));

    expect(within(totalsBar()).getByText("40.00")).toBeTruthy();
    expect(within(totalsBar()).getByText("$850.00")).toBeTruthy();
  });

  it("keeps the row expanded across a re-run of the report", async () => {
    stubFetch();
    render(<DealMatchingTab baseUrl={BASE} />);
    await runAndOpenClient();

    fireEvent.click(screen.getByLabelText("Expand per-symbol detail for S1"));
    expect(screen.getByText("EURUSD")).toBeTruthy();

    // Re-run: the tab drops the detail rows and refetches everything.
    await runAndOpenClient();

    expect(screen.getByText("EURUSD")).toBeTruthy();
    expect(screen.getByLabelText("Collapse per-symbol detail for S1")).toBeTruthy();
  });
});
