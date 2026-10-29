/**
 * Sales department — commission at $1 per realized CFD/FX lot.
 *
 * The approved design is
 * docs/superpowers/specs/2026-10-26-sales-commission-page-design.md; the
 * contract is GET /api/sales/commission (sales/commissionRoute.js).
 *
 * THIS PAGE RENDERS FROM `scope` AND NEVER FROM THE LOCAL ROLE. Roles and
 * `access[]` live in localStorage (src/lib/auth.ts), so a salesperson can edit
 * their own role and a UI filter is tidiness, not confidentiality (spec §4).
 * The server resolves the caller from the verified JWT and sends a salesperson
 * no revenue field at all — not null, absent — so the only honest way to render
 * is to reflect what arrived. Nothing in this file reads getCurrentUser, a role
 * string or localStorage, and `src/pages/departments/salesScopeSource.test.ts`
 * fails the build if that changes.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronDown, ChevronRight } from "lucide-react";
import { authHeaders } from "@/lib/auth";
// The same "this month" the dealing pages default to, built from LOCAL date
// parts (formatLocalYmd): ClientVolume's dates are MT5 server-local, so a
// toISOString() default could ask for the wrong day near midnight.
import { resolveVolumeRange } from "@/lib/clientVolumeApi";

const COMMISSION_URL = "/api/sales/commission";

// ── the contract ─────────────────────────────────────────────────────────────
// Every revenue field is optional because for a salesperson it is ABSENT, not
// null. `undefined` is therefore a real state with its own rendering ("no
// revenue figure exists"), which is why none of these carry a `| null`.

type SalesClient = {
  crmUserId: number;
  name: string;
  logins: string[];
  lots: number;
  stocksLots: number;
  cfdLots: number;
  commissionUsd: number;
  revenueUsd?: number;
  marginAfterCommissionUsd?: number;
  /** DEAL lots -- the volume revenue was earned over. Never a commission basis. */
  dealLots?: number;
  revenueMatched?: boolean;
  revenueRowCount?: number;
};

type Salesperson = {
  managerId: number;
  name: string;
  clientCount: number;
  tradingClientCount: number;
  lots: number;
  stocksLots: number;
  cfdLots: number;
  commissionUsd: number;
  revenueUsd?: number;
  marginAfterCommissionUsd?: number;
  dealLots?: number;
  clients: SalesClient[];
};

type CommissionReport = {
  scope: "all" | "self";
  managerId?: number;
  range: { from: string; to: string };
  rate: { usdPerCfdLot: number; basis: string };
  totals: {
    lots: number;
    stocksLots: number;
    cfdLots: number;
    commissionUsd: number;
    revenueUsd?: number;
    marginAfterCommissionUsd?: number;
    dealLots?: number;
  };
  salespeople: Salesperson[];
  join: {
    volumeRowCount: number;
    volumeRowsMatched: number;
    volumeRowsOutOfScope: number;
    clientsWithNoActivity: number;
    warnings: string[];
    volumeWindow?: { fromDate: string; toDate: string; activeDays: number };
    revenueRowCount?: number;
    revenueRowsMatched?: number;
    revenueRowsNotMatchedToScope?: number;
    clientsMissingRevenue?: number;
    clientsWithMultipleRevenueRows?: number;
  };
  revenue?: { available: boolean; reason?: string };
  degraded: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A body that is not a commission report at all — a proxy's empty response, an
 * HTML error page — must read as a failed load. Rendering it would build a
 * calm-looking page of zeroes out of nothing, and a zero here is a wage.
 *
 * `scope` is checked against the two values the server can send, because every
 * confidentiality decision below is taken from it: a body with no scope must
 * never fall through to the all-salespeople branch.
 */
function isCommissionReport(body: unknown): body is CommissionReport {
  if (!isRecord(body)) return false;
  if (body.scope !== "all" && body.scope !== "self") return false;
  return (
    isRecord(body.range) &&
    isRecord(body.rate) &&
    isRecord(body.totals) &&
    isRecord(body.join) &&
    Array.isArray(body.salespeople) &&
    Array.isArray(body.degraded)
  );
}

function errorCode(body: unknown): string {
  return isRecord(body) && typeof body.error === "string" ? body.error : "";
}

/**
 * What went wrong, in the reader's terms.
 *
 * `crm_unavailable` and `volume_unavailable` are deliberately not softened into
 * "no data": the route answers 502 for exactly the two legs it cannot degrade,
 * and an empty page would be read as "nobody traded".
 */
function messageForError(status: number, code: string): string {
  if (code === "forbidden" || status === 403) {
    return "The server will not release commission figures to this account. A salesperson needs their CRM manager id set in User Management; anyone else needs the Super Admin role.";
  }
  if (code === "from_and_to_required") return "Pick both a start and an end date.";
  if (code === "invalid_date") return "One of those dates is not a real calendar date.";
  if (code === "from_after_to") return "The start date is after the end date.";
  if (code === "range_too_long") return "That range is longer than 366 days. Narrow it and try again.";
  if (code === "crm_unavailable") {
    return "The CRM did not answer, so there is no way to say which clients belong to which salesperson. Nothing is shown rather than a page of zeroes.";
  }
  if (code === "volume_unavailable") {
    return "The volume service did not answer. Lots are the commission basis itself, so nothing is shown rather than a page of zeroes.";
  }
  return "Could not load the commission report.";
}

// ── formatting ───────────────────────────────────────────────────────────────

const fmtLots = (n: number | null | undefined) =>
  Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// formatDollar/formatDollarText are the dealing pages' own helpers, repeated
// here rather than imported because both are module-private to
// DealingDepartmentPage.tsx -- and lifting them into a shared module would take
// them out of the file src/pages/departments/formatterUsage.test.ts scans,
// silently disabling the guard that keeps a JSX formatter out of a template
// literal. This file is added to that test's list instead.
const formatDollarText = (value: number) =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatDollar = (value: number) => {
  const abs = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (value === 0) return <span className="text-slate-500">$0.00</span>;
  if (value > 0) return <span className="text-emerald-700 dark:text-emerald-300">${abs}</span>;
  return <span className="text-rose-700 dark:text-rose-300">-${abs}</span>;
};

/**
 * A revenue or margin figure, or the reason there is none.
 *
 * NEVER falls back to zero. `degraded: ["revenue"]` means the DealMatch fetch
 * failed and the keys are absent; printing $0.00 for that would state that the
 * company earned nothing from this client, which is a different claim from "we
 * could not ask" and happens to be the one that makes commission look like a
 * pure loss.
 */
const formatRevenue = (value: number | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return <span className="text-amber-700 dark:text-amber-300">unavailable</span>;
  }
  return formatDollar(value);
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ── shared classes, following CrmEventsPage / the dealing tabs ────────────────

const SECTION_TITLE = "text-sm font-semibold uppercase tracking-wide text-primary";
const ALERT_WARN =
  "rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200";
const ALERT_BAD =
  "rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-200";
// `whitespace-nowrap` everywhere except the name column: this page is read on a
// phone, where letting six columns compete for 375px crushes the names into
// four-line stacks and wraps "Total traded lots" into a three-line header.
// Letting the table keep its natural width and scroll sideways is the readable
// trade, so the name column carries the only min-width.
const TH = "whitespace-nowrap px-3 py-2 text-left font-medium";
const TH_NUM = "whitespace-nowrap px-3 py-2 text-right font-medium";
const TD = "px-3 py-2 min-w-[11rem]";
const TD_NUM = "whitespace-nowrap px-3 py-2 text-right tabular-nums";
// Commissioned lots carry the dealing pages' purple, so the same figure keeps
// the same colour wherever it appears on the dashboard.
const CFD_TONE = "text-[#c084fc]";

// ── summary cards ────────────────────────────────────────────────────────────

// ONE ROW, always. `flex-1` lets the cards share the width evenly when they
// fit, and `min-w` stops them shrinking into unreadable slivers when they do
// not -- at which point the strip scrolls sideways rather than wrapping the
// sixth card onto a line of its own. 9.5rem holds a $300,000.00 at text-lg.
const CARD =
  "min-w-[9.5rem] flex-1 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800/80 dark:bg-slate-950/70";

/**
 * One headline figure, with the formula that produced it underneath.
 *
 * The formula is a single short line, not a paragraph. A reader who wants to
 * know why a 1,219.04 pays $1,219.04 gets it from `lots × $1.00` in the place
 * they are already looking; the caveats that cannot fit on one line live in the
 * collapsed block at the foot of the page instead of above the numbers.
 */
function StatCard({
  label,
  value,
  formula,
  tone = "",
  testId,
}: {
  label: string;
  value: React.ReactNode;
  formula: string;
  tone?: string;
  testId?: string;
}) {
  return (
    <div className={CARD} data-testid={testId}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold ${tone}`}>{value}</div>
      <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{formula}</div>
    </div>
  );
}

// ── client rows ──────────────────────────────────────────────────────────────

/**
 * One salesperson's clients, as rows of the table they sit under.
 *
 * `showRevenue` is passed in from the single scope decision made in the page
 * body; it is deliberately not re-derived from whether a row happens to carry
 * `revenueUsd`, because a row-level check would render whatever arrived instead
 * of what the caller is entitled to see.
 */
function ClientRows({
  clients,
  showRevenue,
  showStocks,
  columns,
  indent = false,
}: {
  clients: SalesClient[];
  showRevenue: boolean;
  showStocks: boolean;
  columns: number;
  indent?: boolean;
}) {
  if (clients.length === 0) {
    return (
      <tr>
        <td colSpan={columns} className={`${TD} text-xs text-muted-foreground ${indent ? "pl-9" : ""}`}>
          No clients traded in this window.
        </td>
      </tr>
    );
  }
  return (
    <>
      {clients.map((client) => (
        <tr
          key={client.crmUserId}
          data-testid={`sales-client-${client.crmUserId}`}
          className="border-t border-slate-100 align-top dark:border-slate-900"
        >
          <td className={`${TD} ${indent ? "pl-9" : ""}`}>
            <div className="text-foreground">{client.name}</div>
            <div className="text-[11px] text-muted-foreground">
              {client.logins.length > 0 ? client.logins.join(", ") : "no MT5 login"}
            </div>
            {/* Text in the cell, not a `title`: this dashboard is read on a
                phone, where a hover does not exist and a long-press selects
                text -- a tooltip is the same as deleting the reason. */}
            {showRevenue && client.revenueMatched === false ? (
              <div className="text-[11px] text-amber-700 dark:text-amber-300">
                revenue not matched — margin understated
              </div>
            ) : null}
            {showRevenue && (client.revenueRowCount ?? 0) > 1 ? (
              <div className="text-[11px] text-amber-700 dark:text-amber-300">
                {plural(client.revenueRowCount ?? 0, "revenue row")} summed
              </div>
            ) : null}
          </td>
          <td className={`${TD_NUM} ${CFD_TONE}`}>{fmtLots(client.cfdLots)}</td>
          {showStocks ? (
            <td className={`${TD_NUM} text-slate-500 dark:text-slate-400`}>{fmtLots(client.stocksLots)}</td>
          ) : null}
          {showRevenue ? (
            <td className={`${TD_NUM} text-slate-500 dark:text-slate-400`}>{fmtLots(client.dealLots)}</td>
          ) : null}
          <td className={`${TD_NUM} font-medium`}>{formatDollar(client.commissionUsd)}</td>
          {showRevenue ? <td className={TD_NUM}>{formatRevenue(client.revenueUsd)}</td> : null}
          {showRevenue ? (
            <td
              className={`${TD_NUM} ${client.revenueMatched === false ? "text-amber-700 dark:text-amber-300" : ""}`}
            >
              {formatRevenue(client.marginAfterCommissionUsd)}
            </td>
          ) : null}
        </tr>
      ))}
    </>
  );
}

// ── the page ─────────────────────────────────────────────────────────────────

export function SalesDepartmentPage() {
  // Default: the current month (spec §2), the same preset the dealing pages use.
  const initialRange = useMemo(() => resolveVolumeRange("month", new Date()), []);
  const [fromYmd, setFromYmd] = useState(initialRange.from);
  const [toYmd, setToYmd] = useState(initialRange.to);
  // The range the figures on screen belong to, which only moves on Apply: the
  // inputs must not refetch a 45-second report on every keystroke.
  const [applied, setApplied] = useState(initialRange);
  const [report, setReport] = useState<CommissionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number[]>([]);
  // Which request is the latest. Applying twice quickly puts two in flight, and
  // DealMatch/Run costs ~40s whatever the window, so the slower one can land
  // last and print figures for the range nobody is looking at any more.
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latestRequest.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from: applied.from, to: applied.to });
      // Our own Express route behind authRequired, so the dashboard's bearer has
      // to ride along; the CRM and backend tokens are attached server-side.
      const resp = await fetch(`${COMMISSION_URL}?${params.toString()}`, { headers: { ...authHeaders() } });
      const body: unknown = await resp.json().catch(() => null);
      if (mine !== latestRequest.current) return;
      if (!resp.ok) {
        setError(messageForError(resp.status, errorCode(body)));
        setReport(null);
        return;
      }
      if (!isCommissionReport(body)) throw new Error("not a commission report");
      setReport(body);
    } catch {
      if (mine !== latestRequest.current) return;
      // The upstream message can name an internal host, so it is not shown.
      setError("Could not load the commission report.");
      setReport(null);
    } finally {
      if (mine === latestRequest.current) setLoading(false);
    }
  }, [applied]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (managerId: number) =>
    setExpanded((prev) => (prev.includes(managerId) ? prev.filter((id) => id !== managerId) : [...prev, managerId]));

  // ── THE ONE SCOPE DECISION ────────────────────────────────────────────────
  // Revenue columns exist for the caller the server gave scope "all", and for
  // nobody else -- however their locally stored role reads, and whatever stray
  // revenue key a response might carry. A salesperson's payload has no revenue
  // key at all, so there is nothing for this page to leak even by accident.
  //
  // Whether a FIGURE exists is a separate question, answered per value by
  // formatRevenue: the columns stay put when the fetch failed and read
  // "unavailable", rather than disappearing from a table whose shape an
  // elevated reader compares week to week.
  const showRevenue = report?.scope === "all";
  // Only the elevated caller is ever told that revenue is missing: for a sales
  // caller "revenue unavailable" is still a statement about revenue.
  // `!== true` rather than `=== false` so that a response with no revenue key
  // at all is also read as missing -- the safe direction to be wrong in.
  const revenueMissing =
    report?.scope === "all" && (report.degraded.includes("revenue") || report.revenue?.available !== true);

  const warnings = report?.join.warnings ?? [];
  const volumeWindow = report?.join.volumeWindow;
  // What ClientVolume actually answered, which §2 records differing from what
  // was asked (six days returned for a seven-day week). A dropped day is a day
  // of somebody's lots, so a disagreement is said out loud; agreement is not
  // worth a line.
  const windowDiffers = Boolean(
    volumeWindow &&
      report &&
      ((volumeWindow.fromDate && volumeWindow.fromDate !== report.range.from) ||
        (volumeWindow.toDate && volumeWindow.toDate !== report.range.to)),
  );

  // ONE lots column, because on live data there is only one number to show:
  // `stocksLots` is 0.00 for every client in this book, so `lots` and `cfdLots`
  // are the same figure and printing both put the same number on screen twice.
  // The stocks column therefore appears only when there is equity to disclose
  // -- which keeps the day a sales client trades shares from silently dropping
  // volume the commission does not pay on.
  const showStocks = (report?.totals.stocksLots ?? 0) > 0;

  // Name, lots, commission -- plus stocks when there is equity, and deal lots,
  // revenue and margin for the elevated caller. Deal lots ride with revenue
  // because they come from the same DealMatch payload, which is not fetched at
  // all for a salesperson. Used for the colSpan of the empty-book row.
  const columns = 3 + (showStocks ? 1 : 0) + (showRevenue ? 3 : 0);

  return (
    <div className="space-y-3">
      {/* ── range picker, following MarketingDepartmentPage ── */}
      <section className="rounded-2xl border border-border/60 bg-card/75 p-3 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground">Sales</div>
            <div className="mt-1 text-sm font-semibold text-foreground">
              Commission
              {report ? ` — ${formatDollarText(report.rate.usdPerCfdLot)} per commissioned lot` : ""}
            </div>
          </div>
          <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3 lg:w-auto">
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>From</span>
              <input
                type="date"
                aria-label="From"
                value={fromYmd}
                onChange={(e) => setFromYmd(e.target.value)}
                className="h-9 w-full rounded-md border border-border/60 bg-background px-2 text-sm text-foreground outline-none ring-primary/40 focus:ring"
              />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>To</span>
              <input
                type="date"
                aria-label="To"
                value={toYmd}
                onChange={(e) => setToYmd(e.target.value)}
                className="h-9 w-full rounded-md border border-border/60 bg-background px-2 text-sm text-foreground outline-none ring-primary/40 focus:ring"
              />
            </label>
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => setApplied({ from: fromYmd, to: toYmd })}
                disabled={loading}
                className="inline-flex h-9 items-center gap-1 rounded-md border border-primary/40 bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                <CalendarDays className="h-4 w-4" /> Apply
              </button>
            </div>
          </div>
        </div>
      </section>

      {error ? (
        <div role="alert" className={ALERT_BAD}>
          {error}
        </div>
      ) : null}

      {loading ? (
        /* Deliberately says nothing about revenue: this line is on screen for a
           salesperson too, and a loading message is still a statement about
           what is being fetched. */
        <p className="text-sm text-muted-foreground">Loading… about 40 seconds.</p>
      ) : null}

      {report ? (
        <>
          {revenueMissing ? (
            <div role="alert" className={ALERT_WARN}>
              Revenue is unavailable for this window — missing, not zero. Commission is unaffected.
            </div>
          ) : null}

          {windowDiffers ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Lots cover {volumeWindow?.fromDate || "?"} → {volumeWindow?.toDate || "?"}, a different window from the
              one asked for.
            </p>
          ) : null}

          {/* ── the totals, each with the formula that produced it ──
              A single row of up to six, scrolling sideways on a narrow screen
              instead of wrapping: five across with a sixth stranded underneath
              read as two unrelated groups. */}
          <div data-testid="sales-totals" className="flex gap-2 overflow-x-auto pb-1">
            <StatCard
              label="Lots"
              value={fmtLots(report.totals.cfdLots)}
              formula="realized CFD/FX · a closed round trip counts once"
              tone={CFD_TONE}
              testId="total-cfd-lots"
            />
            <StatCard
              label="Commission"
              value={formatDollar(report.totals.commissionUsd)}
              formula={`lots × ${formatDollarText(report.rate.usdPerCfdLot)}`}
              testId="total-commission"
            />
            {showStocks ? (
              <StatCard
                label="Stocks lots"
                value={fmtLots(report.totals.stocksLots)}
                formula="equity volume · never paid on"
                tone="text-slate-500 dark:text-slate-400"
                testId="total-stocks-lots"
              />
            ) : null}
            {showRevenue ? (
              <StatCard
                label="Deal lots"
                value={fmtLots(report.totals.dealLots)}
                formula="every MT5 deal · a round trip is two"
                tone="text-slate-500 dark:text-slate-400"
                testId="total-deal-lots"
              />
            ) : null}
            {showRevenue ? (
              <StatCard
                label="Revenue"
                value={formatRevenue(report.totals.revenueUsd)}
                formula="markup + client comm + swap − LP comm"
                testId="total-revenue"
              />
            ) : null}
            {showRevenue ? (
              <StatCard
                label="Margin"
                value={formatRevenue(report.totals.marginAfterCommissionUsd)}
                formula="revenue − commission"
                testId="total-margin"
              />
            ) : null}
          </div>

          <section className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className={SECTION_TITLE}>{report.scope === "all" ? "Per salesperson" : "Your clients"}</h2>
              <span className="text-xs tabular-nums text-muted-foreground">
                {report.range.from} → {report.range.to}
              </span>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-[11px] uppercase tracking-wide text-muted-foreground dark:bg-slate-900/80">
                  <tr>
                    <th className={TH}>{report.scope === "all" ? "Salesperson" : "Client"}</th>
                    <th className={TH_NUM}>Lots</th>
                    {showStocks ? <th className={TH_NUM}>Stocks lots (unpaid)</th> : null}
                    {showRevenue ? <th className={TH_NUM}>Deal lots</th> : null}
                    <th className={TH_NUM}>Commission</th>
                    {showRevenue ? <th className={TH_NUM}>Revenue</th> : null}
                    {showRevenue ? <th className={TH_NUM}>Margin</th> : null}
                  </tr>
                </thead>

                {report.scope === "all"
                  ? report.salespeople.map((person) => (
                      <Fragment key={person.managerId}>
                        <tbody>
                          <tr
                            data-testid={`sales-card-${person.managerId}`}
                            className="border-t border-slate-200 dark:border-slate-800"
                          >
                            <td className={TD}>
                              <button
                                type="button"
                                onClick={() => toggle(person.managerId)}
                                aria-expanded={expanded.includes(person.managerId)}
                                aria-label={
                                  expanded.includes(person.managerId)
                                    ? `Hide ${person.name}'s clients`
                                    : `Show ${person.name}'s clients (${person.clients.length})`
                                }
                                className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary"
                              >
                                {expanded.includes(person.managerId) ? (
                                  <ChevronDown className="h-4 w-4 shrink-0" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 shrink-0" />
                                )}
                                {person.name}
                              </button>
                              <div className="pl-5 text-[11px] text-muted-foreground">
                                {person.tradingClientCount} of {plural(person.clientCount, "client")} traded
                              </div>
                            </td>
                            <td className={`${TD_NUM} ${CFD_TONE}`}>{fmtLots(person.cfdLots)}</td>
                            {showStocks ? (
                              <td className={`${TD_NUM} text-slate-500 dark:text-slate-400`}>
                                {fmtLots(person.stocksLots)}
                              </td>
                            ) : null}
                            {showRevenue ? (
                              <td className={`${TD_NUM} text-slate-500 dark:text-slate-400`}>
                                {fmtLots(person.dealLots)}
                              </td>
                            ) : null}
                            <td className={`${TD_NUM} font-semibold`}>{formatDollar(person.commissionUsd)}</td>
                            {showRevenue ? <td className={TD_NUM}>{formatRevenue(person.revenueUsd)}</td> : null}
                            {showRevenue ? (
                              <td className={TD_NUM}>{formatRevenue(person.marginAfterCommissionUsd)}</td>
                            ) : null}
                          </tr>
                        </tbody>
                        {expanded.includes(person.managerId) ? (
                          <tbody data-testid={`sales-clients-${person.managerId}`}>
                            <ClientRows
                              clients={person.clients}
                              showRevenue={Boolean(showRevenue)}
                              showStocks={showStocks}
                              columns={columns}
                              indent
                            />
                          </tbody>
                        ) : null}
                      </Fragment>
                    ))
                  : report.salespeople.map((person) => (
                      <tbody key={person.managerId} data-testid={`sales-clients-${person.managerId}`}>
                        <ClientRows
                          clients={person.clients}
                          showRevenue={Boolean(showRevenue)}
                          showStocks={showStocks}
                          columns={columns}
                        />
                      </tbody>
                    ))}

                <tfoot className="border-t-2 border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/60">
                  <tr>
                    <td className={`${TD} font-semibold`}>Total</td>
                    <td className={`${TD_NUM} font-semibold ${CFD_TONE}`}>
                      {fmtLots(report.totals.cfdLots)}
                    </td>
                    {showStocks ? (
                      <td
                        className={`${TD_NUM} font-semibold text-slate-500 dark:text-slate-400`}

                      >
                        {fmtLots(report.totals.stocksLots)}
                      </td>
                    ) : null}
                    {showRevenue ? (
                      <td
                        className={`${TD_NUM} font-semibold text-slate-500 dark:text-slate-400`}

                      >
                        {fmtLots(report.totals.dealLots)}
                      </td>
                    ) : null}
                    <td className={`${TD_NUM} font-semibold`}>
                      {formatDollar(report.totals.commissionUsd)}
                    </td>
                    {showRevenue ? (
                      <td className={`${TD_NUM} font-semibold`}>
                        {formatRevenue(report.totals.revenueUsd)}
                      </td>
                    ) : null}
                    {showRevenue ? (
                      <td className={`${TD_NUM} font-semibold`}>
                        {formatRevenue(report.totals.marginAfterCommissionUsd)}
                      </td>
                    ) : null}
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {/* ── the caveats that do not fit on a card, collapsed ──
              Closed by default: these are what a reader opens when a figure
              looks wrong, not something to read past every time. Revenue and
              margin are gated on `showRevenue` like every other mention of
              them, so a salesperson's page has no definition of a figure they
              were never sent. */}
          <details className="rounded-xl border border-slate-200 bg-white dark:border-slate-800/80 dark:bg-slate-950/70">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-foreground">
              How these are calculated
              {/* A closed block hides whatever is inside it, and one of the
                  things inside it is "these revenue figures may be double
                  counted". The count rides on the summary so a reader who
                  never opens the block still knows there is something to
                  open. */}
              {warnings.length > 0 ? (
                <span className="ml-2 font-normal text-amber-700 dark:text-amber-300">
                  · {plural(warnings.length, "caveat")} from this run
                </span>
              ) : null}
            </summary>
            <dl className="space-y-2 px-3 pb-3 text-xs text-muted-foreground">
              <div>
                <dt className="font-medium text-foreground">Lots</dt>
                <dd>
                  Realized CFD/FX lots from the trading backend. A closed round trip counts once. Equity is excluded
                  and never paid on, so a client who trades only shares earns nothing.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Commission</dt>
                <dd>
                  Lots × {formatDollarText(report.rate.usdPerCfdLot)}. Built from lots alone — nothing else on this
                  page can change it.
                </dd>
              </div>
              {showRevenue ? (
                <>
                  <div>
                    <dt className="font-medium text-foreground">Deal lots</dt>
                    <dd>
                      Every MT5 deal, from the same Deal Match rows the revenue column comes from. A round trip is two
                      deals, so this runs roughly double Lots. It is never a commission basis.
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Revenue</dt>
                    <dd>
                      The backend&apos;s own figure: markup + client commission + swap − LP commission. Matched to
                      clients by MT5 login.{" "}
                      <span className="font-medium text-amber-700 dark:text-amber-300">
                        It is not net of IB rebate
                      </span>{" "}
                      — an IB-referred client&apos;s rebate is still to come out of this.
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Margin</dt>
                    <dd>Revenue − commission. Before IB rebate, because the revenue above it is.</dd>
                  </div>
                </>
              ) : null}
              {/* The backend's own warnings, verbatim and last: they are what
                  this particular run has to say about itself, and they belong
                  beside the definitions they qualify rather than in a banner
                  over the numbers. Not gated on `showRevenue` and safe not to
                  be: commissionCore pushes a revenue warning only when revenue
                  was computed, so a salesperson's array can only ever hold the
                  ClientVolume window line. */}
              {warnings.length > 0 ? (
                <div>
                  <dt className="font-medium text-amber-700 dark:text-amber-300">Caveats from this run</dt>
                  <dd>
                    {warnings.length === 1 ? (
                      warnings[0]
                    ) : (
                      <ul className="list-disc space-y-1 pl-4">
                        {warnings.map((warning, i) => (
                          <li key={`${i}-${warning}`}>{warning}</li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </div>
              ) : null}
            </dl>
          </details>
        </>
      ) : null}
    </div>
  );
}
