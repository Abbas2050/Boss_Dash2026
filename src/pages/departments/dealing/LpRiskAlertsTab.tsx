import { useEffect, useMemo, useRef, useState } from "react";
import { SortableTable, type SortableTableColumn } from "@/components/ui/SortableTable";
import { SignalRConnectionManager, type SignalRStatus } from "@/lib/signalRConnectionManager";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BACKEND_BASE_URL = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com").replace(/\/+$/, "");

const API_BASE = `${BACKEND_BASE_URL}/api/LpRiskAlert`;

// Firing events are pushed roughly every ~10s (service poll interval); a tick
// is considered stale once we haven't heard anything for 30s.
const STALE_MS = 30_000;

// ── formatting helpers ──────────────────────────────────────────────────────

const nf2 = (n: number | null | undefined) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "-";
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtSigned = (n: number | null | undefined) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "-";
  const v = Number(n);
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const posCls = "text-emerald-600 dark:text-emerald-300";
const negCls = "text-rose-600 dark:text-rose-300";
const mutedCls = "text-slate-400 dark:text-slate-500";

// ── types ─────────────────────────────────────────────────────────────────────

type AlertConfig = {
  id: string | number;
  name: string;
  symbols: string[];
  moveAmountPoints: number;
  targetMl: number;
  mlAfterThreshold: number;
  isEnabled: boolean;
};

type FiringEvent = {
  alertId: string | number;
  alertName: string;
  lpName: string;
  source?: string;
  direction?: string; // "up" | "down"
  triggers?: string[]; // "mlBreach" | "fundingBreach"
  mlNow?: number;
  mlAfter?: number;
  mlAfterThreshold?: number;
  deltaPl?: number;
  equityNow?: number;
  equityAfter?: number;
  freeMarginAfter?: number;
  fundingToTarget?: number;
  symbols?: string[];
  lotsBySymbol?: Record<string, number>;
};

const cardKey = (ev: FiringEvent) => `${ev.alertId}|${ev.lpName}`;

// ── defaults for the "New Alert" modal ──────────────────────────────────────

const DEFAULT_MOVE = 50;
const DEFAULT_TARGET_ML = 150;
const DEFAULT_ML_AFTER = 150;

type FormState = {
  id: string | number | null;
  name: string;
  move: string;
  targetMl: string;
  mlAfter: string;
  enabled: boolean;
};

const blankForm = (): FormState => ({
  id: null,
  name: "",
  move: String(DEFAULT_MOVE),
  targetMl: String(DEFAULT_TARGET_ML),
  mlAfter: String(DEFAULT_ML_AFTER),
  enabled: true,
});

// ── live card ────────────────────────────────────────────────────────────────

function LiveCard({ ev }: { ev: FiringEvent }) {
  const isDown = String(ev.direction || "").toLowerCase() === "down";
  const triggers = Array.isArray(ev.triggers) ? ev.triggers : [];
  const hasMl = triggers.includes("mlBreach");
  const hasFund = triggers.includes("fundingBreach");

  const mlAfterBad =
    ev.mlAfter != null && ev.mlAfterThreshold != null && Number(ev.mlAfter) < Number(ev.mlAfterThreshold);
  const deltaPlBad = ev.deltaPl != null && Number(ev.deltaPl) < 0;
  const fundingBad = ev.fundingToTarget != null && Number(ev.fundingToTarget) > 0;

  const syms = Array.isArray(ev.symbols) ? ev.symbols : [];
  const lotsMap = ev.lotsBySymbol || {};

  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-900/60 ${
        isDown ? "border-l-4 border-l-rose-500" : "border-l-4 border-l-amber-500"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`text-sm font-bold ${isDown ? "text-rose-500" : "text-amber-500"}`}>{isDown ? "▼" : "▲"}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100">
          {ev.alertName}
        </span>
        {hasMl && (
          <span className="rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide bg-rose-500/15 text-rose-600 dark:text-rose-300">
            ML
          </span>
        )}
        {hasFund && (
          <span className="rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide bg-amber-500/15 text-amber-600 dark:text-amber-400">
            FUND
          </span>
        )}
      </div>

      <div className="text-slate-500 dark:text-slate-400">
        <span className="text-sm font-bold text-cyan-600 dark:text-cyan-300">{ev.lpName}</span>
        {ev.source ? <span className="opacity-70"> — {ev.source}</span> : null}
      </div>

      <div className="grid grid-cols-3 gap-x-3 gap-y-1">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">ML Now</span>
          <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">{nf2(ev.mlNow)}%</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">ML After</span>
          <span className={`font-semibold tabular-nums ${mlAfterBad ? negCls : "text-slate-800 dark:text-slate-100"}`}>
            {nf2(ev.mlAfter)}%
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">Delta P/L</span>
          <span className={`font-semibold tabular-nums ${deltaPlBad ? negCls : "text-slate-800 dark:text-slate-100"}`}>
            {fmtSigned(ev.deltaPl)}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">Equity Now</span>
          <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">{nf2(ev.equityNow)}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">Equity After</span>
          <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">{nf2(ev.equityAfter)}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">Free Margin After</span>
          <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">{nf2(ev.freeMarginAfter)}</span>
        </div>
      </div>

      <div className="flex items-baseline justify-between border-y border-dashed border-slate-300 py-1.5 dark:border-slate-700">
        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Funding Needed
        </span>
        <span className={`text-sm font-bold tabular-nums ${fundingBad ? negCls : "text-slate-800 dark:text-slate-100"}`}>
          {nf2(ev.fundingToTarget)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-dashed border-slate-300 pt-1.5 dark:border-slate-700">
        <span className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">Position:</span>
        {syms.length === 0 ? (
          <span className="text-slate-400 dark:text-slate-500">-</span>
        ) : (
          syms.map((sym) => {
            const lots = lotsMap[sym] != null ? Number(lotsMap[sym]) : 0;
            const cls = lots > 0 ? posCls : lots < 0 ? negCls : "text-slate-600 dark:text-slate-300";
            const borderCls =
              lots > 0
                ? "border-emerald-400/40"
                : lots < 0
                  ? "border-rose-400/40"
                  : "border-slate-300 dark:border-slate-700";
            return (
              <span
                key={sym}
                className={`rounded border bg-slate-100 px-1.5 py-0.5 tabular-nums dark:bg-slate-950/70 ${borderCls} ${cls}`}
              >
                {sym} {fmtSigned(lots)} lots
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── component ─────────────────────────────────────────────────────────────────

export function LpRiskAlertsTab({ refreshKey }: { refreshKey: number }) {
  // CRUD grid state
  const [alerts, setAlerts] = useState<AlertConfig[]>([]);
  const [gridLoading, setGridLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const msgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm());
  const [pickedSymbols, setPickedSymbols] = useState<string[]>([]);
  const [modalError, setModalError] = useState("");
  const [saving, setSaving] = useState(false);

  // Symbol typeahead
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const [symQuery, setSymQuery] = useState("");
  const [symOpen, setSymOpen] = useState(false);
  const [symActiveIdx, setSymActiveIdx] = useState(-1);
  const symInputRef = useRef<HTMLInputElement | null>(null);

  // Live "In Danger Now" cards
  const [liveEvents, setLiveEvents] = useState<FiringEvent[]>([]);
  const [wsStatus, setWsStatus] = useState<SignalRStatus>("disconnected");
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [, setHeartbeatTick] = useState(0);

  const showMsg = (text: string, ok: boolean) => {
    setMsg({ text, ok });
    if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
    msgTimerRef.current = setTimeout(() => setMsg(null), 4000);
  };

  // ── load alerts ────────────────────────────────────────────────────────────
  const loadAlerts = async () => {
    setGridLoading(true);
    try {
      const resp = await fetch(API_BASE);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as AlertConfig[];
      setAlerts(Array.isArray(data) ? data : []);
    } catch (e) {
      showMsg(`Failed to load alerts: ${e instanceof Error ? e.message : String(e)}`, false);
    } finally {
      setGridLoading(false);
    }
  };

  useEffect(() => {
    void loadAlerts();
    // Reload whenever the page-level refresh button is clicked (mirrors ClientVolumeTab).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // ── load symbols (once) ─────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(`${BACKEND_BASE_URL}/RiskScenario/symbols`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as string[];
        setAllSymbols(Array.isArray(data) ? data.filter(Boolean) : []);
      } catch {
        setAllSymbols([]);
      }
    })();
  }, []);

  // ── SignalR: self-contained subscription to LpRiskAlerts ───────────────────
  useEffect(() => {
    const manager = new SignalRConnectionManager({
      hubUrl: `${BACKEND_BASE_URL}/ws/dashboard`,
      trackedEvents: ["LpRiskAlerts"],
      accessTokenFactory: async () => {
        try {
          const res = await fetch(`${BACKEND_BASE_URL}/api/signalr/token`);
          if (!res.ok) return null;
          const json = await res.json();
          return json.token || null;
        } catch {
          return null;
        }
      },
    });

    const unsubStatus = manager.onStatusChange((next) => setWsStatus(next));
    const unsubEvent = manager.onEvent((payload, eventName) => {
      if (eventName !== "LpRiskAlerts") return;
      const rows = Array.isArray(payload) ? (payload as FiringEvent[]) : [];
      setLiveEvents(rows);
      setLastTickAt(Date.now());
    });

    manager.connect().catch(() => undefined);

    return () => {
      unsubStatus();
      unsubEvent();
      manager.disconnect().catch(() => undefined);
    };
  }, []);

  // Heartbeat label ticks every second so "stale" flips automatically.
  useEffect(() => {
    const id = setInterval(() => setHeartbeatTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const heartbeat = useMemo(() => {
    if (lastTickAt == null) return { text: "Waiting for first tick...", stale: true };
    const ageMs = Date.now() - lastTickAt;
    const ageSec = Math.floor(ageMs / 1000);
    const stale = ageMs > STALE_MS;
    return { text: stale ? `Stale — no tick for ${ageSec}s` : `Last tick: ${ageSec}s ago`, stale };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastTickAt, setHeartbeatTick]);

  const wsPill = useMemo(() => {
    if (wsStatus === "connected") return { label: "Connected", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" };
    if (wsStatus === "reconnecting") return { label: "Reconnecting…", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" };
    if (wsStatus === "connecting") return { label: "Connecting…", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" };
    return { label: "Disconnected", cls: "bg-rose-500/15 text-rose-600 dark:text-rose-300" };
  }, [wsStatus]);

  // ── CRUD actions ─────────────────────────────────────────────────────────
  const toggleEnabled = async (row: AlertConfig) => {
    const verb = row.isEnabled ? "disable" : "enable";
    try {
      const resp = await fetch(`${API_BASE}/${row.id}/${verb}`, { method: "POST" });
      if (!resp.ok) throw new Error(await resp.text());
      showMsg(`${verb === "enable" ? "Enabled" : "Disabled"} ${row.name}`, true);
      void loadAlerts();
    } catch (e) {
      showMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`, false);
    }
  };

  const deleteAlert = async (row: AlertConfig) => {
    if (!window.confirm(`Delete alert "${row.name}"?`)) return;
    try {
      const resp = await fetch(`${API_BASE}/${row.id}`, { method: "DELETE" });
      if (!resp.ok) throw new Error(await resp.text());
      showMsg(`Deleted ${row.name}`, true);
      void loadAlerts();
    } catch (e) {
      showMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`, false);
    }
  };

  // ── Modal ────────────────────────────────────────────────────────────────
  const openCreateModal = () => {
    setForm(blankForm());
    setPickedSymbols([]);
    setModalError("");
    setSymQuery("");
    setSymOpen(false);
    setModalOpen(true);
  };

  const openEditModal = (row: AlertConfig) => {
    setForm({
      id: row.id,
      name: row.name,
      move: String(row.moveAmountPoints),
      targetMl: String(row.targetMl),
      mlAfter: String(row.mlAfterThreshold),
      enabled: !!row.isEnabled,
    });
    setPickedSymbols(Array.isArray(row.symbols) ? [...row.symbols] : []);
    setModalError("");
    setSymQuery("");
    setSymOpen(false);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setSymQuery("");
    setSymOpen(false);
    setSymActiveIdx(-1);
  };

  const addSymbol = (sym: string) => {
    if (!sym || pickedSymbols.includes(sym) || pickedSymbols.length >= 4) return;
    setPickedSymbols((prev) => [...prev, sym]);
    setSymQuery("");
    setSymActiveIdx(-1);
    symInputRef.current?.focus();
  };

  const removeSymbol = (sym: string) => {
    setPickedSymbols((prev) => prev.filter((s) => s !== sym));
  };

  const symMatches = useMemo(() => {
    if (pickedSymbols.length >= 4) return [];
    const q = symQuery.trim().toLowerCase();
    return allSymbols
      .filter((s) => !pickedSymbols.includes(s))
      .filter((s) => !q || s.toLowerCase().includes(q))
      .slice(0, 50);
  }, [allSymbols, pickedSymbols, symQuery]);

  const saveAlert = async () => {
    const name = form.name.trim();
    const move = parseFloat(form.move);
    const targetMl = parseFloat(form.targetMl);
    const mlAfter = parseFloat(form.mlAfter);

    if (!name) return setModalError("Name is required");
    if (!pickedSymbols.length) return setModalError("Pick at least one symbol");
    if (pickedSymbols.length > 4) return setModalError("At most 4 symbols");
    if (!move || move <= 0) return setModalError("Move (pts) must be > 0");
    if (!targetMl || targetMl <= 0 || targetMl > 10000) return setModalError("Target ML must be in (0, 10000]");
    if (!mlAfter || mlAfter <= 0 || mlAfter > 10000) return setModalError("ML-after threshold must be in (0, 10000]");

    const body = {
      name,
      symbols: pickedSymbols,
      moveAmountPoints: move,
      targetMl,
      mlAfterThreshold: mlAfter,
      isEnabled: form.enabled,
    };

    setSaving(true);
    setModalError("");
    try {
      const resp = await fetch(form.id ? `${API_BASE}/${form.id}` : API_BASE, {
        method: form.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        let err = await resp.text();
        try {
          const j = JSON.parse(err);
          if (j && j.error) err = j.error;
        } catch {
          // not JSON, use raw text
        }
        setModalError(err || `HTTP ${resp.status}`);
        return;
      }
      closeModal();
      showMsg(form.id ? "Updated" : "Created", true);
      void loadAlerts();
    } catch (e) {
      setModalError(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  // ── grid columns ─────────────────────────────────────────────────────────
  const columns = useMemo<SortableTableColumn<AlertConfig>[]>(
    () => [
      {
        key: "name",
        label: "Name",
        sortValue: (r) => r.name,
        render: (r) => <span className="font-semibold text-slate-800 dark:text-slate-100">{r.name}</span>,
      },
      {
        key: "symbols",
        label: "Symbols",
        sortValue: (r) => (Array.isArray(r.symbols) ? r.symbols.join(", ") : ""),
        render: (r) => (Array.isArray(r.symbols) ? r.symbols.join(", ") : ""),
      },
      {
        key: "moveAmountPoints",
        label: "Move (pts)",
        sortValue: (r) => Number(r.moveAmountPoints) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => nf2(r.moveAmountPoints),
      },
      {
        key: "mlAfterThreshold",
        label: "ML After ≤",
        sortValue: (r) => Number(r.mlAfterThreshold) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => `${nf2(r.mlAfterThreshold)}%`,
      },
      {
        key: "targetMl",
        label: "Target ML",
        sortValue: (r) => Number(r.targetMl) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => `${nf2(r.targetMl)}%`,
      },
      {
        key: "isEnabled",
        label: "Enabled",
        sortValue: (r) => (r.isEnabled ? 1 : 0),
        render: (r) =>
          r.isEnabled ? (
            <span className="rounded px-2 py-0.5 text-[11px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
              Yes
            </span>
          ) : (
            <span className="rounded px-2 py-0.5 text-[11px] font-semibold bg-slate-500/15 text-slate-500 dark:text-slate-400">
              No
            </span>
          ),
      },
      {
        key: "actions",
        label: "Actions",
        hideable: false,
        render: (r) => (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => openEditModal(r)}
              className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => void toggleEnabled(r)}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200"
            >
              {r.isEnabled ? "Disable" : "Enable"}
            </button>
            <button
              type="button"
              onClick={() => void deleteAlert(r)}
              className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
            >
              Delete
            </button>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── render ───────────────────────────────────────────────────────────────
  const sectionCls = "rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70";
  const inputCls =
    "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100";
  const labelCls = "block text-xs text-slate-500 dark:text-slate-400 mb-1";

  return (
    <section className={sectionCls}>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
        LP Risk Alerts
      </h2>
      <p className="mt-1 mb-3 text-xs text-slate-500 dark:text-slate-400">
        Preventative risk monitor: every tick a hypothetical +/-Move shock is applied to each alert&apos;s symbols. LPs
        whose post-shock margin level or funding-to-target breach are surfaced below before the market actually
        moves.
      </p>

      {/* ── status bar ── */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded px-2.5 py-1 font-bold ${wsPill.cls}`}>{wsPill.label}</span>
        <span
          className={`rounded px-2.5 py-1 font-medium ${
            heartbeat.stale ? "bg-rose-500/15 text-rose-600 dark:text-rose-300" : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
          }`}
        >
          {heartbeat.text}
        </span>
        <span className="ml-auto text-slate-500 dark:text-slate-400">{liveEvents.length} firing</span>
      </div>

      {/* ── In Danger Now ── */}
      <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-900/30">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
          In Danger Now
        </h3>
        {liveEvents.length === 0 ? (
          <div className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
            No alerts currently firing.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {liveEvents.map((ev) => (
              <LiveCard key={cardKey(ev)} ev={ev} />
            ))}
          </div>
        )}
      </div>

      {/* ── CRUD grid ── */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
            All Alerts
          </h3>
          <span className="text-xs text-slate-500 dark:text-slate-400">{gridLoading ? "Loading…" : `${alerts.length} configured`}</span>
          <button
            type="button"
            onClick={openCreateModal}
            className="ml-auto rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
          >
            + New Alert
          </button>
        </div>
        <SortableTable
          tableId="dealing-lp-risk-alerts"
          rows={alerts}
          columns={columns}
          tableClassName="min-w-full text-xs"
          emptyText='No alerts configured. Click "+ New Alert" to add one.'
        />
        {msg && (
          <div className={`text-xs ${msg.ok ? posCls : negCls}`}>{msg.text}</div>
        )}
      </div>

      {/* ── Create / Edit modal ── */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div className="max-h-[90vh] w-[480px] max-w-[95vw] overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-950">
            <h2 className="mb-3 text-sm font-semibold text-cyan-600 dark:text-cyan-300">
              {form.id ? "Edit Alert" : "New Alert"}
            </h2>

            <div className="mb-3">
              <label className={labelCls}>Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                maxLength={200}
                placeholder="e.g. XAU swing watch"
                className={inputCls}
              />
            </div>

            <div className="mb-3">
              <label className={labelCls}>Symbols (1-4)</label>
              <div className="relative">
                <input
                  ref={symInputRef}
                  value={symQuery}
                  onChange={(e) => {
                    setSymQuery(e.target.value);
                    setSymActiveIdx(-1);
                    setSymOpen(true);
                  }}
                  onFocus={() => setSymOpen(true)}
                  onBlur={() => setTimeout(() => setSymOpen(false), 150)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      if (!symMatches.length) return;
                      setSymActiveIdx((i) => (i + 1) % symMatches.length);
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      if (!symMatches.length) return;
                      setSymActiveIdx((i) => (i - 1 + symMatches.length) % symMatches.length);
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      if (symActiveIdx >= 0 && symMatches[symActiveIdx]) {
                        addSymbol(symMatches[symActiveIdx]);
                      } else if (symMatches.length >= 1 && symQuery.trim()) {
                        addSymbol(symMatches[0]);
                      }
                    } else if (e.key === "Escape") {
                      setSymOpen(false);
                    }
                  }}
                  placeholder={pickedSymbols.length >= 4 ? "Max 4 symbols selected" : "Click to browse or type to filter..."}
                  disabled={pickedSymbols.length >= 4}
                  autoComplete="off"
                  className={inputCls}
                />
                {symOpen && symMatches.length > 0 && (
                  <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
                    {symMatches.map((s, i) => (
                      <div
                        key={s}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          addSymbol(s);
                        }}
                        className={`cursor-pointer px-2 py-1.5 text-xs tabular-nums ${
                          i === symActiveIdx
                            ? "bg-cyan-50 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-300"
                            : "text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                        }`}
                      >
                        {s}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="mt-1.5 flex min-h-[22px] flex-wrap gap-1">
                {pickedSymbols.map((s) => (
                  <span
                    key={s}
                    className="inline-flex items-center gap-1 rounded-full border border-cyan-400/40 bg-cyan-500/10 py-0.5 pl-2 pr-1 text-[11px] font-semibold tabular-nums text-cyan-700 dark:text-cyan-300"
                  >
                    {s}
                    <button
                      type="button"
                      onClick={() => removeSymbol(s)}
                      aria-label={`Remove ${s}`}
                      className="leading-none text-cyan-700 dark:text-cyan-300"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                Same Move (pts) is applied per symbol; per-symbol Digits handle scale.
              </div>
            </div>

            <div className="mb-3 flex gap-2.5">
              <div className="flex-1">
                <label className={labelCls}>Move (points)</label>
                <input
                  type="number"
                  min={0.01}
                  step={1}
                  value={form.move}
                  onChange={(e) => setForm((f) => ({ ...f, move: e.target.value }))}
                  className={inputCls}
                />
              </div>
              <div className="flex-1">
                <label className={labelCls}>Target ML %</label>
                <input
                  type="number"
                  min={0.01}
                  max={10000}
                  step={10}
                  value={form.targetMl}
                  onChange={(e) => setForm((f) => ({ ...f, targetMl: e.target.value }))}
                  className={inputCls}
                />
              </div>
              <div className="flex-1">
                <label className={labelCls}>ML-after threshold %</label>
                <input
                  type="number"
                  min={0.01}
                  max={10000}
                  step={10}
                  value={form.mlAfter}
                  onChange={(e) => setForm((f) => ({ ...f, mlAfter: e.target.value }))}
                  className={inputCls}
                />
              </div>
            </div>

            <div className="mb-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-900"
                />
                Enabled
              </label>
            </div>

            {modalError && <div className="mb-2 min-h-[16px] text-xs text-rose-600 dark:text-rose-300">{modalError}</div>}

            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeModal}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveAlert()}
                disabled={saving}
                className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-500/20 disabled:opacity-60 dark:text-emerald-300"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
