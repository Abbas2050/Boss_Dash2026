import React, { useEffect, useState } from "react";
// /api/admin/api-clients is a route on the trading backend, not on this server,
// so it has to go through the same-origin proxy prefix. The doubled "api" in
// /api/backend/api/admin/api-clients is correct: /api/backend is where
// wallet/backendProxy.js is mounted and /api/admin/api-clients is the backend's
// own path underneath it.
import { BACKEND_BASE_URL } from "@/lib/backendBase";
// That prefix sits behind requireSession (server.js denies every /api and /rest
// route by default), so every call here must carry the dashboard session bearer
// or it 401s on our own server before the backend is ever consulted.
import { authHeaders } from "@/lib/auth";
// Every *Utc field below is a UTC instant. Rendering one with toLocaleString()
// would print it in whichever zone the reading device happens to be in; the
// business runs on Dubai time and this dashboard is read on a phone that is not
// always there.
import { formatDubaiInstant } from "@/lib/dubaiTime";

const CLIENTS_URL = `${BACKEND_BASE_URL}/api/admin/api-clients`;

/**
 * VERB NOTE. The per-client update is PATCH, not PUT, because that is what the
 * reference page issues against the live backend. A PUT here would 405 on an
 * endpoint we currently cannot exercise, and a 405 on a route that already
 * answers 401 would be indistinguishable from the authorisation problem below.
 */

/** A row of the client list, as GET /api/admin/api-clients returns it. */
type ApiClient = {
  id: number | string;
  name?: string | null;
  description?: string | null;
  /** Key PREFIXES only ("slc_live"). The backend keeps a salted hash of the
   *  key itself and never returns it again after the one-time reveal. */
  keyPrefixes?: string[] | null;
  keyCount?: number | null;
  scopes?: string[] | null;
  isActive?: boolean;
  createdAtUtc?: string | null;
  createdBy?: string | null;
  lastUsedAtUtc?: string | null;
  activeTokenCount?: number | null;
};

/** A row of the token drilldown, as GET /api/admin/api-clients/{id}/tokens returns it. */
type ApiToken = {
  id: number | string;
  keyPrefix?: string | null;
  scopes?: string[] | null;
  issuedAtUtc?: string | null;
  expiresAtUtc?: string | null;
  lastUsedAtUtc?: string | null;
  issuedFromIp?: string | null;
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

const SCOPE_OPTIONS = ["frontend", "worker-host", "terminal-push", "readonly"] as const;
const ENVIRONMENT_OPTIONS = ["live", "test"] as const;

type Environment = (typeof ENVIRONMENT_OPTIONS)[number];

/**
 * Said in full, on the page, in the words an operator needs. As of writing, a
 * client-credentials token that gets 200 on /api/ClientAccountMonitor gets 401
 * here, and the open theory is that /api/admin/* is a cookie-session admin
 * surface that does not accept Bearer tokens at all. Whatever the cause, the
 * one thing the reader must not conclude is "there are no API clients".
 */
const NOT_AUTHORISED_HEADING = "This dashboard is not authorised for the admin API.";

function notAuthorisedDetail(status: number): string {
  return (
    `The backend answered HTTP ${status} for /api/admin/api-clients. The endpoint exists; the credentials this ` +
    "dashboard authenticates with are not permitted to use it. Nothing is listed below because nothing could be " +
    "read - this is NOT an empty list, and it is not a network fault. Retrying, refreshing or signing in again " +
    "will not change it. The backend team must grant the dashboard's API client access to /api/admin before this " +
    "page can show or change anything."
  );
}

async function describeFailure(resp: Response, label: string): Promise<string> {
  const text = await resp.text().catch(() => "");
  let detail = text.slice(0, 200);
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string" && parsed.error) {
        detail = typeof parsed.message === "string" && parsed.message ? `${parsed.error}: ${parsed.message}` : parsed.error;
      } else if (parsed && typeof parsed.message === "string" && parsed.message) {
        detail = parsed.message;
      }
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

function scopesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((s) => String(s)) : [];
}

export const ApiClientsPage: React.FC = () => {
  const [clients, setClients] = useState<ApiClient[]>([]);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Create form (inline rather than the reference's 420px-wide modal: the
  // primary reader is on a phone, where a fixed-width dialog is unusable).
  const [showCreate, setShowCreate] = useState(false);
  const [cName, setCName] = useState("");
  const [cDescription, setCDescription] = useState("");
  const [cScopes, setCScopes] = useState<string[]>([]);
  const [cEnvironment, setCEnvironment] = useState<Environment>("live");
  const [creating, setCreating] = useState(false);

  // Edit form, opened on one row at a time.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [eName, setEName] = useState("");
  const [eDescription, setEDescription] = useState("");
  const [eScopes, setEScopes] = useState<string[]>([]);
  const [eIsActive, setEIsActive] = useState(true);

  // Token drilldown, with its own three-way load state: the tokens call is a
  // separate endpoint and can be refused independently of the list.
  const [tokensFor, setTokensFor] = useState<ApiClient | null>(null);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [tokenState, setTokenState] = useState<LoadState>({ kind: "ok" });

  /**
   * The one-time key reveal. The raw key lives HERE and nowhere else: not in
   * localStorage, not in a URL, not in a log line, and not in any list row. It
   * is dropped the moment the operator acknowledges having stored it, so it
   * cannot survive in a React tree that a later screenshot or devtools session
   * would pick up.
   */
  const [reveal, setReveal] = useState<{ rawKey: string; keyPrefix: string; clientName: string } | null>(null);
  const [ack, setAck] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    void loadClients();
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

  async function loadClients() {
    setState({ kind: "loading" });
    try {
      const resp = await fetch(CLIENTS_URL, { headers: { ...authHeaders() } });
      if (!resp.ok) {
        // Rows are cleared as well, so a stale list cannot sit under a banner
        // pretending to be current.
        setClients([]);
        setState(
          isNotAuthorised(resp.status)
            ? { kind: "unauthorised", status: resp.status }
            : { kind: "error", message: await describeFailure(resp, "Load API clients") },
        );
        return;
      }
      const data = await resp.json();
      setClients(Array.isArray(data) ? data : []);
      setState({ kind: "ok" });
    } catch (e: any) {
      setClients([]);
      setState({ kind: "error", message: e?.message || "Could not reach the API clients endpoint." });
    }
    // A manual or post-mutation refresh always closes the drilldown: the row it
    // referred to may no longer exist and its counts are now stale.
    setTokensFor(null);
    setTokens([]);
  }

  async function viewTokens(client: ApiClient) {
    setTokensFor(client);
    setTokens([]);
    setTokenState({ kind: "loading" });
    try {
      const resp = await fetch(`${CLIENTS_URL}/${encodeURIComponent(String(client.id))}/tokens`, {
        headers: { ...authHeaders() },
      });
      if (!resp.ok) {
        setTokenState(
          isNotAuthorised(resp.status)
            ? { kind: "unauthorised", status: resp.status }
            : { kind: "error", message: await describeFailure(resp, "Load tokens") },
        );
        return;
      }
      const data = await resp.json();
      setTokens(Array.isArray(data) ? data : []);
      setTokenState({ kind: "ok" });
    } catch (e: any) {
      setTokenState({ kind: "error", message: e?.message || "Could not reach the tokens endpoint." });
    }
  }

  function toggle(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((s) => s !== value) : [...list, value];
  }

  async function submitCreate() {
    const name = cName.trim();
    const description = cDescription.trim();
    if (name.length < 1 || name.length > 64) {
      setNotice({ text: "Name must be 1..64 chars.", ok: false });
      return;
    }
    if (cScopes.length < 1) {
      setNotice({ text: "Pick at least one scope.", ok: false });
      return;
    }
    setCreating(true);
    try {
      const resp = await fetch(CLIENTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name, description: description || null, scopes: cScopes, environment: cEnvironment }),
      });
      if (resp.status === 409) {
        setNotice({ text: "Name already in use.", ok: false });
        return;
      }
      if (!resp.ok) {
        setNotice({ text: await failureNotice(resp, "Create client"), ok: false });
        return;
      }
      const created = await resp.json().catch(() => ({}));
      setShowCreate(false);
      setCName("");
      setCDescription("");
      setCScopes([]);
      setCEnvironment("live");
      setNotice({ text: `Client "${name}" created.`, ok: true });
      await loadClients();
      openReveal(created, name);
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to create the client.", ok: false });
    } finally {
      setCreating(false);
    }
  }

  function beginEdit(client: ApiClient) {
    setEditingId(String(client.id));
    setEName(client.name ?? "");
    setEDescription(client.description ?? "");
    setEScopes(scopesOf(client.scopes));
    setEIsActive(!!client.isActive);
  }

  async function submitEdit(client: ApiClient) {
    const name = eName.trim();
    const description = eDescription.trim();
    if (name.length < 1 || name.length > 64) {
      setNotice({ text: "Name must be 1..64 chars.", ok: false });
      return;
    }
    if (eScopes.length < 1) {
      setNotice({ text: "Pick at least one scope.", ok: false });
      return;
    }
    const label = client.name ? `${client.name} (#${client.id})` : `#${client.id}`;
    // Deactivating is destructive in the way that matters here: it cascades
    // RevokedAtUtc onto every live token under the client, so every deployment
    // holding one stops working at once. Named, and confirmed, before it fires.
    if (client.isActive && !eIsActive) {
      if (
        !window.confirm(
          `Deactivating "${label}" will immediately revoke every live token under this client. Any caller still ` +
            "using one will be rejected. This cannot be undone. Continue?",
        )
      ) {
        return;
      }
    }
    setBusyId(String(client.id));
    try {
      const resp = await fetch(`${CLIENTS_URL}/${encodeURIComponent(String(client.id))}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name, description: description || null, scopes: eScopes, isActive: eIsActive }),
      });
      if (resp.status === 409) {
        setNotice({ text: "Name already in use.", ok: false });
        return;
      }
      if (!resp.ok) {
        setNotice({ text: await failureNotice(resp, "Update client"), ok: false });
        return;
      }
      setNotice({ text: `Updated "${label}".`, ok: true });
      setEditingId(null);
      await loadClients();
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to update the client.", ok: false });
    } finally {
      setBusyId(null);
    }
  }

  async function deleteClient(client: ApiClient) {
    const label = client.name ? `${client.name} (#${client.id})` : `#${client.id}`;
    // Irreversible and cascading: the client's keys and every token issued under
    // it go with it. The prompt names the client so it cannot be mistaken for
    // whichever row the finger happened to land on.
    if (
      !window.confirm(
        `Delete API client "${label}"? Its keys and every token issued under it are dropped by cascade. ` +
          "This cannot be undone.",
      )
    ) {
      return;
    }
    setBusyId(String(client.id));
    try {
      const resp = await fetch(`${CLIENTS_URL}/${encodeURIComponent(String(client.id))}`, {
        method: "DELETE",
        headers: { ...authHeaders() },
      });
      if (!resp.ok) {
        setNotice({ text: await failureNotice(resp, "Delete client"), ok: false });
        return;
      }
      setNotice({ text: `Deleted "${label}".`, ok: true });
      await loadClients();
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to delete the client.", ok: false });
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Environment for a follow-on key: prefer to match an existing key on the
   * client, as the reference does. Falls back to "live" when the client holds
   * no keys yet.
   */
  function pickEnvironment(client: ApiClient): Environment {
    const prefixes = Array.isArray(client.keyPrefixes) ? client.keyPrefixes : [];
    return prefixes.some((p) => String(p) === "slc_test") ? "test" : "live";
  }

  async function mintKey(client: ApiClient, mode: "add" | "regenerate") {
    const label = client.name ? `${client.name} (#${client.id})` : `#${client.id}`;
    const env = pickEnvironment(client);
    const keyCount = Number(client.keyCount || 0);
    if (mode === "add" && keyCount >= 2) {
      setNotice({ text: "Client already holds 2 active keys. Revoke one first.", ok: false });
      return;
    }
    if (mode === "regenerate" && keyCount !== 1) {
      setNotice({ text: "Regenerate only works when the client holds exactly one active key.", ok: false });
      return;
    }
    const prompt =
      mode === "add"
        ? `Mint a new ${env} key for "${label}"? The raw key is shown once and never again.`
        : `Regenerate mints a NEW ${env} key for "${label}" and shows it once. The existing key stays ACTIVE ` +
          "until you revoke it separately or delete the client. Prefer Add second key for graceful rotation. Continue?";
    if (!window.confirm(prompt)) return;
    setBusyId(String(client.id));
    try {
      const resp = await fetch(`${CLIENTS_URL}/${encodeURIComponent(String(client.id))}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ environment: env }),
      });
      if (!resp.ok) {
        setNotice({ text: await failureNotice(resp, mode === "add" ? "Add key" : "Regenerate key"), ok: false });
        return;
      }
      const created = await resp.json().catch(() => ({}));
      setNotice({
        text: mode === "add" ? `Key added to "${label}".` : `New key minted for "${label}". The previous key is still active.`,
        ok: true,
      });
      await loadClients();
      openReveal(created, label);
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to mint the key.", ok: false });
    } finally {
      setBusyId(null);
    }
  }

  async function revokeToken(token: ApiToken) {
    if (!tokensFor) return;
    const clientLabel = tokensFor.name ? `${tokensFor.name} (#${tokensFor.id})` : `#${tokensFor.id}`;
    // Irreversible, and it takes effect for whoever is holding the bearer right
    // now. Both the token and the client it belongs to are named.
    if (
      !window.confirm(
        `Revoke token #${token.id} (key prefix ${token.keyPrefix || "unknown"}) on client "${clientLabel}"? ` +
          "Any caller still holding this bearer will be rejected immediately. This cannot be undone.",
      )
    ) {
      return;
    }
    const reopen = tokensFor;
    setBusyId(`token-${token.id}`);
    try {
      const resp = await fetch(
        `${CLIENTS_URL}/${encodeURIComponent(String(tokensFor.id))}/tokens/${encodeURIComponent(String(token.id))}/revoke`,
        { method: "POST", headers: { ...authHeaders() } },
      );
      if (!resp.ok) {
        setNotice({ text: await failureNotice(resp, "Revoke token"), ok: false });
        return;
      }
      setNotice({ text: `Revoked token #${token.id}.`, ok: true });
      await loadClients();
      // loadClients closes the drilldown; re-open it on the same client so the
      // operator does not lose their place after a single revoke.
      await viewTokens(reopen);
    } catch (e: any) {
      setNotice({ text: e?.message || "Failed to revoke the token.", ok: false });
    } finally {
      setBusyId(null);
    }
  }

  /**
   * The server returns the raw key exactly once, in the body of the create/mint
   * response. If the body does not carry one, say so rather than opening an
   * empty dialog that reads as "no key was made".
   */
  function openReveal(response: any, clientName: string) {
    const rawKey = typeof response?.rawKey === "string" ? response.rawKey : "";
    if (!rawKey) {
      setNotice({
        text: "The key was created but the backend did not return it. It cannot be recovered - rotate the key to get a new one.",
        ok: false,
      });
      return;
    }
    setAck(false);
    setCopyStatus("");
    setReveal({ rawKey, keyPrefix: typeof response?.keyPrefix === "string" ? response.keyPrefix : "", clientName });
  }

  function closeReveal() {
    // Drops the raw key out of component state entirely. It was never written
    // anywhere else, so after this it exists only wherever the operator put it.
    setReveal(null);
    setAck(false);
    setCopyStatus("");
  }

  async function copyRevealKey() {
    if (!reveal) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(reveal.rawKey);
        setCopyStatus("Copied to clipboard.");
      } else {
        setCopyStatus("Clipboard unavailable - select the key above and copy it by hand.");
      }
    } catch {
      // Deliberately not echoing the exception: on some browsers a clipboard
      // error carries the attempted payload.
      setCopyStatus("Copy failed - select the key above and copy it by hand.");
    }
  }

  const inputClass =
    "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900/70";

  function scopePills(list: string[]) {
    if (!list.length) return <span className="text-muted-foreground">-</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {list.map((s) => (
          <span key={s} className="rounded-full border border-slate-300 px-2 py-0.5 text-[10px] dark:border-slate-700">
            {s}
          </span>
        ))}
      </span>
    );
  }

  function scopeChecks(selected: string[], set: (next: string[]) => void, mode: "add" | "edit") {
    const prefix = mode === "edit" ? "Edit scope " : "Scope ";
    return (
      <div className="flex flex-wrap gap-3">
        {SCOPE_OPTIONS.map((scope) => (
          <label key={scope} className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={selected.includes(scope)}
              onChange={() => set(toggle(selected, scope))}
              aria-label={`${prefix}${scope}`}
            />
            {scope}
          </label>
        ))}
      </div>
    );
  }

  /** Actions for one client row, rendered identically in the table and the card. */
  function clientActions(client: ApiClient) {
    const id = String(client.id);
    const kc = Number(client.keyCount || 0);
    const busy = busyId === id;
    const editing = editingId === id;
    if (editing) {
      return (
        <>
          <button
            type="button"
            onClick={() => void submitEdit(client)}
            disabled={busy}
            className="rounded border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-[11px] disabled:opacity-60"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditingId(null)}
            className="rounded border border-slate-300 px-2 py-1 text-[11px] dark:border-slate-700"
          >
            Cancel
          </button>
        </>
      );
    }
    return (
      <>
        <button
          type="button"
          onClick={() => void mintKey(client, "add")}
          disabled={busy || kc >= 2}
          title={kc >= 2 ? "Client already holds 2 active keys" : "Graceful rotation: both keys stay live"}
          className="rounded border border-cyan-400/40 bg-cyan-500/10 px-2 py-1 text-[11px] disabled:opacity-60"
        >
          Add second key
        </button>
        <button
          type="button"
          onClick={() => void mintKey(client, "regenerate")}
          disabled={busy || kc !== 1}
          title={
            kc === 0
              ? "No active key to rotate; use Add second key."
              : kc >= 2
                ? "Client already holds 2 active keys; revoke one first."
                : "Mints a new key. The existing key stays active until you revoke it separately."
          }
          className="rounded border border-slate-300 px-2 py-1 text-[11px] disabled:opacity-60 dark:border-slate-700"
        >
          Regenerate
        </button>
        <button
          type="button"
          onClick={() => void viewTokens(client)}
          className="rounded border border-slate-300 px-2 py-1 text-[11px] dark:border-slate-700"
        >
          View tokens
        </button>
        <button
          type="button"
          onClick={() => beginEdit(client)}
          className="rounded border border-slate-300 px-2 py-1 text-[11px] dark:border-slate-700"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => void deleteClient(client)}
          disabled={busy}
          className="rounded border border-rose-400/40 bg-rose-500/10 px-2 py-1 text-[11px] disabled:opacity-60"
        >
          Delete
        </button>
      </>
    );
  }

  function editFields() {
    return (
      <div className="grid grid-cols-1 gap-2">
        <input value={eName} onChange={(e) => setEName(e.target.value)} maxLength={64} aria-label="Edit Name" className={inputClass} />
        <textarea
          value={eDescription}
          onChange={(e) => setEDescription(e.target.value)}
          maxLength={256}
          aria-label="Edit Description"
          className={inputClass}
        />
        {scopeChecks(eScopes, setEScopes, "edit")}
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={eIsActive} onChange={(e) => setEIsActive(e.target.checked)} aria-label="Edit Active" />
          Client is active
        </label>
      </div>
    );
  }

  /** The three-way load panel, shared by the client list and the token drilldown. */
  function loadPanel(s: LoadState, what: string) {
    if (s.kind === "loading") return <div className="text-xs text-slate-500 dark:text-slate-400">Loading {what}...</div>;
    if (s.kind === "unauthorised") {
      return (
        <div
          role="alert"
          className="rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-4 text-xs text-amber-800 dark:text-amber-200"
        >
          <div className="text-sm font-semibold">{NOT_AUTHORISED_HEADING}</div>
          <div className="mt-1 break-words">{notAuthorisedDetail(s.status)}</div>
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

  return (
    <div className="min-h-screen bg-background p-3 sm:p-4 md:p-6 lg:p-8">
      <div className="mx-auto max-w-[1300px]">
        <h1 className="text-2xl font-bold text-foreground">API Clients</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Create and rotate OAuth client-credentials keys for external machine callers. Two-key graceful rotation, per-key
          and per-token revoke. Super-admin only.
        </p>

        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">Clients</h2>

          <div className="mb-3 rounded-lg border-l-2 border-cyan-400/60 bg-cyan-500/5 px-3 py-2 text-xs text-muted-foreground">
            Each client owns up to two active keys. Use <b>Add second key</b> for graceful rotation - both keys accept auth
            until the older one is revoked. <b>Regenerate</b> mints a new key and reveals it once; the existing key stays
            active until you revoke it separately. Revoking a client, or setting it inactive, cascades a revocation onto
            every live token under it.
          </div>

          <div className="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowCreate((v) => !v)}
              className="rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 dark:text-cyan-200"
            >
              {showCreate ? "Close" : "New API Client"}
            </button>
            <button
              type="button"
              onClick={() => void loadClients()}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700"
            >
              Refresh
            </button>
          </div>

          {showCreate && (
            <form
              className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/50"
              onSubmit={(e) => {
                e.preventDefault();
                void submitCreate();
              }}
            >
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                New API Client
              </div>
              <div className="grid grid-cols-1 gap-2">
                <input
                  value={cName}
                  onChange={(e) => setCName(e.target.value)}
                  placeholder="Name (1..64 chars, unique)"
                  maxLength={64}
                  autoComplete="off"
                  aria-label="Name"
                  className={inputClass}
                />
                <textarea
                  value={cDescription}
                  onChange={(e) => setCDescription(e.target.value)}
                  placeholder="Description (optional, max 256 chars)"
                  maxLength={256}
                  aria-label="Description"
                  className={inputClass}
                />
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Scopes</div>
                  {scopeChecks(cScopes, setCScopes, "add")}
                </div>
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Environment</div>
                  <div className="flex flex-wrap gap-3">
                    {ENVIRONMENT_OPTIONS.map((env) => (
                      <label key={env} className="flex items-center gap-1.5 text-xs">
                        <input
                          type="radio"
                          name="cmEnv"
                          checked={cEnvironment === env}
                          onChange={() => setCEnvironment(env)}
                          aria-label={`Environment ${env}`}
                        />
                        {env} (slc_{env}_...)
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <button
                type="submit"
                disabled={creating}
                className="mt-2 rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 disabled:opacity-60 dark:text-cyan-200"
              >
                {creating ? "Creating..." : "Create"}
              </button>
            </form>
          )}

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

          {loadPanel(state, "API clients")}

          {state.kind === "ok" && clients.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center dark:border-slate-700 dark:bg-slate-900/40">
              <div className="text-sm font-semibold text-foreground">No API clients are configured yet.</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Use New API Client above to register an external machine caller, pick its scopes, and mint its first key.
              </div>
            </div>
          )}

          {state.kind === "ok" && clients.length > 0 && (
            <>
              <div className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                {clients.length} client{clients.length !== 1 ? "s" : ""}
              </div>

              {/* Wide screens: one row per client. */}
              <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block dark:border-slate-800">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-900/80">
                    <tr>
                      <th className="px-2 py-2 text-left">Id</th>
                      <th className="px-2 py-2 text-left">Name</th>
                      <th className="px-2 py-2 text-left">Key prefixes</th>
                      <th className="px-2 py-2 text-left">Scopes</th>
                      <th className="px-2 py-2 text-left">Active</th>
                      <th className="px-2 py-2 text-left">Created (UTC)</th>
                      <th className="px-2 py-2 text-left">Created by</th>
                      <th className="px-2 py-2 text-left">Last used</th>
                      <th className="px-2 py-2 text-right">Live tokens</th>
                      <th className="px-2 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clients.map((client) => {
                      const id = String(client.id);
                      const editing = editingId === id;
                      return (
                        <tr key={`client-${id}`} className="border-t border-slate-200 align-top dark:border-slate-800">
                          <td className="px-2 py-1.5 font-mono font-semibold">{id}</td>
                          {editing ? (
                            <td className="px-2 py-1.5" colSpan={7}>
                              {editFields()}
                            </td>
                          ) : (
                            <>
                              <td className="px-2 py-1.5">{client.name || "-"}</td>
                              <td className="px-2 py-1.5 font-mono">{scopesOf(client.keyPrefixes).join(" / ") || "-"}</td>
                              <td className="px-2 py-1.5">{scopePills(scopesOf(client.scopes))}</td>
                              <td className="px-2 py-1.5">{client.isActive ? "Active" : "Inactive"}</td>
                              <td className="px-2 py-1.5">{formatDubaiInstant(client.createdAtUtc)}</td>
                              <td className="px-2 py-1.5">{client.createdBy || "-"}</td>
                              <td className="px-2 py-1.5">
                                {client.lastUsedAtUtc ? formatDubaiInstant(client.lastUsedAtUtc) : "never used"}
                              </td>
                            </>
                          )}
                          <td className="px-2 py-1.5 text-right">{client.activeTokenCount ?? 0}</td>
                          <td className="px-2 py-1.5">
                            <div className="flex flex-wrap justify-end gap-1">{clientActions(client)}</div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Phones: the same rows, one card each. This dashboard is read on
                  a phone first, and a ten-column table is unreadable there. */}
              <div className="space-y-2 md:hidden">
                {clients.map((client) => {
                  const id = String(client.id);
                  const editing = editingId === id;
                  return (
                    <div
                      key={`client-card-${id}`}
                      className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40"
                    >
                      <div className="flex items-center justify-between">
                        <div className="font-mono text-sm font-semibold">{id}</div>
                        <div className="text-xs text-muted-foreground">{client.name || "-"}</div>
                      </div>
                      {editing ? (
                        <div className="mt-2">{editFields()}</div>
                      ) : (
                        <dl className="mt-2 space-y-1 text-xs">
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Key prefixes</dt>
                            <dd className="font-mono">{scopesOf(client.keyPrefixes).join(" / ") || "-"}</dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Scopes</dt>
                            <dd className="text-right">{scopePills(scopesOf(client.scopes))}</dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Active</dt>
                            <dd>{client.isActive ? "Active" : "Inactive"}</dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Created (UTC)</dt>
                            <dd>{formatDubaiInstant(client.createdAtUtc)}</dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Created by</dt>
                            <dd>{client.createdBy || "-"}</dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Last used</dt>
                            <dd>{client.lastUsedAtUtc ? formatDubaiInstant(client.lastUsedAtUtc) : "never used"}</dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Live tokens</dt>
                            <dd>{client.activeTokenCount ?? 0}</dd>
                          </div>
                        </dl>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1">{clientActions(client)}</div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>

        {/* ---------------- Token drilldown ---------------- */}
        {tokensFor && (
          <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-primary">
                Tokens for {tokensFor.name || `#${tokensFor.id}`}
              </h2>
              <button
                type="button"
                onClick={() => {
                  setTokensFor(null);
                  setTokens([]);
                }}
                className="ml-auto rounded-md border border-slate-300 px-3 py-1 text-xs dark:border-slate-700"
              >
                Hide
              </button>
            </div>

            {loadPanel(tokenState, "tokens")}

            {tokenState.kind === "ok" && tokens.length === 0 && (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center dark:border-slate-700 dark:bg-slate-900/40">
                <div className="text-sm font-semibold text-foreground">No live tokens for this client.</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Tokens appear here once the client exchanges one of its keys for a bearer.
                </div>
              </div>
            )}

            {tokenState.kind === "ok" && tokens.length > 0 && (
              <>
                <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block dark:border-slate-800">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-100 dark:bg-slate-900/80">
                      <tr>
                        <th className="px-2 py-2 text-left">Id</th>
                        <th className="px-2 py-2 text-left">Key prefix</th>
                        <th className="px-2 py-2 text-left">Scopes</th>
                        <th className="px-2 py-2 text-left">Issued (UTC)</th>
                        <th className="px-2 py-2 text-left">Expires (UTC)</th>
                        <th className="px-2 py-2 text-left">Last used</th>
                        <th className="px-2 py-2 text-left">IP</th>
                        <th className="px-2 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tokens.map((token) => (
                        <tr key={`token-${token.id}`} className="border-t border-slate-200 dark:border-slate-800">
                          <td className="px-2 py-1.5 font-mono font-semibold">{String(token.id)}</td>
                          {/* Prefix only. The token's actual bearer value is never
                              returned by this endpoint and must never be shown here. */}
                          <td className="px-2 py-1.5 font-mono">{token.keyPrefix || "-"}</td>
                          <td className="px-2 py-1.5">{scopePills(scopesOf(token.scopes))}</td>
                          <td className="px-2 py-1.5">{formatDubaiInstant(token.issuedAtUtc)}</td>
                          <td className="px-2 py-1.5">{formatDubaiInstant(token.expiresAtUtc)}</td>
                          <td className="px-2 py-1.5">
                            {token.lastUsedAtUtc ? formatDubaiInstant(token.lastUsedAtUtc) : "never used"}
                          </td>
                          <td className="px-2 py-1.5">{token.issuedFromIp || "-"}</td>
                          <td className="px-2 py-1.5 text-right">
                            <button
                              type="button"
                              onClick={() => void revokeToken(token)}
                              disabled={busyId === `token-${token.id}`}
                              className="rounded border border-rose-400/40 bg-rose-500/10 px-2 py-1 text-[11px] disabled:opacity-60"
                            >
                              Revoke
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="space-y-2 md:hidden">
                  {tokens.map((token) => (
                    <div
                      key={`token-card-${token.id}`}
                      className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40"
                    >
                      <div className="flex items-center justify-between">
                        <div className="font-mono text-sm font-semibold">#{String(token.id)}</div>
                        <div className="font-mono text-xs text-muted-foreground">{token.keyPrefix || "-"}</div>
                      </div>
                      <dl className="mt-2 space-y-1 text-xs">
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Scopes</dt>
                          <dd className="text-right">{scopePills(scopesOf(token.scopes))}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Issued (UTC)</dt>
                          <dd>{formatDubaiInstant(token.issuedAtUtc)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Expires (UTC)</dt>
                          <dd>{formatDubaiInstant(token.expiresAtUtc)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Last used</dt>
                          <dd>{token.lastUsedAtUtc ? formatDubaiInstant(token.lastUsedAtUtc) : "never used"}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">IP</dt>
                          <dd>{token.issuedFromIp || "-"}</dd>
                        </div>
                      </dl>
                      <button
                        type="button"
                        onClick={() => void revokeToken(token)}
                        disabled={busyId === `token-${token.id}`}
                        className="mt-2 w-full rounded border border-rose-400/40 bg-rose-500/10 px-2 py-1.5 text-[11px] disabled:opacity-60"
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {/* ---------------- One-time key reveal ----------------
            Deliberately blocking and deliberately gated on an explicit
            acknowledgement: the server keeps only a salted hash, so a dialog
            that could be dismissed by accident would lose a credential that
            cannot be recovered. */}
        {reveal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" role="dialog" aria-modal="true">
            <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">New API Key</h2>
              <div className="mb-3 rounded-lg border-l-2 border-rose-400 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-200">
                <b>This is the only time you will see this key. Store it now.</b>
                <div className="mt-1">
                  The server keeps only a salted hash. If you lose this value you must rotate the key for {reveal.clientName}.
                </div>
              </div>
              {reveal.keyPrefix && (
                <div className="mb-1 text-[11px] text-muted-foreground">
                  Key prefix: <span className="font-mono">{reveal.keyPrefix}</span>
                </div>
              )}
              <pre className="mb-3 whitespace-pre-wrap break-all rounded-lg border border-slate-300 bg-slate-100 p-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-900">
                {reveal.rawKey}
              </pre>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void copyRevealKey()}
                  className="rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs"
                >
                  Copy
                </button>
                <span className="text-[11px] text-muted-foreground">{copyStatus}</span>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} aria-label="I have copied and stored this key." />
                I have copied and stored this key.
              </label>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={closeReveal}
                  disabled={!ack}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-60 dark:border-slate-700"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
