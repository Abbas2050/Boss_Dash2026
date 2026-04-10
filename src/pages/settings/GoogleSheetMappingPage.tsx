import React, { useEffect, useMemo, useState } from "react";

type MappingField = {
  key: string;
  label: string;
  cell: string;
  required?: boolean;
};

type MappingResponse = {
  ok?: boolean;
  fields: MappingField[];
  updatedAt?: string | null;
  source?: string;
};

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const CELL_PATTERN = /^[A-Z]{1,3}[1-9][0-9]*$/;

export const GoogleSheetMappingPage: React.FC = () => {
  const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
  const isLocalhost =
    typeof window !== "undefined" &&
    ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const shouldUseSameOrigin = (() => {
    if (typeof window === "undefined") return true;
    if (isLocalhost) return true;
    if (!backendBaseUrl) return true;
    try {
      const configuredHost = new URL(backendBaseUrl).hostname;
      return configuredHost !== window.location.hostname;
    } catch {
      return true;
    }
  })();
  const apiUrl = (path: string) => {
    if (isLocalhost) return `http://localhost:3001${path}`;
    if (shouldUseSameOrigin) return path;
    return backendBaseUrl ? `${backendBaseUrl}${path}` : path;
  };

  const [fields, setFields] = useState<MappingField[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [source, setSource] = useState<string>("default");

  useEffect(() => {
    void loadConfig();
  }, []);

  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(null), 4500);
    return () => window.clearTimeout(t);
  }, [msg]);

  const hasValidationError = useMemo(() => {
    const keys = new Set<string>();
    for (const f of fields) {
      const key = String(f.key || "").trim();
      const cell = String(f.cell || "").trim().toUpperCase();
      if (!KEY_PATTERN.test(key)) return true;
      if (!CELL_PATTERN.test(cell)) return true;
      const lowered = key.toLowerCase();
      if (keys.has(lowered)) return true;
      keys.add(lowered);
    }
    return fields.length === 0;
  }, [fields]);

  async function readJsonOrThrow(resp: Response, label: string) {
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`${label} failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 240)}` : ""}`);
    }
    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      const text = await resp.text().catch(() => "");
      throw new Error(`${label} returned non-JSON response${text ? `: ${text.slice(0, 120)}` : ""}`);
    }
    return resp.json();
  }

  async function loadConfig() {
    setLoading(true);
    try {
      const resp = await fetch(apiUrl("/api/wallet/google-sheet-mapping"));
      const data = (await readJsonOrThrow(resp, "Load mapping config")) as MappingResponse;
      setFields(Array.isArray(data.fields) ? data.fields : []);
      setUpdatedAt(data.updatedAt || null);
      setSource(data.source || "default");
    } catch (e: any) {
      setMsg({ text: `Failed to load: ${e.message}`, ok: false });
      setFields([]);
      setUpdatedAt(null);
      setSource("unknown");
    } finally {
      setLoading(false);
    }
  }

  function updateField(index: number, patch: Partial<MappingField>) {
    setFields((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function removeField(index: number) {
    setFields((prev) => {
      const item = prev[index];
      if (!item || item.required) return prev;
      return prev.filter((_, i) => i !== index);
    });
  }

  function addField() {
    setFields((prev) => [
      ...prev,
      {
        key: `customField${prev.length + 1}`,
        label: "Custom value",
        cell: "K1",
        required: false,
      },
    ]);
  }

  async function saveConfig() {
    if (hasValidationError) {
      setMsg({ text: "Fix invalid key/cell values before saving.", ok: false });
      return;
    }

    try {
      setSaving(true);
      const payload = {
        fields: fields.map((f) => ({
          key: String(f.key || "").trim(),
          label: String(f.label || "").trim(),
          cell: String(f.cell || "").trim().toUpperCase(),
          required: Boolean(f.required),
        })),
      };

      const resp = await fetch(apiUrl("/api/wallet/google-sheet-mapping"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await readJsonOrThrow(resp, "Save mapping config")) as MappingResponse;

      setFields(Array.isArray(data.fields) ? data.fields : []);
      setUpdatedAt(data.updatedAt || null);
      setSource(data.source || "file");
      setMsg({ text: "Google Sheets mapping saved.", ok: true });
    } catch (e: any) {
      setMsg({ text: `Save failed: ${e.message}`, ok: false });
    } finally {
      setSaving(false);
    }
  }

  async function resetConfig() {
    if (!window.confirm("Reset mapping to defaults?")) return;
    try {
      const resp = await fetch(apiUrl("/api/wallet/google-sheet-mapping/reset"), { method: "POST" });
      const data = (await readJsonOrThrow(resp, "Reset mapping config")) as MappingResponse;
      setFields(Array.isArray(data.fields) ? data.fields : []);
      setUpdatedAt(data.updatedAt || null);
      setSource(data.source || "default");
      setMsg({ text: "Mapping reset to defaults.", ok: true });
    } catch (e: any) {
      setMsg({ text: `Reset failed: ${e.message}`, ok: false });
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <main className="p-8">
        <h1 className="text-2xl font-bold text-foreground mb-2">Google Sheets Mapping</h1>
        <p className="text-sm text-muted-foreground mb-5">
          Edit wallet sheet cell mapping, rename labels, and add extra values from any sheet cell.
        </p>

        <div className="mb-4 text-xs text-muted-foreground">
          <span>Source: {source}</span>
          <span className="mx-2">|</span>
          <span>Updated: {updatedAt ? new Date(updatedAt).toLocaleString() : "Never"}</span>
        </div>

        {msg && (
          <div className={`mb-4 rounded border px-3 py-2 text-sm ${msg.ok ? "border-success/40 text-success" : "border-destructive/40 text-destructive"}`}>
            {msg.text}
          </div>
        )}

        <div className="bg-card/80 border border-border/40 rounded-lg p-4">
          <div className="flex flex-wrap gap-2 items-center justify-between mb-3">
            <div className="text-sm font-semibold uppercase tracking-wide text-primary">Fields</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void loadConfig()}
                disabled={loading}
                className="border border-border bg-background/70 px-3 py-1.5 rounded text-sm hover:bg-secondary/40 disabled:opacity-60"
              >
                {loading ? "Loading..." : "Refresh"}
              </button>
              <button
                type="button"
                onClick={addField}
                className="border border-border bg-background/70 px-3 py-1.5 rounded text-sm hover:bg-secondary/40"
              >
                Add Field
              </button>
              <button
                type="button"
                onClick={() => void resetConfig()}
                className="border border-destructive/40 text-destructive px-3 py-1.5 rounded text-sm hover:bg-destructive/10"
              >
                Reset Defaults
              </button>
              <button
                type="button"
                onClick={() => void saveConfig()}
                disabled={saving || loading || hasValidationError}
                className="bg-primary text-primary-foreground px-3 py-1.5 rounded text-sm disabled:opacity-60"
              >
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="text-left px-3 py-2 text-primary">Field Key</th>
                  <th className="text-left px-3 py-2 text-primary">Label</th>
                  <th className="text-left px-3 py-2 text-primary">Cell</th>
                  <th className="text-left px-3 py-2 text-primary">Type</th>
                  <th className="text-right px-3 py-2 text-primary">Action</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((field, index) => {
                  const key = String(field.key || "").trim();
                  const cell = String(field.cell || "").trim().toUpperCase();
                  const keyInvalid = !KEY_PATTERN.test(key);
                  const cellInvalid = !CELL_PATTERN.test(cell);

                  return (
                    <tr key={`${field.key}-${index}`} className="border-t border-border/30">
                      <td className="px-3 py-2 align-top">
                        <input
                          value={field.key}
                          onChange={(e) => updateField(index, { key: e.target.value })}
                          className={`w-full bg-background/70 border px-2 py-1.5 rounded ${keyInvalid ? "border-destructive" : "border-border"}`}
                          placeholder="uniqueKey"
                        />
                      </td>
                      <td className="px-3 py-2 align-top">
                        <input
                          value={field.label}
                          onChange={(e) => updateField(index, { label: e.target.value })}
                          className="w-full bg-background/70 border border-border px-2 py-1.5 rounded"
                          placeholder="Display label"
                        />
                      </td>
                      <td className="px-3 py-2 align-top">
                        <input
                          value={field.cell}
                          onChange={(e) => updateField(index, { cell: e.target.value.toUpperCase() })}
                          className={`w-full bg-background/70 border px-2 py-1.5 rounded ${cellInvalid ? "border-destructive" : "border-border"}`}
                          placeholder="K18"
                        />
                      </td>
                      <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                        {field.required ? "Required" : "Custom"}
                      </td>
                      <td className="px-3 py-2 align-top text-right">
                        <button
                          type="button"
                          onClick={() => removeField(index)}
                          disabled={Boolean(field.required)}
                          className="border border-destructive/40 text-destructive px-2 py-1 rounded disabled:opacity-40"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-3 text-xs text-muted-foreground">
            Rules: key must be letters/numbers/underscore and start with a letter. Cell must look like A1, J24, or K109.
          </div>
        </div>
      </main>
    </div>
  );
};
