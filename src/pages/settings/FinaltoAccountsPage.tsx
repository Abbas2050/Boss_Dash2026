import React, { useEffect, useMemo, useState } from "react";
// /api/admin/finalto-accounts is a route on the trading backend, not on this
// server, so it has to go through the same-origin proxy prefix. The doubled
// "api" in /api/backend/api/admin/finalto-accounts is correct: /api/backend is
// where wallet/backendProxy.js is mounted and /api/admin/finalto-accounts is
// the backend's own path underneath it.
import { BACKEND_BASE_URL } from "@/lib/backendBase";
// That prefix sits behind requireSession (server.js denies every /api and /rest
// route by default), so every call here must carry the dashboard session bearer
// or it 401s on our own server before the backend is ever consulted.
import { authHeaders } from "@/lib/auth";
// firstSeenAtUtc / lastSeenAtUtc / updatedAtUtc are UTC instants. Rendering one
// with toLocaleString() prints it in whichever zone the reading device happens
// to be in; the business runs on Dubai time and this dashboard is read on a
// phone that is not always there. A past bug shifted every displayed time by
// the viewer's UTC offset exactly this way.
import { formatDubaiInstant } from "@/lib/dubaiTime";

const ACCOUNTS_URL = `${BACKEND_BASE_URL}/api/admin/finalto-accounts`;

/**
 * VERB NOTE. /aggregate/{id}, /sub/{id} and /refresh are WRITES, not reads:
 * a GET on /aggregate/{id} answers 405. The verbs below (PUT, PUT, POST) are
 * the ones the reference page issues against the live backend. Reading the
 * current state is done once, through the collection GET with ?lpAccountId=,
 * which is the only endpoint on this page that returns the page shape.
 */

/** A row of GET /api/admin/finalto-accounts/parents. */
type FinaltoParent = {
  id: number | string;
  lpName?: string | null;
  apiLoginText?: string | null;
  environment?: string | null;
  isActive?: boolean;
};

/** The aggregate half of GET /api/admin/finalto-accounts?lpAccountId={id}. */
type FinaltoAggregate = {
  lpAccountId: number | string;
  lpName?: string | null;
  includeInEquity?: boolean;
  includeInPositions?: boolean;
  includeInDealMatching?: boolean;
  includeInHistory?: boolean;
};

/** One element of the subAccounts half of the same response. */
type FinaltoSubAccount = {
  id: number | string;
  lpAccountId?: number | string;
  finaltoAccountId?: number | string | null;
  finaltoAccountName?: string | null;
  finaltoAccountType?: string | null;
  displayName?: string | null;
  isActive?: boolean;
  includeInEquity?: boolean;
  includeInPositions?: boolean;
  includeInDealMatching?: boolean;
  includeInHistory?: boolean;
  firstSeenAtUtc?: string | null;
  lastSeenAtUtc?: string | null;
  updatedAtUtc?: string | null;
};

/** The whole page shape, nested exactly as the backend returns it. */
type FinaltoAccountsPage = {
  aggregate: FinaltoAggregate | null;
  subAccounts: FinaltoSubAccount[];
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

/**
 * The four booleans are not display preferences. Each one decides whether this
 * Finalto account's figures are counted by a different consumer elsewhere in
 * the dashboard, so the effect of flipping one is spelled out next to it and
 * repeated in the confirmation rather than left for the operator to remember.
 */
const INCLUDE_SWITCHES = [
  { key: "includeInEquity", label: "Include in Equity", effect: "counted in the equity aggregation" },
  { key: "includeInPositions", label: "Include in Positions", effect: "shown on the Coverage grid" },
  { key: "includeInDealMatching", label: "Include in Deal Matching", effect: "matched against client deals" },
  { key: "includeInHistory", label: "Include in History", effect: "counted in the history/report totals" },
] as const;

type IncludeKey = (typeof INCLUDE_SWITCHES)[number]["key"];

const NOT_AUTHORISED_HEADING = "This dashboard is not authorised for the admin API.";

function notAuthorisedDetail(status: number, path: string): string {
  return (
    `The backend answered HTTP ${status} for ${path}. The endpoint exists; the credentials this dashboard ` +
    "authenticates with are not permitted to use it. Nothing is listed below because nothing could be read - this " +
    "is NOT an empty list, and it is not a network fault. Retrying, refreshing or signing in again will not change " +
    "it. The backend team must grant the dashboard's API client access to /api/admin before this page can show or " +
    "change anything."
  );
}

async function describeFailure(resp: Response, label: string): Promise<string> {
  const text = await resp.text().catch(() => "");
  let detail = text.slice(0, 200);
  if (text) {
    try {
      const parsed = JSON.parse(text);
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

/** Editable state of one row, aggregate or sub-account. */
type Draft = {
  /** lpName for the aggregate, displayName for a sub-account. */
  text: string;
  includeInEquity: boolean;
  includeInPositions: boolean;
  includeInDealMatching: boolean;
  includeInHistory: boolean;
};

function draftOfAggregate(a: FinaltoAggregate | null): Draft {
  return {
    text: a?.lpName ?? "",
    includeInEquity: !!a?.includeInEquity,
    includeInPositions: !!a?.includeInPositions,
    includeInDealMatching: !!a?.includeInDealMatching,
    includeInHistory: !!a?.includeInHistory,
  };
}

function draftOfSub(s: FinaltoSubAccount): Draft {
  return {
    text: s.displayName ?? "",
    includeInEquity: !!s.includeInEquity,
    includeInPositions: !!s.includeInPositions,
    includeInDealMatching: !!s.includeInDealMatching,
    includeInHistory: !!s.includeInHistory,
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.text === b.text &&
    a.includeInEquity === b.includeInEquity &&
    a.includeInPositions === b.includeInPositions &&
    a.includeInDealMatching === b.includeInDealMatching &&
    a.includeInHistory === b.includeInHistory
  );
}

/** The switch changes a save is about to make, in words, for the confirmation. */
function switchChanges(before: Draft, after: Draft): string[] {
  return INCLUDE_SWITCHES.filter((s) => before[s.key] !== after[s.key]).map(
    (s) => `- ${s.label}: ${before[s.key] ? "on" : "off"} -> ${after[s.key] ? "on" : "off"} (${s.effect})`,
  );
}

function parentLabel(p: FinaltoParent): string {
  const login = p.apiLoginText || "(no login)";
  const env = p.environment || "(no env)";
  return `#${p.id} - ${p.lpName || "(unnamed)"} (${login}) ${env}${p.isActive ? "" : " [INACTIVE]"}`;
}

export const FinaltoAccountsPage: React.FC = () => {
  const [parents, setParents] = useState<FinaltoParent[]>([]);
  const [parentState, setParentState] = useState<LoadState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string>("");

  const [page, setPage] = useState<FinaltoAccountsPage | null>(null);
  const [pageState, setPageState] = useState<LoadState>({ kind: "ok" });

  const [aggDraft, setAggDraft] = useState<Draft>(draftOfAggregate(null));
  const [aggBase, setAggBase] = useState<Draft>(draftOfAggregate(null));
  const [subDrafts, setSubDrafts] = useState<Record<string, Draft>>({});
  const [subBases, setSubBases] = useState<Record<string, Draft>>({});

  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void loadParents();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /** Turns a non-ok response into the notice text a mutation should show, so a
   *  refused write says the same thing as a refused read rather than becoming
   *  an anonymous "HTTP 401". */
  async function failureNotice(resp: Response, label: string, path: string): Promise<string> {
    if (isNotAuthorised(resp.status)) return `${label}: ${NOT_AUTHORISED_HEADING} ${notAuthorisedDetail(resp.status, path)}`;
    return await describeFailure(resp, label);
  }

  async function loadParents() {
    setParentState({ kind: "loading" });
    try {
      const resp = await fetch(`${ACCOUNTS_URL}/parents`, { headers: { ...authHeaders() } });
      if (!resp.ok) {
        // Rows are cleared as well, so a stale list cannot sit under a banner
        // pretending to be current.
        setParents([]);
        setPage(null);
        setParentState(
          isNotAuthorised(resp.status)
            ? { kind: "unauthorised", status: resp.status }
            : { kind: "error", message: await describeFailure(resp, "Load Finalto parent accounts") },
        );
        return;
      }
      const data = await resp.json();
      const list: FinaltoParent[] = Array.isArray(data) ? data : [];
      setParents(list);
      setParentState({ kind: "ok" });
      if (list.length) {
        const first = String(list[0].id);
        setSelectedId(first);
        await loadPage(first);
      } else {
        setSelectedId("");
        setPage(null);
      }
    } catch (e: any) {
      setParents([]);
      setPage(null);
      setParentState({ kind: "error", message: e?.message || "Could not reach the Finalto accounts endpoint." });
    }
  }

  async function loadPage(id: string) {
    setPageState({ kind: "loading" });
    const url = `${ACCOUNTS_URL}?lpAccountId=${encodeURIComponent(id)}`;
    try {
      const resp = await fetch(url, { headers: { ...authHeaders() } });
      if (!resp.ok) {
        setPage(null);
        setPageState(
          isNotAuthorised(resp.status)
            ? { kind: "unauthorised", status: resp.status }
            : { kind: "error", message: await describeFailure(resp, "Load Finalto sub-accounts") },
        );
        return;
      }
      adopt(await resp.json());
    } catch (e: any) {
      setPage(null);
      setPageState({ kind: "error", message: e?.message || "Could not reach the Finalto accounts endpoint." });
    }
  }

  /**
   * Takes a { aggregate, subAccounts } body - from the collection GET or from
   * the refresh POST, which answers with the same shape - and makes it both the
   * rendered state and the baseline that dirty tracking compares against.
   */
  function adopt(data: any) {
    const aggregate: FinaltoAggregate | null = data && typeof data === "object" ? (data.aggregate ?? null) : null;
    const subAccounts: FinaltoSubAccount[] = Array.isArray(data?.subAccounts) ? data.subAccounts : [];
    setPage({ aggregate, subAccounts });
    const ad = draftOfAggregate(aggregate);
    setAggDraft(ad);
    setAggBase(ad);
    const drafts: Record<string, Draft> = {};
    for (const sub of subAccounts) drafts[String(sub.id)] = draftOfSub(sub);
    setSubDrafts(drafts);
    setSubBases({ ...drafts });
    setPageState({ kind: "ok" });
  }

  async function onSelectParent(id: string) {
    setSelectedId(id);
    if (id) await loadPage(id);
  }

  async function saveAggregate() {
    const aggregate = page?.aggregate;
    if (!aggregate) return;
    const id = String(aggregate.lpAccountId);
    const label = `${aggBase.text || aggregate.lpName || "(unnamed)"} (#${id})`;
    const changes = switchChanges(aggBase, aggDraft);
    // Always confirmed, and the routing switches are named one by one when they
    // move: this write changes what other pages count, and the aggregate row
    // applies to the whole login rather than one sub-account.
    if (
      !window.confirm(
        `Save the aggregate for "${label}"? It applies to the whole Finalto login.` +
          (changes.length ? `\n\nThese routing switches change:\n${changes.join("\n")}` : "") +
          (aggBase.text !== aggDraft.text ? `\n\nLP name: "${aggBase.text}" -> "${aggDraft.text}"` : ""),
      )
    ) {
      return;
    }
    setBusy("aggregate");
    const url = `${ACCOUNTS_URL}/aggregate/${encodeURIComponent(id)}`;
    try {
      const resp = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          lpName: aggDraft.text,
          includeInEquity: aggDraft.includeInEquity,
          includeInPositions: aggDraft.includeInPositions,
          includeInDealMatching: aggDraft.includeInDealMatching,
          includeInHistory: aggDraft.includeInHistory,
        }),
      });
      if (!resp.ok) {
        setNotice({ text: await failureNotice(resp, "Save aggregate", "/api/admin/finalto-accounts/aggregate"), ok: false });
        return;
      }
      setNotice({ text: `Aggregate saved for "${label}".`, ok: true });
      await loadPage(selectedId || id);
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to save the aggregate.", ok: false });
    } finally {
      setBusy(null);
    }
  }

  async function saveSub(sub: FinaltoSubAccount) {
    const id = String(sub.id);
    const draft = subDrafts[id];
    const base = subBases[id];
    if (!draft || !base) return;
    const label = `#${sub.finaltoAccountId ?? id}${sub.finaltoAccountName ? ` (${sub.finaltoAccountName})` : ""}`;
    const changes = switchChanges(base, draft);
    if (
      !window.confirm(
        `Save sub-account ${label}?` +
          (changes.length ? `\n\nThese routing switches change:\n${changes.join("\n")}` : "") +
          (base.text !== draft.text ? `\n\nDisplay name: "${base.text}" -> "${draft.text}"` : ""),
      )
    ) {
      return;
    }
    setBusy(`sub-${id}`);
    const url = `${ACCOUNTS_URL}/sub/${encodeURIComponent(id)}`;
    try {
      const resp = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          displayName: draft.text,
          includeInEquity: draft.includeInEquity,
          includeInPositions: draft.includeInPositions,
          includeInDealMatching: draft.includeInDealMatching,
          includeInHistory: draft.includeInHistory,
        }),
      });
      if (!resp.ok) {
        setNotice({ text: await failureNotice(resp, "Save sub-account", "/api/admin/finalto-accounts/sub"), ok: false });
        return;
      }
      setNotice({ text: `Sub-account ${label} saved.`, ok: true });
      if (selectedId) await loadPage(selectedId);
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to save the sub-account.", ok: false });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Refresh reaches out to Finalto itself and rewrites the stored sub-account
   * set, so it is confirmed and names the parent. It is never fired on mount -
   * the page load is a read of what is already stored.
   */
  async function refreshFromFinalto() {
    if (!selectedId) return;
    const parent = parents.find((p) => String(p.id) === selectedId);
    const label = parent ? parentLabel(parent) : `#${selectedId}`;
    if (
      !window.confirm(
        `Refresh from Finalto for ${label}? This calls Finalto live and rewrites the stored sub-account list for ` +
          "this login - newly returned accounts are added and existing rows have their Finalto name, type and " +
          "last-seen stamp overwritten. Unsaved edits below are discarded. Continue?",
      )
    ) {
      return;
    }
    setBusy("refresh");
    const url = `${ACCOUNTS_URL}/refresh?lpAccountId=${encodeURIComponent(selectedId)}`;
    try {
      const resp = await fetch(url, { method: "POST", headers: { ...authHeaders() } });
      if (!resp.ok) {
        setNotice({ text: await failureNotice(resp, "Refresh from Finalto", "/api/admin/finalto-accounts/refresh"), ok: false });
        return;
      }
      const data = await resp.json();
      adopt(data);
      const count = Array.isArray(data?.subAccounts) ? data.subAccounts.length : 0;
      setNotice({ text: `Refreshed ${count} sub-account${count === 1 ? "" : "s"} from Finalto.`, ok: true });
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to refresh from Finalto.", ok: false });
    } finally {
      setBusy(null);
    }
  }

  /** Newest lastSeenAtUtc across the sub-accounts: the freshness of the stored set. */
  const lastSeen = useMemo(() => {
    const times = (page?.subAccounts ?? [])
      .map((s) => (s.lastSeenAtUtc ? new Date(s.lastSeenAtUtc).getTime() : NaN))
      .filter((t) => Number.isFinite(t));
    if (!times.length) return null;
    return new Date(Math.max(...times)).toISOString();
  }, [page]);

  const inputClass =
    "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900/70";

  /** The three-way load panel, shared by the parent picker and the page body. */
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

  function switchRow(
    idPrefix: string,
    draft: Draft,
    setDraft: (next: Draft) => void,
    base: Draft,
  ) {
    return (
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {INCLUDE_SWITCHES.map((s) => {
          const moved = base[s.key] !== draft[s.key];
          return (
            <label key={s.key} className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={draft[s.key]}
                onChange={(e) => setDraft({ ...draft, [s.key]: e.target.checked } as Draft)}
                aria-label={`${idPrefix} ${s.label}`}
                className="mt-0.5"
              />
              <span>
                {s.label}
                <span className="block text-[10px] text-muted-foreground">{s.effect}</span>
                {/* The unsaved-change marker is text, not just a colour: the
                    routing effect only lands once Save goes through. */}
                {moved && <span className="block text-[10px] font-semibold text-amber-600 dark:text-amber-300">changed, not saved</span>}
              </span>
            </label>
          );
        })}
      </div>
    );
  }

  const aggregate = page?.aggregate ?? null;
  const subAccounts = page?.subAccounts ?? [];

  return (
    <div className="min-h-screen bg-background p-3 sm:p-4 md:p-6 lg:p-8">
      <div className="mx-auto max-w-[1100px]">
        <h1 className="text-2xl font-bold text-foreground">Finalto Accounts</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Display names and downstream visibility for each Finalto sub-account under a parent LP account. The aggregate
          row applies to the whole login. Super-admin only.
        </p>

        <div className="mb-4 rounded-lg border-l-2 border-cyan-400/60 bg-cyan-500/5 px-3 py-2 text-xs text-muted-foreground">
          The four <b>Include in ...</b> boxes are routing switches, not display options: each one decides whether this
          account's figures are counted by a different consumer elsewhere in the dashboard. Sub-account{" "}
          <b>Include in Positions</b> and <b>Display name</b> are live on the Coverage grid today; Equity, Deal Matching
          and History are stored and will take effect when their consumers land. Every save is confirmed and names what
          it moves.
        </div>

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

        {/* ---------------- Parent picker ---------------- */}
        <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">Parent account</h2>

          {loadPanel(parentState, "Finalto parent accounts", "/api/admin/finalto-accounts/parents")}

          {parentState.kind === "ok" && parents.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center dark:border-slate-700 dark:bg-slate-900/40">
              <div className="text-sm font-semibold text-foreground">No saved Finalto accounts.</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Add a Finalto LP account on the LP Manager page, then come back here to configure its sub-accounts.
              </div>
            </div>
          )}

          {parentState.kind === "ok" && parents.length > 0 && (
            <div className="flex flex-col gap-2">
              <select
                value={selectedId}
                onChange={(e) => void onSelectParent(e.target.value)}
                aria-label="Parent account"
                className={inputClass}
              >
                {parents.map((p) => (
                  <option key={`parent-${p.id}`} value={String(p.id)}>
                    {parentLabel(p)}
                  </option>
                ))}
              </select>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void refreshFromFinalto()}
                  disabled={busy === "refresh" || !selectedId}
                  className="rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 disabled:opacity-60 dark:text-cyan-200"
                >
                  {busy === "refresh" ? "Refreshing..." : "Refresh from Finalto"}
                </button>
                <button
                  type="button"
                  onClick={() => selectedId && void loadPage(selectedId)}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700"
                >
                  Reload
                </button>
                <span className="text-[11px] text-muted-foreground">
                  {lastSeen ? `Last seen from Finalto: ${formatDubaiInstant(lastSeen)} (Dubai)` : "No sub-accounts fetched yet."}
                </span>
              </div>
            </div>
          )}
        </section>

        {/* ---------------- Page body ---------------- */}
        {parentState.kind === "ok" && parents.length > 0 && (
          <>
            {loadPanel(pageState, "Finalto sub-accounts", "/api/admin/finalto-accounts")}

            {pageState.kind === "ok" && aggregate && (
              <section className="mb-4 rounded-xl border border-slate-200 border-l-4 border-l-cyan-500 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
                <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-primary">Aggregate (whole login)</h2>
                <div className="mb-3 text-[11px] text-muted-foreground">
                  LP account #{String(aggregate.lpAccountId)} - applies to every sub-account under this login at once.
                </div>
                <div className="grid grid-cols-1 gap-3">
                  <label className="text-xs">
                    <span className="mb-1 block uppercase tracking-wide text-muted-foreground">LP name</span>
                    <input
                      value={aggDraft.text}
                      onChange={(e) => setAggDraft({ ...aggDraft, text: e.target.value })}
                      aria-label="Aggregate LP name"
                      className={inputClass}
                    />
                  </label>
                  {switchRow("Aggregate", aggDraft, setAggDraft, aggBase)}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void saveAggregate()}
                    disabled={busy === "aggregate" || sameDraft(aggDraft, aggBase)}
                    className="rounded-md border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-xs disabled:opacity-60"
                  >
                    Save aggregate
                  </button>
                  {!sameDraft(aggDraft, aggBase) && (
                    <span className="text-[11px] text-amber-600 dark:text-amber-300">Unsaved changes.</span>
                  )}
                </div>
              </section>
            )}

            {pageState.kind === "ok" && subAccounts.length === 0 && (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center dark:border-slate-700 dark:bg-slate-900/40">
                <div className="text-sm font-semibold text-foreground">No sub-accounts stored for this login.</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Use Refresh from Finalto above to fetch the sub-accounts this login owns.
                </div>
              </div>
            )}

            {/* One card per sub-account at every width. The reference page is
                already a panel per row, and the primary reader is on a phone
                where a wide grid of eleven fields is unreadable. */}
            {pageState.kind === "ok" && subAccounts.length > 0 && (
              <section className="space-y-3">
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {subAccounts.length} sub-account{subAccounts.length !== 1 ? "s" : ""}
                </div>
                {subAccounts.map((sub) => {
                  const id = String(sub.id);
                  const draft = subDrafts[id];
                  const base = subBases[id];
                  if (!draft || !base) return null;
                  const dirty = !sameDraft(draft, base);
                  return (
                    <div
                      key={`sub-${id}`}
                      className={`rounded-xl border bg-white p-4 dark:bg-slate-950/70 ${
                        sub.isActive
                          ? "border-slate-200 dark:border-slate-800/80"
                          : "border-rose-400/40 opacity-90 dark:border-rose-400/30"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm font-semibold text-foreground">
                          Sub-account #{String(sub.finaltoAccountId ?? "?")}
                          {/* Finalto's own SOAP-supplied name; rendered as text
                              by React, never as markup. */}
                          {sub.finaltoAccountName ? (
                            <span className="ml-1.5 text-xs font-normal text-muted-foreground">({sub.finaltoAccountName})</span>
                          ) : null}
                        </div>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                            sub.isActive
                              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                              : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                          }`}
                        >
                          {sub.isActive ? "Active" : "Inactive"}
                        </span>
                      </div>

                      <dl className="mt-2 grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Type</dt>
                          <dd>{sub.finaltoAccountType || "-"}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">LP account</dt>
                          <dd>#{String(sub.lpAccountId ?? "-")}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">First seen</dt>
                          <dd>{formatDubaiInstant(sub.firstSeenAtUtc)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Last seen</dt>
                          <dd>{formatDubaiInstant(sub.lastSeenAtUtc)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Updated</dt>
                          <dd>{formatDubaiInstant(sub.updatedAtUtc)}</dd>
                        </div>
                      </dl>

                      <label className="mt-3 block text-xs">
                        <span className="mb-1 block uppercase tracking-wide text-muted-foreground">Display name</span>
                        <input
                          value={draft.text}
                          onChange={(e) => setSubDrafts({ ...subDrafts, [id]: { ...draft, text: e.target.value } })}
                          placeholder="Empty = falls back to the Finalto name"
                          aria-label={`Sub ${id} display name`}
                          className={inputClass}
                        />
                      </label>

                      <div className="mt-3">
                        {switchRow(`Sub ${id}`, draft, (next) => setSubDrafts({ ...subDrafts, [id]: next }), base)}
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void saveSub(sub)}
                          disabled={busy === `sub-${id}` || !dirty}
                          className="rounded-md border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-xs disabled:opacity-60"
                        >
                          {`Save sub-account #${String(sub.finaltoAccountId ?? id)}`}
                        </button>
                        {dirty && <span className="text-[11px] text-amber-600 dark:text-amber-300">Unsaved changes.</span>}
                      </div>
                    </div>
                  );
                })}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
};
