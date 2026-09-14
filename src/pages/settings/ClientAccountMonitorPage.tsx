import React, { useEffect, useMemo, useRef, useState } from "react";
// /api/ClientAccountMonitor is a route on the trading backend, not on this
// server, so it has to go through the same-origin proxy prefix. The doubled
// "api" in /api/backend/api/ClientAccountMonitor is correct: /api/backend is
// where wallet/backendProxy.js is mounted and /api/ClientAccountMonitor is the
// backend's own path underneath it.
import { BACKEND_BASE_URL, DASHBOARD_HUB_URL } from "@/lib/backendBase";
// That prefix sits behind requireSession (server.js denies every /api and
// /rest route by default), so every call here must carry the dashboard session
// bearer or it 401s on our own server before the backend is ever consulted.
import { authHeaders } from "@/lib/auth";
import { SignalRConnectionManager } from "@/lib/signalRConnectionManager";
import { hubAccessTokenFactory } from "@/lib/hubAccessToken";
// updatedUtc is a UTC instant. Rendering it with toLocaleString() would print
// it in whichever zone the reading device happens to be in; the business runs
// on Dubai time and this dashboard is read on a phone that is not always there.
import { formatDubaiInstant } from "@/lib/dubaiTime";

const MONITOR_URL = `${BACKEND_BASE_URL}/api/ClientAccountMonitor`;

/** A row of the watchlist, as GET /api/ClientAccountMonitor returns it. */
type MonitoredAccount = {
  login: number;
  name?: string | null;
  marginLevelThreshold?: number | null;
  equityThreshold?: number | null;
  notes?: string | null;
  updatedUtc?: string | null;
};

/**
 * A row of the live view, as the ClientAccountAlerts hub message delivers it.
 * Every numeric field is optional because the payload is produced by a poller
 * that may not have a figure for an account yet.
 */
type LiveAccountAlert = {
  login: number;
  name?: string | null;
  marginFired?: boolean;
  equityFired?: boolean;
  marginLevel?: number | null;
  equity?: number | null;
  balance?: number | null;
  margin?: number | null;
  freeMargin?: number | null;
  marginLevelThreshold?: number | null;
  equityThreshold?: number | null;
  timestampUtc?: string | null;
};

type Draft = {
  login: string;
  name: string;
  marginLevelThreshold: string;
  equityThreshold: string;
  notes: string;
};

const EMPTY_DRAFT: Draft = { login: "", name: "", marginLevelThreshold: "", equityThreshold: "", notes: "" };

function fmtNum(value: unknown, dp = 2): string {
  if (value === null || value === undefined || value === "") return "-";
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(dp) : "-";
}

/**
 * Blank, not "-", when a threshold is unset: an account may be watched on
 * margin level alone, on equity alone, or on both, and an em dash in the column
 * reads as "we have no value for this" rather than "this one is not watched".
 */
function fmtThreshold(value: unknown, dp = 2): string {
  if (value === null || value === undefined || value === "") return "not set";
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(dp) : "not set";
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * The body shape the backend expects for both POST and PUT. Empty strings are
 * sent as null rather than "": the reference page does the same, and a stored
 * empty string would later come back and render as a name of zero width.
 */
function toRequestBody(draft: Draft) {
  return {
    login: Number(draft.login.trim()),
    name: draft.name.trim() || null,
    marginLevelThreshold: parseOptionalNumber(draft.marginLevelThreshold),
    equityThreshold: parseOptionalNumber(draft.equityThreshold),
    notes: draft.notes.trim() || null,
  };
}

/**
 * A watchlist entry with neither threshold set can never fire, so it is not a
 * watch at all -- it is a silently dead row that looks like coverage. The
 * reference page refuses it on add and reverts it on edit; this refuses it
 * before any request leaves the browser, in both places, and says why.
 */
const NO_THRESHOLD_MESSAGE = "Set at least one threshold - margin level, equity, or both. An entry with neither can never fire.";

function validate(draft: Draft, requireLogin: boolean): string | null {
  if (requireLogin) {
    const login = Number(draft.login.trim());
    if (!Number.isInteger(login) || login <= 0) return "Login must be a positive whole number.";
  }
  const margin = parseOptionalNumber(draft.marginLevelThreshold);
  const equity = parseOptionalNumber(draft.equityThreshold);
  if (margin === null && equity === null) return NO_THRESHOLD_MESSAGE;
  if (margin !== null && margin <= 0) return "Margin level threshold must be greater than zero.";
  return null;
}

async function describeFailure(resp: Response, label: string): Promise<string> {
  const text = await resp.text().catch(() => "");
  let detail = text.slice(0, 200);
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string" && parsed.error) detail = parsed.error;
    } catch {
      /* not JSON; the raw body is the best detail available */
    }
  }
  return `${label} failed (HTTP ${resp.status})${detail ? `: ${detail}` : ""}`;
}

export const ClientAccountMonitorPage: React.FC = () => {
  const [rows, setRows] = useState<MonitoredAccount[]>([]);
  const [loading, setLoading] = useState(false);
  // Deliberately separate from `rows`. A load failure that merely left rows
  // empty would render as "nothing is monitored" -- which is exactly how three
  // settings pages stayed broken in production for weeks, looking merely empty
  // while they were in fact fetching the wrong document entirely.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [addDraft, setAddDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingLogin, setEditingLogin] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busyLogin, setBusyLogin] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [liveRows, setLiveRows] = useState<LiveAccountAlert[]>([]);
  const [hubStatus, setHubStatus] = useState<string>("disconnected");
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const hubRef = useRef<SignalRConnectionManager | null>(null);

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    // The live figures are pushed, not polled: the backend owns the poll
    // interval and broadcasts ClientAccountAlerts. The hub is spoken to
    // directly (see backendBase.ts -- the fetch-based proxy cannot carry a
    // websocket upgrade), so the Bearer is this client's job and comes from
    // the one shared factory.
    const manager = new SignalRConnectionManager({
      hubUrl: DASHBOARD_HUB_URL,
      trackedEvents: ["ClientAccountAlerts"],
      accessTokenFactory: hubAccessTokenFactory,
    });
    hubRef.current = manager;

    const unsubStatus = manager.onStatusChange((s) => setHubStatus(s));
    const unsubEvent = manager.onEvent((payload) => {
      setLiveRows(Array.isArray(payload) ? (payload as LiveAccountAlert[]) : []);
      // An empty payload is still a tick: it means "polled, nothing breaching",
      // which is different from "we have heard nothing at all".
      setLastTickAt(Date.now());
    });

    // Never allowed to reject. A hub that cannot reach the backend is a
    // degraded live panel, not a broken page -- the watchlist below is served
    // over HTTP and must keep working.
    void manager.connect().catch(() => {});

    return () => {
      unsubStatus();
      unsubEvent();
      void manager.disconnect().catch(() => {});
      hubRef.current = null;
    };
  }, []);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const resp = await fetch(MONITOR_URL, { headers: { ...authHeaders() } });
      if (!resp.ok) throw new Error(await describeFailure(resp, "Load monitored accounts"));
      const data = await resp.json();
      setRows(Array.isArray(data) ? data : []);
    } catch (e: any) {
      // Rows are cleared as well as the error set, so a stale list cannot sit
      // under an error banner pretending to be current.
      setRows([]);
      setLoadError(e?.message || "Could not load the monitored accounts.");
    } finally {
      setLoading(false);
    }
  }

  async function addAccount() {
    const problem = validate(addDraft, true);
    if (problem) {
      setNotice({ text: problem, ok: false });
      return;
    }
    const body = toRequestBody(addDraft);
    if (rows.some((r) => Number(r.login) === body.login)) {
      setNotice({ text: `Login ${body.login} is already being monitored. Edit the existing entry instead.`, ok: false });
      return;
    }
    setSubmitting(true);
    try {
      const resp = await fetch(MONITOR_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(await describeFailure(resp, "Add monitored account"));
      setNotice({ text: `Now monitoring login ${body.login}.`, ok: true });
      setAddDraft(EMPTY_DRAFT);
      await load();
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to add the account.", ok: false });
    } finally {
      setSubmitting(false);
    }
  }

  function beginEdit(row: MonitoredAccount) {
    setEditingLogin(Number(row.login));
    setEditDraft({
      login: String(row.login),
      name: row.name ?? "",
      marginLevelThreshold: row.marginLevelThreshold === null || row.marginLevelThreshold === undefined ? "" : String(row.marginLevelThreshold),
      equityThreshold: row.equityThreshold === null || row.equityThreshold === undefined ? "" : String(row.equityThreshold),
      notes: row.notes ?? "",
    });
  }

  async function saveEdit(login: number) {
    const problem = validate(editDraft, false);
    if (problem) {
      setNotice({ text: problem, ok: false });
      return;
    }
    setBusyLogin(login);
    try {
      const resp = await fetch(`${MONITOR_URL}/${login}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ ...toRequestBody(editDraft), login }),
      });
      if (!resp.ok) throw new Error(await describeFailure(resp, "Update monitored account"));
      setNotice({ text: `Updated login ${login}.`, ok: true });
      setEditingLogin(null);
      await load();
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to update the account.", ok: false });
    } finally {
      setBusyLogin(null);
    }
  }

  async function removeAccount(login: number, name?: string | null) {
    // Irreversible: the backend has no undo and no soft-delete for this route,
    // so the login being removed is named in the prompt rather than left to
    // whichever row the finger happened to land on.
    const label = name ? `${login} (${name})` : String(login);
    if (!window.confirm(`Stop monitoring login ${label}? Its thresholds will be deleted and this cannot be undone.`)) return;
    setBusyLogin(login);
    try {
      const resp = await fetch(`${MONITOR_URL}/${login}`, { method: "DELETE", headers: { ...authHeaders() } });
      if (!resp.ok) throw new Error(await describeFailure(resp, "Remove monitored account"));
      setNotice({ text: `Stopped monitoring login ${login}.`, ok: true });
      await load();
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to remove the account.", ok: false });
    } finally {
      setBusyLogin(null);
    }
  }

  const firedCount = useMemo(
    () => liveRows.filter((r) => r.marginFired || r.equityFired).length,
    [liveRows],
  );

  const inputClass =
    "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900/70";

  function firedLabel(row: LiveAccountAlert): string {
    const parts: string[] = [];
    if (row.marginFired) parts.push("Margin");
    if (row.equityFired) parts.push("Equity");
    return parts.length ? parts.join(" + ") : "No";
  }

  /**
   * The add form and the inline row editor are the same five fields, so their
   * accessible names are prefixed by mode. Without that, "Name" would match the
   * add box and the open editor at once -- ambiguous for a screen reader user
   * tabbing through, and ambiguous for the tests.
   */
  function draftFields(draft: Draft, set: (d: Draft) => void, mode: "add" | "edit") {
    const withLogin = mode === "add";
    const label = (field: string) => (mode === "add" ? field : `Edit ${field}`);
    return (
      <>
        {withLogin && (
          <input
            value={draft.login}
            onChange={(e) => set({ ...draft, login: e.target.value })}
            placeholder="Login"
            inputMode="numeric"
            aria-label="Login"
            className={inputClass}
          />
        )}
        <input
          value={draft.name}
          onChange={(e) => set({ ...draft, name: e.target.value })}
          placeholder="Name (optional)"
          aria-label={label("Name")}
          className={inputClass}
        />
        <input
          value={draft.marginLevelThreshold}
          onChange={(e) => set({ ...draft, marginLevelThreshold: e.target.value })}
          placeholder="MarginLevel <= (%)"
          inputMode="decimal"
          aria-label={label("MarginLevel <= (%)")}
          className={inputClass}
        />
        <input
          value={draft.equityThreshold}
          onChange={(e) => set({ ...draft, equityThreshold: e.target.value })}
          placeholder="Equity <="
          inputMode="decimal"
          aria-label={label("Equity <=")}
          className={inputClass}
        />
        <input
          value={draft.notes}
          onChange={(e) => set({ ...draft, notes: e.target.value })}
          placeholder="Notes (optional)"
          aria-label={label("Notes")}
          className={inputClass}
        />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-background p-3 sm:p-4 md:p-6 lg:p-8">
      <div className="mx-auto max-w-[1300px]">
        <h1 className="text-2xl font-bold text-foreground">Client Account Monitor</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Per-client margin level / equity thresholds. An alert fires when the live value falls at or below the configured
          threshold. The poll interval is server-configured; the client-side counterpart of LP Margin Alerts.
        </p>

        {/* ---------------- Watchlist configuration ---------------- */}
        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">Monitored Accounts</h2>

          <form
            className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/50"
            onSubmit={(e) => {
              e.preventDefault();
              void addAccount();
            }}
          >
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
              Add an account to the watchlist
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-5">{draftFields(addDraft, setAddDraft, "add")}</div>
            <button
              type="submit"
              disabled={submitting}
              className="mt-2 rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-500/20 disabled:opacity-60 dark:text-cyan-200"
            >
              {submitting ? "Saving..." : "Add Account"}
            </button>
          </form>

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

          {loading && <div className="mb-3 text-xs text-slate-500 dark:text-slate-400">Loading monitored accounts...</div>}

          {/* A failed load and an empty watchlist are two different things and
              are rendered as two different things. Neither is a blank area. */}
          {!loading && loadError && (
            <div
              role="alert"
              className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-4 text-xs text-rose-700 dark:text-rose-200"
            >
              <div className="font-semibold">Could not load the monitored accounts.</div>
              <div className="mt-1 break-words">{loadError}</div>
              <div className="mt-1 opacity-80">This list is not empty - it is unknown. Nothing below reflects the backend.</div>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-2 rounded-md border border-rose-400/40 bg-rose-500/10 px-3 py-1.5 font-medium"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !loadError && rows.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center dark:border-slate-700 dark:bg-slate-900/40">
              <div className="text-sm font-semibold text-foreground">No accounts are being monitored yet.</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Register a login above with a margin level threshold, an equity threshold, or both, and it will appear here
                and in the live view.
              </div>
            </div>
          )}

          {!loadError && rows.length > 0 && (
            <>
              <div className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                {rows.length} account{rows.length !== 1 ? "s" : ""} monitored
              </div>

              {/* Wide screens: one row per account. */}
              <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block dark:border-slate-800">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-900/80">
                    <tr>
                      <th className="px-2 py-2 text-left">Login</th>
                      <th className="px-2 py-2 text-left">Name</th>
                      <th className="px-2 py-2 text-left">MarginLevel &lt;= (%)</th>
                      <th className="px-2 py-2 text-left">Equity &lt;=</th>
                      <th className="px-2 py-2 text-left">Notes</th>
                      <th className="px-2 py-2 text-left">Updated</th>
                      <th className="px-2 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const login = Number(row.login);
                      const editing = editingLogin === login;
                      return (
                        <tr key={`monitor-${login}`} className="border-t border-slate-200 dark:border-slate-800">
                          <td className="px-2 py-1.5 font-mono font-semibold">{login}</td>
                          {editing ? (
                            <td className="px-2 py-1.5" colSpan={5}>
                              <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
                                {draftFields(editDraft, setEditDraft, "edit")}
                              </div>
                            </td>
                          ) : (
                            <>
                              <td className="px-2 py-1.5">{row.name || "-"}</td>
                              <td className="px-2 py-1.5">{fmtThreshold(row.marginLevelThreshold)}</td>
                              <td className="px-2 py-1.5">{fmtThreshold(row.equityThreshold)}</td>
                              <td className="px-2 py-1.5">{row.notes || "-"}</td>
                              <td className="px-2 py-1.5">{formatDubaiInstant(row.updatedUtc)}</td>
                            </>
                          )}
                          <td className="px-2 py-1.5 text-right whitespace-nowrap">
                            {editing ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void saveEdit(login)}
                                  disabled={busyLogin === login}
                                  className="mr-1 rounded border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-[11px] disabled:opacity-60"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingLogin(null)}
                                  className="rounded border border-slate-300 px-2 py-1 text-[11px] dark:border-slate-700"
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => beginEdit(row)}
                                  className="mr-1 rounded border border-cyan-400/40 bg-cyan-500/10 px-2 py-1 text-[11px]"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void removeAccount(login, row.name)}
                                  disabled={busyLogin === login}
                                  className="rounded border border-rose-400/40 bg-rose-500/10 px-2 py-1 text-[11px] disabled:opacity-60"
                                >
                                  Remove
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Phones: the same rows, one card each. This dashboard is read on
                  a phone first, and a seven-column table is unreadable there. */}
              <div className="space-y-2 md:hidden">
                {rows.map((row) => {
                  const login = Number(row.login);
                  const editing = editingLogin === login;
                  return (
                    <div
                      key={`monitor-card-${login}`}
                      className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40"
                    >
                      <div className="flex items-center justify-between">
                        <div className="font-mono text-sm font-semibold">{login}</div>
                        <div className="text-xs text-muted-foreground">{row.name || "-"}</div>
                      </div>
                      {editing ? (
                        <div className="mt-2 grid grid-cols-1 gap-2">{draftFields(editDraft, setEditDraft, "edit")}</div>
                      ) : (
                        <dl className="mt-2 space-y-1 text-xs">
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">MarginLevel &lt;= (%)</dt>
                            <dd>{fmtThreshold(row.marginLevelThreshold)}</dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Equity &lt;=</dt>
                            <dd>{fmtThreshold(row.equityThreshold)}</dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Notes</dt>
                            <dd className="text-right">{row.notes || "-"}</dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Updated</dt>
                            <dd>{formatDubaiInstant(row.updatedUtc)}</dd>
                          </div>
                        </dl>
                      )}
                      <div className="mt-2 flex gap-2">
                        {editing ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void saveEdit(login)}
                              disabled={busyLogin === login}
                              className="flex-1 rounded border border-emerald-400/40 bg-emerald-500/10 px-2 py-1.5 text-[11px] disabled:opacity-60"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingLogin(null)}
                              className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-[11px] dark:border-slate-700"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => beginEdit(row)}
                              className="flex-1 rounded border border-cyan-400/40 bg-cyan-500/10 px-2 py-1.5 text-[11px]"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => void removeAccount(login, row.name)}
                              disabled={busyLogin === login}
                              className="flex-1 rounded border border-rose-400/40 bg-rose-500/10 px-2 py-1.5 text-[11px] disabled:opacity-60"
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>

        {/* ---------------- Live view ---------------- */}
        <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-primary">Live View</h2>
            <span className="rounded-full border border-slate-300 px-2 py-0.5 text-[11px] capitalize dark:border-slate-700">
              Feed: {hubStatus}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {lastTickAt === null ? "Waiting for the first tick..." : `Last tick ${formatDubaiInstant(lastTickAt)}`}
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {firedCount} alert{firedCount !== 1 ? "s" : ""} firing
            </span>
          </div>

          {liveRows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center text-xs text-muted-foreground dark:border-slate-700 dark:bg-slate-900/40">
              {rows.length === 0
                ? "Nothing to show yet - no accounts are being monitored."
                : "No monitored account is currently breaching a threshold."}
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block dark:border-slate-800">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-900/80">
                    <tr>
                      <th className="px-2 py-2 text-left">Login</th>
                      <th className="px-2 py-2 text-left">Name</th>
                      <th className="px-2 py-2 text-left">Fired</th>
                      <th className="px-2 py-2 text-right">MarginLevel %</th>
                      <th className="px-2 py-2 text-right">Equity</th>
                      <th className="px-2 py-2 text-right">Balance</th>
                      <th className="px-2 py-2 text-right">Margin</th>
                      <th className="px-2 py-2 text-right">Free Margin</th>
                      <th className="px-2 py-2 text-right">MarginLevel &lt;=</th>
                      <th className="px-2 py-2 text-right">Equity &lt;=</th>
                      <th className="px-2 py-2 text-left">Last Update</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveRows.map((row) => (
                      <tr key={`live-${row.login}`} className="border-t border-slate-200 dark:border-slate-800">
                        <td className="px-2 py-1.5 font-mono font-semibold">{row.login}</td>
                        <td className="px-2 py-1.5">{row.name || "-"}</td>
                        <td className="px-2 py-1.5">{firedLabel(row)}</td>
                        <td className="px-2 py-1.5 text-right">{fmtNum(row.marginLevel)}</td>
                        <td className="px-2 py-1.5 text-right">{fmtNum(row.equity)}</td>
                        <td className="px-2 py-1.5 text-right">{fmtNum(row.balance)}</td>
                        <td className="px-2 py-1.5 text-right">{fmtNum(row.margin)}</td>
                        <td className="px-2 py-1.5 text-right">{fmtNum(row.freeMargin)}</td>
                        <td className="px-2 py-1.5 text-right">{fmtThreshold(row.marginLevelThreshold)}</td>
                        <td className="px-2 py-1.5 text-right">{fmtThreshold(row.equityThreshold)}</td>
                        <td className="px-2 py-1.5">{formatDubaiInstant(row.timestampUtc)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="space-y-2 md:hidden">
                {liveRows.map((row) => (
                  <div
                    key={`live-card-${row.login}`}
                    className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40"
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-mono text-sm font-semibold">{row.login}</div>
                      <div className="text-xs text-muted-foreground">{row.name || "-"}</div>
                    </div>
                    <dl className="mt-2 space-y-1 text-xs">
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Fired</dt>
                        <dd>{firedLabel(row)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">MarginLevel %</dt>
                        <dd>{fmtNum(row.marginLevel)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Equity</dt>
                        <dd>{fmtNum(row.equity)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Balance</dt>
                        <dd>{fmtNum(row.balance)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Margin</dt>
                        <dd>{fmtNum(row.margin)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Free Margin</dt>
                        <dd>{fmtNum(row.freeMargin)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">MarginLevel &lt;=</dt>
                        <dd>{fmtThreshold(row.marginLevelThreshold)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Equity &lt;=</dt>
                        <dd>{fmtThreshold(row.equityThreshold)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Last Update</dt>
                        <dd>{formatDubaiInstant(row.timestampUtc)}</dd>
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
