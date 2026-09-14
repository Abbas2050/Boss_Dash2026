// Finalto Admin: the three read endpoints, the one endpoint that makes the
// backend go and do work, the three load outcomes, and the two signals an
// operator opens this page for.
//
// Two hazards are pinned here per request rather than once in aggregate:
//
//   1. URL. Three settings pages on this project spent weeks fetching a BARE
//      "/api/<route>" path. On a single-page app that is not a 404 -- the SPA
//      catch-all answers with index.html and HTTP 200, so the page renders
//      empty and nobody reports it. Every request must carry
//      "/api/backend/api/...": /api/backend is our proxy and /api/Finalto (or
//      /api/admin/finalto-tester) is the backend's own path under it.
//   2. Auth. /api/backend sits behind the deny-by-default gate in
//      auth/requireSession.js, so a call that reaches the right URL without the
//      dashboard JWT 401s on OUR server. A session is seeded into localStorage
//      below precisely so authHeaders() returns a real Bearer and these
//      assertions can fail -- with no session it returns {} and would pass
//      vacuously.
//
// The third is that Backfill triggers work on the server. It must never fire on
// mount and never without a confirmation that states the window.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { FinaltoAdminPage } from "./FinaltoAdminPage";
import { formatDubaiInstant } from "@/lib/dubaiTime";

const FINALTO_URL = "/api/backend/api/Finalto";
const TESTER_ACCOUNTS_URL = "/api/backend/api/admin/finalto-tester/accounts";
const SESSION_KEY = "slc.session.v2";
const TOKEN = "test.session.jwt";
const EXPECTED_AUTH = `Bearer ${TOKEN}`;

/** The same UTC-calendar arithmetic the page uses for its default window. */
function isoDateAddDays(days: number): string {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() + days);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

const YESTERDAY = isoDateAddDays(-1);

// 21:22 UTC on the 1st is 01:22 on the 2nd in Dubai (UTC+4), so a helper-less
// render cannot accidentally agree with a helper-based one here.
const OK_RUN_UTC = "2026-09-01T21:22:35Z";
const FAILED_RUN_UTC = "2026-09-13T20:40:11Z";
const INGESTED_UTC = "2026-09-01T21:22:35Z";

// Captured live from the backend with an admin session: six rows, one per
// ingest domain.
const STATUS = [
  {
    lpAccountId: 52,
    lpName: "Finalto Prime",
    domain: "Trades",
    lastSucceededCoveredDate: "2026-09-12",
    lastRunCompletedAtUtc: OK_RUN_UTC,
    lastRunStatus: "Succeeded",
    missingDatesCount: 0,
    lastError: null,
  },
  {
    lpAccountId: 52,
    lpName: "Finalto Prime",
    domain: "Cash",
    lastSucceededCoveredDate: "2026-09-09",
    lastRunCompletedAtUtc: FAILED_RUN_UTC,
    lastRunStatus: "Failed",
    missingDatesCount: 3,
    lastError: "SOAP timeout after 30s",
  },
  {
    lpAccountId: 52,
    lpName: "Finalto Prime",
    domain: "OrderJournal",
    lastSucceededCoveredDate: "2026-09-12",
    lastRunCompletedAtUtc: OK_RUN_UTC,
    lastRunStatus: "Succeeded",
    missingDatesCount: 0,
    lastError: null,
  },
  {
    lpAccountId: 52,
    lpName: "Finalto Prime",
    domain: "Costs",
    lastSucceededCoveredDate: "2026-09-12",
    lastRunCompletedAtUtc: OK_RUN_UTC,
    lastRunStatus: "Succeeded",
    missingDatesCount: 0,
    lastError: null,
  },
  {
    lpAccountId: 52,
    lpName: "Finalto Prime",
    domain: "SwapRates",
    lastSucceededCoveredDate: "2026-09-12",
    lastRunCompletedAtUtc: OK_RUN_UTC,
    lastRunStatus: "Succeeded",
    missingDatesCount: 0,
    lastError: null,
  },
  {
    lpAccountId: 52,
    lpName: "Finalto Prime",
    domain: "CorporateActions",
    lastSucceededCoveredDate: "2026-09-12",
    lastRunCompletedAtUtc: OK_RUN_UTC,
    lastRunStatus: "Succeeded",
    missingDatesCount: 0,
    lastError: null,
  },
];

const LP_ACCOUNTS = [
  { id: 52, lpName: "Finalto Prime", apiLoginText: "SLC_LIVE", environment: "Production", isActive: true },
];

const TRADE_ROW = {
  lpAccountId: 52,
  accountId: 9001,
  boTradeId: "BO-777",
  tsTradeId: "TS-777",
  instrumentId: 41,
  side: 0,
  amount: "100000",
  price: "1.09321",
  commission: "2.50",
  commissionCurrency: "USD",
  tradeDateFmt: "2026-09-01",
  ingestedAtUtc: INGESTED_UTC,
  // The server's own pre-formatted, zone-less string. It must lose to the raw
  // instant above: parsing it would re-read the time in the viewer's zone.
  ingestedAtUtcFmt: "2026-09-01 21:22:35",
};

type FetchCall = { url: string; init: RequestInit | undefined };

type FetchState = {
  status?: unknown[];
  statusStatus?: number;
  accounts?: unknown[];
  accountsStatus?: number;
  backfill?: unknown[];
  backfillStatus?: number;
  viewer?: unknown;
  viewerStatus?: number;
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function fail(status: number, body = "upstream said no") {
  return { ok: false, status, text: async () => body, json: async () => ({}) };
}

function installFetch(state: FetchState) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const method = String(init?.method || "GET").toUpperCase();
    if (method === "POST" && u.includes("/Backfill")) {
      if (state.backfillStatus) return fail(state.backfillStatus);
      return ok(state.backfill ?? []);
    }
    if (u.includes("/finalto-tester/accounts")) {
      if (state.accountsStatus) return fail(state.accountsStatus);
      return ok(state.accounts ?? []);
    }
    if (u.includes("/Finalto/Status")) {
      if (state.statusStatus) return fail(state.statusStatus);
      return ok(state.status ?? []);
    }
    if (method === "GET") {
      if (state.viewerStatus) return fail(state.viewerStatus);
      return ok(state.viewer ?? { items: [], totalRows: 0 });
    }
    return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
  });
  global.fetch = fn as unknown as typeof fetch;
  return calls;
}

function callsOfMethod(calls: FetchCall[], method: string) {
  return calls.filter((c) => String(c.init?.method || "GET").toUpperCase() === method);
}

function authOf(call: FetchCall): unknown {
  return (call.init?.headers as Record<string, string> | undefined)?.Authorization;
}

const LOADED: FetchState = { status: STATUS, accounts: LP_ACCOUNTS };

async function renderLoaded(state: FetchState = LOADED) {
  const calls = installFetch(state);
  render(<FinaltoAdminPage />);
  await waitFor(() => expect(screen.getAllByText(/Finalto Prime/).length).toBeGreaterThan(0));
  return calls;
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
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("every request goes to the proxy path and carries the session bearer", () => {
  it("GET reads the ingest status from /api/Finalto/Status", async () => {
    const calls = await renderLoaded();
    const statusGet = callsOfMethod(calls, "GET").find((c) => c.url.includes("/Status"));
    expect(statusGet?.url).toBe(`${FINALTO_URL}/Status`);
    expect(authOf(statusGet!)).toBe(EXPECTED_AUTH);
  });

  it("GET reads the LP dropdown from /api/admin/finalto-tester/accounts", async () => {
    const calls = await renderLoaded();
    const lpGet = callsOfMethod(calls, "GET").find((c) => c.url.includes("finalto-tester"));
    expect(lpGet?.url).toBe(TESTER_ACCOUNTS_URL);
    expect(authOf(lpGet!)).toBe(EXPECTED_AUTH);
  });

  it("POST submits the backfill to /api/Finalto/Backfill with the window in the query", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Submit backfill" }));

    await waitFor(() => expect(callsOfMethod(calls, "POST").length).toBe(1));
    const post = callsOfMethod(calls, "POST")[0];
    expect(post.url).toBe(`${FINALTO_URL}/Backfill?from=${YESTERDAY}&to=${YESTERDAY}&domain=Trades&force=false`);
    expect(authOf(post)).toBe(EXPECTED_AUTH);
  });

  it("POST carries the chosen LP, domain and force flag", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = await renderLoaded();

    fireEvent.change(screen.getByLabelText("Backfill LP account"), { target: { value: "52" } });
    fireEvent.change(screen.getByLabelText("Backfill domain"), { target: { value: "Cash" } });
    fireEvent.click(screen.getByLabelText("Backfill force"));
    fireEvent.click(screen.getByRole("button", { name: "Submit backfill" }));

    await waitFor(() => expect(callsOfMethod(calls, "POST").length).toBe(1));
    expect(callsOfMethod(calls, "POST")[0].url).toBe(
      `${FINALTO_URL}/Backfill?from=${YESTERDAY}&to=${YESTERDAY}&domain=Cash&lpAccountId=52&force=true`,
    );
  });

  it("GET reads the row viewer from /api/Finalto/{domain} with paging", async () => {
    const calls = await renderLoaded({ ...LOADED, viewer: { items: [TRADE_ROW], totalRows: 1 } });

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(screen.getAllByText("BO-777").length).toBeGreaterThan(0));
    const viewerGet = callsOfMethod(calls, "GET").find((c) => c.url.includes("/Finalto/Trades"));
    expect(viewerGet?.url).toBe(`${FINALTO_URL}/Trades?from=${YESTERDAY}&to=${YESTERDAY}&page=1&pageSize=100`);
    expect(authOf(viewerGet!)).toBe(EXPECTED_AUTH);
  });
});

describe("Backfill triggers server work, so it is guarded", () => {
  it("does not fire on mount", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = await renderLoaded();

    expect(callsOfMethod(calls, "POST")).toEqual([]);
    expect(calls.every((c) => !c.url.includes("/Backfill"))).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("confirms before calling, states the window, and sends nothing on no", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Submit backfill" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const prompt = String(confirmSpy.mock.calls[0][0]);
    expect(prompt).toContain(YESTERDAY);
    expect(prompt).toMatch(/Window:/);
    expect(prompt).toContain("Trades");
    expect(prompt).toMatch(/ALL active Finalto LPs/);
    expect(callsOfMethod(calls, "POST")).toEqual([]);
    expect(calls.every((c) => !c.url.includes("/Backfill"))).toBe(true);
  });

  it("the confirmation names the LP and says what Force will overwrite", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderLoaded();

    fireEvent.change(screen.getByLabelText("Backfill LP account"), { target: { value: "52" } });
    fireEvent.click(screen.getByLabelText("Backfill force"));
    fireEvent.click(screen.getByRole("button", { name: "Submit backfill" }));

    const prompt = String(confirmSpy.mock.calls[0][0]);
    expect(prompt).toContain("Finalto Prime");
    expect(prompt).toMatch(/re-run and overwritten/i);
  });

  it("an inverted window is refused before anything leaves the browser", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = await renderLoaded();

    fireEvent.change(screen.getByLabelText("Backfill from"), { target: { value: "2026-09-10" } });
    fireEvent.change(screen.getByLabelText("Backfill to"), { target: { value: "2026-09-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit backfill" }));

    await waitFor(() => screen.getByText("From date must be on or before To date."));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(callsOfMethod(calls, "POST")).toEqual([]);
  });

  it("the row viewer does not query on mount or on a tab switch", async () => {
    const calls = await renderLoaded();

    expect(calls.some((c) => c.url.includes("/Finalto/Trades"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cash" }));
    expect(calls.some((c) => c.url.includes("/Finalto/Cash"))).toBe(false);
    expect(screen.getByText(/Nothing is queried until you do/i)).toBeTruthy();
  });
});

describe("loaded-and-empty, refused, and broken are three different screens", () => {
  const EMPTY_HEADING = "No active Finalto LPs are configured.";
  const REFUSED_HEADING = "This dashboard is not authorised for the admin API.";
  const BROKEN_HEADING = "Could not load the ingest status.";

  it("[] renders the empty state -- not an error, and not a blank area", async () => {
    installFetch({ status: [], accounts: [] });
    render(<FinaltoAdminPage />);

    await waitFor(() => screen.getByText(EMPTY_HEADING));
    expect(screen.getByText(/Nothing is being ingested/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(REFUSED_HEADING)).toBeNull();
    expect(screen.queryByText(BROKEN_HEADING)).toBeNull();
  });

  it("401 renders the not-authorised state -- neither empty nor a generic error", async () => {
    installFetch({ statusStatus: 401, accounts: [] });
    render(<FinaltoAdminPage />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText(REFUSED_HEADING)).toBeTruthy();
    expect(screen.getByText(/credentials this dashboard authenticates with are not permitted/i)).toBeTruthy();
    expect(screen.getByText(/backend team must grant/i)).toBeTruthy();
    expect(screen.getByText(/HTTP 401/)).toBeTruthy();
    // And it borrows the words of neither other state.
    expect(screen.queryByText(EMPTY_HEADING)).toBeNull();
    expect(screen.queryByText(/Nothing is being ingested/i)).toBeNull();
    expect(screen.queryByText(BROKEN_HEADING)).toBeNull();
  });

  it("a non-auth failure renders the generic error -- neither empty nor not-authorised", async () => {
    installFetch({ statusStatus: 502, accounts: [] });
    render(<FinaltoAdminPage />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText(BROKEN_HEADING)).toBeTruthy();
    expect(screen.getByText(/This list is not empty - it is unknown/i)).toBeTruthy();
    expect(screen.queryByText(EMPTY_HEADING)).toBeNull();
    expect(screen.queryByText(REFUSED_HEADING)).toBeNull();
  });

  it("the row viewer tells the same three apart on its own endpoint", async () => {
    await renderLoaded({ ...LOADED, viewerStatus: 401 });

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => screen.getByText(REFUSED_HEADING));
    expect(screen.queryByText("No Trades rows match these filters.")).toBeNull();
    expect(screen.queryByText("Could not load the Trades rows.")).toBeNull();
  });

  it("a query that matches nothing says so, and is not an error", async () => {
    await renderLoaded({ ...LOADED, viewer: { items: [], totalRows: 0 } });

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => screen.getByText("No Trades rows match these filters."));
    expect(screen.getByText(/The query succeeded and returned nothing/i)).toBeTruthy();
    expect(screen.queryByText(REFUSED_HEADING)).toBeNull();
  });

  it("a refused LP dropdown says so rather than looking like there are no LPs", async () => {
    installFetch({ status: STATUS, accountsStatus: 401 });
    render(<FinaltoAdminPage />);

    await waitFor(() => screen.getByText(/The LP list could not be read/i));
    expect(screen.getByText(/not authorised for it/i)).toBeTruthy();
  });
});

describe("the two signals an operator opens this page for are surfaced, not buried", () => {
  it("a failed run is stated above the table, with its error", async () => {
    await renderLoaded();

    const banner = screen.getByText("1 ingest run FAILED.");
    expect(banner).toBeTruthy();
    expect(screen.getAllByText(/SOAP timeout after 30s/).length).toBeGreaterThan(0);
    // Named by (LP, domain) so the operator knows which ingest to look at.
    expect(banner.parentElement?.textContent).toContain("Finalto Prime");
    expect(banner.parentElement?.textContent).toContain("Cash");
    // And the run's own status still reads Failed in the row itself.
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
  });

  it("missing dates are stated as a gap, not left as a bare number", async () => {
    await renderLoaded();

    expect(screen.getByText(/Missing days in ingested data on 1 \(LP, domain\) pair/)).toBeTruthy();
    expect(screen.getAllByText(/3 missing date/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("3 missing").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Use Backfill\s+below to fill the gap/).length).toBeGreaterThan(0);
  });

  it("an all-clear run set raises neither banner", async () => {
    const clean = STATUS.map((r) => ({ ...r, lastRunStatus: "Succeeded", missingDatesCount: 0, lastError: null }));
    installFetch({ status: clean, accounts: LP_ACCOUNTS });
    render(<FinaltoAdminPage />);

    await waitFor(() => expect(screen.getAllByText(/Finalto Prime/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/ingest runs? FAILED/i)).toBeNull();
    expect(screen.queryByText(/Missing days in ingested data/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed backfill day-run is shown as failed, not folded into a count", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderLoaded({
      ...LOADED,
      backfill: [
        { date: "2026-09-10", domain: "Trades", lpAccountId: 52, status: "Succeeded", rowsUpserted: 412, elapsedMs: 900 },
        { date: "2026-09-11", domain: "Trades", lpAccountId: 52, status: "Failed", rowsUpserted: 0, elapsedMs: 30000, error: "SOAP timeout" },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit backfill" }));

    await waitFor(() => screen.getByText(/Backfill complete: 1 ok, 1 failed, 2 day-runs total/));
    const failedLine = screen.getByText("2026-09-11").parentElement;
    expect(failedLine?.textContent).toMatch(/Failed/);
    expect(failedLine?.textContent).toMatch(/SOAP timeout/);
    // The succeeded day is still listed, so the operator sees the whole run.
    expect(screen.getByText("2026-09-10").parentElement?.textContent).toMatch(/412 rows upserted/);
  });
});

describe("UTC instants render in Dubai time", () => {
  it("lastRunCompletedAtUtc goes through formatDubaiInstant, not the raw instant", async () => {
    await renderLoaded();

    const expected = formatDubaiInstant(OK_RUN_UTC);
    // Sanity: the helper must actually be doing the UTC+4 shift, otherwise this
    // test would pass against a helper that had been gutted.
    expect(expected).toContain("02");
    expect(expected).toContain("01:22:35");

    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain(OK_RUN_UTC);
    expect(document.body.textContent).not.toContain(FAILED_RUN_UTC);
    expect(document.body.textContent).toContain(formatDubaiInstant(FAILED_RUN_UTC));
    expect(screen.queryByText(new Date(OK_RUN_UTC).toLocaleString())).toBeNull();
  });

  it("a row's ingestedAtUtc goes through the helper, and beats the server's zone-less string", async () => {
    await renderLoaded({ ...LOADED, viewer: { items: [TRADE_ROW], totalRows: 1 } });

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getAllByText("BO-777").length).toBeGreaterThan(0));

    expect(screen.getAllByText(formatDubaiInstant(INGESTED_UTC)).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain(INGESTED_UTC);
    expect(document.body.textContent).not.toContain(TRADE_ROW.ingestedAtUtcFmt);
    // The numeric side code is rendered as a direction, not as "0".
    expect(screen.getAllByText("Buy").length).toBeGreaterThan(0);
  });
});
