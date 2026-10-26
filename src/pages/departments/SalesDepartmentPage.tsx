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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
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

const CARD = "rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800/80 dark:bg-slate-950/70";
const SECTION_TITLE = "mb-2 text-sm font-semibold uppercase tracking-wide text-primary";
const ALERT_WARN =
  "rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-3 text-sm text-amber-800 dark:text-amber-200";
const ALERT_BAD =
  "rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-3 text-sm text-rose-700 dark:text-rose-200";
const TH = "p-2 text-left";
const TH_NUM = "p-2 text-right";
const TD_NUM = "p-2 text-right tabular-nums";
// CFD lots carry the dealing pages' purple and stocks their blue, so the same
// figure keeps the same colour across the dashboard.
const CFD_TONE = "text-[#c084fc]";

// ── the client table, shared by both views ───────────────────────────────────

/**
 * One salesperson's clients.
 *
 * `showRevenue` is passed in from the single scope decision made in the page
 * body; it is deliberately not re-derived from whether a row happens to carry
 * `revenueUsd`, because a row-level check would render whatever arrived instead
 * of what the caller is entitled to see.
 */
function ClientTable({ clients, showRevenue }: { clients: SalesClient[]; showRevenue: boolean }) {
  if (clients.length === 0) {
    return (
      <p className="p-2 text-xs text-muted-foreground">
        No clients traded in this window. An empty book is a zero, not a missing salesperson.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
      <table className="w-full text-xs">
        <thead className="bg-slate-100 text-[11px] uppercase tracking-wide text-muted-foreground dark:bg-slate-900/80">
          <tr>
            <th className={TH}>Client</th>
            {/* The two paid columns are first and say so in their own headers.
                Someone reading a 240 in "stocks lots" as $240 owed is the
                specific misreading this ordering and this wording exist to
                stop. */}
            <th className={TH_NUM}>
              CFD lots <span className="normal-case">(paid on)</span>
            </th>
            <th className={TH_NUM}>Commission USD</th>
            <th className={TH_NUM}>
              All lots <span className="normal-case">(not paid)</span>
            </th>
            <th className={TH_NUM}>
              Stocks lots <span className="normal-case">(not paid)</span>
            </th>
            {showRevenue ? <th className={TH_NUM}>Revenue USD</th> : null}
            {showRevenue ? <th className={TH_NUM}>Margin after commission</th> : null}
          </tr>
        </thead>
        <tbody>
          {clients.map((client) => (
            <tr
              key={client.crmUserId}
              data-testid={`sales-client-${client.crmUserId}`}
              className="border-t border-slate-200 align-top dark:border-slate-800"
            >
              <td className="p-2">
                <div className="font-medium text-foreground">{client.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {client.logins.length > 0 ? `login ${client.logins.join(", ")}` : "no MT5 login"}
                </div>
                {/* Text in the cell, not a `title`: this dashboard is read on a
                    phone, where a hover does not exist and a long-press selects
                    text -- a tooltip is the same as deleting the reason. */}
                {showRevenue && client.revenueMatched === false ? (
                  <div className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                    revenue not matched — margin understated
                  </div>
                ) : null}
                {showRevenue && (client.revenueRowCount ?? 0) > 1 ? (
                  <div className="text-[11px] text-amber-700 dark:text-amber-300">
                    {plural(client.revenueRowCount ?? 0, "revenue row")} summed — the table is documented as one per
                    client
                  </div>
                ) : null}
              </td>
              <td className={`${TD_NUM} ${CFD_TONE}`}>{fmtLots(client.cfdLots)}</td>
              <td className={`${TD_NUM} font-semibold`}>{formatDollar(client.commissionUsd)}</td>
              <td className={`${TD_NUM} text-slate-500 dark:text-slate-400`}>{fmtLots(client.lots)}</td>
              <td className={`${TD_NUM} text-slate-500 dark:text-slate-400`}>{fmtLots(client.stocksLots)}</td>
              {showRevenue ? <td className={TD_NUM}>{formatRevenue(client.revenueUsd)}</td> : null}
              {showRevenue ? (
                <td className={`${TD_NUM} ${client.revenueMatched === false ? "text-amber-700 dark:text-amber-300" : ""}`}>
                  {formatRevenue(client.marginAfterCommissionUsd)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One label/value row inside a salesperson card. Real text on both sides. */
function CardRow({ label, value, muted = false }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span className={`text-xs ${muted ? "text-muted-foreground" : "text-slate-600 dark:text-slate-300"}`}>
        {label}
      </span>
      <span className="text-sm tabular-nums">{value}</span>
    </div>
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
  // of somebody's lots, so the answered window is printed either way and marked
  // when it disagrees.
  const windowDiffers = Boolean(
    volumeWindow &&
      report &&
      ((volumeWindow.fromDate && volumeWindow.fromDate !== report.range.from) ||
        (volumeWindow.toDate && volumeWindow.toDate !== report.range.to)),
  );

  return (
    <div className="space-y-4">
      {/* ── range picker, following MarketingDepartmentPage ── */}
      <section className="rounded-2xl border border-border/60 bg-card/75 p-3 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground">Sales</div>
            <div className="mt-1 text-sm font-semibold text-foreground">Commission — $1 per realized CFD/FX lot</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Recalculated live from the CRM and the trading backend; nothing is stored, so a past month can move if the
              backend restates. This page reports commission, it is not a payout record.
            </p>
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
        <p className="text-sm text-muted-foreground">
          {/* Deliberately says nothing about revenue: this line is on screen for
              a salesperson too, and a loading message is still a statement
              about what is being fetched. */}
          Loading… the trading backend takes about 40 seconds to answer, whatever range is asked for.
        </p>
      ) : null}

      {report ? (
        <>
          {/* ── degraded: commission is still exact ── */}
          {revenueMissing ? (
            <div role="alert" className={ALERT_WARN}>
              <div className="font-medium">Revenue could not be loaded. Commission below is still exact.</div>
              <p className="mt-1">
                Commission is built from CFD lots and never from revenue, so every figure in the commission columns is
                final. The revenue and margin columns are <span className="font-medium">missing, not zero</span> — no
                revenue figure was obtained for this window.
              </p>
            </div>
          ) : null}

          {/* ── the backend's own plain-English warnings, verbatim ── */}
          {warnings.length > 0 ? (
            <div role="alert" className={ALERT_WARN}>
              <div className="font-medium">Read this before using the figures below.</div>
              <ul className="mt-1 list-disc pl-5">
                {warnings.map((warning, i) => (
                  <li key={`${i}-${warning}`}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* ── what was asked for, and what the lots actually cover ── */}
          <p className={`text-xs ${windowDiffers ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>
            Asked for {report.range.from} → {report.range.to}.
            {volumeWindow
              ? ` Lots cover ${volumeWindow.fromDate || "?"} → ${volumeWindow.toDate || "?"} (${plural(
                  volumeWindow.activeDays,
                  "active day",
                )})${windowDiffers ? " — a different window from the one asked for." : "."}`
              : " The volume service did not say which window it answered."}
          </p>

          {/* ── totals ── */}
          <section>
            <h2 className={SECTION_TITLE}>
              {report.scope === "all" ? "All salespeople" : "Your totals"} · {report.range.from} → {report.range.to}
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <div className={CARD} data-testid="total-cfd-lots">
                <div className="text-xs text-muted-foreground">CFD lots (paid on)</div>
                <div className={`mt-1 font-mono text-xl font-semibold ${CFD_TONE}`}>{fmtLots(report.totals.cfdLots)}</div>
              </div>
              <div className={CARD} data-testid="total-commission">
                <div className="text-xs text-muted-foreground">Commission owed</div>
                <div className="mt-1 font-mono text-xl font-semibold">{formatDollar(report.totals.commissionUsd)}</div>
              </div>
              <div className={CARD} data-testid="total-lots">
                <div className="text-xs text-muted-foreground">All lots (not paid)</div>
                <div className="mt-1 font-mono text-xl font-semibold text-slate-500 dark:text-slate-400">
                  {fmtLots(report.totals.lots)}
                </div>
              </div>
              <div className={CARD} data-testid="total-stocks-lots">
                <div className="text-xs text-muted-foreground">Stocks lots (not paid)</div>
                <div className="mt-1 font-mono text-xl font-semibold text-slate-500 dark:text-slate-400">
                  {fmtLots(report.totals.stocksLots)}
                </div>
              </div>
              {/* Rendered for the elevated caller only, and "unavailable" rather
                  than $0.00 when the revenue leg failed. */}
              {report.scope === "all" ? (
                <div className={CARD} data-testid="total-revenue">
                  <div className="text-xs text-muted-foreground">Revenue earned</div>
                  <div className="mt-1 font-mono text-xl font-semibold">{formatRevenue(report.totals.revenueUsd)}</div>
                </div>
              ) : null}
              {report.scope === "all" ? (
                <div className={CARD} data-testid="total-margin">
                  <div className="text-xs text-muted-foreground">Margin after commission</div>
                  <div className="mt-1 font-mono text-xl font-semibold">
                    {formatRevenue(report.totals.marginAfterCommissionUsd)}
                  </div>
                </div>
              ) : null}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Commission is {formatDollarText(report.rate.usdPerCfdLot)} per realized CFD/FX lot, paid on{" "}
              <span className="font-medium">{report.rate.basis}</span> alone. The two lot columns beside it are context
              and are never paid on — a client who trades only shares earns their salesperson nothing.
            </p>
          </section>

          {/* ── a Super Admin: the salespeople side by side ── */}
          {report.scope === "all" ? (
            <section>
              <h2 className={SECTION_TITLE}>Per salesperson</h2>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                {report.salespeople.map((person) => (
                  <div key={person.managerId} className={CARD} data-testid={`sales-card-${person.managerId}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="text-sm font-semibold text-foreground">{person.name}</div>
                      <div className="text-[11px] text-muted-foreground">manager {person.managerId}</div>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {plural(person.clientCount, "client")} · {person.tradingClientCount} traded
                    </div>
                    <div className="mt-2 border-t border-slate-200 pt-2 dark:border-slate-800">
                      <CardRow label="CFD lots (paid on)" value={<span className={CFD_TONE}>{fmtLots(person.cfdLots)}</span>} />
                      <CardRow label="Commission owed" value={<span className="font-semibold">{formatDollar(person.commissionUsd)}</span>} />
                      <CardRow label="All lots (not paid)" value={fmtLots(person.lots)} muted />
                      <CardRow label="Stocks lots (not paid)" value={fmtLots(person.stocksLots)} muted />
                      <CardRow label="Revenue earned" value={formatRevenue(person.revenueUsd)} />
                      <CardRow label="Margin after commission" value={formatRevenue(person.marginAfterCommissionUsd)} />
                    </div>
                    <button
                      type="button"
                      onClick={() => toggle(person.managerId)}
                      aria-expanded={expanded.includes(person.managerId)}
                      className="mt-2 w-full rounded-md border border-border/60 bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                    >
                      {expanded.includes(person.managerId)
                        ? `Hide ${person.name}'s clients`
                        : `Show ${person.name}'s clients (${person.clients.length})`}
                    </button>
                  </div>
                ))}
              </div>

              {/* The expanded books render full width below the cards rather
                  than inside a third-of-a-row column: six numeric columns in a
                  card that narrow is unreadable, and this page is read on a
                  phone. */}
              {report.salespeople
                .filter((person) => expanded.includes(person.managerId))
                .map((person) => (
                  <div key={person.managerId} className="mt-3 space-y-1" data-testid={`sales-clients-${person.managerId}`}>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {person.name} — {plural(person.clients.length, "client")}
                    </h3>
                    <ClientTable clients={person.clients} showRevenue={Boolean(showRevenue)} />
                  </div>
                ))}
            </section>
          ) : (
            /* ── a salesperson: their own book, and nothing about anyone else ── */
            <section>
              <h2 className={SECTION_TITLE}>Your clients</h2>
              {report.salespeople.map((person) => (
                <div key={person.managerId} className="space-y-1" data-testid={`sales-clients-${person.managerId}`}>
                  <p className="text-xs text-muted-foreground">
                    {person.name} · manager {person.managerId} · {plural(person.clientCount, "client")} ·{" "}
                    {person.tradingClientCount} traded
                  </p>
                  <ClientTable clients={person.clients} showRevenue={Boolean(showRevenue)} />
                </div>
              ))}
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}
