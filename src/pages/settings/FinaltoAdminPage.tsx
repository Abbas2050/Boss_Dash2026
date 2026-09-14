import React, { useEffect, useMemo, useRef, useState } from "react";
// /api/Finalto/* and /api/admin/finalto-tester/* are routes on the trading
// backend, not on this server, so they have to go through the same-origin proxy
// prefix. The doubled "api" in /api/backend/api/Finalto/Status is correct:
// /api/backend is where wallet/backendProxy.js is mounted and /api/Finalto is
// the backend's own path underneath it.
import { BACKEND_BASE_URL } from "@/lib/backendBase";
// That prefix sits behind requireSession (server.js denies every /api and /rest
// route by default), so every call here must carry the dashboard session bearer
// or it 401s on our own server before the backend is ever consulted.
import { authHeaders } from "@/lib/auth";
// lastRunCompletedAtUtc and the per-row ingestedAtUtc are UTC instants.
// Rendering one with toLocaleString() prints it in whichever zone the reading
// device happens to be in; the business runs on Dubai time and this dashboard
// is read on a phone that is not always there. A past bug shifted every
// displayed time by the viewer's UTC offset exactly this way.
import { formatDubaiInstant } from "@/lib/dubaiTime";

const FINALTO_URL = `${BACKEND_BASE_URL}/api/Finalto`;
const TESTER_ACCOUNTS_URL = `${BACKEND_BASE_URL}/api/admin/finalto-tester/accounts`;

/** One (LP, domain) pair of GET /api/Finalto/Status. Six rows: one per domain. */
type IngestStatusRow = {
  lpAccountId?: number | string | null;
  lpName?: string | null;
  domain?: string | null;
  /** A calendar date, not an instant - rendered verbatim. */
  lastSucceededCoveredDate?: string | null;
  lastRunCompletedAtUtc?: string | null;
  lastRunStatus?: string | null;
  missingDatesCount?: number | null;
  lastError?: string | null;
};

/** A row of GET /api/admin/finalto-tester/accounts - same shape as the
 *  finalto-accounts /parents list, and already filtered to Finalto LPs. */
type LpAccount = {
  id: number | string;
  lpName?: string | null;
  apiLoginText?: string | null;
  environment?: string | null;
  isActive?: boolean;
};

/** One line of the POST /api/Finalto/Backfill result array. */
type BackfillResult = {
  date?: string | null;
  domain?: string | null;
  lpAccountId?: number | string | null;
  status?: string | null;
  rowsUpserted?: number | null;
  elapsedMs?: number | null;
  error?: string | null;
};

/**
 * Three outcomes, never two. "We asked and got nothing", "we are not allowed to
 * ask" and "the asking broke" are different facts about the world and are
 * rendered as three different things. Collapsing any pair of them is how three
 * settings pages on this project sat broken in production for weeks looking
 * merely empty.
 */
type LoadState =
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "unauthorised"; status: number }
  | { kind: "error"; message: string };

const NOT_AUTHORISED_HEADING = "This dashboard is not authorised for the admin API.";

function notAuthorisedDetail(status: number, path: string): string {
  return (
    `The backend answered HTTP ${status} for ${path}. The endpoint exists; the credentials this dashboard ` +
    "authenticates with are not permitted to use it. Nothing is listed below because nothing could be read - this " +
    "is NOT an empty list, and it is not a network fault. Retrying, refreshing or signing in again will not change " +
    "it. The backend team must grant the dashboard's API client access to the Finalto admin surface before this " +
    "page can show or change anything."
  );
}

async function describeFailure(resp: Response, label: string): Promise<string> {
  const text = await resp.text().catch(() => "");
  let detail = text.slice(0, 200);
  if (text) {
    try {
      const parsed = JSON.parse(text);
      // The controller returns plain strings from BadRequest(...) as
      // JSON-encoded string bodies, so a parsed string is the message itself.
      if (typeof parsed === "string" && parsed) detail = parsed;
      else if (parsed && typeof parsed.error === "string" && parsed.error) detail = parsed.error;
      else if (parsed && typeof parsed.message === "string" && parsed.message) detail = parsed.message;
    } catch {
      /* not JSON; the raw body is the best detail available */
    }
  }
  return `${label} failed (HTTP ${resp.status})${detail ? `: ${detail}` : ""}`;
}

/** 403 joins 401 here: both mean "you may not", which is a different repair
 *  from "it broke", and an operator needs to be sent to the backend team for
 *  either one rather than to the logs. */
function isNotAuthorised(status: number): boolean {
  return status === 401 || status === 403;
}

const DOMAINS = ["Trades", "Cash", "OrderJournal", "Costs", "SwapRates", "CorporateActions"] as const;
type Domain = (typeof DOMAINS)[number];

/** UTC calendar date N days from today, as the yyyy-mm-dd an <input type=date> wants. */
function isoDateAddDays(days: number): string {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() + days);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Inclusive day count of a yyyy-mm-dd window, for the backfill confirmation. */
function dayCount(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86400000) + 1;
}

type FilterField = {
  key: string;
  label: string;
  kind: "date" | "number" | "select";
  required?: boolean;
  options?: readonly string[];
  initial?: () => string;
};

/**
 * Each domain takes its own filter set, exactly as the backend's query
 * parameters are named. "All" on a select is a UI-only marker and is omitted
 * from the query so the server matches every value.
 */
const FILTERS: Record<Domain, readonly FilterField[]> = {
  Trades: [
    { key: "from", label: "From", kind: "date", required: true, initial: () => isoDateAddDays(-1) },
    { key: "to", label: "To", kind: "date", required: true, initial: () => isoDateAddDays(-1) },
    { key: "accountId", label: "Account ID", kind: "number" },
    { key: "lpAccountId", label: "LP Account ID", kind: "number" },
  ],
  Cash: [
    { key: "from", label: "From", kind: "date", required: true, initial: () => isoDateAddDays(-1) },
    { key: "to", label: "To", kind: "date", required: true, initial: () => isoDateAddDays(-1) },
    { key: "accountId", label: "Account ID", kind: "number" },
    { key: "lpAccountId", label: "LP Account ID", kind: "number" },
  ],
  OrderJournal: [
    { key: "tradeDate", label: "Trade Date", kind: "date", required: true, initial: () => isoDateAddDays(-1) },
    { key: "accountId", label: "Account ID", kind: "number" },
    { key: "lpAccountId", label: "LP Account ID", kind: "number" },
  ],
  Costs: [
    { key: "tradeDate", label: "Trade Date", kind: "date", required: true, initial: () => isoDateAddDays(-1) },
    { key: "accountId", label: "Account ID", kind: "number" },
    { key: "lpAccountId", label: "LP Account ID", kind: "number" },
  ],
  SwapRates: [
    { key: "tradeDate", label: "Trade Date", kind: "date", required: true, initial: () => isoDateAddDays(-1) },
    { key: "accountId", label: "Account ID", kind: "number" },
    { key: "kind", label: "Kind", kind: "select", options: ["All", "TomNext", "Preliminary"] },
    { key: "lpAccountId", label: "LP Account ID", kind: "number" },
  ],
  CorporateActions: [
    { key: "exDateFrom", label: "Ex-date From", kind: "date", required: true, initial: () => isoDateAddDays(-30) },
    { key: "exDateTo", label: "Ex-date To", kind: "date", required: true, initial: () => isoDateAddDays(30) },
    { key: "accountId", label: "Account ID", kind: "number" },
    { key: "type", label: "Type", kind: "select", options: ["All", "Dividend", "Split", "ReverseSplit", "Delisting"] },
    { key: "lpAccountId", label: "LP Account ID", kind: "number" },
  ],
};

/** Ordered (from, to) pairs whose second value must not precede the first. */
const RANGE_PAIRS: Partial<Record<Domain, [string, string]>> = {
  Trades: ["from", "to"],
  Cash: ["from", "to"],
  CorporateActions: ["exDateFrom", "exDateTo"],
};

type Column = {
  header: string;
  field: string;
  /**
   * An instant column. `field` is the raw UTC instant; `fmtField` is the
   * server's own pre-formatted string, kept only as a fallback for the case
   * where the raw instant is absent from the payload. The raw value is
   * preferred because a server-formatted string carries no zone, and parsing a
   * zone-less "2026-09-01 21:22:35" as a date would re-read it in the viewer's
   * own zone - the exact bug formatDubaiInstant exists to prevent.
   */
  instant?: boolean;
  fmtField?: string;
  /** The Cash jsonb blob, shown behind a toggle rather than inline. */
  json?: boolean;
  /** Wire value -> operator-readable text, for columns the backend sends as a code. */
  map?: (value: unknown) => string;
};

const COLUMNS: Record<Domain, readonly Column[]> = {
  Trades: [
    { header: "LP #", field: "lpAccountId" },
    { header: "Account", field: "accountId" },
    { header: "BO Trade ID", field: "boTradeId" },
    { header: "TS Trade ID", field: "tsTradeId" },
    { header: "Instr ID", field: "instrumentId" },
    // The wire carries a numeric side; "0" in a column an operator scans for
    // direction is worse than useless.
    { header: "Side", field: "side", map: (v) => (v === 0 ? "Buy" : v === 1 ? "Sell" : String(v)) },
    { header: "Amount", field: "amount" },
    { header: "Price", field: "price" },
    { header: "Commission", field: "commission" },
    { header: "Comm Ccy", field: "commissionCurrency" },
    { header: "Execution", field: "executionDate", fmtField: "executionDateFmt", instant: true },
    { header: "Trade Date", field: "tradeDateFmt" },
    { header: "Value Date", field: "valueDateFmt" },
    { header: "Order ID", field: "orderId" },
    { header: "Trade Type", field: "tradeType" },
    { header: "Cancelled", field: "cancelled" },
    { header: "Closed", field: "closed" },
    { header: "Ingested", field: "ingestedAtUtc", fmtField: "ingestedAtUtcFmt", instant: true },
  ],
  Cash: [
    { header: "LP #", field: "lpAccountId" },
    { header: "Account", field: "accountId" },
    { header: "Cash Act ID", field: "cashActivityId" },
    { header: "Type", field: "cashActivityType" },
    { header: "Amount", field: "amount" },
    { header: "Ccy", field: "currency" },
    { header: "Conv Amount", field: "convertedAmount" },
    { header: "Conv Ccy", field: "convertedCurrency" },
    { header: "Trade Date", field: "tradeDateFmt" },
    { header: "Activity Time", field: "activityTime", fmtField: "activityTimeFmt", instant: true },
    { header: "Comment", field: "comment" },
    { header: "Details", field: "details", json: true },
    { header: "Ingested", field: "ingestedAtUtc", fmtField: "ingestedAtUtcFmt", instant: true },
  ],
  OrderJournal: [
    { header: "LP #", field: "lpAccountId" },
    { header: "Account", field: "accountId" },
    { header: "Journal ID", field: "journalId" },
    { header: "Activity Time", field: "activityTime", fmtField: "activityTimeFmt", instant: true },
    { header: "Event", field: "orderEvent" },
    { header: "Instrument", field: "instrument" },
    { header: "Side", field: "orderSide" },
    { header: "Type", field: "orderType" },
    { header: "Order Amount", field: "orderAmount" },
    { header: "Order Price", field: "orderPrice" },
    { header: "Fill Amount", field: "fillAmount" },
    { header: "Fill Price", field: "fillPrice" },
    { header: "Trade ID", field: "tradeId" },
    { header: "Order ID", field: "orderId" },
    { header: "Trade Date", field: "tradeDateFmt" },
    { header: "Ingested", field: "ingestedAtUtc", fmtField: "ingestedAtUtcFmt", instant: true },
  ],
  Costs: [
    { header: "LP #", field: "lpAccountId" },
    { header: "Account", field: "accountId" },
    { header: "Symbol", field: "instrumentSymbol" },
    { header: "Trade Date", field: "tradeDateFmt" },
    { header: "Long Cost", field: "longPosCost" },
    { header: "Short Cost", field: "shortPosCost" },
    { header: "EOD Rate", field: "eODRate" },
    { header: "Ccy Code", field: "currencyCode" },
    { header: "Gross Div", field: "grossDividend" },
    { header: "Net Div", field: "netDividend" },
    { header: "WHT Rate", field: "withholdingTaxRate" },
    { header: "Div Ccy", field: "dividendCurrency" },
    { header: "Finance From", field: "dayToFinanceFrom", fmtField: "dayToFinanceFromFmt", instant: true },
    { header: "Finance To", field: "dayToFinanceTo", fmtField: "dayToFinanceToFmt", instant: true },
    { header: "Ingested", field: "ingestedAtUtc", fmtField: "ingestedAtUtcFmt", instant: true },
  ],
  SwapRates: [
    { header: "LP #", field: "lpAccountId" },
    { header: "Account", field: "accountId" },
    { header: "Symbol", field: "instrumentSymbol" },
    { header: "Trade Date", field: "tradeDateFmt" },
    { header: "Kind", field: "kind" },
    { header: "Long Pips", field: "longPosPips" },
    { header: "Short Pips", field: "shortPosPips" },
    { header: "Pip Size", field: "pipSize" },
    { header: "EOD Rate", field: "eODRate" },
    { header: "From Val Date", field: "fromValueDate", fmtField: "fromValueDateFmt", instant: true },
    { header: "To Val Date", field: "toValueDate", fmtField: "toValueDateFmt", instant: true },
    { header: "Ingested", field: "ingestedAtUtc", fmtField: "ingestedAtUtcFmt", instant: true },
  ],
  CorporateActions: [
    { header: "LP #", field: "lpAccountId" },
    { header: "Account", field: "accountId" },
    { header: "Symbol", field: "instrumentSymbol" },
    { header: "Ex Date", field: "exDateFmt" },
    { header: "Type", field: "corporateActionType" },
    { header: "Value", field: "displayValue" },
    { header: "Ccy", field: "currencyCode" },
    { header: "Ingested", field: "ingestedAtUtc", fmtField: "ingestedAtUtcFmt", instant: true },
  ],
};

const PAGE_SIZE = 100;

function initialFilters(domain: Domain): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FILTERS[domain]) out[f.key] = f.initial ? f.initial() : f.kind === "select" ? String(f.options?.[0] ?? "") : "";
  return out;
}

function isFailure(status: unknown): boolean {
  return String(status || "").toLowerCase() === "failed";
}

function statusRowKey(row: IngestStatusRow, i: number): string {
  return `${row.lpAccountId ?? "?"}-${row.domain ?? "?"}-${i}`;
}

export const FinaltoAdminPage: React.FC = () => {
  // ---- Ingest status ----
  const [statusRows, setStatusRows] = useState<IngestStatusRow[]>([]);
  const [statusState, setStatusState] = useState<LoadState>({ kind: "loading" });
  const [statusStamp, setStatusStamp] = useState<string | null>(null);

  // ---- Backfill ----
  const [lpAccounts, setLpAccounts] = useState<LpAccount[]>([]);
  const [lpState, setLpState] = useState<LoadState>({ kind: "loading" });
  const [bfLp, setBfLp] = useState("");
  const [bfDomain, setBfDomain] = useState<Domain>("Trades");
  const [bfFrom, setBfFrom] = useState(() => isoDateAddDays(-1));
  const [bfTo, setBfTo] = useState(() => isoDateAddDays(-1));
  const [bfForce, setBfForce] = useState(false);
  const [bfBusy, setBfBusy] = useState(false);
  const [bfResults, setBfResults] = useState<BackfillResult[] | null>(null);

  // ---- Row viewer ----
  const [tab, setTab] = useState<Domain>("Trades");
  const [filters, setFilters] = useState<Record<Domain, Record<string, string>>>(() => ({
    Trades: initialFilters("Trades"),
    Cash: initialFilters("Cash"),
    OrderJournal: initialFilters("OrderJournal"),
    Costs: initialFilters("Costs"),
    SwapRates: initialFilters("SwapRates"),
    CorporateActions: initialFilters("CorporateActions"),
  }));
  const [rows, setRows] = useState<any[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [pageNo, setPageNo] = useState(1);
  const [disclaimer, setDisclaimer] = useState<string | null>(null);
  const [viewerState, setViewerState] = useState<LoadState | null>(null);
  const [openJson, setOpenJson] = useState<string | null>(null);

  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    void loadStatus();
    void loadLpAccounts();
    // The status panel is the operator's watch on an overnight job, so it keeps
    // itself current. This is a read and nothing else: nothing on this page
    // triggers backend work without a click and a confirmation.
    const timer = window.setInterval(() => void loadStatus(), 60000);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(t);
  }, [notice]);

  async function failureNotice(resp: Response, label: string, path: string): Promise<string> {
    if (isNotAuthorised(resp.status)) return `${label}: ${NOT_AUTHORISED_HEADING} ${notAuthorisedDetail(resp.status, path)}`;
    return await describeFailure(resp, label);
  }

  async function loadStatus() {
    setStatusState((s) => (s.kind === "ok" ? s : { kind: "loading" }));
    try {
      const resp = await fetch(`${FINALTO_URL}/Status`, { headers: { ...authHeaders() } });
      if (!aliveRef.current) return;
      if (!resp.ok) {
        // Rows are cleared as well, so a stale table cannot sit under a banner
        // pretending to be current.
        setStatusRows([]);
        setStatusState(
          isNotAuthorised(resp.status)
            ? { kind: "unauthorised", status: resp.status }
            : { kind: "error", message: await describeFailure(resp, "Load ingest status") },
        );
        return;
      }
      const data = await resp.json();
      if (!aliveRef.current) return;
      setStatusRows(Array.isArray(data) ? data : []);
      setStatusState({ kind: "ok" });
      setStatusStamp(new Date().toISOString());
    } catch (e: any) {
      if (!aliveRef.current) return;
      setStatusRows([]);
      setStatusState({ kind: "error", message: e?.message || "Could not reach the Finalto status endpoint." });
    }
  }

  async function loadLpAccounts() {
    setLpState({ kind: "loading" });
    try {
      const resp = await fetch(TESTER_ACCOUNTS_URL, { headers: { ...authHeaders() } });
      if (!aliveRef.current) return;
      if (!resp.ok) {
        setLpAccounts([]);
        setLpState(
          isNotAuthorised(resp.status)
            ? { kind: "unauthorised", status: resp.status }
            : { kind: "error", message: await describeFailure(resp, "Load Finalto LP accounts") },
        );
        return;
      }
      const data = await resp.json();
      if (!aliveRef.current) return;
      setLpAccounts(Array.isArray(data) ? data : []);
      setLpState({ kind: "ok" });
    } catch (e: any) {
      if (!aliveRef.current) return;
      setLpAccounts([]);
      setLpState({ kind: "error", message: e?.message || "Could not reach the Finalto LP accounts endpoint." });
    }
  }

  const failedRuns = useMemo(() => statusRows.filter((r) => isFailure(r.lastRunStatus)), [statusRows]);
  const gapRows = useMemo(() => statusRows.filter((r) => Number(r.missingDatesCount || 0) > 0), [statusRows]);

  /**
   * Backfill makes the backend go and fetch from Finalto for every day in the
   * window, so it is confirmed, the confirmation states the exact window it
   * will cover, and nothing fires until the operator says yes. It is never
   * called on mount.
   */
  async function runBackfill() {
    if (!bfFrom || !bfTo) {
      setNotice({ text: "From and To dates are required.", ok: false });
      return;
    }
    if (bfFrom > bfTo) {
      setNotice({ text: "From date must be on or before To date.", ok: false });
      return;
    }
    const lp = lpAccounts.find((a) => String(a.id) === bfLp);
    const lpLabel = bfLp ? `LP #${bfLp}${lp?.lpName ? ` (${lp.lpName})` : ""}` : "ALL active Finalto LPs";
    const days = dayCount(bfFrom, bfTo);
    if (
      !window.confirm(
        `Backfill ${bfDomain} for ${lpLabel}?\n\n` +
          `Window: ${bfFrom} to ${bfTo} inclusive (${days} day${days === 1 ? "" : "s"}).\n` +
          `Force: ${bfForce ? "YES - days already marked Succeeded will be re-run and overwritten" : "no - only days not already Succeeded"}.\n\n` +
          "This makes the backend call Finalto once per day in the window and upsert what comes back. It can take " +
          "30s or more on a wide window. Continue?",
      )
    ) {
      return;
    }
    const qs = new URLSearchParams();
    qs.set("from", bfFrom);
    qs.set("to", bfTo);
    qs.set("domain", bfDomain);
    if (bfLp) qs.set("lpAccountId", bfLp);
    qs.set("force", bfForce ? "true" : "false");

    setBfBusy(true);
    setBfResults(null);
    try {
      const resp = await fetch(`${FINALTO_URL}/Backfill?${qs.toString()}`, {
        method: "POST",
        headers: { ...authHeaders() },
      });
      if (!resp.ok) {
        setNotice({ text: await failureNotice(resp, "Backfill", "/api/Finalto/Backfill"), ok: false });
        return;
      }
      const data = await resp.json();
      const results: BackfillResult[] = Array.isArray(data) ? data : [];
      setBfResults(results);
      const okCount = results.filter((r) => String(r.status || "").toLowerCase() === "succeeded").length;
      const failCount = results.filter((r) => isFailure(r.status)).length;
      setNotice({
        text: `Backfill complete: ${okCount} ok, ${failCount} failed, ${results.length} day-runs total.`,
        ok: failCount === 0,
      });
      // Immediate status refresh so the operator sees the effect of what they
      // just triggered rather than waiting out the 60s tick.
      await loadStatus();
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to submit the backfill.", ok: false });
    } finally {
      setBfBusy(false);
    }
  }

  function setFilter(key: string, value: string) {
    setFilters((prev) => ({ ...prev, [tab]: { ...prev[tab], [key]: value } }));
  }

  /** Query string for the current tab, or the reason it cannot be built. */
  function buildQuery(page: number): { qs: string } | { error: string } {
    const current = filters[tab];
    const qs = new URLSearchParams();
    for (const f of FILTERS[tab]) {
      const raw = (current[f.key] ?? "").trim();
      if (f.required && !raw) return { error: `${f.label} is required.` };
      if (!raw) continue;
      // "All" is a UI-only marker; omitting the param is what makes the server
      // match every value.
      if (f.kind === "select" && raw === "All") continue;
      qs.set(f.key, raw);
    }
    const range = RANGE_PAIRS[tab];
    if (range) {
      const [a, b] = range;
      if (current[a] && current[b] && current[a] > current[b]) {
        return { error: `${FILTERS[tab].find((f) => f.key === a)?.label} must be on or before ${FILTERS[tab].find((f) => f.key === b)?.label}.` };
      }
    }
    qs.set("page", String(page));
    qs.set("pageSize", String(PAGE_SIZE));
    return { qs: qs.toString() };
  }

  async function fetchRows(page: number) {
    const built = buildQuery(page);
    if ("error" in built) {
      setNotice({ text: built.error, ok: false });
      return;
    }
    setViewerState({ kind: "loading" });
    setOpenJson(null);
    const url = `${FINALTO_URL}/${tab}?${built.qs}`;
    try {
      const resp = await fetch(url, { headers: { ...authHeaders() } });
      if (!resp.ok) {
        setRows([]);
        setTotalRows(0);
        setViewerState(
          isNotAuthorised(resp.status)
            ? { kind: "unauthorised", status: resp.status }
            : { kind: "error", message: await describeFailure(resp, `Load ${tab} rows`) },
        );
        return;
      }
      const data = await resp.json();
      setRows(Array.isArray(data?.items) ? data.items : []);
      setTotalRows(Number(data?.totalRows || 0));
      setDisclaimer(typeof data?.disclaimer === "string" && data.disclaimer ? data.disclaimer : null);
      setPageNo(page);
      setViewerState({ kind: "ok" });
    } catch (e: any) {
      setRows([]);
      setTotalRows(0);
      setViewerState({ kind: "error", message: e?.message || `Could not reach the ${tab} endpoint.` });
    }
  }

  function switchTab(next: Domain) {
    // Switching tabs does NOT fetch: browsing between six tabs would otherwise
    // fire six queries nobody asked for.
    setTab(next);
    setRows([]);
    setTotalRows(0);
    setPageNo(1);
    setDisclaimer(null);
    setViewerState(null);
    setOpenJson(null);
  }

  /** One cell's text, with instant columns routed through the Dubai helper. */
  function cellText(row: any, col: Column): string {
    if (col.instant) {
      const raw = row?.[col.field];
      if (raw !== null && raw !== undefined && raw !== "") return formatDubaiInstant(raw);
      // Only reached when the payload carries no raw instant. The server's own
      // formatted string is shown verbatim rather than parsed, because parsing
      // a zone-less string would re-read it in the viewer's zone.
      const fmt = col.fmtField ? row?.[col.fmtField] : null;
      return fmt === null || fmt === undefined || fmt === "" ? "-" : String(fmt);
    }
    const v = row?.[col.field];
    if (v === null || v === undefined || v === "") return "-";
    if (col.map) return col.map(v);
    if (typeof v === "boolean") return v ? "yes" : "no";
    return String(v);
  }

  function prettyJson(value: unknown): string {
    const s = typeof value === "string" ? value : JSON.stringify(value ?? null);
    try {
      return JSON.stringify(JSON.parse(String(s)), null, 2);
    } catch {
      return String(s);
    }
  }

  const inputClass =
    "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900/70";

  function loadPanel(s: LoadState, what: string, path: string) {
    if (s.kind === "loading") return <div className="text-xs text-slate-500 dark:text-slate-400">Loading {what}...</div>;
    if (s.kind === "unauthorised") {
      return (
        <div
          role="alert"
          className="rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-4 text-xs text-amber-800 dark:text-amber-200"
        >
          <div className="text-sm font-semibold">{NOT_AUTHORISED_HEADING}</div>
          <div className="mt-1 break-words">{notAuthorisedDetail(s.status, path)}</div>
        </div>
      );
    }
    if (s.kind === "error") {
      return (
        <div
          role="alert"
          className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-4 text-xs text-rose-700 dark:text-rose-200"
        >
          <div className="text-sm font-semibold">Could not load the {what}.</div>
          <div className="mt-1 break-words">{s.message}</div>
          <div className="mt-1 opacity-80">This list is not empty - it is unknown. Nothing below reflects the backend.</div>
        </div>
      );
    }
    return null;
  }

  function statusPill(status: unknown) {
    const text = String(status || "") || "(none)";
    const cls = isFailure(status)
      ? "bg-rose-500/20 text-rose-700 dark:text-rose-300"
      : text.toLowerCase() === "succeeded"
        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
        : "bg-slate-500/15 text-slate-700 dark:text-slate-300";
    return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>{text}</span>;
  }

  /**
   * The Cash Details column is a jsonb blob. It is shown behind a toggle and
   * rendered as text, never as markup: it comes from Finalto's own response.
   */
  function jsonCell(row: any, col: Column, i: number) {
    const raw = row?.[col.field];
    if (raw === null || raw === undefined || raw === "" || raw === "[]" || raw === "null") return <span>-</span>;
    const key = `${tab}-${i}`;
    const open = openJson === key;
    return (
      <span>
        <button
          type="button"
          onClick={() => setOpenJson(open ? null : key)}
          className="rounded border border-slate-300 px-2 py-0.5 text-[11px] dark:border-slate-700"
        >
          {open ? "Hide" : "View"}
        </button>
        {open && (
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-300 bg-slate-100 p-2 text-left text-[11px] dark:border-slate-700 dark:bg-slate-900">
            {prettyJson(raw)}
          </pre>
        )}
      </span>
    );
  }

  return (
    <div className="min-h-screen bg-background p-3 sm:p-4 md:p-6 lg:p-8">
      <div className="mx-auto max-w-[1300px]">
        <h1 className="text-2xl font-bold text-foreground">Finalto Admin</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Per-(LP, domain) ingest status, a backfill window, and a paged row viewer across the six Finalto ingest
          tables. Super-admin only.
        </p>

        {notice && (
          <div
            role="status"
            className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
              notice.ok
                ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
                : "border-amber-400/30 bg-amber-500/10 text-amber-700 dark:text-amber-200"
            }`}
          >
            {notice.text}
          </div>
        )}

        {/* ---------------- Ingest status ---------------- */}
        <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-primary">Ingest status</h2>
            <button
              type="button"
              onClick={() => void loadStatus()}
              className="ml-auto rounded-md border border-slate-300 px-3 py-1 text-xs dark:border-slate-700"
            >
              Refresh now
            </button>
          </div>
          <div className="mb-2 text-[11px] text-muted-foreground">
            Auto-refreshes every 60s.{" "}
            {statusStamp ? `Last refreshed ${formatDubaiInstant(statusStamp)} (Dubai).` : "Not refreshed yet."}
          </div>

          {/* A failed run is the whole reason an operator opens this page, so it
              is stated above the table with its error, not left as one cell in
              a six-row grid that has to be read across. */}
          {statusState.kind === "ok" && failedRuns.length > 0 && (
            <div
              role="alert"
              className="mb-3 rounded-lg border border-rose-400/50 bg-rose-500/10 px-3 py-3 text-xs text-rose-700 dark:text-rose-200"
            >
              <div className="text-sm font-semibold">
                {failedRuns.length} ingest run{failedRuns.length !== 1 ? "s" : ""} FAILED.
              </div>
              <ul className="mt-1 space-y-1">
                {failedRuns.map((r, i) => (
                  <li key={`failed-${statusRowKey(r, i)}`} className="break-words">
                    <b>
                      {r.lpName || `LP #${r.lpAccountId}`} / {r.domain}
                    </b>{" "}
                    - last run {formatDubaiInstant(r.lastRunCompletedAtUtc)}
                    {r.lastError ? `: ${r.lastError}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* A gap means days that were never ingested. A bare number in a cell
              reads as a statistic; this says what it means. */}
          {statusState.kind === "ok" && gapRows.length > 0 && (
            <div
              role="alert"
              className="mb-3 rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-3 text-xs text-amber-800 dark:text-amber-200"
            >
              <div className="text-sm font-semibold">
                Missing days in ingested data on {gapRows.length} (LP, domain) pair{gapRows.length !== 1 ? "s" : ""}.
              </div>
              <ul className="mt-1 space-y-1">
                {gapRows.map((r, i) => (
                  <li key={`gap-${statusRowKey(r, i)}`}>
                    <b>
                      {r.lpName || `LP #${r.lpAccountId}`} / {r.domain}
                    </b>{" "}
                    - {Number(r.missingDatesCount)} missing date{Number(r.missingDatesCount) !== 1 ? "s" : ""}. Use Backfill
                    below to fill the gap.
                  </li>
                ))}
              </ul>
            </div>
          )}

          {loadPanel(statusState, "ingest status", "/api/Finalto/Status")}

          {statusState.kind === "ok" && statusRows.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center dark:border-slate-700 dark:bg-slate-900/40">
              <div className="text-sm font-semibold text-foreground">No active Finalto LPs are configured.</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Nothing is being ingested. Add a Finalto LP account on the LP Manager page to start a daily ingest.
              </div>
            </div>
          )}

          {statusState.kind === "ok" && statusRows.length > 0 && (
            <>
              <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block dark:border-slate-800">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-900/80">
                    <tr>
                      <th className="px-2 py-2 text-left">LP</th>
                      <th className="px-2 py-2 text-left">Domain</th>
                      <th className="px-2 py-2 text-left">Last succeeded covered date</th>
                      <th className="px-2 py-2 text-left">Last run completed</th>
                      <th className="px-2 py-2 text-left">Last run status</th>
                      <th className="px-2 py-2 text-right">Missing days</th>
                      <th className="px-2 py-2 text-left">Last error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statusRows.map((r, i) => (
                      <tr
                        key={`status-${statusRowKey(r, i)}`}
                        className={`border-t border-slate-200 align-top dark:border-slate-800 ${
                          isFailure(r.lastRunStatus) ? "bg-rose-500/5" : ""
                        }`}
                      >
                        <td className="px-2 py-1.5">
                          {r.lpName || "-"} <span className="text-muted-foreground">#{String(r.lpAccountId ?? "?")}</span>
                        </td>
                        <td className="px-2 py-1.5">{r.domain || "-"}</td>
                        <td className="px-2 py-1.5">{r.lastSucceededCoveredDate || "-"}</td>
                        <td className="px-2 py-1.5">{formatDubaiInstant(r.lastRunCompletedAtUtc)}</td>
                        <td className="px-2 py-1.5">{statusPill(r.lastRunStatus)}</td>
                        <td
                          className={`px-2 py-1.5 text-right ${
                            Number(r.missingDatesCount || 0) > 0 ? "font-semibold text-amber-600 dark:text-amber-300" : ""
                          }`}
                        >
                          {Number(r.missingDatesCount || 0) > 0
                            ? `${Number(r.missingDatesCount)} missing`
                            : String(Number(r.missingDatesCount || 0))}
                        </td>
                        <td className="px-2 py-1.5 break-words text-rose-600 dark:text-rose-300">{r.lastError || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Phones: the same rows, one card each. */}
              <div className="space-y-2 md:hidden">
                {statusRows.map((r, i) => (
                  <div
                    key={`status-card-${statusRowKey(r, i)}`}
                    className={`rounded-xl border p-3 ${
                      isFailure(r.lastRunStatus)
                        ? "border-rose-400/50 bg-rose-500/5"
                        : "border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold">
                        {r.lpName || `LP #${r.lpAccountId}`} / {r.domain}
                      </div>
                      {statusPill(r.lastRunStatus)}
                    </div>
                    <dl className="mt-2 space-y-1 text-xs">
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Last succeeded covered date</dt>
                        <dd>{r.lastSucceededCoveredDate || "-"}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Last run completed</dt>
                        <dd>{formatDubaiInstant(r.lastRunCompletedAtUtc)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Missing days</dt>
                        <dd className={Number(r.missingDatesCount || 0) > 0 ? "font-semibold text-amber-600 dark:text-amber-300" : ""}>
                          {Number(r.missingDatesCount || 0) > 0
                            ? `${Number(r.missingDatesCount)} missing`
                            : String(Number(r.missingDatesCount || 0))}
                        </dd>
                      </div>
                    </dl>
                    {r.lastError ? (
                      <div className="mt-2 break-words text-xs text-rose-600 dark:text-rose-300">{r.lastError}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        {/* ---------------- Backfill ---------------- */}
        <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">Backfill</h2>
          <div className="mb-3 rounded-lg border-l-2 border-cyan-400/60 bg-cyan-500/5 px-3 py-2 text-xs text-muted-foreground">
            The scheduled ingest runs at 01:00 UTC daily and covers the previous date. Backfill makes the backend go and
            fetch from Finalto now, once per day in the window, so use it to fill a gap or force-refresh a window - not
            as a routine refresh. Nothing is submitted until you confirm the window.
          </div>

          {lpState.kind === "unauthorised" && (
            <div className="mb-3 rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              The LP list could not be read (HTTP {lpState.status} for /api/admin/finalto-tester/accounts) - this
              dashboard is not authorised for it. Backfill can still be submitted for all active Finalto LPs, or for a
              specific LP id typed on the Row viewer filters below.
            </div>
          )}
          {lpState.kind === "error" && (
            <div className="mb-3 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-200">
              The LP list could not be loaded: {lpState.message}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs">
              <span className="mb-1 block uppercase tracking-wide text-muted-foreground">LP account</span>
              <select value={bfLp} onChange={(e) => setBfLp(e.target.value)} aria-label="Backfill LP account" className={inputClass}>
                <option value="">-- All active Finalto LPs --</option>
                {lpAccounts.map((a) => (
                  <option key={`bf-lp-${a.id}`} value={String(a.id)}>
                    #{a.id} - {a.lpName || "(unnamed)"} ({a.apiLoginText || "no login"}) {a.environment || ""}
                    {a.isActive ? "" : " [INACTIVE]"}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              <span className="mb-1 block uppercase tracking-wide text-muted-foreground">Domain</span>
              <select
                value={bfDomain}
                onChange={(e) => setBfDomain(e.target.value as Domain)}
                aria-label="Backfill domain"
                className={inputClass}
              >
                {DOMAINS.map((d) => (
                  <option key={`bf-domain-${d}`} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              <span className="mb-1 block uppercase tracking-wide text-muted-foreground">From</span>
              <input type="date" value={bfFrom} onChange={(e) => setBfFrom(e.target.value)} aria-label="Backfill from" className={inputClass} />
            </label>
            <label className="text-xs">
              <span className="mb-1 block uppercase tracking-wide text-muted-foreground">To</span>
              <input type="date" value={bfTo} onChange={(e) => setBfTo(e.target.value)} aria-label="Backfill to" className={inputClass} />
            </label>
            <label className="flex items-start gap-2 text-xs sm:col-span-2">
              <input
                type="checkbox"
                checked={bfForce}
                onChange={(e) => setBfForce(e.target.checked)}
                aria-label="Backfill force"
                className="mt-0.5"
              />
              <span>
                Force
                <span className="block text-[10px] text-muted-foreground">
                  Re-runs days already marked Succeeded and overwrites what is stored for them.
                </span>
              </span>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void runBackfill()}
              disabled={bfBusy}
              className="rounded-md border border-amber-400/50 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-800 disabled:opacity-60 dark:text-amber-200"
            >
              {bfBusy ? "Backfilling..." : "Submit backfill"}
            </button>
            <span className="text-[11px] text-muted-foreground">
              {bfBusy ? "Running - a wide window can take 30s or more." : "Asks for confirmation before anything is submitted."}
            </span>
          </div>

          {bfResults && (
            <div className="mt-3">
              {bfResults.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  The backfill returned no day-runs. Nothing matched - check that the LP is an active Finalto account.
                </div>
              ) : (
                <div className="space-y-1">
                  {bfResults.map((r, i) => (
                    <div
                      key={`bf-result-${i}`}
                      className={`rounded-md border px-2 py-1.5 text-xs ${
                        isFailure(r.status)
                          ? "border-rose-400/50 bg-rose-500/10 text-rose-700 dark:text-rose-200"
                          : "border-slate-200 dark:border-slate-800"
                      }`}
                    >
                      <b>{r.date || "?"}</b> {r.domain || "?"} LP #{String(r.lpAccountId ?? "?")} - {String(r.status || "?")},{" "}
                      {Number(r.rowsUpserted || 0)} row{Number(r.rowsUpserted || 0) !== 1 ? "s" : ""} upserted
                      {r.elapsedMs != null ? `, ${r.elapsedMs}ms` : ""}
                      {r.error ? ` - ${r.error}` : ""}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ---------------- Row viewer ---------------- */}
        <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">Row viewer</h2>

          <div className="mb-3 flex flex-wrap gap-1">
            {DOMAINS.map((d) => (
              <button
                key={`tab-${d}`}
                type="button"
                onClick={() => switchTab(d)}
                aria-pressed={tab === d}
                className={`rounded-md border px-2.5 py-1 text-xs ${
                  tab === d
                    ? "border-cyan-400/50 bg-cyan-500/10 font-semibold text-cyan-700 dark:text-cyan-200"
                    : "border-slate-300 dark:border-slate-700"
                }`}
              >
                {d}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {FILTERS[tab].map((f) => (
              <label key={`filter-${tab}-${f.key}`} className="text-xs">
                <span className="mb-1 block uppercase tracking-wide text-muted-foreground">
                  {f.label}
                  {f.required ? " (required)" : ""}
                </span>
                {f.kind === "select" ? (
                  <select
                    value={filters[tab][f.key] ?? ""}
                    onChange={(e) => setFilter(f.key, e.target.value)}
                    aria-label={`${tab} ${f.label}`}
                    className={inputClass}
                  >
                    {(f.options ?? []).map((o) => (
                      <option key={`opt-${f.key}-${o}`} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.kind === "date" ? "date" : "number"}
                    value={filters[tab][f.key] ?? ""}
                    onChange={(e) => setFilter(f.key, e.target.value)}
                    placeholder={f.required ? "" : "optional"}
                    aria-label={`${tab} ${f.label}`}
                    className={inputClass}
                  />
                )}
              </label>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void fetchRows(1)}
              className="rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 dark:text-cyan-200"
            >
              Search
            </button>
            <button
              type="button"
              onClick={() => void fetchRows(pageNo - 1)}
              disabled={pageNo <= 1 || viewerState?.kind !== "ok"}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-60 dark:border-slate-700"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => void fetchRows(pageNo + 1)}
              disabled={viewerState?.kind !== "ok" || pageNo * PAGE_SIZE >= totalRows}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-60 dark:border-slate-700"
            >
              Next
            </button>
            <span className="text-[11px] text-muted-foreground">
              {viewerState?.kind === "ok"
                ? totalRows === 0
                  ? "0 rows"
                  : `Page ${pageNo} - rows ${(pageNo - 1) * PAGE_SIZE + 1}..${Math.min(pageNo * PAGE_SIZE, totalRows)} of ${totalRows}`
                : "No search yet."}
            </span>
          </div>

          {disclaimer && (
            <div className="mt-3 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              {disclaimer}
            </div>
          )}

          <div className="mt-3">
            {viewerState === null && (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center text-xs text-muted-foreground dark:border-slate-700 dark:bg-slate-900/40">
                Set the filters above and press Search. Nothing is queried until you do.
              </div>
            )}

            {viewerState && loadPanel(viewerState, `${tab} rows`, `/api/Finalto/${tab}`)}

            {viewerState?.kind === "ok" && rows.length === 0 && (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center dark:border-slate-700 dark:bg-slate-900/40">
                <div className="text-sm font-semibold text-foreground">No {tab} rows match these filters.</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  The query succeeded and returned nothing. If you expected rows, check the ingest status above - the
                  window may never have been ingested.
                </div>
              </div>
            )}

            {viewerState?.kind === "ok" && rows.length > 0 && (
              <>
                <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block dark:border-slate-800">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-100 dark:bg-slate-900/80">
                      <tr>
                        {COLUMNS[tab].map((c) => (
                          <th key={`th-${tab}-${c.field}`} className="whitespace-nowrap px-2 py-2 text-left">
                            {c.header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr key={`row-${i}`} className="border-t border-slate-200 align-top dark:border-slate-800">
                          {COLUMNS[tab].map((c) => (
                            <td key={`td-${tab}-${c.field}-${i}`} className="px-2 py-1.5">
                              {c.json ? jsonCell(row, c, i) : cellText(row, c)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Phones: the same rows, one card each. */}
                <div className="space-y-2 md:hidden">
                  {rows.map((row, i) => (
                    <div
                      key={`row-card-${i}`}
                      className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40"
                    >
                      <dl className="space-y-1 text-xs">
                        {COLUMNS[tab].map((c) => (
                          <div key={`dd-${tab}-${c.field}-${i}`} className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">{c.header}</dt>
                            <dd className="break-words text-right">{c.json ? jsonCell(row, c, i) : cellText(row, c)}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );

};
