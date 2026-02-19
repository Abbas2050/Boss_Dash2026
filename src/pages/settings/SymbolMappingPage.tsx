import React, { useEffect, useState } from "react";

type Mapping = { id?: number; rawSymbol: string; mappedSymbol: string };

export const SymbolMappingPage: React.FC = () => {
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [raw, setRaw] = useState("");
  const [mapped, setMapped] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    loadMappings();
  }, []);

  async function loadMappings() {
    try {
      const resp = await fetch("/api/SymbolMapping");
      const data = await resp.json();
      setMappings(data || []);
    } catch (e: any) {
      setMappings([]);
      setMsg({ text: `Failed to load: ${e.message}`, ok: false });
    }
  }

  async function addMapping() {
    const rawSymbol = raw.trim();
    const mappedSymbol = mapped.trim();
    if (!rawSymbol || !mappedSymbol) {
      setMsg({ text: "Both fields are required", ok: false });
      return;
    }

    try {
      const resp = await fetch("/api/SymbolMapping", {
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
    }
  }

  async function deleteMapping(id?: number) {
    if (!id) return;
    if (!confirm("Delete mapping?")) return;
    try {
      const resp = await fetch(`/api/SymbolMapping/${id}`, { method: "DELETE" });
      if (resp.ok) {
        setMsg({ text: "Mapping deleted", ok: true });
        loadMappings();
      } else {
        setMsg({ text: "Failed to delete", ok: false });
      }
    } catch (e: any) {
      setMsg({ text: `Failed: ${e.message}`, ok: false });
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <main className="p-8">
        <h1 className="text-2xl font-bold text-foreground mb-6">Symbol Mapping</h1>

        <div className="mb-6 bg-card/80 border border-border/40 p-4 rounded">
          <div className="flex gap-2 items-center">
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
            <button onClick={addMapping} className="bg-primary text-primary-foreground px-4 py-2 rounded">
              Add
            </button>
          </div>
          <div className="mt-2" id="msg">
            {msg && <div className={msg.ok ? "text-success" : "text-destructive"}>{msg.text}</div>}
          </div>
        </div>

        <div className="bg-card/80 border border-border/40 p-4 rounded">
          <div className="text-sm text-muted-foreground mb-2">
            {mappings.length} mapping{mappings.length !== 1 ? "s" : ""}
          </div>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="text-left px-4 py-2 text-primary">ID</th>
                <th className="text-left px-4 py-2 text-primary">Raw Symbol</th>
                <th className="text-left px-4 py-2 text-primary">Mapped Symbol</th>
                <th className="text-right px-4 py-2 text-primary">Actions</th>
              </tr>
            </thead>
            <tbody>
              {mappings.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-center text-muted-foreground py-6">
                    No symbol mappings configured. Add one above.
                  </td>
                </tr>
              )}
              {mappings.map((m) => (
                <tr key={m.id} className="hover:bg-secondary/40">
                  <td className="px-4 py-2 text-foreground font-semibold">{m.id}</td>
                  <td className="px-4 py-2 text-foreground">{m.rawSymbol}</td>
                  <td className="px-4 py-2 text-success font-semibold">{m.mappedSymbol}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => deleteMapping(m.id)}
                      className="bg-destructive text-destructive-foreground px-3 py-1 rounded text-sm"
                    >
                      Delete
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
