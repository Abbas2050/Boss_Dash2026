import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HubConnectionBuilder, LogLevel, type HubConnection } from "@microsoft/signalr";
import { authHeaders } from "@/lib/auth";
import { BACKEND_BASE_URL, DASHBOARD_HUB_URL } from "@/lib/backendBase";
import { hubAccessTokenFactory } from "@/lib/hubAccessToken";

/**
 * Market Watch — live broker prices with per-symbol dealer markup.
 *
 * Ported from the standalone dashboard page (market-watch.html), which was
 * built on AG Grid. This app has no grid library and every other dealing tab
 * is a plain table, so the grid is rebuilt on those primitives rather than
 * adding a ~1MB dependency for one tab. What that costs us is cell editing
 * and tick flashing, which AG Grid supplied for free and which are hand-rolled
 * below; what it buys is one table idiom in the codebase instead of two.
 *
 * Two halves, deliberately kept separate in the data model:
 *
 *  - PRICES are read-only and arrive from the hub many times a second. They
 *    live in a ref, not in state (see the rAF batching note on `quotesRef`).
 *  - MARKUP / COMMENT are user-edited and persisted. They live in React state
 *    so a tick can never overwrite half-typed input — the exact bug the source
 *    page's own comment describes fighting with AG Grid's row transactions.
 */

const LS_KEY = "mw-symbols-v1";
const STALE_MS = 30_000;
const FLASH_MS = 350;

type SymbolSettings = { markup: number; comment: string };

/** A subscribed row's user-owned values. Never written by a price tick. */
type Row = { symbol: string; markup: number; comment: string };

/** A subscribed row's feed-owned values. Never written by the user. */
type Quote = {
  rawBid: number | null;
  rawAsk: number | null;
  time: number | null;
  bidDir: "up" | "down" | null;
  askDir: "up" | "down" | null;
  lastUpdate: number;
  flashTimer: ReturnType<typeof setTimeout> | null;
};

const emptyQuote = (): Quote => ({
  rawBid: null,
  rawAsk: null,
  time: null,
  bidDir: null,
  askDir: null,
  lastUpdate: 0,
  flashTimer: null,
});

/**
 * Digits are derived from magnitude, not from a symbol name lookup, exactly as
 * the source page does it: the feed does not tell us the symbol's digits, and
 * a name-based table would be wrong for every broker suffix (XAUUSD.f2,
 * GOLD_ft2, EURUSD.xt) the dealing desk actually trades.
 */
export function digitsFor(price: number): number {
  const v = Math.abs(price);
  if (v >= 1000) return 2;
  if (v >= 100) return 3;
  if (v >= 10) return 3;
  return 5;
}

export function pointSizeFor(price: number): number {
  return Math.pow(10, -digitsFor(price));
}

/**
 * Markup widens the CLIENT-FACING spread: the ask is pushed up and the bid
 * pushed down by `markup` points each. This is the reason this tab is a
 * pricing control and not a viewer — the numbers shown here in Bid/Ask are
 * what a client would be quoted, not the raw feed.
 */
export function markedBid(raw: number | null, rawAsk: number | null, markup: number): number | null {
  if (raw == null) return null;
  return raw - (markup || 0) * pointSizeFor(rawAsk ?? raw);
}

export function markedAsk(raw: number | null, markup: number): number | null {
  if (raw == null) return null;
  return raw + (markup || 0) * pointSizeFor(raw);
}

/**
 * "Pipette" rendering: the final decimal is shown smaller and raised, the
 * convention every dealing terminal uses so the eye reads the big figure
 * without the last digit's churn pulling focus. The source page built this
 * with innerHTML; here it is JSX, so the symbol text can never be interpreted
 * as markup.
 */
function PriceCell({ value }: { value: number | null }) {
  if (value == null || !Number.isFinite(value)) return <>—</>;
  const str = value.toFixed(digitsFor(value));
  const main = str.slice(0, -1);
  const pip = str.slice(-1);
  const [intPart, fracPart] = main.split(".");
  const intFormatted = Number(intPart).toLocaleString();
  return (
    <>
      {fracPart != null ? `${intFormatted}.${fracPart}` : intFormatted}
      <span className="ml-px inline-block -translate-y-1 text-[0.72em] font-bold opacity-85">{pip}</span>
    </>
  );
}

function formatTime(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
}

export function MarketWatchTab({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const [symbolsFailed, setSymbolsFailed] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const [listOpen, setListOpen] = useState(false);
  const [ws, setWs] = useState<"connected" | "reconnecting" | "disconnected">("disconnected");
  const [saved, setSaved] = useState<Record<string, SymbolSettings>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Prices are kept OUT of React state on purpose.
   *
   * A busy feed emits far more ticks per second than the browser paints. Held
   * in state, every one of them would be a full re-render of the table — and
   * would also re-render the markup/comment inputs while someone is typing in
   * them. Instead ticks mutate this ref and schedule at most one repaint per
   * animation frame via `bumpQuotes`, so render cost is bounded by the display
   * refresh rate no matter how fast the feed runs.
   */
  const quotesRef = useRef<Map<string, Quote>>(new Map());
  const [quoteTick, setQuoteTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  const connectionRef = useRef<HubConnection | null>(null);
  /** Read inside hub callbacks, which close over their first render otherwise. */
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;

  const bumpQuotes = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setQuoteTick((n) => n + 1);
    });
  }, []);

  // ── Loading symbols and saved settings ──────────────────────────────

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${BACKEND_BASE_URL}/MarketWatch/symbols`, { headers: { ...authHeaders() } });
        if (!resp.ok) throw new Error(`symbols ${resp.status}`);
        const data = await resp.json();
        if (cancelled) return;
        setAllSymbols(Array.isArray(data) ? data.filter((s: unknown) => typeof s === "string") : []);
        setSymbolsFailed(false);
      } catch {
        // Not fatal, and deliberately not an error banner. The typeahead is a
        // convenience over a list the backend happens to expose; a dealer who
        // knows the broker's exact symbol can still type it and press Enter
        // (see `canAddRaw`). Without this the tab would be entirely unusable
        // the moment that one endpoint is missing or renamed.
        if (!cancelled) {
          setAllSymbols([]);
          setSymbolsFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${BACKEND_BASE_URL}/MarketWatch/settings`, { headers: { ...authHeaders() } });
        if (!resp.ok) throw new Error(`settings ${resp.status}`);
        const data = await resp.json();
        if (cancelled || !Array.isArray(data)) return;
        const next: Record<string, SymbolSettings> = {};
        for (const r of data) {
          if (r && typeof r.symbol === "string") {
            next[r.symbol] = { markup: Number(r.markup) || 0, comment: r.comment || "" };
          }
        }
        setSaved(next);
        // Rows already on screen were seeded with whatever we knew at the time
        // (nothing, on a cold start). Re-seed any that the user has not since
        // edited, so a restored subscription shows its stored markup.
        setRows((prev) =>
          prev.map((row) => {
            const s = next[row.symbol];
            if (!s) return row;
            const untouched = row.markup === 0 && row.comment === "";
            return untouched ? { ...row, markup: s.markup, comment: s.comment } : row;
          }),
        );
      } catch {
        if (!cancelled) setSaved({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // ── Subscription management ─────────────────────────────────────────

  const subscribe = useCallback(async (symbol: string) => {
    const sym = symbol.trim();
    if (!sym) return;
    if (rowsRef.current.some((r) => r.symbol === sym)) return;

    quotesRef.current.set(sym, emptyQuote());
    setRows((prev) => {
      if (prev.some((r) => r.symbol === sym)) return prev;
      // `saved` is read via the functional form's closure-free path below --
      // seeding happens here so a row never flashes 0 before settings land.
      return [...prev, { symbol: sym, markup: 0, comment: "" }];
    });

    try {
      await connectionRef.current?.invoke("SubscribeToSymbol", sym);
    } catch {
      // A failed subscribe leaves the row in place showing "—". That is
      // honest: the row IS subscribed as far as this client is concerned, and
      // it will start populating on the next successful reconnect resubscribe.
    }
  }, []);

  // Seeding a new row from saved settings is a separate effect rather than
  // being done inside subscribe(), which would have to close over `saved` and
  // go stale. Any row still at its defaults picks up its stored values here.
  useEffect(() => {
    setRows((prev) => {
      let changed = false;
      const next = prev.map((row) => {
        const s = saved[row.symbol];
        if (!s) return row;
        if (row.markup === 0 && row.comment === "" && (s.markup !== 0 || s.comment !== "")) {
          changed = true;
          return { ...row, markup: s.markup, comment: s.comment };
        }
        return row;
      });
      return changed ? next : prev;
    });
  }, [saved, rows.length]);

  const unsubscribe = useCallback(async (symbol: string) => {
    const q = quotesRef.current.get(symbol);
    if (q?.flashTimer) clearTimeout(q.flashTimer);
    quotesRef.current.delete(symbol);
    setRows((prev) => prev.filter((r) => r.symbol !== symbol));
    try {
      await connectionRef.current?.invoke("UnsubscribeFromSymbol", symbol);
    } catch {
      // Already gone from our side; the server drops the subscription when the
      // connection closes regardless.
    }
  }, []);

  const subscribeAll = useCallback(async () => {
    const toAdd = picked;
    setPicked([]);
    for (const s of toAdd) await subscribe(s);
  }, [picked, subscribe]);

  const clearAll = useCallback(async () => {
    for (const r of [...rowsRef.current]) await unsubscribe(r.symbol);
  }, [unsubscribe]);

  // ── Persistence of the subscription list ────────────────────────────

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(rows.map((r) => r.symbol)));
    } catch {
      // Private mode / blocked storage. The tab works, it just will not
      // restore the list next time.
    }
  }, [rows]);

  // ── The hub ─────────────────────────────────────────────────────────

  useEffect(() => {
    // Same construction as the Metrics gold quote already in
    // DealingDepartmentPage: websocket straight to the backend origin (the
    // /api/backend proxy is fetch-based and cannot carry an upgrade), so it
    // carries its own Bearer from the shared factory.
    // Captured for the cleanup below. The ref's `.current` is reassigned on
    // unsubscribe, so reading it in the teardown could miss timers belonging
    // to the map this effect actually populated.
    const quotes = quotesRef.current;

    const connection = new HubConnectionBuilder()
      .withUrl(DASHBOARD_HUB_URL, { accessTokenFactory: hubAccessTokenFactory })
      .withAutomaticReconnect([0, 1000, 2000, 5000, 10000])
      .configureLogging(LogLevel.None)
      .build();

    connection.on("PriceUpdate", (payload: { symbol?: string; bid?: number; ask?: number; timestamp?: number }) => {
      // Raw broker casing, never uppercased. Some MT5 symbols are genuinely
      // lowercase (XAUUSD.f2, GOLD_ft2) and the hub rejects a forced-upper
      // name -- the source page carries the same warning.
      const sym = String(payload?.symbol ?? "");
      const q = quotesRef.current.get(sym);
      if (!q) return;

      const bid = Number(payload?.bid);
      const ask = Number(payload?.ask);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;

      const ts = Number(payload?.timestamp) || Date.now();
      const bidChanged = q.rawBid !== bid;
      const askChanged = q.rawAsk !== ask;
      q.lastUpdate = Date.now();

      if (!bidChanged && !askChanged) {
        // A redundant snapshot still refreshes the clock, so stale detection
        // stays honest about when we last actually heard from the feed.
        if (q.time !== ts) {
          q.time = ts;
          bumpQuotes();
        }
        return;
      }

      if (q.rawBid != null && bidChanged) q.bidDir = bid > q.rawBid ? "up" : "down";
      if (q.rawAsk != null && askChanged) q.askDir = ask > q.rawAsk ? "up" : "down";
      q.rawBid = bid;
      q.rawAsk = ask;
      q.time = ts;

      if (q.flashTimer) clearTimeout(q.flashTimer);
      q.flashTimer = setTimeout(() => {
        q.bidDir = null;
        q.askDir = null;
        q.flashTimer = null;
        bumpQuotes();
      }, FLASH_MS);

      bumpQuotes();
    });

    connection.onclose(() => setWs("disconnected"));
    connection.onreconnecting(() => setWs("reconnecting"));
    connection.onreconnected(async () => {
      setWs("connected");
      for (const r of rowsRef.current) {
        try {
          await connection.invoke("SubscribeToSymbol", r.symbol);
        } catch {
          // Next reconnect will try again.
        }
      }
    });

    connectionRef.current = connection;

    (async () => {
      try {
        await connection.start();
        setWs("connected");
        // Restore the previous session's list only once the hub is up, so each
        // restored symbol's SubscribeToSymbol actually reaches the server.
        let restore: string[] = [];
        try {
          const parsed = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
          if (Array.isArray(parsed)) restore = parsed.filter((s) => typeof s === "string");
        } catch {
          restore = [];
        }
        for (const sym of restore) await subscribe(sym);
      } catch {
        setWs("disconnected");
      }
    })();

    return () => {
      connection.off("PriceUpdate");
      connection.stop().catch(() => undefined);
      if (connectionRef.current === connection) connectionRef.current = null;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      for (const q of quotes.values()) {
        if (q.flashTimer) clearTimeout(q.flashTimer);
      }
    };
    // Mounted once for the life of the tab. `subscribe` is stable (useCallback
    // with no deps) so this does not re-run and tear the socket down.
  }, [bumpQuotes, subscribe]);

  // Stale feed: drop the flash tint for any symbol that has gone quiet, so a
  // frozen green cell cannot be mistaken for a live rising price.
  useEffect(() => {
    const iv = setInterval(() => {
      let touched = false;
      const now = Date.now();
      for (const q of quotesRef.current.values()) {
        if (q.lastUpdate && now - q.lastUpdate > STALE_MS && (q.bidDir || q.askDir)) {
          q.bidDir = null;
          q.askDir = null;
          touched = true;
        }
      }
      if (touched) bumpQuotes();
    }, 5000);
    return () => clearInterval(iv);
  }, [bumpQuotes]);

  // ── Dirty tracking and save ─────────────────────────────────────────

  const isDirty = useCallback(
    (row: Row, field: "markup" | "comment") => {
      const s = saved[row.symbol] || { markup: 0, comment: "" };
      if (field === "markup") return (Number(row.markup) || 0) !== (Number(s.markup) || 0);
      return (row.comment || "") !== (s.comment || "");
    },
    [saved],
  );

  const dirtyRows = useMemo(
    () => rows.filter((r) => isDirty(r, "markup") || isDirty(r, "comment")),
    [rows, isDirty],
  );

  const applyPending = useCallback(async () => {
    if (!dirtyRows.length) return;
    setSaving(true);
    setError(null);
    const payload = dirtyRows.map((r) => ({
      symbol: r.symbol,
      markup: Number(r.markup) || 0,
      comment: r.comment || null,
    }));
    try {
      const resp = await fetch(`${BACKEND_BASE_URL}/MarketWatch/settings/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`Save failed (${resp.status})`);
      setSaved((prev) => {
        const next = { ...prev };
        for (const p of payload) next[p.symbol] = { markup: p.markup, comment: p.comment || "" };
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save markup changes.");
    } finally {
      setSaving(false);
    }
  }, [dirtyRows]);

  // ── Typeahead ───────────────────────────────────────────────────────

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const taken = new Set([...rows.map((r) => r.symbol), ...picked]);
    return allSymbols.filter((s) => s.toLowerCase().includes(q) && !taken.has(s)).slice(0, 30);
  }, [search, allSymbols, rows, picked]);

  /** With no symbol list, whatever was typed is taken at face value. */
  const canAddRaw = useMemo(() => {
    const raw = search.trim();
    if (!raw || matches.length) return false;
    return !rows.some((r) => r.symbol === raw) && !picked.includes(raw);
  }, [search, matches, rows, picked]);

  const addChip = useCallback((sym: string) => {
    setPicked((prev) => (prev.includes(sym) ? prev : [...prev, sym]));
    setSearch("");
    setHighlight(-1);
    setListOpen(false);
  }, []);

  const setRowField = useCallback((symbol: string, field: "markup" | "comment", value: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.symbol === symbol
          ? field === "markup"
            ? { ...r, markup: value === "" || value === "-" ? 0 : Number(value) || 0 }
            : { ...r, comment: value }
          : r,
      ),
    );
  }, []);

  // `quoteTick` is read here purely so React knows this render depends on the
  // mutable quotes ref; without it the rAF bump would repaint nothing.
  void quoteTick;

  const wsLabel = ws === "connected" ? "Connected" : ws === "reconnecting" ? "Reconnecting…" : "Disconnected";
  const wsClass =
    ws === "connected"
      ? "bg-emerald-500/15 text-emerald-500"
      : ws === "reconnecting"
        ? "bg-amber-500/15 text-amber-500"
        : "bg-rose-500/15 text-rose-500";

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">Market Watch</h2>
        <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${wsClass}`}>{wsLabel}</span>

        <div className="relative min-w-[240px] flex-1 max-w-[480px]">
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setHighlight(-1);
              setListOpen(true);
            }}
            onFocus={() => setListOpen(true)}
            onBlur={() => window.setTimeout(() => setListOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((i) => Math.min(i + 1, matches.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (matches.length) addChip(matches[highlight >= 0 ? highlight : 0]);
                else if (canAddRaw) addChip(search.trim());
              } else if (e.key === "Escape") {
                setListOpen(false);
              }
            }}
            placeholder={
              symbolsFailed
                ? "Type an exact broker symbol and press Enter…"
                : "Search broker symbols (raw names — no normalisation)…"
            }
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          {listOpen && (matches.length > 0 || canAddRaw) && (
            <div className="absolute left-0 right-0 top-full z-50 mt-0.5 max-h-60 overflow-y-auto rounded border border-slate-300 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
              {matches.map((s, i) => (
                <div
                  key={s}
                  onMouseDown={() => addChip(s)}
                  className={`cursor-pointer px-2 py-1 text-xs ${
                    i === highlight
                      ? "bg-emerald-500/15 text-slate-900 dark:text-slate-100"
                      : "text-slate-700 dark:text-slate-300"
                  }`}
                >
                  {s}
                </div>
              ))}
              {canAddRaw && (
                <div
                  onMouseDown={() => addChip(search.trim())}
                  className="cursor-pointer px-2 py-1 text-xs italic text-slate-500 dark:text-slate-400"
                >
                  Add “{search.trim()}” as typed
                </div>
              )}
            </div>
          )}
        </div>

        <button
          onClick={subscribeAll}
          disabled={!picked.length}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
        >
          Subscribe All
        </button>
        <button
          onClick={clearAll}
          disabled={!rows.length}
          className="rounded border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300"
        >
          Clear All
        </button>
        <button
          onClick={applyPending}
          disabled={!dirtyRows.length || saving}
          title="Save pending markup / comment edits"
          className={`rounded px-3 py-1 text-xs font-semibold disabled:opacity-50 ${
            dirtyRows.length ? "bg-amber-500 text-slate-900" : "border border-slate-300 text-slate-500 dark:border-slate-700"
          }`}
        >
          {saving ? "Saving…" : `Apply (${dirtyRows.length})`}
        </button>
        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
          {rows.length ? `${rows.length} subscribed` : ""}
        </span>
      </div>

      {picked.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {picked.map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400"
            >
              {s}
              <button onClick={() => setPicked((prev) => prev.filter((x) => x !== s))} className="leading-none">
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="mt-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-slate-300 py-10 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
          No active subscriptions. Pick symbols above and hit <b>Subscribe All</b>.
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-100 dark:bg-slate-900/80">
              <tr>
                <th className="px-2 py-2 text-left">Symbol</th>
                <th className="px-2 py-2 text-right">Markup (pts)</th>
                <th className="px-2 py-2 text-right">Bid</th>
                <th className="px-2 py-2 text-right">Ask</th>
                <th className="px-2 py-2 text-right">Spread</th>
                <th className="px-2 py-2 text-left">Comment</th>
                <th className="px-2 py-2 text-left">Time</th>
                <th className="px-2 py-2 text-center" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const q = quotesRef.current.get(row.symbol) ?? emptyQuote();
                const bid = markedBid(q.rawBid, q.rawAsk, row.markup);
                const ask = markedAsk(q.rawAsk, row.markup);
                const spread = bid != null && ask != null ? ask - bid : null;
                const flash = (dir: "up" | "down" | null) =>
                  dir === "up" ? "bg-emerald-400/40" : dir === "down" ? "bg-rose-400/40" : "";
                return (
                  <tr key={row.symbol} className="border-b border-slate-200 dark:border-slate-800">
                    <td className="px-2 py-1.5 font-bold text-emerald-600 dark:text-emerald-400">{row.symbol}</td>
                    <td className="px-2 py-1.5 text-right">
                      <input
                        type="number"
                        value={row.markup}
                        onChange={(e) => setRowField(row.symbol, "markup", e.target.value)}
                        className={`w-20 rounded border bg-transparent px-1 py-0.5 text-right tabular-nums ${
                          isDirty(row, "markup")
                            ? "border-amber-500 bg-amber-500/10"
                            : "border-slate-300 dark:border-slate-700"
                        }`}
                      />
                    </td>
                    <td className={`px-2 py-1.5 text-right text-base font-bold tabular-nums transition-colors ${flash(q.bidDir)}`}>
                      <PriceCell value={bid} />
                    </td>
                    <td className={`px-2 py-1.5 text-right text-base font-bold tabular-nums transition-colors ${flash(q.askDir)}`}>
                      <PriceCell value={ask} />
                    </td>
                    <td className="px-2 py-1.5 text-right font-semibold tabular-nums">
                      {spread != null ? spread.toFixed(q.rawAsk != null ? digitsFor(q.rawAsk) : 5) : "—"}
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="text"
                        value={row.comment}
                        onChange={(e) => setRowField(row.symbol, "comment", e.target.value)}
                        className={`w-full rounded border bg-transparent px-1 py-0.5 italic ${
                          isDirty(row, "comment")
                            ? "border-amber-500 bg-amber-500/10"
                            : "border-slate-300 dark:border-slate-700"
                        }`}
                      />
                    </td>
                    <td className="px-2 py-1.5 tabular-nums text-sky-500">{formatTime(q.time)}</td>
                    <td className="px-2 py-1.5 text-center">
                      <button
                        onClick={() => unsubscribe(row.symbol)}
                        title="Unsubscribe"
                        className="text-slate-400 hover:text-rose-500"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
