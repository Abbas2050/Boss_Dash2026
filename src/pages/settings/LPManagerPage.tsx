import React, { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ChevronDown, ChevronRight, Layers3, PlusCircle, RefreshCw, Server, ShieldCheck, Sparkles } from "lucide-react";
import { SortableTable, type SortableTableColumn } from "../../components/ui/SortableTable";

type LPSource = "Manager" | "Terminal" | "Bonus";

type LPAccount = {
  id: number;
  lpName: string;
  mt5Login: number | string;
  source?: string | number;
  groupPattern?: string | null;
  description?: string | null;
  isActive: boolean;
  mt5TerminalPath?: string | null;
  mt5Server?: string | null;
  coverageAccountLogin?: number | null;
  excludeFromEquity?: boolean;
  excludeFromPositions?: boolean;
};

type TerminalStatusItem = {
  login: number | string;
  isStale?: boolean;
  lastPush?: string | null;
};

type CoverageBreakdownItem = {
  lpName?: string;
  mt5Login?: number | string;
  buyLots?: number;
  sellLots?: number;
  netLots?: number;
  positionCount?: number;
  profit?: number;
};

type CoverageItem = {
  baseSymbol?: string;
  netUncovered?: number;
  clientBuyLots?: number;
  clientSellLots?: number;
  clientNetLots?: number;
  clientPositions?: number;
  clientProfit?: number;
  lpBreakdown?: CoverageBreakdownItem[];
};

type LPAccountTableRow = LPAccount & {
  sourceLabel: LPSource;
};

type TerminalFeedRow = {
  key: string;
  lpName: string;
  login: string;
  isActive: boolean | null;
  isStale: boolean;
  lastPushLabel: string;
};

const sourceName = (val: unknown): LPSource => {
  if (typeof val === "string") {
    const normalized = val.trim().toLowerCase();
    if (normalized === "terminal") return "Terminal";
    if (normalized === "bonus") return "Bonus";
    return "Manager";
  }
  if (typeof val === "number") {
    if (val === 1) return "Terminal";
    if (val === 2) return "Bonus";
  }
  return "Manager";
};

const fmtNum = (value: unknown, digits = 2) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return num.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

const sourceBadgeClass = (source: LPSource) => {
  if (source === "Terminal") return "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border-cyan-500/30";
  if (source === "Bonus") return "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30";
  return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
};

const panelClass = "rounded-xl border border-border/40 bg-card/80 shadow-sm";
const inputClass =
  "rounded border border-border bg-background/70 p-2 text-sm transition outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20";

export const LPManagerPage: React.FC = () => {
  const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
  const apiUrl = (path: string) => (backendBaseUrl ? `${backendBaseUrl}${path}` : path);

  const [accounts, setAccounts] = useState<LPAccount[]>([]);
  const [coverageRows, setCoverageRows] = useState<CoverageItem[]>([]);
  const [coverageExpanded, setCoverageExpanded] = useState(false);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [terminalRows, setTerminalRows] = useState<TerminalStatusItem[]>([]);

  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [editMsg, setEditMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const [lpName, setLpName] = useState("");
  const [mt5Login, setMt5Login] = useState("");
  const [source, setSource] = useState<LPSource>("Manager");
  const [groupPattern, setGroupPattern] = useState("");
  const [description, setDescription] = useState("");
  const [coverageAccountLogin, setCoverageAccountLogin] = useState("");
  const [excludeFromEquity, setExcludeFromEquity] = useState(false);
  const [excludeFromPositions, setExcludeFromPositions] = useState(false);
  const [mt5TerminalPath, setMt5TerminalPath] = useState("");
  const [mt5Server, setMt5Server] = useState("");
  const [mt5Password, setMt5Password] = useState("");

  const [editing, setEditing] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editLpName, setEditLpName] = useState("");
  const [editMt5Login, setEditMt5Login] = useState("");
  const [editGroupPattern, setEditGroupPattern] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editIsActive, setEditIsActive] = useState(true);
  const [editIsTerminal, setEditIsTerminal] = useState(false);
  const [editTerminalPath, setEditTerminalPath] = useState("");
  const [editMt5Server, setEditMt5Server] = useState("");
  const [editMt5Password, setEditMt5Password] = useState("");
  const [editCoverageAccountLogin, setEditCoverageAccountLogin] = useState("");
  const [editExcludeFromEquity, setEditExcludeFromEquity] = useState(false);
  const [editExcludeFromPositions, setEditExcludeFromPositions] = useState(false);
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const [editSaving, setEditSaving] = useState(false);
  const lpNameInputRef = useRef<HTMLInputElement | null>(null);
  const [sourceFilter, setSourceFilter] = useState<"all" | LPSource>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [equityFilter, setEquityFilter] = useState<"all" | "included" | "excluded">("all");
  const [positionsFilter, setPositionsFilter] = useState<"all" | "included" | "excluded">("all");

  async function readJsonOrThrow<T>(resp: Response, label: string): Promise<T> {
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`${label} failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      const text = await resp.text().catch(() => "");
      throw new Error(`${label} returned non-JSON response${text ? `: ${text.slice(0, 120)}` : ""}`);
    }
    return resp.json() as Promise<T>;
  }

  async function loadAccounts() {
    try {
      const resp = await fetch(apiUrl(`/api/LpAccount?all=true`), { headers: { Accept: "application/json" } });
      const data = await readJsonOrThrow<LPAccount[]>(resp, "Load accounts");
      setAccounts(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setAccounts([]);
      setMsg({ text: `Failed to load accounts: ${e.message}`, ok: false });
    }
  }

  async function loadCoverage() {
    setCoverageLoading(true);
    try {
      const resp = await fetch(apiUrl(`/Coverage/dashboard`), { headers: { Accept: "application/json" } });
      const data = await readJsonOrThrow<CoverageItem[]>(resp, "Load coverage");
      setCoverageRows(Array.isArray(data) ? data : []);
    } catch {
      setCoverageRows([]);
    } finally {
      setCoverageLoading(false);
    }
  }

  async function loadTerminalStatus() {
    try {
      const resp = await fetch(apiUrl(`/api/TerminalPosition/status`), { headers: { Accept: "application/json" } });
      const data = await readJsonOrThrow<TerminalStatusItem[]>(resp, "Load terminal status");
      setTerminalRows(Array.isArray(data) ? data : []);
    } catch {
      setTerminalRows([]);
    }
  }

  async function loadAll() {
    await Promise.all([loadAccounts(), loadCoverage(), loadTerminalStatus()]);
  }

  useEffect(() => {
    loadAccounts();
    loadTerminalStatus();
  }, []);

  useEffect(() => {
    if (!coverageExpanded) return;
    loadCoverage();
    const covInterval = setInterval(loadCoverage, 3000);
    return () => clearInterval(covInterval);
  }, [coverageExpanded]);

  useEffect(() => {
    const termInterval = setInterval(loadTerminalStatus, 5000);
    return () => {
      clearInterval(termInterval);
    };
  }, []);

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
    if (!editing) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeEditModal();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [editing]);

  const accountStats = useMemo(() => {
    let managerCount = 0;
    let terminalCount = 0;
    let bonusCount = 0;
    for (const account of accounts) {
      const src = sourceName(account.source);
      if (src === "Terminal") terminalCount += 1;
      else if (src === "Bonus") bonusCount += 1;
      else managerCount += 1;
    }
    return {
      total: accounts.length,
      managerCount,
      terminalCount,
      bonusCount,
    };
  }, [accounts]);

  const accountByLogin = useMemo(() => {
    const map = new Map<string, LPAccount>();
    for (const a of accounts) {
      const key = String(a.mt5Login ?? "").trim();
      if (!key) continue;
      map.set(key, a);
    }
    return map;
  }, [accounts]);

  const lpAccountRows = useMemo<LPAccountTableRow[]>(
    () => accounts.map((a) => ({ ...a, sourceLabel: sourceName(a.source) })),
    [accounts],
  );

  const filteredAccountRows = useMemo(() => {
    return lpAccountRows.filter((row) => {
      if (sourceFilter !== "all" && row.sourceLabel !== sourceFilter) return false;
      if (statusFilter === "active" && !row.isActive) return false;
      if (statusFilter === "inactive" && row.isActive) return false;
      if (equityFilter === "excluded" && !row.excludeFromEquity) return false;
      if (equityFilter === "included" && row.excludeFromEquity) return false;
      if (positionsFilter === "excluded" && !row.excludeFromPositions) return false;
      if (positionsFilter === "included" && row.excludeFromPositions) return false;
      return true;
    });
  }, [equityFilter, lpAccountRows, positionsFilter, sourceFilter, statusFilter]);

  const terminalFeedRows = useMemo<TerminalFeedRow[]>(() => {
    return terminalRows.map((row, idx) => {
      const matched = accountByLogin.get(String(row.login));
      const lastPushDate = row.lastPush ? new Date(row.lastPush) : null;
      return {
        key: `term-${row.login}-${idx}`,
        lpName: matched?.lpName || `Login ${row.login}`,
        login: String(row.login),
        isActive: matched ? !!matched.isActive : null,
        isStale: !!row.isStale,
        lastPushLabel: lastPushDate ? lastPushDate.toLocaleTimeString() : "Never",
      };
    });
  }, [accountByLogin, terminalRows]);

  const canSubmitAccount = useMemo(() => {
    const hasBase = lpName.trim().length > 0 && mt5Login.trim().length > 0;
    if (!hasBase) return false;
    const parsedLogin = Number(mt5Login);
    if (!Number.isFinite(parsedLogin) || parsedLogin <= 0) return false;
    if (source !== "Terminal") return true;
    return mt5TerminalPath.trim().length > 0 && mt5Server.trim().length > 0 && mt5Password.trim().length > 0;
  }, [lpName, mt5Login, mt5Password, mt5Server, mt5TerminalPath, source]);

  function resetAddForm() {
    setLpName("");
    setMt5Login("");
    setSource("Manager");
    setGroupPattern("");
    setDescription("");
    setCoverageAccountLogin("");
    setExcludeFromEquity(false);
    setExcludeFromPositions(false);
    setMt5TerminalPath("");
    setMt5Server("");
    setMt5Password("");
  }

  function openEditModal(id: number) {
    const a = accounts.find((x) => x.id === id);
    if (!a) return;
    const isTerminal = sourceName(a.source) === "Terminal";
    setEditId(a.id);
    setEditLpName(a.lpName || "");
    setEditMt5Login(String(a.mt5Login || ""));
    setEditGroupPattern(a.groupPattern || "");
    setEditDescription(a.description || "");
    setEditIsActive(!!a.isActive);
    setEditIsTerminal(isTerminal);
    setEditTerminalPath(a.mt5TerminalPath || "");
    setEditMt5Server(a.mt5Server || "");
    setEditMt5Password("");
    setEditCoverageAccountLogin(
      a.coverageAccountLogin === null || a.coverageAccountLogin === undefined
        ? ""
        : String(a.coverageAccountLogin),
    );
    setEditExcludeFromEquity(!!a.excludeFromEquity);
    setEditExcludeFromPositions(!!a.excludeFromPositions);
    setEditErrors({});
    setEditMsg(null);
    setEditing(true);
  }

  function closeEditModal() {
    setEditing(false);
    setEditId(null);
    setEditMsg(null);
    setEditErrors({});
  }

  async function saveEdit() {
    if (!editId) return;
    const errors: Record<string, string> = {};
    if (!editLpName.trim()) errors.lpName = "LP Name is required";
    setEditErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const coverageVal = editCoverageAccountLogin.trim();
    const body: any = {
      lpName: editLpName.trim() || null,
      groupPattern: editGroupPattern.trim() || null,
      description: editDescription.trim() || null,
      isActive: editIsActive,
      coverageAccountLogin: coverageVal ? Number(coverageVal) : null,
      excludeFromEquity: editExcludeFromEquity,
      excludeFromPositions: editExcludeFromPositions,
    };

    const path = editTerminalPath.trim();
    const server = editMt5Server.trim();
    const password = editMt5Password.trim();
    if (path) body.mt5TerminalPath = path;
    if (server) body.mt5Server = server;
    if (password) body.mt5Password = password;

    setEditSaving(true);
    try {
      const resp = await fetch(apiUrl(`/api/LpAccount/${editId}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        closeEditModal();
        setMsg({ text: "Account updated successfully", ok: true });
        await loadAccounts();
        loadCoverage();
      } else {
        const text = await resp.text().catch(() => "");
        setEditMsg({ text: `Error: ${text || "Failed to save changes"}`, ok: false });
      }
    } catch (e: any) {
      setEditMsg({ text: `Failed: ${e.message}`, ok: false });
    } finally {
      setEditSaving(false);
    }
  }

  async function addAccount() {
    if (!lpName.trim() || !mt5Login.trim()) {
      setMsg({ text: "LP Name and MT5 Login are required", ok: false });
      return;
    }
    const parsedLogin = parseInt(mt5Login, 10);
    if (!Number.isFinite(parsedLogin) || parsedLogin <= 0) {
      setMsg({ text: "MT5 Login must be a valid positive number", ok: false });
      return;
    }

    const coverageVal = coverageAccountLogin.trim();
    const body: any = {
      lpName: lpName.trim(),
      mt5Login: parsedLogin,
      source,
      groupPattern: groupPattern.trim() || null,
      description: description.trim() || null,
      coverageAccountLogin: coverageVal ? parseInt(coverageVal, 10) : null,
      excludeFromEquity,
      excludeFromPositions,
    };

    if (source === "Terminal") {
      const path = mt5TerminalPath.trim();
      const server = mt5Server.trim();
      const password = mt5Password.trim();
      if (!path || !server || !password) {
        setMsg({ text: "Terminal source requires Path, Server, and Password", ok: false });
        return;
      }
      body.mt5TerminalPath = path;
      body.mt5Server = server;
      body.mt5Password = password;
    }

    try {
      const resp = await fetch(apiUrl(`/api/LpAccount`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        const a = await resp.json().catch(() => null);
        setMsg({ text: `Added ${a?.lpName || body.lpName} (login ${a?.mt5Login || body.mt5Login})`, ok: true });
        resetAddForm();
        await loadAccounts();
        loadCoverage();
      } else {
        const text = await resp.text().catch(() => "");
        setMsg({ text: `Error: ${text || "Failed to add account"}`, ok: false });
      }
    } catch (e: any) {
      setMsg({ text: `Failed: ${e.message}`, ok: false });
    }
  }

  async function deactivate(id: number) {
    if (!confirm("Deactivate this LP account? It will stop tracking positions.")) return;
    try {
      const resp = await fetch(apiUrl(`/api/LpAccount/${id}`), { method: "DELETE" });
      if (resp.ok) {
        setMsg({ text: "Account deactivated", ok: true });
        loadAccounts();
        loadCoverage();
      } else {
        setMsg({ text: "Failed to deactivate", ok: false });
      }
    } catch (e: any) {
      setMsg({ text: `Failed: ${e.message}`, ok: false });
    }
  }

  async function activate(id: number) {
    try {
      const resp = await fetch(apiUrl(`/api/LpAccount/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true }),
      });
      if (resp.ok) {
        setMsg({ text: "Account activated", ok: true });
        loadAccounts();
        loadCoverage();
      } else {
        setMsg({ text: "Failed to activate", ok: false });
      }
    } catch (e: any) {
      setMsg({ text: `Failed: ${e.message}`, ok: false });
    }
  }

  async function removeAccount(id: number, name: string) {
    if (!confirm(`Permanently remove LP account "${name}" (#${id})? This cannot be undone.`)) return;
    try {
      const resp = await fetch(apiUrl(`/api/LpAccount/${id}?permanent=true`), { method: "DELETE" });
      if (resp.ok) {
        setMsg({ text: `Account "${name}" permanently removed`, ok: true });
        loadAccounts();
        loadCoverage();
      } else {
        setMsg({ text: "Failed to remove", ok: false });
      }
    } catch (e: any) {
      setMsg({ text: `Failed: ${e.message}`, ok: false });
    }
  }

  const lpAccountColumns: SortableTableColumn<LPAccountTableRow>[] = [
    {
      key: "id",
      label: "ID",
      sortValue: (row) => row.id,
      searchValue: (row) => String(row.id),
      hideable: false,
      render: (row) => row.id,
    },
    {
      key: "lpName",
      label: "LP Name",
      sortValue: (row) => row.lpName || "",
      searchValue: (row) => row.lpName || "",
      hideable: false,
      render: (row) => <span className="font-semibold text-foreground">{row.lpName}</span>,
    },
    {
      key: "mt5Login",
      label: "MT5 Login",
      sortValue: (row) => String(row.mt5Login || ""),
      searchValue: (row) => String(row.mt5Login || ""),
      render: (row) => <span className="font-mono">{row.mt5Login}</span>,
    },
    {
      key: "source",
      label: "Source",
      sortValue: (row) => row.sourceLabel,
      searchValue: (row) => row.sourceLabel,
      render: (row) => (
        <span className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${sourceBadgeClass(row.sourceLabel)}`}>{row.sourceLabel}</span>
      ),
    },
    {
      key: "coverage",
      label: "Coverage Login",
      sortValue: (row) => Number(row.coverageAccountLogin || 0),
      searchValue: (row) => String(row.coverageAccountLogin || "-"),
      render: (row) => row.coverageAccountLogin || "-",
    },
    {
      key: "equity",
      label: "Equity",
      sortValue: (row) => (row.excludeFromEquity ? 0 : 1),
      searchValue: (row) => (row.excludeFromEquity ? "Excluded" : "Included"),
      render: (row) =>
        row.excludeFromEquity ? (
          <span className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-700 dark:text-rose-300">Excluded</span>
        ) : (
          <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">Included</span>
        ),
    },
    {
      key: "positions",
      label: "Positions",
      sortValue: (row) => (row.excludeFromPositions ? 0 : 1),
      searchValue: (row) => (row.excludeFromPositions ? "Excluded" : "Included"),
      render: (row) =>
        row.excludeFromPositions ? (
          <span className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-700 dark:text-rose-300">Excluded</span>
        ) : (
          <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">Included</span>
        ),
    },
    {
      key: "group",
      label: "Group",
      sortValue: (row) => row.groupPattern || "",
      searchValue: (row) => row.groupPattern || "",
      render: (row) => (
        <span className="inline-block max-w-[240px] truncate align-middle" title={row.groupPattern || "-"}>
          {row.groupPattern || "-"}
        </span>
      ),
    },
    {
      key: "description",
      label: "Description",
      sortValue: (row) => row.description || "",
      searchValue: (row) => row.description || "",
      render: (row) => (
        <span className="inline-block max-w-[260px] truncate align-middle" title={row.description || "-"}>
          {row.description || "-"}
        </span>
      ),
      defaultVisible: false,
    },
    {
      key: "status",
      label: "Status",
      sortValue: (row) => (row.isActive ? 1 : 0),
      searchValue: (row) => (row.isActive ? "Active" : "Inactive"),
      render: (row) =>
        row.isActive ? (
          <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">Active</span>
        ) : (
          <span className="rounded border border-slate-500/30 bg-slate-500/10 px-2 py-0.5 text-[11px] text-slate-700 dark:text-slate-300">Inactive</span>
        ),
    },
    {
      key: "actions",
      label: "Actions",
      hideable: false,
      headerClassName: "text-right",
      cellClassName: "text-right",
      render: (row) => (
        <div className="inline-flex flex-wrap justify-end gap-1.5">
          <button
            onClick={() => openEditModal(row.id)}
            className="rounded bg-amber-400 px-2 py-1 text-[11px] font-medium text-black hover:bg-amber-500"
          >
            Edit
          </button>
          {row.isActive ? (
            <button
              onClick={() => deactivate(row.id)}
              className="rounded border border-rose-500/40 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-500/10 dark:text-rose-300"
            >
              Deactivate
            </button>
          ) : (
            <button
              onClick={() => activate(row.id)}
              className="rounded bg-emerald-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-600"
            >
              Activate
            </button>
          )}
          <button
            onClick={() => removeAccount(row.id, row.lpName)}
            className="rounded bg-rose-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-rose-600"
          >
            Remove
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="bg-background min-h-screen">
        <main className="p-3 sm:p-4 md:p-6 lg:p-8 space-y-5">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">Settings Control</div>
            <h1 className="mt-1 text-2xl font-bold text-primary">LP Account Manager</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage LP sources, coverage exclusions, terminal workers, and live coverage telemetry in one place.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            <div className={`${panelClass} bg-gradient-to-br from-slate-500/5 to-slate-400/5 p-3`}>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">LP Accounts</div>
              <div className="mt-1 flex items-center gap-2">
                <Layers3 className="h-4 w-4 text-muted-foreground" />
                <div className="font-mono text-lg font-semibold text-foreground">{accountStats.total.toLocaleString()}</div>
              </div>
            </div>
            <div className={`${panelClass} bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 p-3`}>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Manager</div>
              <div className="mt-1 flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
                <div className="font-mono text-lg font-semibold text-emerald-700 dark:text-emerald-300">{accountStats.managerCount.toLocaleString()}</div>
              </div>
            </div>
            <div className={`${panelClass} bg-gradient-to-br from-cyan-500/10 to-cyan-500/5 p-3`}>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Terminal</div>
              <div className="mt-1 flex items-center gap-2">
                <Server className="h-4 w-4 text-cyan-700 dark:text-cyan-300" />
                <div className="font-mono text-lg font-semibold text-cyan-700 dark:text-cyan-300">{accountStats.terminalCount.toLocaleString()}</div>
              </div>
            </div>
            <div className={`${panelClass} bg-gradient-to-br from-violet-500/10 to-violet-500/5 p-3`}>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Bonus</div>
              <div className="mt-1 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-violet-700 dark:text-violet-300" />
                <div className="font-mono text-lg font-semibold text-violet-700 dark:text-violet-300">{accountStats.bonusCount.toLocaleString()}</div>
              </div>
            </div>
            <div className={`${panelClass} p-3 flex items-end`}>
              <button
                onClick={loadAll}
                className="group w-full inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-500/30 bg-gradient-to-r from-cyan-500/20 via-blue-500/15 to-violet-500/20 px-3 py-2 text-xs font-semibold text-cyan-900 shadow-sm transition hover:from-cyan-500/30 hover:to-violet-500/30 dark:text-cyan-100"
              >
                <RefreshCw className="h-3.5 w-3.5 transition-transform duration-500 group-hover:rotate-180" />
                Refresh All Data
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <div className={`${panelClass} p-4 bg-gradient-to-br from-blue-500/10 via-card to-indigo-500/5`}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!canSubmitAccount) {
                    setMsg({ text: "Please complete required fields before submitting.", ok: false });
                    return;
                  }
                  addAccount();
                }}
              >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-primary">Add LP Account</h2>
                  <div className="mt-1 text-xs text-muted-foreground">Create and classify LP accounts with optional terminal and coverage controls.</div>
                  <div className="mt-1 text-[11px] text-cyan-700 dark:text-cyan-300">Submit button is at the bottom of this form.</div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                <input
                  ref={lpNameInputRef}
                  value={lpName}
                  onChange={(e) => setLpName(e.target.value)}
                  placeholder="LP Name (e.g. ATFX, FXCM)"
                  className={inputClass}
                />
                <input
                  value={mt5Login}
                  onChange={(e) => setMt5Login(e.target.value)}
                  placeholder="MT5 Login"
                  type="number"
                  className={inputClass}
                />
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value as LPSource)}
                  className={inputClass}
                >
                  <option value="Manager">Manager</option>
                  <option value="Terminal">Terminal</option>
                  <option value="Bonus">Bonus</option>
                </select>
                <input
                  value={groupPattern}
                  onChange={(e) => setGroupPattern(e.target.value)}
                  placeholder="Group Pattern (optional)"
                  className={inputClass}
                />
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Description (optional)"
                  className={`${inputClass} md:col-span-2`}
                />
                <input
                  value={coverageAccountLogin}
                  onChange={(e) => setCoverageAccountLogin(e.target.value)}
                  placeholder="Coverage Account Login (optional)"
                  type="number"
                  className={inputClass}
                />
                <div className="flex items-center gap-2 rounded border border-border bg-background/70 p-2 text-sm">
                  <label className="text-muted-foreground">Exclude From Equity</label>
                  <select
                    value={String(excludeFromEquity)}
                    onChange={(e) => setExcludeFromEquity(e.target.value === "true")}
                    className="ml-auto rounded border border-border bg-card px-2 py-1 text-xs"
                  >
                    <option value="false">No</option>
                    <option value="true">Yes</option>
                  </select>
                </div>
                <div className="flex items-center gap-2 rounded border border-border bg-background/70 p-2 text-sm">
                  <label className="text-muted-foreground">Exclude From Positions</label>
                  <select
                    value={String(excludeFromPositions)}
                    onChange={(e) => setExcludeFromPositions(e.target.value === "true")}
                    className="ml-auto rounded border border-border bg-card px-2 py-1 text-xs"
                  >
                    <option value="false">No</option>
                    <option value="true">Yes</option>
                  </select>
                </div>
              </div>

              {source === "Terminal" && (
                <div className="mt-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3">
                  <div className="mb-2 text-xs text-cyan-700 dark:text-cyan-300">
                    Terminal source requires MT5 terminal installed on this machine
                  </div>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                    <input
                      value={mt5TerminalPath}
                      onChange={(e) => setMt5TerminalPath(e.target.value)}
                      placeholder="Terminal Path"
                      className={inputClass}
                    />
                    <input
                      value={mt5Server}
                      onChange={(e) => setMt5Server(e.target.value)}
                      placeholder="MT5 Server"
                      className={inputClass}
                    />
                    <input
                      value={mt5Password}
                      onChange={(e) => setMt5Password(e.target.value)}
                      type="password"
                      placeholder="MT5 Password"
                      className={inputClass}
                    />
                  </div>
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 p-2">
                <button
                  type="submit"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-blue-700 bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                  style={{ backgroundColor: "#2563eb", color: "#ffffff", borderColor: "#1d4ed8" }}
                >
                  <PlusCircle className="h-4 w-4" />
                  <span style={{ color: "#ffffff" }}>Submit LP Account</span>
                </button>
                <div className="text-[11px] text-muted-foreground">
                  Required: LP Name + MT5 Login{source === "Terminal" ? " + Terminal Path + Server + Password." : "."}
                </div>
                {msg && (
                  <div className={msg.ok ? "text-sm text-emerald-600 dark:text-emerald-300" : "text-sm text-rose-600 dark:text-rose-300"}>
                    {msg.text}
                  </div>
                )}
              </div>
              </form>
            </div>

            <div className={`${panelClass} p-4 bg-gradient-to-br from-cyan-500/10 via-card to-emerald-500/5`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-primary">Terminal Feed Status</h2>
                  <div className="mt-1 text-xs text-muted-foreground">Live heartbeat of MT5 terminal workers and last push timestamps.</div>
                </div>
                <div className="inline-flex items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">
                  <Activity className="h-3.5 w-3.5" />
                  Live
                </div>
              </div>
              <div className="mt-3">
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="min-w-full text-xs">
                    <thead className="bg-secondary/70 text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left font-semibold uppercase tracking-wide">LP Name</th>
                        <th className="px-2 py-1.5 text-left font-semibold uppercase tracking-wide">Login</th>
                        <th className="px-2 py-1.5 text-left font-semibold uppercase tracking-wide">Status</th>
                        <th className="px-2 py-1.5 text-left font-semibold uppercase tracking-wide">Last Push</th>
                        <th className="px-2 py-1.5 text-left font-semibold uppercase tracking-wide">Health</th>
                      </tr>
                    </thead>
                    <tbody>
                      {terminalFeedRows.map((row) => (
                        <tr key={row.key} className="border-t border-border bg-background/30 hover:bg-background/60 transition-colors">
                          <td className="px-2 py-1.5 font-semibold text-foreground">{row.lpName}</td>
                          <td className="px-2 py-1.5 font-mono text-muted-foreground">{row.login}</td>
                          <td className="px-2 py-1.5">
                            {row.isActive === null ? (
                              <span className="rounded border border-slate-500/30 bg-slate-500/10 px-2 py-0.5 text-[10px] text-slate-700 dark:text-slate-300">Unknown</span>
                            ) : row.isActive ? (
                              <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">Active</span>
                            ) : (
                              <span className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-700 dark:text-rose-300">Inactive</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">{row.lastPushLabel}</td>
                          <td className="px-2 py-1.5">
                            {row.isStale ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-600 dark:text-amber-300">
                                <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                                Stale
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-300">
                                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                                OK
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                      {!terminalFeedRows.length && (
                        <tr>
                          <td colSpan={5} className="px-3 py-3 text-center text-xs text-muted-foreground">
                            No terminal feeds active.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>

          <div className={`${panelClass} p-4`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-primary">LP Accounts</h2>
                <div className="mt-1 text-xs text-muted-foreground">
                  Modern table controls enabled: search, sorting, CSV export, column show/hide, and drag re-order.
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as "all" | LPSource)} className="rounded border border-border bg-background/70 px-2 py-1.5 text-xs">
                  <option value="all">All Sources</option>
                  <option value="Manager">Manager</option>
                  <option value="Terminal">Terminal</option>
                  <option value="Bonus">Bonus</option>
                </select>
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "all" | "active" | "inactive")} className="rounded border border-border bg-background/70 px-2 py-1.5 text-xs">
                  <option value="all">All Status</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
                <select value={equityFilter} onChange={(e) => setEquityFilter(e.target.value as "all" | "included" | "excluded")} className="rounded border border-border bg-background/70 px-2 py-1.5 text-xs">
                  <option value="all">Equity: All</option>
                  <option value="included">Equity: Included</option>
                  <option value="excluded">Equity: Excluded</option>
                </select>
                <select value={positionsFilter} onChange={(e) => setPositionsFilter(e.target.value as "all" | "included" | "excluded")} className="rounded border border-border bg-background/70 px-2 py-1.5 text-xs">
                  <option value="all">Positions: All</option>
                  <option value="included">Positions: Included</option>
                  <option value="excluded">Positions: Excluded</option>
                </select>
              </div>
            </div>

            <div className="mt-3">
              <SortableTable
                rows={filteredAccountRows}
                columns={lpAccountColumns}
                tableId="lp-manager-accounts"
                enableColumnVisibility
                exportFilePrefix="lp-accounts"
                emptyText="No LP accounts found for the current filters."
                tableClassName="min-w-full text-xs"
                rowClassName={(_, index) => (index % 2 === 0 ? "bg-background/40 hover:bg-background/70 transition-colors" : "bg-background/20 hover:bg-background/60 transition-colors")}
              />
            </div>
          </div>

          <div className={`${panelClass} p-4`}>
            <button
              type="button"
              onClick={() => setCoverageExpanded((v) => !v)}
              className="flex w-full items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-left"
            >
              <div>
                <h2 className="text-base font-semibold text-primary">Coverage Dashboard (Live)</h2>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  Hidden by default. Expand only when you need deep coverage diagnostics.
                </div>
              </div>
              <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                {coverageExpanded ? "Collapse" : "Expand"}
                {coverageExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </span>
            </button>

            {coverageExpanded && (
              <div className="mt-3 space-y-3">
                {coverageLoading && (
                  <div className="rounded border border-border bg-background/60 p-3 text-xs text-muted-foreground">
                    Loading coverage data...
                  </div>
                )}
                {!coverageLoading && !coverageRows.length && (
                  <div className="rounded border border-border bg-background/60 p-3 text-xs text-muted-foreground">
                    No coverage data yet. Add LP accounts and wait for positions.
                  </div>
                )}
                {coverageRows.map((row, idx) => {
                  const uncovered = Number(row.netUncovered || 0);
                  const uncoveredClass =
                    uncovered === 0 ? "text-slate-600 dark:text-slate-300" : uncovered > 0 ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300";
                  return (
                    <div
                      key={`cov-${row.baseSymbol || idx}`}
                      className={`rounded-lg border bg-background/60 p-3 transition hover:bg-background/80 ${
                        uncovered > 0
                          ? "border-rose-500/30"
                          : uncovered < 0
                            ? "border-emerald-500/30"
                            : "border-border"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-sm font-semibold text-foreground">{row.baseSymbol || "-"}</span>
                        <span className={`text-xs font-semibold ${uncoveredClass}`}>Uncovered: {fmtNum(row.netUncovered, 2)} lots</span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Client: Buy {fmtNum(row.clientBuyLots, 2)} | Sell {fmtNum(row.clientSellLots, 2)} | Net {fmtNum(row.clientNetLots, 2)} | {fmtNum(row.clientPositions, 0)} pos | PnL {fmtNum(row.clientProfit, 2)}
                      </div>
                      <div className="mt-2 space-y-1">
                        {(row.lpBreakdown || []).length === 0 && (
                          <div className="text-xs text-muted-foreground">No LP positions</div>
                        )}
                        {(row.lpBreakdown || []).map((lp, lpIdx) => (
                          <div key={`cov-lp-${row.baseSymbol}-${lp.lpName}-${lpIdx}`} className="rounded-md border border-border/70 bg-card/70 px-2 py-1 text-[11px]">
                            <span className="font-semibold text-violet-700 dark:text-violet-300">{lp.lpName || "-"}</span> ({lp.mt5Login || "-"}): Buy {fmtNum(lp.buyLots, 2)} | Sell {fmtNum(lp.sellLots, 2)} | Net <strong>{fmtNum(lp.netLots, 2)}</strong> | {fmtNum(lp.positionCount, 0)} pos | PnL {fmtNum(lp.profit, 2)}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {!coverageExpanded && (
              <div className="mt-3 rounded border border-dashed border-border/70 bg-background/40 p-3 text-xs text-muted-foreground">
                Coverage cards are collapsed. Click <span className="font-semibold text-foreground">Expand</span> to fetch and view live coverage.
              </div>
            )}
          </div>
          
          <div className="rounded-xl border border-border/30 bg-gradient-to-r from-cyan-500/5 to-violet-500/5 px-3 py-2 text-[11px] text-muted-foreground">
            Tip: keep this page open for terminal heartbeat monitoring; coverage polling only runs when the coverage panel is expanded.
          </div>
        </main>
      </div>

      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeEditModal();
          }}
        >
          <div className="w-[760px] max-w-[95vw] max-h-[90vh] overflow-y-auto rounded-xl border border-border/50 bg-card p-5 shadow-2xl">
            <h2 className="text-lg font-semibold text-primary">
              Edit LP Account <span className="text-muted-foreground text-sm">#{editId}</span>
            </h2>
            <div className="mt-1 text-xs text-muted-foreground">Update account metadata, inclusion flags, and optional terminal connection fields.</div>
            <div className="mt-3 flex flex-col gap-2">
              <div>
                <input
                  value={editLpName}
                  onChange={(e) => setEditLpName(e.target.value)}
                  placeholder="LP Name"
                  className={`w-full ${inputClass}`}
                />
                {editErrors.lpName && <div className="mt-1 text-sm text-rose-600 dark:text-rose-300">{editErrors.lpName}</div>}
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <input value={editMt5Login} disabled className="w-full rounded border border-border bg-muted/40 p-2 text-sm opacity-60" />
                <select
                  value={String(editIsActive)}
                  onChange={(e) => setEditIsActive(e.target.value === "true")}
                  className={`w-full ${inputClass}`}
                >
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </div>
                <input
                  value={editGroupPattern}
                  onChange={(e) => setEditGroupPattern(e.target.value)}
                  placeholder="Group Pattern"
                  className={`w-full ${inputClass}`}
                />
                <input
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="Description"
                  className={`w-full ${inputClass}`}
                />
              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                  <input
                    value={editCoverageAccountLogin}
                    onChange={(e) => setEditCoverageAccountLogin(e.target.value)}
                    placeholder="Coverage Account Login"
                    type="number"
                    className={`w-full ${inputClass}`}
                  />
                <div className="flex items-center gap-2 rounded border border-border bg-background/70 p-2 text-sm">
                  <label className="text-muted-foreground">Exclude Equity</label>
                  <select
                    value={String(editExcludeFromEquity)}
                    onChange={(e) => setEditExcludeFromEquity(e.target.value === "true")}
                    className="ml-auto rounded border border-border bg-card px-2 py-1 text-xs"
                  >
                    <option value="false">No</option>
                    <option value="true">Yes</option>
                  </select>
                </div>
                <div className="flex items-center gap-2 rounded border border-border bg-background/70 p-2 text-sm">
                  <label className="text-muted-foreground">Exclude Positions</label>
                  <select
                    value={String(editExcludeFromPositions)}
                    onChange={(e) => setEditExcludeFromPositions(e.target.value === "true")}
                    className="ml-auto rounded border border-border bg-card px-2 py-1 text-xs"
                  >
                    <option value="false">No</option>
                    <option value="true">Yes</option>
                  </select>
                </div>
              </div>

              {editIsTerminal && (
                <div className="rounded border border-cyan-500/30 bg-cyan-500/5 p-3">
                  <div className="mb-2 text-xs text-cyan-700 dark:text-cyan-300">Terminal connection settings</div>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                    <input
                      value={editTerminalPath}
                      onChange={(e) => setEditTerminalPath(e.target.value)}
                      placeholder="Terminal Path"
                      className={inputClass}
                    />
                    <input
                      value={editMt5Server}
                      onChange={(e) => setEditMt5Server(e.target.value)}
                      placeholder="MT5 Server"
                      className={inputClass}
                    />
                    <input
                      value={editMt5Password}
                      onChange={(e) => setEditMt5Password(e.target.value)}
                      placeholder="MT5 Password (leave blank to keep)"
                      type="password"
                      className={inputClass}
                    />
                  </div>
                </div>
              )}

              <div className="mt-3 flex justify-end gap-2">
                <button onClick={closeEditModal} className="rounded border border-border bg-secondary px-4 py-2 text-sm hover:bg-secondary/70">
                  Cancel
                </button>
                <button
                  onClick={saveEdit}
                  disabled={editSaving}
                  className={`rounded px-4 py-2 text-sm font-medium text-white ${editSaving ? "bg-slate-500" : "bg-blue-500 hover:bg-blue-600"}`}
                >
                  {editSaving ? "Saving..." : "Save Changes"}
                </button>
              </div>
              {editMsg && (
                <div className={editMsg.ok ? "text-sm text-emerald-600 dark:text-emerald-300" : "text-sm text-rose-600 dark:text-rose-300"}>
                  {editMsg.text}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
