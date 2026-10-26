// @vitest-environment node
//
// The three network legs, with the CRM and the trading backend stubbed.
//
// reportShared.js is replaced wholesale rather than through importOriginal, so
// the chart renderer and node-cron never load for a test about which field of
// which payload is read.
import { describe, it, expect, beforeEach, vi } from "vitest";

const crmPost = vi.fn();
const backendFetch = vi.fn();
let configured = true;

vi.mock("../reports/reportShared.js", () => ({
  crmPost: (...args) => crmPost(...args),
  backendFetch: (...args) => backendFetch(...args),
  crmConfigured: () => configured,
}));

const {
  ACCOUNT_ID_BATCH,
  CRM_MAX_PAGES,
  CRM_PAGE_SIZE,
  DEAL_MATCH_TIMEOUT_MS,
  fetchClientRevenueSummaries,
  fetchClientVolumeByClient,
  fetchSalesClients,
} = await import("./commissionSources.js");

const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const RANGE = { from: "2026-10-01", to: "2026-10-26" };

beforeEach(() => {
  crmPost.mockReset();
  backendFetch.mockReset();
  configured = true;
});

describe("fetchSalesClients", () => {
  it("asks FXBO for users by managerIds, then for their accounts", () => {
    // Two calls, not one: the /rest/users record carries managerId but NO
    // logins (see the User interface in src/lib/api.ts). Logins live on
    // /rest/accounts, which is how reports/dealMatchWeeklyReport.js already
    // resolves a login to a CRM client. The design document says /rest/users
    // gives "their MT5 logins"; it does not.
    crmPost.mockImplementation(async (path) => {
      if (path === "users") return [{ id: 101, managerId: 28, firstName: "Alice", lastName: "Trader" }];
      return [{ login: "5001", userId: 101, group: "real\\A" }];
    });

    return fetchSalesClients({ managerIds: [28] }).then((result) => {
      expect(crmPost).toHaveBeenCalledTimes(2);
      expect(crmPost.mock.calls[0][0]).toBe("users");
      expect(crmPost.mock.calls[0][1]).toEqual({ managerIds: [28], segment: { limit: CRM_PAGE_SIZE, offset: 0 } });
      expect(crmPost.mock.calls[1][0]).toBe("accounts");
      expect(crmPost.mock.calls[1][1]).toEqual({ userIds: [101], segment: { limit: CRM_PAGE_SIZE, offset: 0 } });

      expect(result.clients).toEqual([{ userId: 101, managerId: 28, name: "Alice Trader" }]);
      expect(result.accounts).toEqual([{ login: "5001", userId: 101, group: "real\\A" }]);
    });
  });

  it("carries no client email or phone past this boundary", async () => {
    crmPost.mockImplementation(async (path) => {
      if (path === "users") {
        return [
          {
            id: 101,
            managerId: 28,
            firstName: "Alice",
            lastName: "Trader",
            email: "alice@example.com",
            phone: "+971500000000",
          },
        ];
      }
      return [];
    });
    const result = await fetchSalesClients({ managerIds: [28] });
    expect(JSON.stringify(result)).not.toContain("alice@example.com");
    expect(JSON.stringify(result)).not.toContain("+971500000000");
  });

  it("drops a user FXBO returned outside the requested managers", async () => {
    // `managerIds` is not part of the typed UserRequest shape, so whether FXBO
    // honours it is unverified. If it ignores the filter this call is merely
    // expensive, never wrong.
    crmPost.mockImplementation(async (path) => {
      if (path === "users") {
        return [
          { id: 101, managerId: 28, firstName: "Mine", lastName: "Client" },
          { id: 999, managerId: 44, firstName: "Someone", lastName: "Else" },
        ];
      }
      return [];
    });
    const result = await fetchSalesClients({ managerIds: [28] });
    expect(result.clients.map((c) => c.userId)).toEqual([101]);
    expect(crmPost.mock.calls[1][1].userIds).toEqual([101]);
  });

  it("matches a manager id FXBO returned as a string", async () => {
    crmPost.mockImplementation(async (path) =>
      path === "users" ? [{ id: 101, managerId: "28", firstName: "Alice", lastName: "Trader" }] : [],
    );
    const result = await fetchSalesClients({ managerIds: [28] });
    expect(result.clients).toEqual([{ userId: 101, managerId: 28, name: "Alice Trader" }]);
  });

  it("pages until a short page arrives", async () => {
    const page = (n) =>
      Array.from({ length: n }, (_, i) => ({ id: i + 1, managerId: 28, firstName: "C", lastName: String(i) }));
    crmPost.mockImplementation(async (path, payload) => {
      if (path !== "users") return [];
      return payload.segment.offset === 0 ? page(CRM_PAGE_SIZE) : page(3);
    });
    const result = await fetchSalesClients({ managerIds: [28] });
    expect(result.clients).toHaveLength(CRM_PAGE_SIZE + 3);
  });

  it("throws rather than return a truncated book if FXBO ignores segment", async () => {
    // The loop's exit condition is "a short page". An endpoint that returned
    // the same full page forever would otherwise never return -- and silently
    // underpaying whoever fell off the end is worse than an error.
    crmPost.mockImplementation(async (path) => {
      if (path !== "users") return [];
      return Array.from({ length: CRM_PAGE_SIZE }, (_, i) => ({ id: i + 1, managerId: 28 }));
    });
    await expect(fetchSalesClients({ managerIds: [28] })).rejects.toThrow(/refusing a truncated book/);
    expect(crmPost).toHaveBeenCalledTimes(CRM_MAX_PAGES);
  });

  it("batches the account lookup rather than asking per client", async () => {
    const clients = Array.from({ length: ACCOUNT_ID_BATCH + 1 }, (_, i) => ({ id: i + 1, managerId: 28 }));
    crmPost.mockImplementation(async (path) => (path === "users" ? clients : []));
    await fetchSalesClients({ managerIds: [28] });
    // 1 users page + 2 account batches, not 201 lookups.
    expect(crmPost).toHaveBeenCalledTimes(3);
  });

  it("refuses to answer at all without a CRM token", async () => {
    configured = false;
    await expect(fetchSalesClients({ managerIds: [28] })).rejects.toThrow(/API_TOKEN is not set/);
    expect(crmPost).not.toHaveBeenCalled();
  });
});

describe("fetchClientVolumeByClient", () => {
  it("reads byClient, not byDate", () => {
    // src/lib/clientVolumeApi.ts reads byDate for the daily tile. This route
    // needs lots per LOGIN, and reading the wrong array would produce an empty
    // join and a page of zero commission.
    backendFetch.mockResolvedValue(
      ok({
        byDate: [{ date: "2026-10-01", lots: 999, cfdLots: 999 }],
        byClient: [{ login: "5001", name: "Alice", group: "real\\A", lots: 100, stocksLots: 40, cfdLots: 12.5 }],
      }),
    );
    return fetchClientVolumeByClient(RANGE).then((result) => {
      expect(result.rows).toEqual([
        { login: "5001", name: "Alice", group: "real\\A", lots: 100, stocksLots: 40, cfdLots: 12.5 },
      ]);
      expect(backendFetch.mock.calls[0][0]).toBe("/ClientVolume/Run?from=2026-10-01&to=2026-10-26&group=*");
    });
  });

  it("leaves internal accounts out", async () => {
    // A parallel bucket, not clients (dealing-reporting §4), and nobody is paid
    // commission on the firm's own flow.
    backendFetch.mockResolvedValue(
      ok({ byClient: [], byInternalAccount: [{ login: "90001", lots: 50, cfdLots: 50 }] }),
    );
    expect((await fetchClientVolumeByClient(RANGE)).rows).toEqual([]);
  });

  it("throws on a non-OK response instead of reporting no lots", async () => {
    backendFetch.mockResolvedValue({ ok: false, status: 503, text: async () => "upstream down" });
    await expect(fetchClientVolumeByClient(RANGE)).rejects.toThrow(/ClientVolume\/Run HTTP 503/);
  });
});

describe("fetchClientRevenueSummaries", () => {
  it("asks for lite=true and passes totalRevenueUsd through untouched", () => {
    backendFetch.mockResolvedValue(
      ok({
        clientRevenueSummaries: [
          {
            login: "5001",
            totalRevenueUsd: 21609.65,
            // Present and deliberately ignored: rebuilding Total Revenue from
            // markup + clientComm drops client swap, which on 2026-09-16 was
            // $20,313.91 of this very figure (dealing-reporting §5).
            markupRevenueUsd: 1736.28,
            clientCommissionUsd: 27.5,
            lpCommissionUsd: -468.04,
          },
        ],
      }),
    );
    return fetchClientRevenueSummaries(RANGE).then((result) => {
      expect(result.rows).toEqual([{ login: "5001", totalRevenueUsd: 21609.65 }]);
      const [url, options] = backendFetch.mock.calls[0];
      expect(url).toContain("lite=true");
      expect(url).not.toContain("lite=false");
      // ~45 MB a month of match rows is what lite=false would download.
      expect(options.timeoutMs).toBe(DEAL_MATCH_TIMEOUT_MS);
      expect(DEAL_MATCH_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
    });
  });

  it("throws on a non-OK response", async () => {
    backendFetch.mockResolvedValue({ ok: false, status: 504, text: async () => "gateway timeout" });
    await expect(fetchClientRevenueSummaries(RANGE)).rejects.toThrow(/DealMatch\/Run HTTP 504/);
  });
});

describe("every call is bounded", () => {
  it("passes a timeout to all three", async () => {
    crmPost.mockResolvedValue([]);
    backendFetch.mockResolvedValue(ok({ byClient: [], clientRevenueSummaries: [] }));
    await fetchSalesClients({ managerIds: [28] });
    await fetchClientVolumeByClient(RANGE);
    await fetchClientRevenueSummaries(RANGE);
    // Node's native fetch has no timeout, so an unbounded call holds the HTTP
    // request open until the IIS worker recycles (crmSignup/sendTimeout.js).
    for (const call of crmPost.mock.calls) {
      expect(call[2]?.timeoutMs).toBeGreaterThan(0);
    }
    for (const call of backendFetch.mock.calls) {
      expect(call[1]?.timeoutMs).toBeGreaterThan(0);
    }
  });
});
