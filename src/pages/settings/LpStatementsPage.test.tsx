// LP Statements: the upload path, the preview gate, and the three states that
// look identical when they are wrong.
//
// Two things about how this page reaches the backend have gone wrong on this
// project before, and both are asserted per verb rather than once in aggregate:
//
//   1. URL. Three settings pages spent weeks fetching a BARE "/api/<Route>"
//      path. On a single-page app that is not a 404 -- the SPA catch-all
//      answers with index.html and HTTP 200, so the page renders empty and
//      nobody reports it. Every request here must carry
//      "/api/backend/api/LpStatements..." : /api/backend is our proxy and
//      /api/LpStatements is the backend's own path under it.
//   2. Auth. /api/backend sits behind the deny-by-default gate in
//      auth/requireSession.js, so a call that reaches the right URL without the
//      JWT 401s on OUR server. A session is seeded into localStorage below
//      precisely so authHeaders() returns a real Bearer and these assertions
//      can fail -- with no session it returns {} and would pass vacuously.
//
// The upload itself is new and is the risky part. A multipart body only means
// anything if the browser writes the Content-Type with its own boundary, so the
// test below asserts that we do NOT write that header ourselves; and the proxy
// caps raw bodies at 25mb and answers 413 over it, so the refusal has to name
// the number an operator would have to get changed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { LpStatementsPage } from "./LpStatementsPage";
import { formatDubaiInstant } from "@/lib/dubaiTime";

const LP_ACCOUNTS_URL = "/api/backend/api/LpAccount?all=true";
const STATEMENTS_URL = "/api/backend/api/LpStatements";
const SESSION_KEY = "slc.session.v2";
const TOKEN = "test.session.jwt";
const EXPECTED_AUTH = `Bearer ${TOKEN}`;

const LP_ROWS = [{ id: 7, lpName: "CMC Markets", lpVendor: "Cmc" }];

const COVERAGE_WITH_GAP = {
  lps: [
    {
      lpName: "CMC Markets",
      lpVendor: "Cmc",
      statements: [
        {
          id: 31,
          statementDate: "2026-08-31T00:00:00Z",
          openingEquity: 1000,
          closingEquity: 1100,
          totalSwaps: -12.5,
          totalCommissions: -3.25,
        },
      ],
    },
  ],
};

const DETAIL = {
  header: {
    statementKind: "Monthly",
    statementDate: "2026-08-31T00:00:00Z",
    vendorAccountNumber: "ACC-1",
    openingEquity: 1000,
    closingEquity: 1100,
    totalSwaps: -12.5,
    totalCommissions: -3.25,
    // 21:22 UTC on the 1st is 01:22 on the 2nd in Dubai (UTC+4), so a
    // helper-less render cannot accidentally agree with a helper-based one.
    importedAtUtc: "2026-09-01T21:22:35Z",
  },
  productLines: [{ product: "FX", commission: -3.25, holdingCosts: -12.5 }],
};

type FetchCall = { url: string; init: RequestInit | undefined };

type FetchState = {
  lps?: unknown;
  lpStatus?: number;
  coverage?: unknown;
  coverageStatus?: number;
  previewStatus?: number;
  previewRows?: unknown;
  importRows?: unknown;
  detail?: unknown;
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function fail(status: number, body: unknown) {
  return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function installFetch(state: FetchState) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith(`${STATEMENTS_URL}/preview`)) {
      const status = state.previewStatus ?? 200;
      if (status === 413) {
        return fail(413, { error: "payload_too_large", limit: "25mb", message: "Request body exceeds the 25mb limit" });
      }
      if (status !== 200) return fail(status, { error: "nope" });
      return ok(state.previewRows ?? []);
    }
    if (u.startsWith(`${STATEMENTS_URL}/import`)) return ok(state.importRows ?? []);
    if (u.startsWith(`${STATEMENTS_URL}/coverage`)) {
      const status = state.coverageStatus ?? 200;
      if (status !== 200) return fail(status, { error: "coverage refused" });
      return ok(state.coverage ?? { lps: [] });
    }
    if (u.startsWith(LP_ACCOUNTS_URL)) {
      const status = state.lpStatus ?? 200;
      if (status !== 200) return fail(status, { error: "lp refused" });
      return ok(state.lps ?? LP_ROWS);
    }
    if (u.startsWith(`${STATEMENTS_URL}/`)) return ok(state.detail ?? DETAIL);
    return fail(404, { error: "unrouted", url: u });
  });
  global.fetch = fn as unknown as typeof fetch;
  return calls;
}

function callsOfMethod(calls: FetchCall[], method: string) {
  return calls.filter((c) => String(c.init?.method || "GET").toUpperCase() === method);
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init?.headers as Record<string, string> | undefined) || {};
}

function pdf(name: string, bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type: "application/pdf" });
}

/** jest-dom is not installed in this project, so disabledness is read off the
 *  element rather than asserted with toBeDisabled(). */
function importBtn(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Import" }) as HTMLButtonElement;
}

function attach(files: File[]) {
  fireEvent.change(screen.getByLabelText("Statement files"), { target: { files } });
}

const PREVIEW_OK = [
  {
    fileName: "cmc-aug.pdf",
    success: true,
    kind: "Monthly",
    statementDateUtc: "2026-08-31T00:00:00Z",
    vendorAccountNumber: "ACC-1",
    openingEquity: 1000,
    closingEquity: 1100,
    totalSwaps: -12.5,
    totalCommissions: -3.25,
  },
];

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
  vi.restoreAllMocks();
});

describe("every request goes to the proxy path and carries the session bearer", () => {
  it("GET lists LP accounts through /api/backend/api/LpAccount?all=true", async () => {
    const calls = installFetch({});
    render(<LpStatementsPage />);

    await waitFor(() => expect(calls.some((c) => c.url.startsWith(LP_ACCOUNTS_URL))).toBe(true));
    const call = calls.find((c) => c.url.startsWith(LP_ACCOUNTS_URL))!;
    expect(call.url).toBe(LP_ACCOUNTS_URL);
    expect(headersOf(call).Authorization).toBe(EXPECTED_AUTH);
  });

  it("GET reads coverage through /api/backend/api/LpStatements/coverage", async () => {
    const calls = installFetch({ coverage: COVERAGE_WITH_GAP });
    render(<LpStatementsPage />);

    await waitFor(() => expect(calls.some((c) => c.url.startsWith(`${STATEMENTS_URL}/coverage`))).toBe(true));
    const call = calls.find((c) => c.url.startsWith(`${STATEMENTS_URL}/coverage`))!;
    expect(call.url.startsWith(`${STATEMENTS_URL}/coverage?kind=Monthly&from=`)).toBe(true);
    expect(headersOf(call).Authorization).toBe(EXPECTED_AUTH);
  });

  it("POST previews against /api/backend/api/LpStatements/preview", async () => {
    const calls = installFetch({ previewRows: PREVIEW_OK });
    render(<LpStatementsPage />);
    await waitFor(() => screen.getByLabelText("Statement files"));

    attach([pdf("cmc-aug.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => expect(callsOfMethod(calls, "POST").length).toBe(1));
    const post = callsOfMethod(calls, "POST")[0];
    expect(post.url).toBe(`${STATEMENTS_URL}/preview`);
    expect(headersOf(post).Authorization).toBe(EXPECTED_AUTH);
  });

  it("POST imports against /api/backend/api/LpStatements/import", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = installFetch({ previewRows: PREVIEW_OK, importRows: PREVIEW_OK });
    render(<LpStatementsPage />);
    await waitFor(() => screen.getByLabelText("Statement files"));

    attach([pdf("cmc-aug.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(importBtn().disabled).toBe(false));
    fireEvent.click(importBtn());

    await waitFor(() => expect(callsOfMethod(calls, "POST").length).toBe(2));
    const imp = callsOfMethod(calls, "POST")[1];
    expect(imp.url).toBe(`${STATEMENTS_URL}/import`);
    expect(headersOf(imp).Authorization).toBe(EXPECTED_AUTH);
  });

  it("GET reads one statement's detail against /api/backend/api/LpStatements/{id}", async () => {
    const calls = installFetch({ coverage: COVERAGE_WITH_GAP });
    render(<LpStatementsPage />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Statement 31 for/ }).length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: /^Statement 31 for/ })[0]);

    await waitFor(() => expect(calls.some((c) => c.url === `${STATEMENTS_URL}/31`)).toBe(true));
    const call = calls.find((c) => c.url === `${STATEMENTS_URL}/31`)!;
    // The verb comes from the reference page, which calls fetch() with no init
    // at all on this route: a GET.
    expect(String(call.init?.method || "GET").toUpperCase()).toBe("GET");
    expect(headersOf(call).Authorization).toBe(EXPECTED_AUTH);
  });
});

describe("the upload sends a real multipart body and lets the browser describe it", () => {
  it("preview posts FormData and sets no Content-Type of its own", async () => {
    const calls = installFetch({ previewRows: PREVIEW_OK });
    render(<LpStatementsPage />);
    await waitFor(() => screen.getByLabelText("Statement files"));

    attach([pdf("cmc-aug.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => expect(callsOfMethod(calls, "POST").length).toBe(1));
    const post = callsOfMethod(calls, "POST")[0];
    expect(post.init?.body).toBeInstanceOf(FormData);
    const fd = post.init?.body as FormData;
    expect(fd.get("vendor")).toBe("Cmc");
    expect((fd.getAll("files")[0] as File).name).toBe("cmc-aug.pdf");
    // The boundary is generated by the browser when it serialises the FormData.
    // Writing Content-Type by hand omits it and the backend receives one
    // unsplittable blob, so the header must be absent in every casing.
    const keys = Object.keys(headersOf(post)).map((k) => k.toLowerCase());
    expect(keys).not.toContain("content-type");
  });

  it("import posts FormData with the LP and overwrite flag, and sets no Content-Type", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = installFetch({ previewRows: PREVIEW_OK, importRows: PREVIEW_OK });
    render(<LpStatementsPage />);
    await waitFor(() => screen.getByLabelText("Statement files"));

    attach([pdf("cmc-aug.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(importBtn().disabled).toBe(false));
    fireEvent.click(screen.getByLabelText("Force re-ingest"));
    fireEvent.click(importBtn());

    await waitFor(() => expect(callsOfMethod(calls, "POST").length).toBe(2));
    const imp = callsOfMethod(calls, "POST")[1];
    expect(imp.init?.body).toBeInstanceOf(FormData);
    const fd = imp.init?.body as FormData;
    expect(fd.get("vendor")).toBe("Cmc");
    expect(fd.get("lpAccountId")).toBe("7");
    expect(fd.get("overwrite")).toBe("true");
    expect((fd.getAll("files")[0] as File).name).toBe("cmc-aug.pdf");
    const keys = Object.keys(headersOf(imp)).map((k) => k.toLowerCase());
    expect(keys).not.toContain("content-type");
  });
});

describe("an over-size upload is refused in words that name the limit", () => {
  it("413 renders a message naming the 25mb proxy cap, and leaves the import locked", async () => {
    const calls = installFetch({ previewStatus: 413 });
    render(<LpStatementsPage />);
    await waitFor(() => screen.getByLabelText("Statement files"));

    attach([pdf("huge.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => expect(screen.getByText(/25mb/)).toBeTruthy());
    const text = screen.getByRole("status").textContent || "";
    expect(text).toContain("25mb");
    expect(text).toMatch(/nothing was imported/i);
    // A refused preview is not a preview, so the gate stays shut.
    expect(importBtn().disabled).toBe(true);
    expect(callsOfMethod(calls, "POST").filter((c) => c.url.includes("/import"))).toEqual([]);
  });
});

describe("an import can only run against something that was previewed", () => {
  it("Import is disabled and sends nothing before a preview", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = installFetch({});
    render(<LpStatementsPage />);
    await waitFor(() => screen.getByLabelText("Statement files"));

    attach([pdf("cmc-aug.pdf")]);
    expect(importBtn().disabled).toBe(true);
    fireEvent.click(importBtn());

    await waitFor(() => screen.getByText(/Import is locked until these exact files are previewed/i));
    expect(calls.filter((c) => c.url.includes("/import"))).toEqual([]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("swapping the files after a preview locks the import again", async () => {
    const calls = installFetch({ previewRows: PREVIEW_OK });
    render(<LpStatementsPage />);
    await waitFor(() => screen.getByLabelText("Statement files"));

    attach([pdf("cmc-aug.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(importBtn().disabled).toBe(false));

    // A different file has never been through the parser, so the preview on
    // screen no longer describes what an import would store.
    attach([pdf("something-else.pdf", 2048)]);
    expect(importBtn().disabled).toBe(true);
    fireEvent.click(importBtn());
    expect(calls.filter((c) => c.url.includes("/import"))).toEqual([]);
  });

  it("confirms before importing, naming the file and the LP, and sends nothing on no", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = installFetch({ previewRows: PREVIEW_OK });
    render(<LpStatementsPage />);
    await waitFor(() => screen.getByLabelText("Statement files"));

    attach([pdf("cmc-aug.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(importBtn().disabled).toBe(false));
    fireEvent.click(importBtn());

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const prompt = String(confirmSpy.mock.calls[0][0]);
    expect(prompt).toContain("cmc-aug.pdf");
    expect(prompt).toContain("CMC Markets");
    expect(prompt).toContain("id 7");
    expect(calls.filter((c) => c.url.includes("/import"))).toEqual([]);
  });
});

describe("nothing that writes fires on mount", () => {
  it("mount issues reads only", async () => {
    const calls = installFetch({ coverage: COVERAGE_WITH_GAP });
    render(<LpStatementsPage />);

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    expect(callsOfMethod(calls, "POST")).toEqual([]);
    expect(callsOfMethod(calls, "PUT")).toEqual([]);
    expect(callsOfMethod(calls, "DELETE")).toEqual([]);
  });
});

describe("loaded-and-empty, not authorised, and other failure are three different states", () => {
  it("an empty coverage result renders the empty state -- not an error", async () => {
    installFetch({ coverage: { lps: [] } });
    render(<LpStatementsPage />);

    await waitFor(() => screen.getByText("No statements in the selected range."));
    expect(screen.getByText(/Widen the From\/To window/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Could not load the coverage.")).toBeNull();
  });

  it("a 401 on coverage says we are not allowed -- not that there is nothing", async () => {
    installFetch({ coverageStatus: 401 });
    render(<LpStatementsPage />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText("This dashboard is not authorised for the LP statements API.")).toBeTruthy();
    expect(screen.getByText(/HTTP 401/)).toBeTruthy();
    expect(screen.queryByText("No statements in the selected range.")).toBeNull();
    expect(screen.queryByText("Could not load the coverage.")).toBeNull();
  });

  it("a 502 on coverage says the load broke -- and borrows neither of the other two", async () => {
    installFetch({ coverageStatus: 502 });
    render(<LpStatementsPage />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText("Could not load the coverage.")).toBeTruthy();
    expect(screen.queryByText("No statements in the selected range.")).toBeNull();
    expect(screen.queryByText("This dashboard is not authorised for the LP statements API.")).toBeNull();
  });
});

describe("coverage gaps are stated, not buried", () => {
  it("names the missing months and counts missing against present", async () => {
    installFetch({ coverage: COVERAGE_WITH_GAP });
    render(<LpStatementsPage />);

    // Six months requested, one statement present, so the gap is loud.
    await waitFor(() => expect(screen.getAllByText(/missing month/i).length).toBeGreaterThan(0));
    // The headline states the gap in words, with the count.
    expect(screen.getByText("6 missing months")).toBeTruthy();
    expect(screen.getAllByText(/Each one is a statement that was never uploaded/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026-08").length).toBeGreaterThan(0);
  });
});

describe("importedAtUtc is rendered in Dubai time", () => {
  it("renders through formatDubaiInstant, not the raw instant", async () => {
    installFetch({ coverage: COVERAGE_WITH_GAP });
    render(<LpStatementsPage />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Statement 31 for/ }).length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: /^Statement 31 for/ })[0]);

    const expected = formatDubaiInstant(DETAIL.header.importedAtUtc);
    // Sanity: the helper must actually be doing the UTC+4 shift, otherwise this
    // test would pass against a helper that had been gutted.
    expect(expected).toContain("02");
    expect(expected).toContain("01:22:35");

    await waitFor(() => expect(screen.getAllByText(expected).length).toBeGreaterThan(0));
    expect(screen.queryByText(DETAIL.header.importedAtUtc)).toBeNull();
    expect(screen.queryByText(new Date(DETAIL.header.importedAtUtc).toLocaleString())).toBeNull();
  });
});
