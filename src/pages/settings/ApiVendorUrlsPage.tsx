import React, { useEffect, useState } from "react";
// /api/admin/vendor-urls is a route on the trading backend, not on this server,
// so it has to go through the same-origin proxy prefix. The doubled "api" in
// /api/backend/api/admin/vendor-urls is correct: /api/backend is where
// wallet/backendProxy.js is mounted and /api/admin/vendor-urls is the backend's
// own path underneath it.
import { BACKEND_BASE_URL } from "@/lib/backendBase";
// That prefix sits behind requireSession (server.js denies every /api and /rest
// route by default), so every call here must carry the dashboard session bearer
// or it 401s on our own server before the backend is ever consulted.
import { authHeaders } from "@/lib/auth";
// updatedAtUtc is a UTC instant. Rendering it with toLocaleString() would print
// it in whichever zone the reading device happens to be in; the business runs
// on Dubai time and this dashboard is read on a phone that is not always there.
import { formatDubaiInstant } from "@/lib/dubaiTime";

const VENDOR_URLS_URL = `${BACKEND_BASE_URL}/api/admin/vendor-urls`;

/**
 * VERB NOTE. The upsert is PUT and the revert is DELETE with the identifying
 * pair in the query string, because that is what the reference page issues
 * against the live backend. There is no POST and no per-id path: a row is
 * identified by (vendor, environment), which is also why Save on a Default row
 * and Save on an Override row are the same request.
 */

/** A row of the effective-URL list, as GET /api/admin/vendor-urls returns it. */
type VendorUrlRow = {
  vendor: string;
  environment: string;
  url?: string | null;
  /** "Default" = compiled fallback, no DB row. "Override" = stored in ApiVendorUrls. */
  source?: string | null;
  updatedAtUtc?: string | null;
  updatedBy?: string | null;
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
 * Said in full, on the page, in the words an operator needs. As of writing, a
 * client-credentials token that gets 200 on /api/ClientAccountMonitor gets 401
 * here, and the open theory is that /api/admin/* is a cookie-session admin
 * surface that does not accept Bearer tokens at all. Whatever the cause, the
 * one thing the reader must not conclude is "no vendor URL is overridden".
 */
const NOT_AUTHORISED_HEADING = "This dashboard is not authorised for the admin API.";

function notAuthorisedDetail(status: number): string {
  return (
    `The backend answered HTTP ${status} for /api/admin/vendor-urls. The endpoint exists; the credentials this ` +
    "dashboard authenticates with are not permitted to use it. Nothing is listed below because nothing could be " +
    "read - this is NOT an empty list, and it is not a network fault. Retrying, refreshing or signing in again " +
    "will not change it. The backend team must grant the dashboard's API client access to /api/admin before this " +
    "page can show or change anything."
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
      if (parsed && typeof parsed.error === "string" && parsed.error) detail = parsed.error;
    } catch {
      /* not JSON; the raw body is the best detail available */
    }
  }
  return `${label} failed (HTTP ${resp.status})${detail ? `: ${detail}` : ""}`;
}

/**
 * Row identity is the (vendor, environment) pair, not an id. It stays stable
 * across Default <-> Override transitions: Save on a Default row upserts and
 * comes back as an Override on the same pair, and Revert takes it back.
 */
function rowKey(row: { vendor: string; environment: string }): string {
  return `${row.vendor}|${row.environment}`;
}

/**
 * The same check the reference makes before enabling Save. Plain http is
 * refused rather than silently upgraded: these are the base URLs live vendor
 * clients authenticate against, and quietly rewriting one would be a worse
 * surprise than refusing it.
 */
function isValidHttps(url: string): boolean {
  if (!url || url.length > 512) return false;
  if (url.indexOf("https://") !== 0) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export const ApiVendorUrlsPage: React.FC = () => {
  const [rows, setRows] = useState<VendorUrlRow[]>([]);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** Per-row edited URL, keyed by (vendor, environment). Reset on every load so
   *  a stale draft cannot sit on top of a value the backend has since changed. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /** Turns a non-ok response into the notice text a mutation should show, so a
   *  refused write says the same thing as a refused read rather than becoming
   *  an anonymous "HTTP 401". */
  async function failureNotice(resp: Response, label: string): Promise<string> {
    if (isNotAuthorised(resp.status)) return `${label}: ${NOT_AUTHORISED_HEADING} ${notAuthorisedDetail(resp.status)}`;
    return await describeFailure(resp, label);
  }

  async function load() {
    setState({ kind: "loading" });
    try {
      const resp = await fetch(VENDOR_URLS_URL, { headers: { ...authHeaders() } });
      if (!resp.ok) {
        // Rows are cleared as well, so a stale list cannot sit under a banner
        // pretending to be current.
        setRows([]);
        setDrafts({});
        setState(
          isNotAuthorised(resp.status)
            ? { kind: "unauthorised", status: resp.status }
            : { kind: "error", message: await describeFailure(resp, "Load vendor URLs") },
        );
        return;
      }
      const data = await resp.json();
      const list: VendorUrlRow[] = Array.isArray(data) ? data : [];
      setRows(list);
      const next: Record<string, string> = {};
      for (const row of list) next[rowKey(row)] = String(row.url ?? "");
      setDrafts(next);
      setState({ kind: "ok" });
    } catch (e: any) {
      setRows([]);
      setDrafts({});
      setState({ kind: "error", message: e?.message || "Could not reach the vendor URLs endpoint." });
    }
  }

  function draftOf(row: VendorUrlRow): string {
    const key = rowKey(row);
    return key in drafts ? drafts[key] : String(row.url ?? "");
  }

  function setDraft(row: VendorUrlRow, value: string) {
    setDrafts((prev) => ({ ...prev, [rowKey(row)]: value }));
  }

  async function saveRow(row: VendorUrlRow) {
    const url = draftOf(row).trim();
    if (!isValidHttps(url)) {
      setNotice({ text: "Url must start with https:// and be a valid absolute URI of at most 512 characters.", ok: false });
      return;
    }
    setBusyKey(rowKey(row));
    try {
      const resp = await fetch(VENDOR_URLS_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ vendor: row.vendor, environment: row.environment, url }),
      });
      if (!resp.ok) {
        setNotice({ text: await failureNotice(resp, "Save vendor URL"), ok: false });
        return;
      }
      setNotice({ text: `Saved ${row.vendor} / ${row.environment}.`, ok: true });
      await load();
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to save the vendor URL.", ok: false });
    } finally {
      setBusyKey(null);
    }
  }

  async function revertRow(row: VendorUrlRow) {
    if (row.source !== "Override") return;
    // Destructive: it deletes the stored override, and what the vendor client
    // falls back to afterwards is not necessarily what is on screen now. Both
    // the vendor and the environment are named so the row cannot be mistaken.
    if (
      !window.confirm(
        `Delete the override for ${row.vendor} / ${row.environment}? The vendor will fall back to its compiled ` +
          "default (or to the per-row Mt5Server host for Xtb and Lmax). This cannot be undone.",
      )
    ) {
      return;
    }
    setBusyKey(rowKey(row));
    try {
      const qs = `vendor=${encodeURIComponent(row.vendor)}&environment=${encodeURIComponent(row.environment)}`;
      const resp = await fetch(`${VENDOR_URLS_URL}?${qs}`, { method: "DELETE", headers: { ...authHeaders() } });
      if (!resp.ok) {
        setNotice({ text: await failureNotice(resp, "Revert vendor URL"), ok: false });
        return;
      }
      setNotice({ text: `Reverted ${row.vendor} / ${row.environment}.`, ok: true });
      await load();
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to revert the vendor URL.", ok: false });
    } finally {
      setBusyKey(null);
    }
  }

  const inputClass =
    "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900/70";

  function sourcePill(source?: string | null) {
    const isOverride = source === "Override";
    return (
      <span
        className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
          isOverride
            ? "border-cyan-400/50 bg-cyan-500/10 text-cyan-700 dark:text-cyan-200"
            : "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300"
        }`}
      >
        {source || "Default"}
      </span>
    );
  }

  function rowActions(row: VendorUrlRow) {
    const key = rowKey(row);
    const busy = busyKey === key;
    const valid = isValidHttps(draftOf(row).trim());
    return (
      <>
        <button
          type="button"
          onClick={() => void saveRow(row)}
          disabled={busy || !valid}
          title={valid ? "Upsert this URL as an override" : "Url must start with https:// and be a valid absolute URI"}
          className="rounded border border-cyan-400/40 bg-cyan-500/10 px-2 py-1 text-[11px] disabled:opacity-60"
        >
          Save
        </button>
        {row.source === "Override" && (
          <button
            type="button"
            onClick={() => void revertRow(row)}
            disabled={busy}
            className="rounded border border-rose-400/40 bg-rose-500/10 px-2 py-1 text-[11px] disabled:opacity-60"
          >
            Revert
          </button>
        )}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-background p-3 sm:p-4 md:p-6 lg:p-8">
      <div className="mx-auto max-w-[1300px]">
        <h1 className="text-2xl font-bold text-foreground">API Vendor URLs</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Override the Live / Demo base URLs used by env-driven vendor clients (Finalto today). Revert deletes the override
          and falls back to the compiled default. Super-admin only.
        </p>

        <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">Effective Base URLs</h2>

          <div className="mb-3 rounded-lg border-l-2 border-cyan-400/60 bg-cyan-500/5 px-3 py-2 text-xs text-muted-foreground">
            Rows shown are the URL each vendor client will actually use. <b>Default</b> is the compiled fallback, with no
            stored row. <b>Override</b> is the value stored in ApiVendorUrls. Edit the Url field, then Save to upsert an
            override; Revert deletes it and falls back to Default. Xtb and Lmax rows appear only once an override exists -
            those vendors normally use their per-row Mt5Server host.
          </div>

          <div className="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700"
            >
              Refresh
            </button>
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

          {state.kind === "loading" && (
            <div className="text-xs text-slate-500 dark:text-slate-400">Loading vendor URLs...</div>
          )}

          {/* Refused, broken and empty are three separate panels. Only one can
              ever be on screen, and none of them is a blank area. */}
          {state.kind === "unauthorised" && (
            <div
              role="alert"
              className="rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-4 text-xs text-amber-800 dark:text-amber-200"
            >
              <div className="text-sm font-semibold">{NOT_AUTHORISED_HEADING}</div>
              <div className="mt-1 break-words">{notAuthorisedDetail(state.status)}</div>
            </div>
          )}

          {state.kind === "error" && (
            <div
              role="alert"
              className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-4 text-xs text-rose-700 dark:text-rose-200"
            >
              <div className="text-sm font-semibold">Could not load the vendor URLs.</div>
              <div className="mt-1 break-words">{state.message}</div>
              <div className="mt-1 opacity-80">This list is not empty - it is unknown. Nothing below reflects the backend.</div>
            </div>
          )}

          {state.kind === "ok" && rows.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center dark:border-slate-700 dark:bg-slate-900/40">
              <div className="text-sm font-semibold text-foreground">No vendor base URLs are configured yet.</div>
              <div className="mt-1 text-xs text-muted-foreground">
                The backend lists one row per env-driven vendor client, and a row can be overridden here once it appears.
                It returned none, so no vendor client is currently reading its base URL from this table. Use Refresh after
                the backend registers one.
              </div>
            </div>
          )}

          {state.kind === "ok" && rows.length > 0 && (
            <>
              <div className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                {rows.length} row{rows.length !== 1 ? "s" : ""},{" "}
                {rows.filter((r) => r.source === "Override").length} overridden
              </div>

              {/* Wide screens: one row per vendor/environment pair. */}
              <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block dark:border-slate-800">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-900/80">
                    <tr>
                      <th className="px-2 py-2 text-left">Vendor</th>
                      <th className="px-2 py-2 text-left">Environment</th>
                      <th className="px-2 py-2 text-left">Url</th>
                      <th className="px-2 py-2 text-left">Source</th>
                      <th className="px-2 py-2 text-left">Updated (UTC)</th>
                      <th className="px-2 py-2 text-left">Updated By</th>
                      <th className="px-2 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={`vendor-${rowKey(row)}`} className="border-t border-slate-200 dark:border-slate-800">
                        <td className="px-2 py-1.5 font-semibold">{row.vendor}</td>
                        <td className="px-2 py-1.5">{row.environment}</td>
                        <td className="px-2 py-1.5 min-w-[280px]">
                          <input
                            value={draftOf(row)}
                            onChange={(e) => setDraft(row, e.target.value)}
                            aria-label={`Url for ${row.vendor} ${row.environment}`}
                            className={inputClass}
                          />
                        </td>
                        <td className="px-2 py-1.5">{sourcePill(row.source)}</td>
                        <td className="px-2 py-1.5">{formatDubaiInstant(row.updatedAtUtc)}</td>
                        <td className="px-2 py-1.5">{row.updatedBy || "-"}</td>
                        <td className="px-2 py-1.5">
                          <div className="flex flex-wrap justify-end gap-1">{rowActions(row)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Phones: the same rows, one card each. This dashboard is read on
                  a phone first, and a seven-column table is unreadable there. */}
              <div className="space-y-2 md:hidden">
                {rows.map((row) => (
                  <div
                    key={`vendor-card-${rowKey(row)}`}
                    className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold">
                        {row.vendor} / {row.environment}
                      </div>
                      {sourcePill(row.source)}
                    </div>
                    <div className="mt-2">
                      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Url</div>
                      <input
                        value={draftOf(row)}
                        onChange={(e) => setDraft(row, e.target.value)}
                        aria-label={`Url for ${row.vendor} ${row.environment}`}
                        className={inputClass}
                      />
                    </div>
                    <dl className="mt-2 space-y-1 text-xs">
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Updated (UTC)</dt>
                        <dd>{formatDubaiInstant(row.updatedAtUtc)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Updated By</dt>
                        <dd>{row.updatedBy || "-"}</dd>
                      </div>
                    </dl>
                    <div className="mt-2 flex gap-2">{rowActions(row)}</div>
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
