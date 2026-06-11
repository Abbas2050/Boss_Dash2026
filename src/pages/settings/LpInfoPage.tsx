import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SortableTable, type SortableTableColumn } from "../../components/ui/SortableTable";

// ── Types ──────────────────────────────────────────────────────────────────────

type LpAccount = {
  id: number;
  lpName: string;
  mt5Login: number | string;
  source?: string | number;
  isActive?: boolean;
};

type LpInfo = {
  id: number;
  lpName: string;
  offsetHours: number;
  revSharePercent: number;
  swapFreeDays: number;
  creditCap: number;
  notes: string | null;
  manualStartEquity: number;
  customStartDate: string | null;
  customEndDate: string | null;
  commissionPerMillionUsd: number | null;
  useCalculatedCommission: boolean;
};

type LpCentroidAlias = {
  id: number;
  lpInfoId: number;
  alias: string;
};

type TableRow = {
  _rowId: string;
  lpName: string;
  mt5Login: number | string;
  source: string | number | undefined;
  isActive: boolean;
  offsetHours: number;
  revSharePercent: number;
  swapFreeDays: number;
  creditCap: number;
  manualStartEquity: number;
  commissionPerMillionUsd: number | null;
  useCalculatedCommission: boolean;
  centroidAliases: string[];
  notes: string | null;
  infoId: number | null;
  _noInfo: boolean;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

const panelClass = "rounded-xl border border-border/40 bg-card/80 shadow-sm";
const inputClass =
  "rounded border border-border bg-background/70 p-2 text-sm transition outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20";

function sourceLabel(val: string | number | undefined): string {
  if (val === 0 || val === "Manager") return "Manager";
  if (val === 1 || val === "Terminal") return "Terminal";
  if (val === 2 || val === "Api") return "Api";
  return String(val ?? "-");
}

function sourceBadgeClass(val: string | number | undefined): string {
  const lbl = sourceLabel(val);
  if (lbl === "Manager") return "bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30";
  if (lbl === "Terminal") return "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30";
  if (lbl === "Api") return "bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30";
  return "bg-slate-500/10 text-slate-500 border-slate-500/30";
}

function toDateStr(dt: string | null | undefined): string {
  if (!dt) return "";
  return dt.split("T")[0];
}

// ── Modal State ────────────────────────────────────────────────────────────────

type ModalState = {
  lpName: string;
  infoId: number | null;
  offsetHours: string;
  revSharePercent: string;
  swapFreeDays: string;
  creditCap: string;
  notes: string;
  commissionPerMillionUsd: string;
  useCalculatedCommission: string;
  manualStartEquity: string;
  customStartDate: string;
  customEndDate: string;
};

function defaultModal(lpName = "", info: LpInfo | null = null): ModalState {
  return {
    lpName,
    infoId: info ? info.id : null,
    offsetHours: info ? String(info.offsetHours) : "0",
    revSharePercent: info ? String(info.revSharePercent) : "0",
    swapFreeDays: info ? String(info.swapFreeDays) : "0",
    creditCap: info ? String(info.creditCap) : "0",
    notes: info ? (info.notes ?? "") : "",
    commissionPerMillionUsd:
      info && info.commissionPerMillionUsd != null ? String(info.commissionPerMillionUsd) : "",
    useCalculatedCommission: info ? String(info.useCalculatedCommission) : "false",
    manualStartEquity: info ? String(info.manualStartEquity) : "0",
    customStartDate: info ? toDateStr(info.customStartDate) : "",
    customEndDate: info ? toDateStr(info.customEndDate) : "",
  };
}

// ── Component ──────────────────────────────────────────────────────────────────

export const LpInfoPage: React.FC = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
  const apiUrl = (p: string) => (backendBaseUrl ? backendBaseUrl + p : p);

  // ── Data State ───────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<TableRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // ── Selection ────────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // ── CSV Import ───────────────────────────────────────────────────────────────
  const [csvText, setCsvText] = useState("");
  const [importMsg, setImportMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [importing, setImporting] = useState(false);

  // ── Edit Modal ───────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [modal, setModal] = useState<ModalState>(defaultModal());
  const [editMsg, setEditMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  // Alias state (inside modal)
  const [aliases, setAliases] = useState<LpCentroidAlias[]>([]);
  const [newAlias, setNewAlias] = useState("");
  const [aliasMsg, setAliasMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [aliasLoading, setAliasLoading] = useState(false);

  // ── Auto-clear messages ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(null), 4000);
    return () => window.clearTimeout(t);
  }, [msg]);

  useEffect(() => {
    if (!editMsg) return;
    const t = window.setTimeout(() => setEditMsg(null), 4000);
    return () => window.clearTimeout(t);
  }, [editMsg]);

  useEffect(() => {
    if (!importMsg) return;
    const t = window.setTimeout(() => setImportMsg(null), 6000);
    return () => window.clearTimeout(t);
  }, [importMsg]);

  useEffect(() => {
    if (!aliasMsg) return;
    const t = window.setTimeout(() => setAliasMsg(null), 4000);
    return () => window.clearTimeout(t);
  }, [aliasMsg]);

  // ── Escape key ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!editing) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") closeModal(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [editing]);

  // ── Load Data ────────────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [accResp, infoResp, aliasResp] = await Promise.all([
        fetch(apiUrl("/api/LpAccount?all=true"), { headers: { Accept: "application/json" } }),
        fetch(apiUrl("/api/LpInfo"), { headers: { Accept: "application/json" } }),
        fetch(apiUrl("/api/LpCentroidAlias"), { headers: { Accept: "application/json" } }),
      ]);
      const accounts: LpAccount[] = await accResp.json();
      const infos: LpInfo[] = await infoResp.json();
      const allAliases: LpCentroidAlias[] = await aliasResp.json();

      const infoMap = new Map<string, LpInfo>();
      for (const info of infos) infoMap.set(info.lpName.toLowerCase(), info);

      const aliasMap = new Map<number, string[]>();
      for (const a of allAliases) {
        const existing = aliasMap.get(a.lpInfoId) ?? [];
        existing.push(a.alias);
        aliasMap.set(a.lpInfoId, existing);
      }

      const tableRows: TableRow[] = accounts.map((lp) => {
        const info = infoMap.get(lp.lpName.toLowerCase()) ?? null;
        return {
          _rowId: String(lp.id),
          lpName: lp.lpName,
          mt5Login: lp.mt5Login,
          source: lp.source,
          isActive: lp.isActive ?? true,
          offsetHours: info ? info.offsetHours : 0,
          revSharePercent: info ? info.revSharePercent : 0,
          swapFreeDays: info ? info.swapFreeDays : 0,
          creditCap: info ? info.creditCap : 0,
          manualStartEquity: info ? info.manualStartEquity : 0,
          commissionPerMillionUsd: info ? info.commissionPerMillionUsd : null,
          useCalculatedCommission: info ? info.useCalculatedCommission : false,
          centroidAliases: info ? (aliasMap.get(info.id) ?? []) : [],
          notes: info ? info.notes : null,
          infoId: info ? info.id : null,
          _noInfo: !info,
        };
      });

      setRows(tableRows);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setMsg({ text: `Failed to load: ${e.message}`, ok: false });
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadData(); }, [loadData]);

  // ── Modal helpers ────────────────────────────────────────────────────────────
  function openModal(row: TableRow) {
    const info: LpInfo | null = row.infoId
      ? {
          id: row.infoId,
          lpName: row.lpName,
          offsetHours: row.offsetHours,
          revSharePercent: row.revSharePercent,
          swapFreeDays: row.swapFreeDays,
          creditCap: row.creditCap,
          notes: row.notes,
          manualStartEquity: row.manualStartEquity,
          customStartDate: null,
          customEndDate: null,
          commissionPerMillionUsd: row.commissionPerMillionUsd,
          useCalculatedCommission: row.useCalculatedCommission,
        }
      : null;
    setModal(defaultModal(row.lpName, info));
    setEditMsg(null);
    setAliasMsg(null);
    setNewAlias("");
    setAliases([]);
    setEditing(true);
    if (row.infoId) loadAliases(row.infoId);
  }

  function closeModal() {
    setEditing(false);
    setEditMsg(null);
    setSaving(false);
  }

  // ── Load Aliases (for existing LpInfo) ─────────────────────────────────────
  async function loadAliases(infoId: number) {
    setAliasLoading(true);
    try {
      const resp = await fetch(apiUrl(`/api/LpCentroidAlias?lpInfoId=${infoId}`), {
        headers: { Accept: "application/json" },
      });
      const data: LpCentroidAlias[] = await resp.json();
      setAliases(data);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setAliasMsg({ text: `Failed to load aliases: ${e.message}`, ok: false });
    } finally {
      setAliasLoading(false);
    }
  }

  async function addAlias() {
    const infoId = modal.infoId;
    if (!infoId) { setAliasMsg({ text: "Save the LP first", ok: false }); return; }
    const alias = newAlias.trim();
    if (!alias) { setAliasMsg({ text: "Enter an alias", ok: false }); return; }
    try {
      const resp = await fetch(apiUrl("/api/LpCentroidAlias"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lpInfoId: infoId, alias }),
      });
      if (resp.ok) {
        setNewAlias("");
        setAliasMsg({ text: "Added", ok: true });
        loadAliases(infoId);
      } else {
        const text = await resp.text().catch(() => "");
        setAliasMsg({ text: `Error: ${text}`, ok: false });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setAliasMsg({ text: `Failed: ${e.message}`, ok: false });
    }
  }

  async function deleteAlias(id: number) {
    if (!confirm("Remove this alias?")) return;
    const infoId = modal.infoId;
    try {
      const resp = await fetch(apiUrl(`/api/LpCentroidAlias/${id}`), { method: "DELETE" });
      if (resp.ok) {
        setAliasMsg({ text: "Removed", ok: true });
        if (infoId) loadAliases(infoId);
      } else {
        const text = await resp.text().catch(() => "");
        setAliasMsg({ text: `Error: ${text}`, ok: false });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setAliasMsg({ text: `Failed: ${e.message}`, ok: false });
    }
  }

  // ── Save ─────────────────────────────────────────────────────────────────────
  async function saveModal() {
    const { lpName, infoId } = modal;
    const commRaw = modal.commissionPerMillionUsd.trim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      lpName,
      offsetHours: parseFloat(modal.offsetHours) || 0,
      revSharePercent: parseFloat(modal.revSharePercent) || 0,
      swapFreeDays: parseInt(modal.swapFreeDays, 10) || 0,
      creditCap: parseFloat(modal.creditCap) || 0,
      notes: modal.notes.trim() || null,
      manualStartEquity: parseFloat(modal.manualStartEquity) || 0,
      customStartDate: modal.customStartDate || null,
      customEndDate: modal.customEndDate || null,
      commissionPerMillionUsd: commRaw === "" ? null : parseFloat(commRaw),
      useCalculatedCommission: modal.useCalculatedCommission === "true",
    };

    setSaving(true);
    try {
      const resp = infoId
        ? await fetch(apiUrl(`/api/LpInfo/${infoId}`), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch(apiUrl("/api/LpInfo"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
      if (resp.ok) {
        closeModal();
        setMsg({ text: `LP Info ${infoId ? "updated" : "created"} for ${lpName}`, ok: true });
        await loadData();
      } else {
        const text = await resp.text().catch(() => "");
        setEditMsg({ text: `Error: ${text || "Failed to save"}`, ok: false });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setEditMsg({ text: `Failed: ${e.message}`, ok: false });
    } finally {
      setSaving(false);
    }
  }

  // ── Bulk ─────────────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function bulkUpdate(patch: Record<string, any>, label: string) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      const resp = await fetch(apiUrl("/api/lpinfo/bulk-update"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, patch }),
      });
      if (resp.ok) {
        setSelectedIds(new Set());
        await loadData();
        setMsg({ text: `${label}: updated ${ids.length} LP(s)`, ok: true });
      } else {
        const text = await resp.text().catch(() => "");
        setMsg({ text: `Error: ${text || resp.statusText}`, ok: false });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setMsg({ text: `Bulk update failed: ${e.message}`, ok: false });
    }
  }

  function bulkSetRate() {
    const raw = window.prompt("Enter $/M rate (positive number):", "");
    if (raw === null) return;
    const val = Number(raw);
    if (!Number.isFinite(val) || val <= 0) {
      setMsg({ text: "Invalid rate — must be a positive number", ok: false });
      return;
    }
    bulkUpdate({ commissionPerMillionUsd: val }, "Set $/M");
  }

  // ── CSV Import ───────────────────────────────────────────────────────────────
  async function importCsv() {
    const text = csvText.trim();
    if (!text) { setImportMsg({ text: "Paste CSV content first", ok: false }); return; }
    setImporting(true);
    try {
      const resp = await fetch(apiUrl("/api/LpInfo/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText: text }),
      });
      if (resp.ok) {
        const result = await resp.json();
        let message = `Imported ${result.imported ?? 0} LP(s)`;
        if (result.skipped > 0) message += `, skipped ${result.skipped}`;
        if (result.errors && result.errors.length > 0) message += ` (${result.errors.length} errors)`;
        setImportMsg({ text: message, ok: true });
        setCsvText("");
        await loadData();
      } else {
        const errText = await resp.text().catch(() => "");
        setImportMsg({ text: `Error: ${errText}`, ok: false });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setImportMsg({ text: `Failed: ${e.message}`, ok: false });
    } finally {
      setImporting(false);
    }
  }

  // ── Selection helpers ─────────────────────────────────────────────────────
  const selectableRows = useMemo(() => rows.filter((r) => !r._noInfo && r.infoId != null), [rows]);
  const allSelected =
    selectableRows.length > 0 && selectableRows.every((r) => selectedIds.has(r.infoId!));
  const someSelected = !allSelected && selectableRows.some((r) => selectedIds.has(r.infoId!));
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableRows.map((r) => r.infoId!)));
    }
  }

  function toggleRow(infoId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(infoId)) next.delete(infoId); else next.add(infoId);
      return next;
    });
  }

  // ── Table Columns ─────────────────────────────────────────────────────────
  const columns: SortableTableColumn<TableRow>[] = [
    {
      key: "select",
      label: "",
      hideable: false,
      headerRender: () => (
        <input
          ref={selectAllRef}
          type="checkbox"
          checked={allSelected}
          onChange={toggleSelectAll}
          className="h-3.5 w-3.5 cursor-pointer rounded border-slate-500"
          title="Select all selectable rows"
        />
      ),
      render: (row) =>
        row._noInfo ? (
          <span className="inline-block h-3.5 w-3.5" />
        ) : (
          <input
            type="checkbox"
            checked={selectedIds.has(row.infoId!)}
            onChange={() => toggleRow(row.infoId!)}
            className="h-3.5 w-3.5 cursor-pointer rounded border-slate-500"
          />
        ),
    },
    {
      key: "lpName",
      label: "LP Name",
      hideable: false,
      sortValue: (r) => r.lpName,
      searchValue: (r) => r.lpName,
      render: (r) => <span className="font-semibold text-foreground">{r.lpName}</span>,
    },
    {
      key: "mt5Login",
      label: "Login",
      sortValue: (r) => String(r.mt5Login ?? ""),
      searchValue: (r) => String(r.mt5Login ?? ""),
      render: (r) => <span className="font-mono">{r.mt5Login}</span>,
    },
    {
      key: "source",
      label: "Source",
      sortValue: (r) => sourceLabel(r.source),
      searchValue: (r) => sourceLabel(r.source),
      render: (r) => (
        <span className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${sourceBadgeClass(r.source)}`}>
          {sourceLabel(r.source)}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      sortValue: (r) => (r.isActive ? 1 : 0),
      searchValue: (r) => (r.isActive ? "Active" : "Inactive"),
      render: (r) =>
        r.isActive ? (
          <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
            Active
          </span>
        ) : (
          <span className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-700 dark:text-rose-300">
            Inactive
          </span>
        ),
    },
    {
      key: "offsetHours",
      label: "Offset (Hrs)",
      sortValue: (r) => (r._noInfo ? -Infinity : r.offsetHours),
      searchValue: (r) => (r._noInfo ? "" : String(r.offsetHours)),
      render: (r) => {
        if (r._noInfo) return <span className="italic text-muted-foreground">-</span>;
        const v = r.offsetHours || 0;
        const color = v > 0 ? "text-emerald-600 dark:text-emerald-400" : v < 0 ? "text-rose-600 dark:text-rose-400" : "";
        return <span className={color}>{v > 0 ? `+${v}` : v}</span>;
      },
    },
    {
      key: "revSharePercent",
      label: "Rev Share %",
      sortValue: (r) => (r._noInfo ? -Infinity : r.revSharePercent),
      searchValue: (r) => (r._noInfo ? "" : String(r.revSharePercent)),
      render: (r) =>
        r._noInfo ? (
          <span className="italic text-muted-foreground">-</span>
        ) : (
          <span>{r.revSharePercent ?? 0}%</span>
        ),
    },
    {
      key: "swapFreeDays",
      label: "Swap-Free Days",
      sortValue: (r) => (r._noInfo ? -Infinity : r.swapFreeDays),
      searchValue: (r) => (r._noInfo ? "" : String(r.swapFreeDays)),
      render: (r) =>
        r._noInfo ? <span className="italic text-muted-foreground">-</span> : <span>{r.swapFreeDays ?? 0}</span>,
    },
    {
      key: "creditCap",
      label: "Credit Cap",
      sortValue: (r) => (r._noInfo ? -Infinity : r.creditCap),
      searchValue: (r) => (r._noInfo ? "" : String(r.creditCap)),
      render: (r) =>
        r._noInfo ? (
          <span className="italic text-muted-foreground">-</span>
        ) : (
          <span>{(r.creditCap ?? 0).toLocaleString()}</span>
        ),
    },
    {
      key: "startEquity",
      label: "Start Equity",
      sortValue: (r) => (r._noInfo ? -Infinity : r.manualStartEquity),
      searchValue: (r) => (r._noInfo ? "" : String(r.manualStartEquity)),
      render: (r) => {
        if (r._noInfo) return <span className="italic text-muted-foreground">-</span>;
        const v = r.manualStartEquity ?? 0;
        return v > 0 ? <span>{v.toLocaleString()}</span> : <span className="text-muted-foreground">-</span>;
      },
    },
    {
      key: "commissionPerMillionUsd",
      label: "$/M",
      sortValue: (r) => (r.commissionPerMillionUsd ?? -Infinity),
      searchValue: (r) => (r.commissionPerMillionUsd != null ? String(r.commissionPerMillionUsd) : ""),
      render: (r) => {
        if (r._noInfo || r.commissionPerMillionUsd == null)
          return <span className="italic text-muted-foreground">-</span>;
        return (
          <span className="font-bold text-blue-600 dark:text-blue-400">
            ${Number(r.commissionPerMillionUsd).toFixed(2)}
          </span>
        );
      },
    },
    {
      key: "useCalc",
      label: "Use Calc",
      sortValue: (r) => (r._noInfo ? -1 : r.useCalculatedCommission ? 1 : 0),
      searchValue: (r) => (r._noInfo ? "" : r.useCalculatedCommission ? "Calc" : "Actual"),
      render: (r) => {
        if (r._noInfo) return <span className="italic text-muted-foreground">-</span>;
        return r.useCalculatedCommission ? (
          <span className="font-bold text-blue-600 dark:text-blue-400">Calc</span>
        ) : (
          <span className="text-amber-600 dark:text-amber-400">Actual</span>
        );
      },
    },
    {
      key: "centroidAliases",
      label: "Centroid Aliases",
      sortValue: (r) => r.centroidAliases.join(","),
      searchValue: (r) => r.centroidAliases.join(" "),
      render: (r) => {
        if (r._noInfo) return <span className="italic text-muted-foreground">-</span>;
        if (!r.centroidAliases.length) return <span className="italic text-muted-foreground">none</span>;
        return (
          <span className="flex flex-wrap gap-1">
            {r.centroidAliases.map((a) => (
              <code
                key={a}
                className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[11px] text-blue-700 dark:text-blue-300"
              >
                {a}
              </code>
            ))}
          </span>
        );
      },
    },
    {
      key: "notes",
      label: "Notes",
      sortValue: (r) => r.notes ?? "",
      searchValue: (r) => r.notes ?? "",
      render: (r) => (
        <span className="text-muted-foreground">{r.notes || <span className="italic">-</span>}</span>
      ),
    },
    {
      key: "actions",
      label: "Actions",
      hideable: false,
      headerClassName: "text-right",
      cellClassName: "text-right",
      render: (r) =>
        r._noInfo ? (
          <button
            onClick={() => openModal(r)}
            title="Add LP Info"
            className="rounded border border-emerald-500/40 bg-transparent px-2 py-1 text-[11px] font-bold text-emerald-600 hover:bg-emerald-500 hover:text-white dark:text-emerald-400"
          >
            +
          </button>
        ) : (
          <button
            onClick={() => openModal(r)}
            title="Edit LP Info"
            className="rounded bg-amber-400 px-2 py-1 text-[11px] font-medium text-black hover:bg-amber-500"
          >
            ✎
          </button>
        ),
    },
  ];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="bg-background min-h-screen">
        <main className="space-y-5 p-3 sm:p-4 md:p-6 lg:p-8">
          {/* Header */}
          <div>
            <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
              Settings Control
            </div>
            <h1 className="mt-1 text-2xl font-bold text-primary">LP Info Management</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Configure offset hours, revenue share, commission rates, and Centroid aliases for each LP.
            </p>
          </div>

          {/* Status message */}
          {msg && (
            <div
              className={`rounded-lg border px-3 py-2 text-sm ${
                msg.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
              }`}
            >
              {msg.text}
            </div>
          )}

          {/* CSV Import Panel */}
          <div className={`${panelClass} p-4`}>
            <h2 className="mb-1 text-base font-semibold text-primary">CSV Import</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Paste CSV with header:{" "}
              <code className="text-[11px]">
                LP Name, Offset (Hrs), Rev Share %, Swap-Free Days, Credit Cap, Notes
              </code>
              <br />
              Existing LPs will be updated. TOTAL row is skipped.
            </p>
            <textarea
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              placeholder="Paste CSV content here..."
              rows={4}
              className={`${inputClass} w-full resize-y font-mono`}
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="min-h-[18px] text-sm">
                {importMsg && (
                  <span
                    className={
                      importMsg.ok
                        ? "text-emerald-600 dark:text-emerald-300"
                        : "text-rose-600 dark:text-rose-300"
                    }
                  >
                    {importMsg.text}
                  </span>
                )}
              </div>
              <button
                onClick={importCsv}
                disabled={importing}
                className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {importing ? "Importing…" : "Import CSV"}
              </button>
            </div>
          </div>

          {/* Bulk Toolbar (conditional) */}
          {selectedIds.size > 0 && (
            <div className={`${panelClass} flex flex-wrap items-center gap-3 border-blue-500/50 px-4 py-2.5`}>
              <span className="text-sm font-semibold text-foreground">{selectedIds.size} selected</span>
              <button
                onClick={() => bulkUpdate({ useCalculatedCommission: true }, "Set Use Calculated")}
                className="rounded bg-blue-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-700"
              >
                Use Calculated
              </button>
              <button
                onClick={() => bulkUpdate({ useCalculatedCommission: false }, "Set Use Actual")}
                className="rounded bg-amber-500 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-amber-600"
              >
                Use Actual
              </button>
              <button
                onClick={bulkSetRate}
                className="rounded bg-purple-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-purple-700"
              >
                Set $/M…
              </button>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="rounded border border-border px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-secondary"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Table Panel */}
          <div className={`${panelClass} p-4`}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-primary">LP Accounts &amp; Info</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Shows all LP accounts. Click <strong>+</strong> to create LP Info or{" "}
                  <strong>✎</strong> to edit. Select rows (with LpInfo) for bulk actions.
                </p>
              </div>
              <button
                onClick={loadData}
                disabled={loading}
                className="rounded border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary disabled:opacity-50"
              >
                {loading ? "Loading…" : "Refresh"}
              </button>
            </div>
            <SortableTable
              rows={rows}
              columns={columns}
              tableId="lp-info-table"
              enableColumnVisibility
              exportFilePrefix="lp-info"
              emptyText="No LP accounts found."
              tableClassName="min-w-full text-xs"
              rowClassName={(r, i) =>
                r._noInfo
                  ? "bg-amber-500/5 hover:bg-amber-500/10 transition-colors"
                  : i % 2 === 0
                    ? "bg-background/40 hover:bg-background/70 transition-colors"
                    : "bg-background/20 hover:bg-background/60 transition-colors"
              }
            />
          </div>
        </main>
      </div>

      {/* ── Edit / Create Modal ── */}
      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div className="max-h-[90vh] w-[560px] max-w-[95vw] overflow-y-auto rounded-xl border border-border/50 bg-card p-5 shadow-2xl">
            <h2 className="text-lg font-semibold text-primary">
              {modal.infoId ? "Edit LP Info" : "Add LP Info"}{" "}
              <span className="text-sm font-normal text-muted-foreground">{modal.lpName}</span>
            </h2>

            {/* ── General ── */}
            <div className="mt-4 mb-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              General
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Offset (Hrs)
                <input
                  type="number"
                  step="0.5"
                  value={modal.offsetHours}
                  onChange={(e) => setModal((m) => ({ ...m, offsetHours: e.target.value }))}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Rev Share %
                <input
                  type="number"
                  step="0.1"
                  value={modal.revSharePercent}
                  onChange={(e) => setModal((m) => ({ ...m, revSharePercent: e.target.value }))}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Swap-Free Days
                <input
                  type="number"
                  step="1"
                  value={modal.swapFreeDays}
                  onChange={(e) => setModal((m) => ({ ...m, swapFreeDays: e.target.value }))}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Credit Cap
                <input
                  type="number"
                  step="1"
                  value={modal.creditCap}
                  onChange={(e) => setModal((m) => ({ ...m, creditCap: e.target.value }))}
                  className={inputClass}
                />
              </label>
              <label className="col-span-full flex flex-col gap-1 text-xs text-muted-foreground">
                Notes
                <input
                  type="text"
                  value={modal.notes}
                  onChange={(e) => setModal((m) => ({ ...m, notes: e.target.value }))}
                  className={inputClass}
                />
              </label>
            </div>

            {/* ── Commission ── */}
            <div className="mt-4 mb-1 border-t border-border pt-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Commission
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                $ per Million
                <input
                  type="number"
                  step="0.01"
                  placeholder="blank = unknown"
                  value={modal.commissionPerMillionUsd}
                  onChange={(e) => setModal((m) => ({ ...m, commissionPerMillionUsd: e.target.value }))}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Use Calculated
                <select
                  value={modal.useCalculatedCommission}
                  onChange={(e) => setModal((m) => ({ ...m, useCalculatedCommission: e.target.value }))}
                  className={inputClass}
                >
                  <option value="false">No — use MT5 actual commission field</option>
                  <option value="true">Yes — use $/M x notional</option>
                </select>
              </label>
            </div>

            {/* ── History / Revenue Share ── */}
            <div className="mt-4 mb-1 border-t border-border pt-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              History / Revenue Share
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Manual Start Equity
                <input
                  type="number"
                  step="0.01"
                  value={modal.manualStartEquity}
                  onChange={(e) => setModal((m) => ({ ...m, manualStartEquity: e.target.value }))}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Custom Start Date
                <input
                  type="date"
                  value={modal.customStartDate}
                  onChange={(e) => setModal((m) => ({ ...m, customStartDate: e.target.value }))}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Custom End Date
                <input
                  type="date"
                  value={modal.customEndDate}
                  onChange={(e) => setModal((m) => ({ ...m, customEndDate: e.target.value }))}
                  className={inputClass}
                />
              </label>
            </div>

            {/* ── Centroid Aliases (only for existing LpInfo) ── */}
            {modal.infoId && (
              <>
                <div className="mt-4 mb-1 border-t border-border pt-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Centroid Aliases
                </div>
                <p className="mb-2 text-xs text-muted-foreground">
                  Maker / lpsid identifiers used by Centroid for this LP (e.g.{" "}
                  <code className="text-[11px]">LMAX2_LIVE</code>). Used to attribute LP commission on the
                  Deal Matching page.
                </p>
                {aliasLoading ? (
                  <div className="text-xs text-muted-foreground">Loading aliases…</div>
                ) : aliases.length === 0 ? (
                  <div className="mb-2 text-xs italic text-muted-foreground">No aliases set.</div>
                ) : (
                  <div className="mb-2 flex flex-col gap-1">
                    {aliases.map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center gap-2 rounded border border-border bg-background/60 px-2 py-1"
                      >
                        <code className="flex-1 text-[12px] text-blue-700 dark:text-blue-300">{a.alias}</code>
                        <button
                          onClick={() => deleteAlias(a.id)}
                          className="rounded bg-rose-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-rose-600"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="e.g. LMAX2_LIVE"
                    value={newAlias}
                    onChange={(e) => setNewAlias(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAlias(); } }}
                    className={`flex-1 ${inputClass}`}
                  />
                  <button
                    onClick={addAlias}
                    className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
                  >
                    Add
                  </button>
                </div>
                {aliasMsg && (
                  <div
                    className={`mt-1 text-xs ${
                      aliasMsg.ok
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400"
                    }`}
                  >
                    {aliasMsg.text}
                  </div>
                )}
              </>
            )}

            {/* ── Modal Actions ── */}
            <div className="mt-4 flex items-center justify-end gap-2">
              {editMsg && (
                <span
                  className={`flex-1 text-sm ${
                    editMsg.ok
                      ? "text-emerald-600 dark:text-emerald-300"
                      : "text-rose-600 dark:text-rose-300"
                  }`}
                >
                  {editMsg.text}
                </span>
              )}
              <button
                onClick={closeModal}
                className="rounded border border-border bg-secondary px-4 py-2 text-sm hover:bg-secondary/70"
              >
                Cancel
              </button>
              <button
                onClick={saveModal}
                disabled={saving}
                className={`rounded px-4 py-2 text-sm font-semibold text-white ${
                  saving ? "bg-slate-500" : "bg-blue-600 hover:bg-blue-700"
                }`}
              >
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
