import { useEffect, useMemo, useState } from "react";

type InternalAccount = {
  id: number;
  mt5Login: number | string;
  label: string;
  system: "Live" | "Bonus" | string | number;
  description?: string | null;
  excludeFromEquity: boolean;
  excludeFromPositions: boolean;
  isActive: boolean;
};

type AccountForm = {
  mt5Login: string;
  label: string;
  system: "Live" | "Bonus";
  description: string;
  excludeFromEquity: boolean;
  excludeFromPositions: boolean;
};

const EMPTY_FORM: AccountForm = {
  mt5Login: "",
  label: "",
  system: "Live",
  description: "",
  excludeFromEquity: true,
  excludeFromPositions: true,
};

const systemToLabel = (value: unknown) => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "2" || raw === "bonus") return "Bonus";
  return "Live";
};

const systemToFormValue = (value: unknown): "Live" | "Bonus" => {
  return systemToLabel(value) === "Bonus" ? "Bonus" : "Live";
};

export function InternalAccountsTab({ backendBaseUrl, refreshKey }: { backendBaseUrl: string; refreshKey: number }) {
  const [rows, setRows] = useState<InternalAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState<AccountForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);

  const api = `${backendBaseUrl}/api/internal-accounts`;

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${api}?all=true`);
      if (!resp.ok) throw new Error(`Internal accounts ${resp.status}`);
      const data = (await resp.json()) as InternalAccount[];
      setRows(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e?.message || "Failed to load internal accounts.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [refreshKey]);

  const setField = <K extends keyof AccountForm>(field: K, value: AccountForm[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const submitAdd = async () => {
    const login = Number(form.mt5Login);
    if (!Number.isFinite(login) || login <= 0 || !form.label.trim()) {
      setError("Login and label are required.");
      return;
    }
    setError(null);
    try {
      const resp = await fetch(api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mt5Login: login,
          label: form.label.trim(),
          system: form.system,
          description: form.description.trim() || null,
          excludeFromEquity: form.excludeFromEquity,
          excludeFromPositions: form.excludeFromPositions,
        }),
      });
      if (!resp.ok) throw new Error(await resp.text().catch(() => `Add ${resp.status}`));
      setMessage(`Added ${login}.`);
      setForm(EMPTY_FORM);
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to add account.");
    }
  };

  const submitUpdate = async (row: InternalAccount) => {
    const login = Number(row.mt5Login);
    if (!Number.isFinite(login) || login <= 0 || !String(row.label || "").trim()) {
      setError("Login and label are required.");
      return;
    }
    setError(null);
    try {
      const resp = await fetch(`${api}/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mt5Login: login,
          label: String(row.label || "").trim(),
          system: systemToFormValue(row.system),
          description: String(row.description || "").trim() || null,
          excludeFromEquity: !!row.excludeFromEquity,
          excludeFromPositions: !!row.excludeFromPositions,
        }),
      });
      if (!resp.ok) throw new Error(await resp.text().catch(() => `Update ${resp.status}`));
      setMessage(`Updated ${login}.`);
      setEditingId(null);
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to update account.");
    }
  };

  const toggleActive = async (row: InternalAccount, isActive: boolean) => {
    setError(null);
    try {
      const resp = await fetch(`${api}/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (!resp.ok) throw new Error(await resp.text().catch(() => `Toggle ${resp.status}`));
      setMessage(`${isActive ? "Activated" : "Deactivated"} ${row.mt5Login}.`);
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to update account status.");
    }
  };

  const deletePermanent = async (row: InternalAccount) => {
    setError(null);
    try {
      const resp = await fetch(`${api}/${row.id}?permanent=true`, { method: "DELETE" });
      if (!resp.ok) throw new Error(await resp.text().catch(() => `Delete ${resp.status}`));
      setMessage(`Deleted ${row.mt5Login}.`);
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to delete account.");
    }
  };

  const resolveSystems = async () => {
    setError(null);
    try {
      const resp = await fetch(`${api}/resolve-systems`, { method: "POST" });
      if (!resp.ok) throw new Error(await resp.text().catch(() => `Resolve ${resp.status}`));
      const data = (await resp.json()) as { corrected?: number; total?: number };
      setMessage(`Auto-detected systems: corrected ${Number(data?.corrected || 0)} of ${Number(data?.total || 0)} accounts.`);
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to resolve systems.");
    }
  };

  const updateRow = (id: number, patch: Partial<InternalAccount>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const activeCount = useMemo(() => rows.filter((r) => r.isActive).length, [rows]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">Internal Accounts</h2>
        <button type="button" onClick={resolveSystems} className="rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-500/20 dark:text-cyan-200">Auto-Detect Systems</button>
      </div>

      <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">Add Internal Account</div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-6">
          <input value={form.mt5Login} onChange={(e) => setField("mt5Login", e.target.value)} placeholder="MT5 Login" className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900/70" />
          <input value={form.label} onChange={(e) => setField("label", e.target.value)} placeholder="Label" className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900/70" />
          <select value={form.system} onChange={(e) => setField("system", e.target.value as "Live" | "Bonus")} className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900/70">
            <option value="Live">Live</option>
            <option value="Bonus">Bonus</option>
          </select>
          <input value={form.description} onChange={(e) => setField("description", e.target.value)} placeholder="Description" className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900/70" />
          <label className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900/70"><input type="checkbox" checked={form.excludeFromEquity} onChange={(e) => setField("excludeFromEquity", e.target.checked)} />Equity</label>
          <label className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900/70"><input type="checkbox" checked={form.excludeFromPositions} onChange={(e) => setField("excludeFromPositions", e.target.checked)} />Positions</label>
        </div>
        <button type="button" onClick={submitAdd} className="mt-2 rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-500/20 dark:text-cyan-200">Add Account</button>
      </div>

      {error && <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</div>}
      {message && <div className="mb-3 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">{message}</div>}

      <div className="mb-2 text-xs text-slate-500 dark:text-slate-400">Total {rows.length} accounts ({activeCount} active)</div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-100 dark:bg-slate-900/80">
            <tr>
              <th className="px-2 py-2 text-left">Login</th>
              <th className="px-2 py-2 text-left">Label</th>
              <th className="px-2 py-2 text-left">System</th>
              <th className="px-2 py-2 text-center">Equity</th>
              <th className="px-2 py-2 text-center">Positions</th>
              <th className="px-2 py-2 text-left">Description</th>
              <th className="px-2 py-2 text-center">Status</th>
              <th className="px-2 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`internal-${row.id}`} className={`border-t border-slate-200 dark:border-slate-800 ${row.isActive ? "" : "opacity-60"}`}>
                <td className="px-2 py-1.5 font-mono">{String(row.mt5Login)}</td>
                <td className="px-2 py-1.5">
                  {editingId === row.id ? (
                    <input value={row.label} onChange={(e) => updateRow(row.id, { label: e.target.value })} className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900/70" />
                  ) : (
                    row.label
                  )}
                </td>
                <td className="px-2 py-1.5">
                  {editingId === row.id ? (
                    <select value={systemToFormValue(row.system)} onChange={(e) => updateRow(row.id, { system: e.target.value })} className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900/70">
                      <option value="Live">Live</option>
                      <option value="Bonus">Bonus</option>
                    </select>
                  ) : (
                    systemToLabel(row.system)
                  )}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {editingId === row.id ? <input type="checkbox" checked={row.excludeFromEquity} onChange={(e) => updateRow(row.id, { excludeFromEquity: e.target.checked })} /> : row.excludeFromEquity ? "Excluded" : "Included"}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {editingId === row.id ? <input type="checkbox" checked={row.excludeFromPositions} onChange={(e) => updateRow(row.id, { excludeFromPositions: e.target.checked })} /> : row.excludeFromPositions ? "Excluded" : "Included"}
                </td>
                <td className="px-2 py-1.5">
                  {editingId === row.id ? (
                    <input value={String(row.description || "")} onChange={(e) => updateRow(row.id, { description: e.target.value })} className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900/70" />
                  ) : (
                    row.description || "-"
                  )}
                </td>
                <td className="px-2 py-1.5 text-center">{row.isActive ? "Active" : "Inactive"}</td>
                <td className="px-2 py-1.5 text-right">
                  {editingId === row.id ? (
                    <>
                      <button type="button" onClick={() => submitUpdate(row)} className="mr-1 rounded border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-[11px]">Save</button>
                      <button type="button" onClick={() => { setEditingId(null); load(); }} className="rounded border border-slate-300 px-2 py-1 text-[11px] dark:border-slate-700">Cancel</button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={() => setEditingId(row.id)} className="mr-1 rounded border border-cyan-400/40 bg-cyan-500/10 px-2 py-1 text-[11px]">Edit</button>
                      {row.isActive ? (
                        <button type="button" onClick={() => toggleActive(row, false)} className="mr-1 rounded border border-amber-400/40 bg-amber-500/10 px-2 py-1 text-[11px]">Deactivate</button>
                      ) : (
                        <button type="button" onClick={() => toggleActive(row, true)} className="mr-1 rounded border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-[11px]">Activate</button>
                      )}
                      {!row.isActive && (
                        <button type="button" onClick={() => deletePermanent(row)} className="rounded border border-rose-400/40 bg-rose-500/10 px-2 py-1 text-[11px]">Delete</button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr>
                <td className="px-2 py-4 text-center text-slate-500" colSpan={8}>No internal accounts configured.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {loading && <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">Loading internal accounts...</div>}
    </section>
  );
}
