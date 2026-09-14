// LP Manager, brought up to lp-manager 6.html.
//
// The substance of that update is the connection/error states. MT5's manager API
// answers with a return-code symbol -- MT_RET_AUTH_UPGRADE, MT_RET_ERR_FREQUENT
// -- and the page used to print it raw, which told an operator nothing. Each
// symbol is a DIFFERENT remedy: a wrong password is a credential to rotate, an
// auth upgrade is a server version to match, "called too frequently" is our own
// polling hitting the vendor's rate limiter. So every one of them is asserted to
// render its own words AND to differ from all the others; a test that only
// checked "some friendly text appears" would pass a page that collapsed all
// seventeen codes into "connection error", which is exactly the regression.
//
// Alongside that: Stock Revenue Accounts (validated before any request, because
// an empty name would POST a row that renders as a blank line), and the swaps
// exclusion, which must keep reading the SAME `excludeFromSwaps` field that
// /api/LpAccount already carries and that InternalAccountsTab already reads --
// a second field for the same idea is two answers to "is this LP in the swaps
// report".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { LPManagerPage, mt5ErrorText, MT5_ERROR_TEXT } from "./LPManagerPage";
import { formatDubaiInstant } from "@/lib/dubaiTime";

const SESSION_KEY = "slc.session.v2";
const TOKEN = "test.session.jwt";

/** Only the swaps flag is set, so "Excluded" appearing once in the LP table is
 *  an exact assertion about which column it came from. */
const LP_ACCOUNT = {
  id: 42,
  lpName: "ATFX",
  mt5Login: 5001,
  source: "Manager",
  groupPattern: "real\\\\atfx*",
  description: "primary LP",
  isActive: true,
  coverageAccountLogin: 7777,
  excludeFromEquity: false,
  excludeFromPositions: false,
  isBonus: false,
  excludeFromHistory: false,
  excludeFromDealMatching: false,
  excludeFromSwaps: true,
  isRevenueAccount: false,
};

const REVENUE_ACCOUNT = {
  id: 99,
  lpName: "Stocks Revenue",
  mt5Login: 987654,
  source: "Manager",
  description: "stock commission revenue",
  isActive: true,
  isRevenueAccount: true,
  createdAtUnused: null,
  createdAt: "2026-09-01T21:22:35Z",
  updatedAt: "2026-09-02T05:00:00Z",
};

const MANAGER_STATUS = [
  { name: "Mgr Auth Timeout", login: 11, configured: true, connected: false, lastAttemptUtc: "2026-09-01T21:22:35Z", lastResult: "MT_RET_AUTH_TIMEOUT" },
  { name: "Mgr Auth Server", login: 12, configured: true, connected: false, lastAttemptUtc: "2026-09-01T21:22:35Z", lastResult: "MT_RET_AUTH_SERVER_ERR" },
  { name: "Mgr Auth Upgrade", login: 13, configured: true, connected: false, lastAttemptUtc: "2026-09-01T21:22:35Z", lastResult: "MT_RET_AUTH_UPGRADE" },
  { name: "Mgr Frequent", login: 14, configured: true, connected: false, lastAttemptUtc: "2026-09-01T21:22:35Z", lastResult: "MT_RET_ERR_FREQUENT" },
  { name: "Mgr Connection", login: 15, configured: true, connected: false, lastAttemptUtc: "2026-09-01T21:22:35Z", lastResult: "MT_RET_ERR_CONNECTION" },
  { name: "Mgr Disabled", login: 16, configured: true, connected: false, lastAttemptUtc: "2026-09-01T21:22:35Z", lastResult: "MT_RET_ERR_DISABLED" },
  { name: "Mgr Password", login: 17, configured: true, connected: false, lastAttemptUtc: "2026-09-01T21:22:35Z", lastResult: "MT_RET_AUTH_INVALID_PASSWORD" },
];

type Call = { url: string; init: RequestInit | undefined };

type Stub = {
  accounts?: unknown[];
  terminal?: unknown[];
  managers?: unknown[];
  logs?: unknown[];
  logStatus?: number;
  writeOk?: boolean;
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetch(stub: Stub = {}): Call[] {
  const calls: Call[] = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.includes("/api/LpLog/")) {
      const status = stub.logStatus ?? 200;
      return jsonResponse(stub.logs ?? [], status);
    }
    if (u.includes("/api/TerminalPosition/status")) return jsonResponse(stub.terminal ?? []);
    if (u.includes("/api/ManagerStatus")) return jsonResponse(stub.managers ?? []);
    if (u.includes("/Coverage/dashboard")) return jsonResponse([]);
    if (u.includes("/api/lpaccount/bulk-")) return jsonResponse({ ok: true }, stub.writeOk === false ? 500 : 200);
    if (u.includes("/api/LpAccount")) {
      if ((init?.method || "GET").toUpperCase() !== "GET") {
        return jsonResponse({ id: 1 }, stub.writeOk === false ? 500 : 200);
      }
      return jsonResponse(stub.accounts ?? []);
    }
    return jsonResponse([]);
  }) as unknown as typeof fetch;
  return calls;
}

function writeCalls(calls: Call[]): Call[] {
  return calls.filter((c) => (c.init?.method || "GET").toUpperCase() !== "GET");
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
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("MT5 return codes render as named causes, not one generic error", () => {
  it("gives each code its own words", async () => {
    installFetch({ managers: MANAGER_STATUS });
    render(<LPManagerPage />);

    const expected = [
      "Auth timed out",
      "Auth server error",
      "Auth upgrade required",
      "Called too frequently",
      "Connection lost",
      "Feature disabled",
      "Wrong password",
    ];

    await waitFor(() => expect(screen.getByText("Auth timed out")).toBeTruthy());
    for (const text of expected) {
      expect(screen.getAllByText(text).length, `"${text}" is not on screen`).toBe(1);
    }
    // and they really are seven different messages, not one repeated
    expect(new Set(expected).size).toBe(expected.length);
  });

  it("shows an unrecognised code as itself rather than inventing a meaning", () => {
    expect(mt5ErrorText("MT_RET_SOMETHING_NEW")).toBe("MT_RET_SOMETHING_NEW");
    expect(mt5ErrorText(null)).toBe("");
  });

  it("covers every code the reference maps", () => {
    // The reference's map is the contract. Losing an entry silently turns that
    // cause back into a raw symbol on screen.
    for (const code of [
      "MT_RET_OK",
      "MT_RET_ERR_NETWORK",
      "MT_RET_ERR_CONNECTION",
      "MT_RET_ERR_TIMEOUT",
      "MT_RET_ERR_PARAMS",
      "MT_RET_ERR_NOTFOUND",
      "MT_RET_ERR_PERMISSIONS",
      "MT_RET_ERR_DISABLED",
      "MT_RET_ERR_TOO_MANY",
      "MT_RET_ERR_MEMORY",
      "MT_RET_ERR_CANCEL",
      "MT_RET_ERR_FREQUENT",
      "MT_RET_AUTH_ACCOUNT_INVALID",
      "MT_RET_AUTH_INVALID_PASSWORD",
      "MT_RET_AUTH_SERVER_ERR",
      "MT_RET_AUTH_TIMEOUT",
      "MT_RET_AUTH_UPGRADE",
    ]) {
      expect(MT5_ERROR_TEXT[code], `${code} is missing from the map`).toBeTruthy();
    }
    // No two codes may share a message: that is the collapse this update undoes.
    const messages = Object.values(MT5_ERROR_TEXT);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("renders the last attempt in Dubai wall-clock", async () => {
    installFetch({ managers: [MANAGER_STATUS[0]] });
    render(<LPManagerPage />);
    await waitFor(() => expect(screen.getByText("Auth timed out")).toBeTruthy());
    expect(screen.getByText(`Last attempt: ${formatDubaiInstant("2026-09-01T21:22:35Z")}`)).toBeTruthy();
  });
});

describe("the per-LP error log drilldown", () => {
  it("opens from the affordance and asks /api/LpLog for that account", async () => {
    const calls = installFetch({ accounts: [LP_ACCOUNT], managers: [{ ...MANAGER_STATUS[0], login: 5001 }], logs: [] });
    render(<LPManagerPage />);
    await waitFor(() => expect(screen.getByText("Click to view recent errors")).toBeTruthy());

    fireEvent.click(screen.getByText("Click to view recent errors"));
    await waitFor(() => expect(screen.getByText(/LpAccount #42/)).toBeTruthy());

    const logCall = calls.find((c) => c.url.includes("/api/LpLog/"));
    expect(logCall?.url).toBe("/api/backend/api/LpLog/42?level=Warning&limit=200");
    expect((logCall?.init?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("keeps an empty buffer, a refusal and a failure apart", async () => {
    installFetch({ accounts: [LP_ACCOUNT], managers: [{ ...MANAGER_STATUS[0], login: 5001 }], logs: [] });
    render(<LPManagerPage />);
    await waitFor(() => expect(screen.getByText("Click to view recent errors")).toBeTruthy());
    fireEvent.click(screen.getByText("Click to view recent errors"));
    await waitFor(() => expect(screen.getByText(/No events at this level/)).toBeTruthy());
    expect(screen.queryByText(/Not authorised/)).toBeNull();

    cleanup();
    installFetch({ accounts: [LP_ACCOUNT], managers: [{ ...MANAGER_STATUS[0], login: 5001 }], logStatus: 401 });
    render(<LPManagerPage />);
    await waitFor(() => expect(screen.getByText("Click to view recent errors")).toBeTruthy());
    fireEvent.click(screen.getByText("Click to view recent errors"));
    await waitFor(() => expect(screen.getByText(/Not authorised to read this LP's logs/)).toBeTruthy());
    expect(screen.queryByText(/No events at this level/)).toBeNull();

    cleanup();
    installFetch({ accounts: [LP_ACCOUNT], managers: [{ ...MANAGER_STATUS[0], login: 5001 }], logStatus: 500 });
    render(<LPManagerPage />);
    await waitFor(() => expect(screen.getByText("Click to view recent errors")).toBeTruthy());
    fireEvent.click(screen.getByText("Click to view recent errors"));
    await waitFor(() => expect(screen.getByText("Fetch failed: HTTP 500")).toBeTruthy());
    expect(screen.queryByText(/No events at this level/)).toBeNull();
    expect(screen.queryByText(/Not authorised/)).toBeNull();
  });

  it("does not fetch logs on mount", async () => {
    const calls = installFetch({ accounts: [LP_ACCOUNT], managers: [{ ...MANAGER_STATUS[0], login: 5001 }] });
    render(<LPManagerPage />);
    await waitFor(() => expect(screen.getByText("Click to view recent errors")).toBeTruthy());
    expect(calls.filter((c) => c.url.includes("/api/LpLog/"))).toEqual([]);
  });
});

describe("Stock Revenue Accounts", () => {
  function openRevenuePanel() {
    fireEvent.click(screen.getByText("Add Stock Revenue Account"));
  }

  it("refuses an empty Account Name before any request is made", async () => {
    const calls = installFetch({});
    render(<LPManagerPage />);
    await waitFor(() => expect(screen.getByText("Add Stock Revenue Account")).toBeTruthy());
    openRevenuePanel();

    fireEvent.change(screen.getByLabelText("Revenue MT5 Login"), { target: { value: "987654" } });
    const before = writeCalls(calls).length;
    fireEvent.click(screen.getByRole("button", { name: /Add Revenue Account/ }));

    await waitFor(() => expect(screen.getByText("Account Name is required")).toBeTruthy());
    expect(writeCalls(calls).length, "a request was sent despite the missing name").toBe(before);
  });

  it("refuses a non-positive MT5 login before any request is made", async () => {
    const calls = installFetch({});
    render(<LPManagerPage />);
    await waitFor(() => expect(screen.getByText("Add Stock Revenue Account")).toBeTruthy());
    openRevenuePanel();

    fireEvent.change(screen.getByLabelText("Account Name"), { target: { value: "Stocks Revenue" } });
    fireEvent.change(screen.getByLabelText("Revenue MT5 Login"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /Add Revenue Account/ }));

    await waitFor(() => expect(screen.getByText("MT5 Login must be a positive number")).toBeTruthy());
    expect(writeCalls(calls)).toEqual([]);
  });

  it("confirms, naming the account, then POSTs with the three exclusions forced on", async () => {
    const calls = installFetch({});
    render(<LPManagerPage />);
    await waitFor(() => expect(screen.getByText("Add Stock Revenue Account")).toBeTruthy());
    openRevenuePanel();

    fireEvent.change(screen.getByLabelText("Account Name"), { target: { value: "Stocks Revenue" } });
    fireEvent.change(screen.getByLabelText("Revenue MT5 Login"), { target: { value: "987654" } });
    fireEvent.click(screen.getByRole("button", { name: /Add Revenue Account/ }));

    await waitFor(() => expect(writeCalls(calls).length).toBe(1));
    const confirmText = String((window.confirm as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(confirmText).toContain("Stocks Revenue");
    expect(confirmText).toContain("987654");

    const post = writeCalls(calls)[0];
    expect(post.url).toBe("/api/backend/api/LpAccount");
    const body = JSON.parse(String(post.init?.body));
    expect(body).toMatchObject({
      lpName: "Stocks Revenue",
      mt5Login: 987654,
      source: "Manager",
      isRevenueAccount: true,
      excludeFromEquity: true,
      excludeFromPositions: true,
      excludeFromDealMatching: true,
    });
  });

  it("keeps revenue accounts out of the LP grid and the LP counts", async () => {
    installFetch({ accounts: [LP_ACCOUNT, REVENUE_ACCOUNT] });
    render(<LPManagerPage />);
    await waitFor(() => expect(screen.getByText("ATFX")).toBeTruthy());

    // One LP account, not two.
    const lpCountCard = screen.getByText("LP Accounts", { selector: "div" }).parentElement!;
    expect(within(lpCountCard).getByText("1")).toBeTruthy();

    // The revenue account renders in its own grid, with its instants in Dubai time.
    expect(screen.getByText("Stocks Revenue")).toBeTruthy();
    expect(screen.getAllByText(formatDubaiInstant("2026-09-01T21:22:35Z")).length).toBeGreaterThan(0);
  });
});

describe("the swaps exclusion reads the field the API already carries", () => {
  it("renders Excluded from row.excludeFromSwaps and from nothing else", async () => {
    installFetch({ accounts: [LP_ACCOUNT] });
    render(<LPManagerPage />);
    await waitFor(() => expect(screen.getByText("ATFX")).toBeTruthy());

    const row = screen.getByText("ATFX").closest("tr")!;
    // Only excludeFromSwaps is true on this row, so exactly one "Excluded"
    // badge may appear. A second source of truth for the same idea -- a new
    // `swapsExcluded`, say -- would either lose this badge or double it.
    expect(within(row).getAllByText("Excluded")).toHaveLength(1);
    expect(within(row).getAllByText("Included")).toHaveLength(4);
  });

  it("bulk-updates the same excludeFromSwaps field, not a new one", async () => {
    const calls = installFetch({ accounts: [LP_ACCOUNT] });
    render(<LPManagerPage />);
    await waitFor(() => expect(screen.getByText("ATFX")).toBeTruthy());

    const row = screen.getByText("ATFX").closest("tr")!;
    fireEvent.click(within(row).getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Exclude Swaps" }));

    await waitFor(() => expect(writeCalls(calls).length).toBe(1));
    const post = writeCalls(calls)[0];
    expect(post.url).toBe("/api/backend/api/lpaccount/bulk-update");
    const body = JSON.parse(String(post.init?.body));
    expect(body.patch).toEqual({ excludeFromSwaps: true });
    expect(body.ids).toEqual([42]);
  });
});

describe("the fields that were already on this page still render what they rendered", () => {
  it("keeps LP name, login, coverage login and the four inclusion badges", async () => {
    installFetch({ accounts: [LP_ACCOUNT] });
    render(<LPManagerPage />);
    await waitFor(() => expect(screen.getByText("ATFX")).toBeTruthy());

    const row = screen.getByText("ATFX").closest("tr")!;
    expect(within(row).getByText("5001")).toBeTruthy();
    expect(within(row).getByText("7777")).toBeTruthy();
    expect(within(row).getByText("Manager")).toBeTruthy();
    expect(within(row).getByText("Normal")).toBeTruthy();
    expect(within(row).getByText("Active")).toBeTruthy();

    for (const header of ["LP Name", "MT5 Login", "Source", "Coverage Login", "Equity", "Positions", "Routing", "History", "Deal Matching", "Swaps"]) {
      expect(screen.getAllByText(header).length, `column "${header}" disappeared`).toBeGreaterThan(0);
    }
  });
});
