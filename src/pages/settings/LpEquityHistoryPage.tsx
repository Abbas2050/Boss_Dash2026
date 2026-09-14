import React, { useEffect, useMemo, useState } from "react";
// Everything here goes through the same-origin proxy prefix, because these are
// routes on the trading backend rather than on this server.
//
// READ THE TWO PREFIXES BELOW CAREFULLY. They are genuinely different and both
// live on this one page:
//
//   /LpEquityHistory/*        is mounted at the backend's ROOT, with no "api"
//                             segment, so it becomes /api/backend/LpEquityHistory/...
//   /api/LpEquitySnapshotSchedule  is under the backend's own "api" segment,
//                             so it becomes /api/backend/api/LpEquitySnapshotSchedule
//
// The doubled "api" in the second is correct and the missing one in the first
// is correct. Adding an "api" to the first, or dropping it from the second,
// produces a path the proxy forwards to a route that does not exist -- and on
// a single-page app a wrong same-origin path answers with index.html and HTTP
// 200 rather than failing, which is how three settings pages on this project
// stayed broken in production for weeks. src/lib/backendBase.ts has the whole
// story.
import { BACKEND_BASE_URL } from "@/lib/backendBase";
// /api/backend sits behind the deny-by-default gate in auth/requireSession.js,
// so every call here must carry the dashboard session bearer or it 401s on OUR
// server before the backend is ever consulted.
import { authHeaders } from "@/lib/auth";
// firstSeen, latestAt, updatedUtc and every snapshot timestamp are instants.
// They arrive with a "+00:00" offset rather than a "Z", which `new Date(...)`
// parses correctly but `toLocaleString()` would then print in whichever zone
// the reading device happens to be in. A past bug on this project shifted
// displayed times by exactly the viewer's UTC offset that way. The business
// runs on Dubai time and this dashboard is read on a phone that is not always
// there, so every instant goes through this helper.
import { formatDubaiInstant } from "@/lib/dubaiTime";

/** Root-mounted on the backend: NO "api" segment. */
const EQUITY_HISTORY_URL = `${BACKEND_BASE_URL}/LpEquityHistory`;
/** Under the backend's own "api" segment: the doubled "api" is deliberate. */
const SCHEDULE_URL = `${BACKEND_BASE_URL}/api/LpEquitySnapshotSchedule`;

/**
 * VERB NOTE. Reads are GET. The schedule is written with PUT and the manual
 * trigger is POST /run-now, both taken from the reference page. Nothing on this
 * page deletes.
 */

/** A row of GET /LpEquityHistory/lps. */
type LpRow = {
  login: number | string;
  name?: string | null;
  source?: string | null;
  firstSeen?: string | null;
  latestAt?: string | null;
};

/** One point of GET /LpEquityHistory/series. */
type SeriesPoint = {
  timestamp?: string | null;
  equity?: number | null;
  balance?: number | null;
  credit?: number | null;
  margin?: number | null;
  freeMargin?: number | null;
  marginLevel?: number | null;
  source?: string | null;
};

type SeriesEntry = {
  login: number | string;
  name?: string | null;
  source?: string | null;
  points?: SeriesPoint[] | null;
};

/** A flattened grid row, in the reference grid's column order. */
type SnapshotRow = {
  login: number | string;
  name: string;
  source: string;
  timestamp: string | null;
  equity: number | null;
  balance: number | null;
  credit: number | null;
  margin: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
};

type Schedule = {
  snapshotHourUtc?: number | null;
  snapshotMinuteUtc?: number | null;
  updatedUtc?: string | null;
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

const NOT_AUTHORISED_HEADING = "This dashboard is not authorised for the LP equity history API.";

function notAuthorisedDetail(status: number, path: string): string {
  return (
    `The backend answered HTTP ${status} for ${path}. The endpoint exists; the credentials this dashboard ` +
    "authenticates with are not permitted to use it. Nothing is listed below because nothing could be read - this " +
    "is NOT an empty result, and it is not a network fault. Retrying, refreshing or signing in again will not " +
    "change it. The backend team must grant the dashboard's API client access before this page can show or change " +
    "anything."
  );
}

/** 403 joins 401 here: both mean "you may not", which is a different repair
 *  from "it broke", and an operator needs to be sent to the backend team for
 *  either one rather than to the logs. */
function isNotAuthorised(status: number): boolean {
  return status === 401 || status === 403;
}

async function describeFailure(resp: Response, label: string): Promise<string> {
  const text = await resp.text().catch(() => "");
  let detail = text.slice(0, 200);
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string" && parsed.error) {
        detail = typeof parsed.message === "string" && parsed.message ? `${parsed.error}: ${parsed.message}` : parsed.error;
      } else if (parsed && typeof parsed.message === "string" && parsed.message) {
        detail = parsed.message;
      }
    } catch {
      /* not JSON; the raw body is the best detail available */
    }
  }
  return `${label} failed (HTTP ${resp.status})${detail ? `: ${detail}` : ""}`;
}

function fmtNum(v: unknown, digits = 2): string {
  if (v === null || v === undefined || v === "") return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function pad2(n: unknown): string {
  const v = Number(n);
  return Number.isFinite(v) ? String(v).padStart(2, "0") : "--";
}

function todayUtcIso(): string {
  return new Date().toISOString().substring(0, 10);
}

export const LpEquityHistoryPage: React.FC = () => {
  // ---- LP list + selection ----------------------------------------------
  const [lps, setLps] = useState<LpRow[]>([]);
  const [lpState, setLpState] = useState<LoadState>({ kind: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  // ---- Range + series ----------------------------------------------------
  const [from, setFrom] = useState<string>(todayUtcIso());
  const [to, setTo] = useState<string>(todayUtcIso());
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [seriesState, setSeriesState] = useState<LoadState>({ kind: "ok" });
  const [seriesNote, setSeriesNote] = useState<string>("");

  // ---- Schedule ----------------------------------------------------------
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [schedState, setSchedState] = useState<LoadState>({ kind: "loading" });
  const [hour, setHour] = useState<string>("");
  const [minute, setMinute] = useState<string>("");
  const [schedBusy, setSchedBusy] = useState<"" | "save" | "run">("");
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    // Reads only. run-now triggers real server work and the schedule PUT moves
    // when data is captured for everyone, so neither is allowed anywhere near
    // mount -- both are behind a button and a confirm.
    void loadLps();
    void loadSchedule();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 9000);
    return () => window.clearTimeout(t);
  }, [notice]);

  async function loadLps() {
    setLpState({ kind: "loading" });
    try {
      const resp = await fetch(`${EQUITY_HISTORY_URL}/lps`, { headers: { ...authHeaders() } });
      if (!resp.ok) {
        setLps([]);
        setLpState(
          isNotAuthorised(resp.status)
            ? { kind: "unauthorised", status: resp.status }
            : { kind: "error", message: await describeFailure(resp, "Load LP list") },
        );
        return;
      }
      const data = await resp.json();
      const list: LpRow[] = Array.isArray(data) ? data : [];
      setLps(list);
      setLpState({ kind: "ok" });
      const logins = list.map((lp) => String(lp.login));
      setSelected(new Set(logins));
      if (logins.length > 0) await loadSeries(logins);
    } catch (e: any) {
      setLps([]);
      setLpState({ kind: "error", message: e?.message || "Could not reach the LP list endpoint." });
    }
  }

  async function loadSeries(loginsOverride?: string[]) {
    const logins = loginsOverride ?? (selected.size > 0 ? Array.from(selected) : lps.map((lp) => String(lp.login)));
    if (!from || !to) {
      setSeriesState({ kind: "error", message: "Pick both a From and a To date." });
      return;
    }
    if (from > to) {
      setSeriesState({ kind: "error", message: "The From date must not be after the To date." });
      return;
    }
    setSeriesState({ kind: "loading" });
    setSeriesNote("");
    const qs = new URLSearchParams();
    for (const l of logins) qs.append("logins", l);
    qs.set("from", `${from}T00:00:00Z`);
    qs.set("to", `${to}T23:59:59Z`);
    try {
      const resp = await fetch(`${EQUITY_HISTORY_URL}/series?${qs.toString()}`, { headers: { ...authHeaders() } });
      if (!resp.ok) {
        setRows([]);
        setSeriesState(
          isNotAuthorised(resp.status)
            ? { kind: "unauthorised", status: resp.status }
            : { kind: "error", message: await describeFailure(resp, "Load snapshots") },
        );
        return;
      }
      const body = await resp.json();
      const payload: SeriesEntry[] = Array.isArray(body?.series) ? body.series : Array.isArray(body) ? body : [];
      const flat: SnapshotRow[] = [];
      for (const s of payload) {
        for (const p of s.points || []) {
          flat.push({
            login: s.login,
            name: String(s.name ?? ""),
            source: String(p.source ?? s.source ?? ""),
            timestamp: p.timestamp ?? null,
            equity: p.equity ?? null,
            balance: p.balance ?? null,
            credit: p.credit ?? null,
            margin: p.margin ?? null,
            freeMargin: p.freeMargin ?? null,
            marginLevel: p.marginLevel ?? null,
          });
        }
      }
      flat.sort((a, b) => {
        if (String(a.login) !== String(b.login)) return String(a.login) < String(b.login) ? -1 : 1;
        return String(a.timestamp) < String(b.timestamp) ? -1 : String(a.timestamp) > String(b.timestamp) ? 1 : 0;
      });
      setRows(flat);
      setSeriesState({ kind: "ok" });
      setSeriesNote(
        `Loaded ${flat.length} snapshot${flat.length === 1 ? "" : "s"} across ${logins.length} LP${
          logins.length === 1 ? "" : "s"
        }.`,
      );
    } catch (e: any) {
      setRows([]);
      setSeriesState({ kind: "error", message: e?.message || "Could not reach the series endpoint." });
    }
  }

  async function loadSchedule() {
    setSchedState({ kind: "loading" });
    try {
      const resp = await fetch(SCHEDULE_URL, { headers: { ...authHeaders() } });
      if (!resp.ok) {
        setSchedule(null);
        setSchedState(
          isNotAuthorised(resp.status)
            ? { kind: "unauthorised", status: resp.status }
            : { kind: "error", message: await describeFailure(resp, "Load snapshot schedule") },
        );
        return;
      }
      const data: Schedule = await resp.json();
      setSchedule(data || null);
      setHour(String(data?.snapshotHourUtc ?? ""));
      setMinute(String(data?.snapshotMinuteUtc ?? ""));
      setSchedState({ kind: "ok" });
    } catch (e: any) {
      setSchedule(null);
      setSchedState({ kind: "error", message: e?.message || "Could not reach the snapshot schedule endpoint." });
    }
  }

  const currentScheduleText = schedule
    ? `${pad2(schedule.snapshotHourUtc)}:${pad2(schedule.snapshotMinuteUtc)} UTC`
    : "unknown";

  async function saveSchedule() {
    const h = Number.parseInt(hour, 10);
    const m = Number.parseInt(minute, 10);
    if (!Number.isFinite(h) || h < 0 || h > 23) {
      setNotice({ text: "Hour must be a whole number from 0 to 23.", ok: false });
      return;
    }
    if (!Number.isFinite(m) || m < 0 || m > 59) {
      setNotice({ text: "Minute must be a whole number from 0 to 59.", ok: false });
      return;
    }
    // Moving this time changes WHEN equity is captured for every LP, for
    // everybody, from the next day onwards -- so the prompt puts the value it
    // is leaving next to the value it is going to, rather than only naming the
    // new one.
    if (
      !window.confirm(
        `Change the daily LP equity snapshot time?\n\n` +
          `Current: ${currentScheduleText}\n` +
          `New:     ${pad2(h)}:${pad2(m)} UTC\n\n` +
          "This is the single schedule the backend uses for every LP, so it changes when data is captured for " +
          "everyone. Existing snapshots are not affected. Continue?",
      )
    ) {
      return;
    }
    setSchedBusy("save");
    try {
      const resp = await fetch(SCHEDULE_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ snapshotHourUtc: h, snapshotMinuteUtc: m }),
      });
      if (!resp.ok) {
        setNotice({
          text: isNotAuthorised(resp.status)
            ? `Save schedule: ${NOT_AUTHORISED_HEADING} ${notAuthorisedDetail(resp.status, "/api/LpEquitySnapshotSchedule")}`
            : await describeFailure(resp, "Save schedule"),
          ok: false,
        });
        return;
      }
      const saved: Schedule = await resp.json().catch(() => ({}));
      setSchedule(saved && saved.snapshotHourUtc !== undefined ? saved : { snapshotHourUtc: h, snapshotMinuteUtc: m });
      setNotice({
        text: `Saved. The next snapshot fires at ${pad2(saved?.snapshotHourUtc ?? h)}:${pad2(
          saved?.snapshotMinuteUtc ?? m,
        )} UTC.`,
        ok: true,
      });
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to save the snapshot schedule.", ok: false });
    } finally {
      setSchedBusy("");
    }
  }

  async function runNow() {
    // Real server work: the backend goes and polls every LP and writes a
    // snapshot row per LP. It is never fired on mount and never without asking.
    if (
      !window.confirm(
        `Take an LP equity snapshot right now?\n\n` +
          `This makes the backend poll all ${lps.length} LP account${lps.length === 1 ? "" : "s"} immediately and ` +
          "write a snapshot row for each one, outside the daily schedule (" +
          `${currentScheduleText}). It can take a few seconds. Continue?`,
      )
    ) {
      return;
    }
    setSchedBusy("run");
    try {
      const resp = await fetch(`${SCHEDULE_URL}/run-now`, { method: "POST", headers: { ...authHeaders() } });
      if (resp.status === 409) {
        setNotice({ text: "A snapshot is already running - try again in a moment.", ok: false });
        return;
      }
      if (!resp.ok) {
        setNotice({
          text: isNotAuthorised(resp.status)
            ? `Run snapshot: ${NOT_AUTHORISED_HEADING} ${notAuthorisedDetail(
                resp.status,
                "/api/LpEquitySnapshotSchedule/run-now",
              )}`
            : await describeFailure(resp, "Run snapshot"),
          ok: false,
        });
        return;
      }
      const body = await resp.json().catch(() => ({}));
      const run = body?.run;
      let text: string;
      if (run == null) {
        text = "Snapshot triggered, but the backend returned no JobRuns row - check the app log before assuming it ran.";
      } else if (run.status === "succeeded") {
        text = `Succeeded. ${run.recordsProcessed || 0} snapshot row(s) written in ${run.durationMs ?? "?"} ms (JobRunId ${run.jobRunId}).`;
      } else if (run.status === "failed") {
        text = `Failed: ${run.errorMessage || "(no error message)"} (JobRunId ${run.jobRunId}).`;
      } else {
        text = `Status: ${run.status} (JobRunId ${run.jobRunId}).`;
      }
      setNotice({ text, ok: run?.status === "succeeded" });
      await loadSchedule();
      if (lps.length > 0) await loadSeries();
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to trigger the snapshot.", ok: false });
    } finally {
      setSchedBusy("");
    }
  }

  function toggleLogin(login: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(login)) next.delete(login);
      else next.add(login);
      return next;
    });
  }

  const visibleLps = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return lps;
    return lps.filter(
      (lp) => String(lp.name || "").toLowerCase().includes(q) || String(lp.login).toLowerCase().includes(q),
    );
  }, [lps, filter]);

  function selectAll(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const lp of visibleLps) {
        if (on) next.add(String(lp.login));
        else next.delete(String(lp.login));
      }
      return next;
    });
  }

  const inputClass =
    "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900/70";

  /** The three-way load panel, shared by every section on this page. */
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
          <div className="mt-1 opacity-80">This is not empty - it is unknown. Nothing below reflects the backend.</div>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="min-h-screen bg-background p-3 sm:p-4 md:p-6 lg:p-8">
      <div className="mx-auto max-w-[1500px]">
        <h1 className="text-2xl font-bold text-foreground">LP Equity History</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Daily equity snapshots per LP account, the range they cover, and the schedule that captures them. Instants are
          shown in Dubai time.
        </p>

        {notice && (
          <div
            role="status"
            className={`mb-4 rounded-lg border px-3 py-2 text-xs ${
              notice.ok
                ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
                : "border-amber-400/30 bg-amber-500/10 text-amber-700 dark:text-amber-200"
            }`}
          >
            {notice.text}
          </div>
        )}

        {/* ---------------- LP accounts ---------------- */}
        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">
            LP accounts <span className="font-normal normal-case text-muted-foreground">({selected.size} selected)</span>
          </h2>

          {loadPanel(lpState, "LP list", "/LpEquityHistory/lps")}

          {lpState.kind === "ok" && lps.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center dark:border-slate-700 dark:bg-slate-900/40">
              <div className="text-sm font-semibold text-foreground">No LP accounts have ever been snapshotted.</div>
              <div className="mt-1 text-xs text-muted-foreground">
                The list is built from the snapshot table itself, so it fills in after the first successful run. Use Take
                Snapshot Now below to seed it.
              </div>
            </div>
          )}

          {lpState.kind === "ok" && lps.length > 0 && (
            <>
              <div className="mb-2 flex flex-wrap items-end gap-2">
                <div className="min-w-[180px] flex-1">
                  <label htmlFor="leh-filter" className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
                    Filter by name or login
                  </label>
                  <input
                    id="leh-filter"
                    aria-label="Filter by name or login"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => selectAll(true)}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => selectAll(false)}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700"
                >
                  Clear
                </button>
              </div>

              {/* Wide screens: one row per LP. */}
              <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block dark:border-slate-800">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-900/80">
                    <tr>
                      <th className="px-2 py-2 text-left">Include</th>
                      <th className="px-2 py-2 text-left">Login</th>
                      <th className="px-2 py-2 text-left">Name</th>
                      <th className="px-2 py-2 text-left">Source</th>
                      <th className="px-2 py-2 text-left">First seen</th>
                      <th className="px-2 py-2 text-left">Latest at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleLps.map((lp) => (
                      <tr key={`lp-${lp.login}`} className="border-t border-slate-200 dark:border-slate-800">
                        <td className="px-2 py-1.5">
                          <input
                            type="checkbox"
                            checked={selected.has(String(lp.login))}
                            onChange={() => toggleLogin(String(lp.login))}
                            aria-label={`Include ${lp.login}`}
                          />
                        </td>
                        <td className="px-2 py-1.5 font-mono font-semibold">{lp.login}</td>
                        <td className="px-2 py-1.5">{lp.name || "-"}</td>
                        <td className="px-2 py-1.5">{lp.source || "-"}</td>
                        <td className="px-2 py-1.5">{formatDubaiInstant(lp.firstSeen)}</td>
                        <td className="px-2 py-1.5">{formatDubaiInstant(lp.latestAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Phones: the same rows, one card each. */}
              <div className="space-y-2 md:hidden">
                {visibleLps.map((lp) => (
                  <div
                    key={`lp-card-${lp.login}`}
                    className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40"
                  >
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selected.has(String(lp.login))}
                        onChange={() => toggleLogin(String(lp.login))}
                        aria-label={`Include ${lp.login} (card)`}
                      />
                      <span className="font-mono text-sm font-semibold">{lp.login}</span>
                      <span className="text-xs text-muted-foreground">{lp.name || "-"}</span>
                    </label>
                    <dl className="mt-2 space-y-1 text-xs">
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Source</dt>
                        <dd>{lp.source || "-"}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">First seen</dt>
                        <dd>{formatDubaiInstant(lp.firstSeen)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Latest at</dt>
                        <dd>{formatDubaiInstant(lp.latestAt)}</dd>
                      </div>
                    </dl>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="leh-from" className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
                From (UTC)
              </label>
              <input id="leh-from" aria-label="From (UTC)" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label htmlFor="leh-to" className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
                To (UTC)
              </label>
              <input id="leh-to" aria-label="To (UTC)" type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
            </div>
            <div className="flex items-end">
              <button
                type="button"
                onClick={() => void loadSeries()}
                className="rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 dark:text-cyan-200"
              >
                Load
              </button>
            </div>
          </div>
        </section>

        {/* ---------------- Snapshot schedule ---------------- */}
        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">Daily snapshot time (UTC)</h2>

          {loadPanel(schedState, "snapshot schedule", "/api/LpEquitySnapshotSchedule")}

          {schedState.kind === "ok" && (
            <>
              <div className="mb-3 rounded-lg border-l-2 border-cyan-400/60 bg-cyan-500/5 px-3 py-2 text-xs text-muted-foreground">
                Currently fires daily at <b>{currentScheduleText}</b>
                {schedule?.updatedUtc ? <> (last saved {formatDubaiInstant(schedule.updatedUtc)} Dubai)</> : null}. This
                one schedule governs every LP, so changing it changes when data is captured for everyone.
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="leh-hour" className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
                    Hour (0-23)
                  </label>
                  <input
                    id="leh-hour"
                    aria-label="Hour (0-23)"
                    type="number"
                    min={0}
                    max={23}
                    step={1}
                    value={hour}
                    onChange={(e) => setHour(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="leh-minute" className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
                    Minute (0-59)
                  </label>
                  <input
                    id="leh-minute"
                    aria-label="Minute (0-59)"
                    type="number"
                    min={0}
                    max={59}
                    step={1}
                    value={minute}
                    onChange={(e) => setMinute(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div className="flex items-end gap-2">
                  <button
                    type="button"
                    onClick={() => void saveSchedule()}
                    disabled={schedBusy !== ""}
                    className="rounded-md border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 disabled:opacity-60 dark:text-emerald-200"
                  >
                    {schedBusy === "save" ? "Saving..." : "Save Schedule"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void runNow()}
                    disabled={schedBusy !== ""}
                    title="Polls every LP immediately and writes a snapshot row for each."
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-60 dark:border-slate-700"
                  >
                    {schedBusy === "run" ? "Running..." : "Take Snapshot Now"}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>

        {/* ---------------- Snapshots ---------------- */}
        <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">
            Snapshots <span className="font-normal normal-case text-muted-foreground">({rows.length} rows)</span>
          </h2>

          {loadPanel(seriesState, "snapshots", "/LpEquityHistory/series")}
          {seriesState.kind === "ok" && seriesNote && (
            <div className="mb-2 text-xs text-slate-500 dark:text-slate-400">{seriesNote}</div>
          )}

          {seriesState.kind === "ok" && rows.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center dark:border-slate-700 dark:bg-slate-900/40">
              <div className="text-sm font-semibold text-foreground">No snapshots in the selected range.</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Widen the From/To window or include more LPs above, then press Load. This is an answer, not a failure.
              </div>
            </div>
          )}

          {seriesState.kind === "ok" && rows.length > 0 && (
            <>
              {/* Wide screens: one row per snapshot, in the reference grid's
                  column order. */}
              <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block dark:border-slate-800">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-900/80">
                    <tr>
                      <th className="px-2 py-2 text-left">Login</th>
                      <th className="px-2 py-2 text-left">Name</th>
                      <th className="px-2 py-2 text-left">Source</th>
                      {/* The reference labels this "Timestamp (UTC)" and prints
                          UTC. We print Dubai, so the label says Dubai: a column
                          that claims a zone it is not showing is worse than a
                          renamed one. The field is unchanged. */}
                      <th className="px-2 py-2 text-left">Timestamp (Dubai)</th>
                      <th className="px-2 py-2 text-right">Equity</th>
                      <th className="px-2 py-2 text-right">Balance</th>
                      <th className="px-2 py-2 text-right">Credit</th>
                      <th className="px-2 py-2 text-right">Margin</th>
                      <th className="px-2 py-2 text-right">Free Margin</th>
                      <th className="px-2 py-2 text-right">Margin Level %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`snap-${i}-${r.login}`} className="border-t border-slate-200 dark:border-slate-800">
                        <td className="px-2 py-1.5 font-mono font-semibold">{r.login}</td>
                        <td className="px-2 py-1.5">{r.name || "-"}</td>
                        <td className="px-2 py-1.5">{r.source || "-"}</td>
                        <td className="px-2 py-1.5">{formatDubaiInstant(r.timestamp)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(r.equity)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(r.balance)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(r.credit)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(r.margin)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(r.freeMargin)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(r.marginLevel)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Phones: the same rows, one card each. */}
              <div className="space-y-2 md:hidden">
                {rows.map((r, i) => (
                  <div
                    key={`snap-card-${i}-${r.login}`}
                    className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40"
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-mono text-sm font-semibold">{r.login}</div>
                      <div className="text-xs text-muted-foreground">{r.name || "-"}</div>
                    </div>
                    <dl className="mt-2 space-y-1 text-xs">
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Source</dt>
                        <dd>{r.source || "-"}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Timestamp (Dubai)</dt>
                        <dd>{formatDubaiInstant(r.timestamp)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Equity</dt>
                        <dd className="tabular-nums">{fmtNum(r.equity)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Balance</dt>
                        <dd className="tabular-nums">{fmtNum(r.balance)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Credit</dt>
                        <dd className="tabular-nums">{fmtNum(r.credit)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Margin</dt>
                        <dd className="tabular-nums">{fmtNum(r.margin)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Free Margin</dt>
                        <dd className="tabular-nums">{fmtNum(r.freeMargin)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Margin Level %</dt>
                        <dd className="tabular-nums">{fmtNum(r.marginLevel)}</dd>
                      </div>
                    </dl>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
};

export default LpEquityHistoryPage;
