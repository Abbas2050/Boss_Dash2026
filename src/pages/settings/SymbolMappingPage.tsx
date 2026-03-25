import React, { useEffect, useMemo, useState } from "react";

type Mapping = { id?: number; rawSymbol: string; mappedSymbol: string };

export const SymbolMappingPage: React.FC = () => {
  const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
  const apiUrl = (path: string) => (backendBaseUrl ? `${backendBaseUrl}${path}` : path);

  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [raw, setRaw] = useState("");
  const [mapped, setMapped] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    void loadMappings();
  }, []);

  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(null), 4000);
    return () => window.clearTimeout(t);
  }, [msg]);

  const filteredMappings = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...mappings].sort((a, b) => (b.id || 0) - (a.id || 0));
    if (!q) return sorted;
    return sorted.filter((m) => `${m.id ?? ""} ${m.rawSymbol} ${m.mappedSymbol}`.toLowerCase().includes(q));
  }, [mappings, search]);

  async function readJsonOrThrow(resp: Response, label: string) {
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`${label} failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      const text = await resp.text().catch(() => "");
      throw new Error(`${label} returned non-JSON response${text ? `: ${text.slice(0, 120)}` : ""}`);
    }
    return resp.json();
  }

  async function loadMappings() {
    setLoading(true);
    try {
      const resp = await fetch(apiUrl("/api/SymbolMapping"));
      const data = await readJsonOrThrow(resp, "Load symbol mappings");
      setMappings(data || []);
    } catch (e: any) {
      setMappings([]);
      setMsg({ text: `Failed to load: ${e.message}`, ok: false });
    } finally {
      setLoading(false);
    }
  }

  async function addMapping() {
    const rawSymbol = raw.trim();
    const mappedSymbol = mapped.trim();
    if (!rawSymbol || !mappedSymbol) {
      setMsg({ text: "Both fields are required", ok: false });
      return;
    }

    const duplicate = mappings.some(
      (m) => m.rawSymbol.toLowerCase() === rawSymbol.toLowerCase() && m.mappedSymbol.toLowerCase() === mappedSymbol.toLowerCase(),
    );
    if (duplicate) {
      setMsg({ text: `Mapping already exists: ${rawSymbol} -> ${mappedSymbol}`, ok: false });
      return;
    }

    try {
      setSubmitting(true);
      const resp = await fetch(apiUrl("/api/SymbolMapping"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawSymbol, mappedSymbol }),
      });
      if (resp.ok) {
        setMsg({ text: `Mapping added: ${rawSymbol} -> ${mappedSymbol}`, ok: true });
        setRaw("");
        setMapped("");
        await loadMappings();
      } else {
        const text = await resp.text();
        setMsg({ text: `Error: ${text}`, ok: false });
      }
    } catch (e: any) {
      setMsg({ text: `Failed: ${e.message}`, ok: false });
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteMapping(id: number, name: string) {
    if (!id) return;
    if (!confirm(`Delete mapping for '${name}'?`)) return;
    try {
      setDeletingId(id);
      const resp = await fetch(apiUrl(`/api/SymbolMapping/${id}`), { method: "DELETE" });
      if (resp.ok) {
        setMsg({ text: `Mapping deleted: ${name}`, ok: true });
        await loadMappings();
      } else {
        const text = await resp.text();
        setMsg({ text: `Failed to delete: ${text || "unknown error"}`, ok: false });
      }
    } catch (e: any) {
      setMsg({ text: `Failed: ${e.message}`, ok: false });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <main className="p-8">
        <h1 className="text-2xl font-bold text-foreground mb-6">Symbol Mapping</h1>
        <p className="text-sm text-muted-foreground -mt-4 mb-6">
          Map LP-specific symbol names to normalized symbols used by coverage and risk tables.
        </p>

        <div className="mb-6 bg-card/80 border border-border/40 p-4 rounded">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-primary mb-3">Add Mapping</h2>
          <form
            className="flex gap-2 items-center"
            onSubmit={(e) => {
              e.preventDefault();
              void addMapping();
            }}
          >
            <input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="LP symbol (e.g. XAUUSDi)"
              className="bg-background/70 border border-border px-3 py-2 rounded flex-1"
            />
            <span className="text-muted-foreground">{"->"}</span>
            <input
              value={mapped}
              onChange={(e) => setMapped(e.target.value)}
              placeholder="Normalized (e.g. XAUUSD)"
              className="bg-background/70 border border-border px-3 py-2 rounded flex-1"
            />
            <button
              type="submit"
              disabled={submitting}
              className="bg-primary text-primary-foreground px-4 py-2 rounded disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? "Adding..." : "Add"}
            </button>
          </form>
          <div className="mt-2" id="msg">
            {msg && <div className={msg.ok ? "text-success" : "text-destructive"}>{msg.text}</div>}
          </div>
        </div>

        <div className="bg-card/80 border border-border/40 p-4 rounded">
          <div className="mb-3 flex flex-wrap items-center gap-2 justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-primary">Mappings</h2>
            <div className="flex items-center gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search mappings..."
                className="bg-background/70 border border-border px-3 py-1.5 rounded text-sm"
              />
              <button
                type="button"
                onClick={() => void loadMappings()}
                disabled={loading}
                className="border border-border bg-background/70 px-3 py-1.5 rounded text-sm hover:bg-secondary/40 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {loading ? "Loading..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="text-sm text-muted-foreground mb-2">
            {filteredMappings.length} mapping{filteredMappings.length !== 1 ? "s" : ""}
          </div>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left px-4 py-2 text-primary">ID</th>
                <th className="text-left px-4 py-2 text-primary">Raw Symbol (LP)</th>
                <th className="text-left px-2 py-2 text-primary">&rarr;</th>
                <th className="text-left px-4 py-2 text-primary">Mapped Symbol</th>
                <th className="text-right px-4 py-2 text-primary">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={5} className="text-center text-muted-foreground py-6">
                    Loading mappings...
                  </td>
                </tr>
              )}
              {!loading && filteredMappings.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-muted-foreground py-6">
                    {search.trim() ? "No mappings match your search." : "No symbol mappings configured. Add one above."}
                  </td>
                </tr>
              )}
              {!loading && filteredMappings.map((m) => (
                <tr key={m.id} className="hover:bg-secondary/40">
                  <td className="px-4 py-2 text-foreground font-semibold">{m.id}</td>
                  <td className="px-4 py-2 text-amber-600 font-semibold">{m.rawSymbol}</td>
                  <td className="px-2 py-2 text-muted-foreground">&rarr;</td>
                  <td className="px-4 py-2 text-success font-semibold">{m.mappedSymbol}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => m.id && void deleteMapping(m.id, m.rawSymbol)}
                      disabled={!m.id || deletingId === m.id}
                      className="bg-destructive text-destructive-foreground px-3 py-1 rounded text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {deletingId === m.id ? "Deleting..." : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
};
