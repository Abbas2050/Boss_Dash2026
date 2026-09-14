import React, { useEffect, useMemo, useState } from "react";
// /api/LpAccount and /api/LpStatements/* are routes on the trading backend, not
// on this server, so they have to go through the same-origin proxy prefix. The
// doubled "api" in /api/backend/api/LpStatements is correct: /api/backend is
// where wallet/backendProxy.js is mounted and /api/LpStatements is the
// backend's own path underneath it.
import { BACKEND_BASE_URL } from "@/lib/backendBase";
// That prefix sits behind requireSession (server.js denies every /api and /rest
// route by default), so every call here must carry the dashboard session bearer
// or it 401s on our own server before the backend is ever consulted.
import { authHeaders } from "@/lib/auth";
// importedAtUtc is a real UTC instant. Rendering one with toLocaleString() would
// print it in whichever zone the reading device happens to be in; the business
// runs on Dubai time and this dashboard is read on a phone that is not always
// there.
import { formatDubaiInstant } from "@/lib/dubaiTime";

const LP_ACCOUNTS_URL = `${BACKEND_BASE_URL}/api/LpAccount?all=true`;
const STATEMENTS_URL = `${BACKEND_BASE_URL}/api/LpStatements`;

/**
 * VERB NOTE. The per-statement detail is a GET on /api/LpStatements/{id},
 * because that is what the reference page issues against the live backend: it
 * requests that path with no init object at all, which is a GET. preview and
 * import are both POST with multipart/form-data, and nothing here deletes.
 *
 * The literal call is deliberately described in prose rather than quoted. The
 * scan in src/lib/apiAuthHeaders.test.ts reads source text, so a quoted
 * same-origin fetch inside a comment is indistinguishable to it from a real
 * unauthenticated one -- and a comment that trips a guard gets the guard
 * weakened rather than the comment rewritten.
 */

/**
 * The proxy's raw-body cap, mirrored from BACKEND_PROXY_RAW_BODY_LIMIT in
 * wallet/backendProxy.js. It is repeated as a literal rather than imported
 * because that module is server-side Node and must not be pulled into the
 * browser bundle. The number appears on screen whenever an upload is refused:
 * an operator holding a 40mb PDF needs to be told the limit, not handed an
 * anonymous HTTP 413.
 */
const PROXY_BODY_LIMIT = "25mb";

/** Vendors, in the reference page's order. Value is the wire value; label is
 *  what the reference shows the operator. */
const VENDORS = [
  { value: "Cmc", label: "CMC" },
  { value: "FxEdge", label: "FX-EDGE" },
  { value: "Fxcm", label: "FXCM" },
  { value: "Lmax", label: "LMAX" },
  { value: "B2B", label: "B2B" },
  { value: "Ig", label: "IG" },
  { value: "Finalto", label: "FINALTO" },
] as const;

type LpAccount = {
  id: number | string;
  lpName?: string | null;
  lpVendor?: string | null;
};

/** One row of POST /api/LpStatements/preview, and of /import (which adds the
 *  two duplicate/overwrite flags). */
type StatementRow = {
  fileName?: string | null;
  success?: boolean;
  error?: string | null;
  kind?: string | null;
  statementDateUtc?: string | null;
  vendorAccountNumber?: string | null;
  openingEquity?: number | null;
  closingEquity?: number | null;
  totalSwaps?: number | null;
  totalCommissions?: number | null;
  isDuplicate?: boolean;
  isOverwrite?: boolean;
};

type CoverageStatement = {
  id: number | string;
  statementDate: string;
  openingEquity?: number | null;
  closingEquity?: number | null;
  totalSwaps?: number | null;
  totalCommissions?: number | null;
};

type CoverageLp = {
  lpName?: string | null;
  lpVendor?: string | null;
  statements: CoverageStatement[];
};

type Coverage = { lps: CoverageLp[] };

type StatementDetail = {
  header: {
    statementKind?: string | null;
    statementDate?: string | null;
    vendorAccountNumber?: string | null;
    openingEquity?: number | null;
    closingEquity?: number | null;
    totalSwaps?: number | null;
    totalCommissions?: number | null;
    importedAtUtc?: string | null;
  };
  productLines: { product?: string | null; commission?: number | null; holdingCosts?: number | null }[];
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

const NOT_AUTHORISED_HEADING = "This dashboard is not authorised for the LP statements API.";

function notAuthorisedDetail(status: number, path: string): string {
  return (
    `The backend answered HTTP ${status} for ${path}. The endpoint exists; the credentials this dashboard ` +
    "authenticates with are not permitted to use it. Nothing is listed below because nothing could be read - this " +
    "is NOT an empty result, and it is not a network fault. Retrying, refreshing or signing in again will not " +
    "change it. The backend team must grant the dashboard's API client access before this page can show or change " +
    "anything."
  );
}

/** 403 joins 401 here: both mean "you may not", which is a different repair
 *  from "it broke", and an operator needs to be sent to the backend team for
 *  either one rather than to the logs. */
function isNotAuthorised(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * The proxy answers an over-size upload with 413 and a JSON body naming its own
 * limit. Said in full and in the operator's words, because the repair is
 * theirs: split the PDF, or ask for the cap to be raised. A bare "HTTP 413"
 * reads as a server fault and sends them to the wrong people.
 */
function tooLargeMessage(files: File[]): string {
  const total = files.reduce((n, f) => n + f.size, 0);
  const mb = (total / (1024 * 1024)).toFixed(1);
  return (
    `Upload refused: the request body exceeds the ${PROXY_BODY_LIMIT} limit on /api/backend. ` +
    `The ${files.length} selected file${files.length === 1 ? "" : "s"} total ${mb} MB. Nothing was sent to the ` +
    "backend and nothing was imported. Upload fewer files at a time, or ask for the proxy's " +
    `${PROXY_BODY_LIMIT} cap to be raised.`
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

function fmtMoney(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * A statement DATE, not an instant. It is the calendar day (or month) the
 * statement covers, and the coverage buckets below are built from it in UTC --
 * so it is rendered as the UTC calendar date, exactly as the reference does
 * with `iso.substring(0, 10)`. Pushing it through formatDubaiInstant would
 * shift a midnight-UTC statement date back into the previous day and put the
 * cell in the wrong column of its own matrix. importedAtUtc, which really is an
 * instant, does go through the Dubai helper.
 */
function fmtStatementDate(iso: string | null | undefined): string {
  return iso ? String(iso).substring(0, 10) : "-";
}

/** Bucket key for a statement date, matching the column headers built below. */
function bucketOfStatement(kind: string, isoDate: string): string {
  const dt = new Date(isoDate);
  if (!Number.isFinite(dt.getTime())) return "";
  if (kind === "Monthly") {
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  return dt.toISOString().substring(0, 10);
}

/** Every bucket the operator asked about, present or not. The missing ones are
 *  the whole point of the page, so they have to be enumerated from the range
 *  rather than inferred from what came back. */
function buildBuckets(kind: string, fromIso: string, toIso: string): string[] {
  const buckets: string[] = [];
  const start = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return buckets;
  const cur = new Date(start);
  if (kind === "Monthly") {
    cur.setUTCDate(1);
    while (cur <= end && buckets.length < 400) {
      buckets.push(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}`);
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
  } else {
    while (cur <= end && buckets.length < 400) {
      buckets.push(cur.toISOString().substring(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }
  return buckets;
}

function isoDaysAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().substring(0, 10);
}

export const LpStatementsPage: React.FC = () => {
  // ---- Upload ------------------------------------------------------------
  const [vendor, setVendor] = useState<string>(VENDORS[0].value);
  const [lpAccounts, setLpAccounts] = useState<LpAccount[]>([]);
  const [lpState, setLpState] = useState<LoadState>({ kind: "loading" });
  const [lpAccountId, setLpAccountId] = useState<string>("");
  const [files, setFiles] = useState<File[]>([]);
  const [previewRows, setPreviewRows] = useState<StatementRow[]>([]);
  const [importRows, setImportRows] = useState<StatementRow[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [uploadBusy, setUploadBusy] = useState<"" | "preview" | "import">("");
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  /**
   * THE PREVIEW GATE. An import is allowed only against the exact selection
   * that was previewed: the same vendor and the same files, identified by name,
   * size and mtime. Swapping a file or changing the vendor after previewing
   * would otherwise let an operator commit something nobody has ever looked at,
   * which is the one thing this two-step flow exists to prevent. Any change to
   * the selection drops the token, so Import goes back to disabled.
   */
  const selectionKey = useMemo(
    () => `${vendor}|${files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join(",")}`,
    [vendor, files],
  );
  const [previewedSelection, setPreviewedSelection] = useState<string | null>(null);
  const previewOkCount = previewRows.filter((r) => r.success).length;
  const previewIsCurrent = files.length > 0 && previewedSelection !== null && previewedSelection === selectionKey;
  const canImport = previewIsCurrent && previewOkCount > 0 && lpAccountId !== "" && uploadBusy === "";

  // ---- Coverage ----------------------------------------------------------
  const [covKind, setCovKind] = useState<"Daily" | "Monthly">("Monthly");
  const [covFrom, setCovFrom] = useState<string>(isoDaysAgo(6));
  const [covTo, setCovTo] = useState<string>(new Date().toISOString().substring(0, 10));
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [covRange, setCovRange] = useState<{ kind: string; from: string; to: string } | null>(null);
  const [covState, setCovState] = useState<LoadState>({ kind: "loading" });

  // ---- Detail ------------------------------------------------------------
  const [detail, setDetail] = useState<{ id: string; data: StatementDetail } | null>(null);
  const [detailState, setDetailState] = useState<LoadState>({ kind: "ok" });

  useEffect(() => {
    void loadLpAccounts();
    void loadCoverage();
    // Reads only. Nothing on this page that changes stored data fires on mount.
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 9000);
    return () => window.clearTimeout(t);
  }, [notice]);

  async function loadLpAccounts() {
    setLpState({ kind: "loading" });
    try {
      const resp = await fetch(LP_ACCOUNTS_URL, { headers: { ...authHeaders() } });
      if (!resp.ok) {
        setLpAccounts([]);
        setLpState(
          isNotAuthorised(resp.status)
            ? { kind: "unauthorised", status: resp.status }
            : { kind: "error", message: await describeFailure(resp, "Load LP accounts") },
        );
        return;
      }
      const data = await resp.json();
      const rows: LpAccount[] = Array.isArray(data) ? data : [];
      setLpAccounts(rows);
      setLpState({ kind: "ok" });
      if (rows.length > 0) setLpAccountId((cur) => (cur === "" ? String(rows[0].id) : cur));
    } catch (e: any) {
      setLpAccounts([]);
      setLpState({ kind: "error", message: e?.message || "Could not reach the LP accounts endpoint." });
    }
  }

  function lpLabel(id: string): string {
    const lp = lpAccounts.find((a) => String(a.id) === id);
    return lp ? `${lp.lpName || "LP"} (id ${lp.id})` : `LP account ${id || "(none selected)"}`;
  }

  function pickFiles(list: FileList | null) {
    setFiles(list ? Array.from(list) : []);
    // A new selection is by definition un-previewed.
    setPreviewRows([]);
    setImportRows([]);
    setPreviewedSelection(null);
  }

  async function doPreview() {
    if (files.length === 0) return;
    setUploadBusy("preview");
    setImportRows([]);
    try {
      // Real FormData, and NO Content-Type header of our own: the browser has to
      // set multipart/form-data together with the boundary it generates. Writing
      // the header by hand omits the boundary and the backend cannot split the
      // parts -- the upload arrives as one unparseable blob.
      const fd = new FormData();
      fd.append("vendor", vendor);
      for (const f of files) fd.append("files", f, f.name);

      const resp = await fetch(`${STATEMENTS_URL}/preview`, {
        method: "POST",
        headers: { ...authHeaders() },
        body: fd,
      });
      if (resp.status === 413) {
        setPreviewRows([]);
        setPreviewedSelection(null);
        setNotice({ text: tooLargeMessage(files), ok: false });
        return;
      }
      if (!resp.ok) {
        setPreviewRows([]);
        setPreviewedSelection(null);
        setNotice({
          text: isNotAuthorised(resp.status)
            ? `Preview: ${NOT_AUTHORISED_HEADING} ${notAuthorisedDetail(resp.status, "/api/LpStatements/preview")}`
            : await describeFailure(resp, "Preview"),
          ok: false,
        });
        return;
      }
      const data = await resp.json();
      const rows: StatementRow[] = Array.isArray(data) ? data : [];
      setPreviewRows(rows);
      setPreviewedSelection(selectionKey);
      const ok = rows.filter((r) => r.success).length;
      setNotice({
        text:
          ok === rows.length
            ? `Parsed ${ok}/${rows.length} file${rows.length === 1 ? "" : "s"}. Nothing has been stored yet - review the rows, then Import.`
            : `Parsed ${ok}/${rows.length} files. The failed rows are listed below and will NOT be imported.`,
        ok: ok > 0,
      });
    } catch (e: any) {
      setPreviewRows([]);
      setPreviewedSelection(null);
      setNotice({ text: e?.message || "Could not reach the preview endpoint.", ok: false });
    } finally {
      setUploadBusy("");
    }
  }

  async function doImport() {
    // The gate again, on the way out. The button is disabled without a current
    // preview, but a disabled button is a hint and not a rule: this is the rule.
    if (!previewIsCurrent) {
      setNotice({
        text: "Preview first. An import can only run against the exact files and vendor that were previewed - change either one and the preview no longer describes what would be stored.",
        ok: false,
      });
      return;
    }
    if (previewOkCount === 0) {
      setNotice({ text: "No file in the preview parsed successfully, so there is nothing to import.", ok: false });
      return;
    }
    if (!lpAccountId) {
      setNotice({ text: "Pick the LP account these statements belong to before importing.", ok: false });
      return;
    }

    // Named in full: an import writes rows nobody else can easily unpick, and
    // "force re-ingest" additionally DELETES the stored statement it replaces.
    const names = files.map((f) => f.name).join(", ");
    if (
      !window.confirm(
        `Import ${previewOkCount} statement${previewOkCount === 1 ? "" : "s"} into ${lpLabel(lpAccountId)}?\n\n` +
          `Vendor: ${VENDORS.find((v) => v.value === vendor)?.label || vendor}\n` +
          `File${files.length === 1 ? "" : "s"}: ${names}\n` +
          `Force re-ingest: ${
            overwrite
              ? "YES - the existing statement for the same LP + kind + date will be DELETED and replaced"
              : "no - a statement that already exists is skipped as a duplicate"
          }\n\n` +
          "This stores the parsed statements against that LP. Continue?",
      )
    ) {
      return;
    }

    setUploadBusy("import");
    try {
      // Same rules as preview: real FormData, no hand-written Content-Type.
      const fd = new FormData();
      fd.append("vendor", vendor);
      fd.append("lpAccountId", lpAccountId);
      fd.append("overwrite", overwrite ? "true" : "false");
      for (const f of files) fd.append("files", f, f.name);

      const resp = await fetch(`${STATEMENTS_URL}/import`, {
        method: "POST",
        headers: { ...authHeaders() },
        body: fd,
      });
      if (resp.status === 413) {
        setNotice({ text: tooLargeMessage(files), ok: false });
        return;
      }
      if (!resp.ok) {
        setNotice({
          text: isNotAuthorised(resp.status)
            ? `Import: ${NOT_AUTHORISED_HEADING} ${notAuthorisedDetail(resp.status, "/api/LpStatements/import")}`
            : await describeFailure(resp, "Import"),
          ok: false,
        });
        return;
      }
      const data = await resp.json();
      const rows: StatementRow[] = Array.isArray(data) ? data : [];
      setImportRows(rows);
      const ok = rows.filter((r) => r.success).length;
      const dups = rows.filter((r) => r.success && r.isDuplicate).length;
      const overwrites = rows.filter((r) => r.success && r.isOverwrite).length;
      const parts: string[] = [];
      if (dups > 0) parts.push(`${dups} skipped as duplicate`);
      if (overwrites > 0) parts.push(`${overwrites} overwritten`);
      setNotice({
        text: `Imported ${ok}/${rows.length} into ${lpLabel(lpAccountId)}${parts.length ? ` (${parts.join(", ")})` : ""}.`,
        ok: ok > 0,
      });
      // The files are spent and the preview no longer describes anything
      // pending, so the gate closes again before coverage is re-read.
      setFiles([]);
      setPreviewRows([]);
      setPreviewedSelection(null);
      await loadCoverage();
    } catch (e: any) {
      setNotice({ text: e?.message || "Could not reach the import endpoint.", ok: false });
    } finally {
      setUploadBusy("");
    }
  }

  async function loadCoverage() {
    if (!covFrom || !covTo) {
      setCovState({ kind: "error", message: "Pick both a From and a To date." });
      return;
    }
    setCovState({ kind: "loading" });
    const url = `${STATEMENTS_URL}/coverage?kind=${encodeURIComponent(covKind)}&from=${encodeURIComponent(
      `${covFrom}T00:00:00Z`,
    )}&to=${encodeURIComponent(`${covTo}T23:59:59Z`)}`;
    try {
      const resp = await fetch(url, { headers: { ...authHeaders() } });
      if (!resp.ok) {
        setCoverage(null);
        setCovState(
          isNotAuthorised(resp.status)
            ? { kind: "unauthorised", status: resp.status }
            : { kind: "error", message: await describeFailure(resp, "Load coverage") },
        );
        return;
      }
      const data = await resp.json();
      setCoverage({ lps: Array.isArray(data?.lps) ? data.lps : [] });
      setCovRange({ kind: covKind, from: covFrom, to: covTo });
      setCovState({ kind: "ok" });
    } catch (e: any) {
      setCoverage(null);
      setCovState({ kind: "error", message: e?.message || "Could not reach the coverage endpoint." });
    }
  }

  async function openDetail(id: string) {
    setDetail(null);
    setDetailState({ kind: "loading" });
    try {
      const resp = await fetch(`${STATEMENTS_URL}/${encodeURIComponent(id)}`, { headers: { ...authHeaders() } });
      if (!resp.ok) {
        setDetailState(
          isNotAuthorised(resp.status)
            ? { kind: "unauthorised", status: resp.status }
            : { kind: "error", message: await describeFailure(resp, "Load statement detail") },
        );
        return;
      }
      const data = await resp.json();
      setDetail({ id, data: { header: data?.header || {}, productLines: Array.isArray(data?.productLines) ? data.productLines : [] } });
      setDetailState({ kind: "ok" });
    } catch (e: any) {
      setDetailState({ kind: "error", message: e?.message || "Could not reach the statement detail endpoint." });
    }
  }

  /** Missing/present per LP over the requested range: the gap report itself. */
  const gaps = useMemo(() => {
    if (!coverage || !covRange) return [];
    const buckets = buildBuckets(covRange.kind, covRange.from, covRange.to);
    return coverage.lps.map((lp) => {
      const present = new Set(lp.statements.map((s) => bucketOfStatement(covRange.kind, s.statementDate)));
      const missing = buckets.filter((b) => !present.has(b));
      return { lp, buckets, missing, presentCount: present.size };
    });
  }, [coverage, covRange]);

  const totalMissing = gaps.reduce((n, g) => n + g.missing.length, 0);
  const lpsWithGaps = gaps.filter((g) => g.missing.length > 0).length;

  const inputClass =
    "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900/70";

  /** The three-way load panel, shared by every section on this page. */
  function loadPanel(s: LoadState, what: string) {
    if (s.kind === "loading") return <div className="text-xs text-slate-500 dark:text-slate-400">Loading {what}...</div>;
    if (s.kind === "unauthorised") {
      return (
        <div
          role="alert"
          className="rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-4 text-xs text-amber-800 dark:text-amber-200"
        >
          <div className="text-sm font-semibold">{NOT_AUTHORISED_HEADING}</div>
          <div className="mt-1 break-words">{notAuthorisedDetail(s.status, `/api/LpStatements (${what})`)}</div>
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
          <div className="mt-1 opacity-80">This is not empty - it is unknown. Nothing below reflects the backend.</div>
        </div>
      );
    }
    return null;
  }

  function statementRowsTable(rows: StatementRow[], title: string) {
    if (rows.length === 0) return null;
    return (
      <div className="mt-3">
        <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{title}</div>

        {/* Wide screens: one row per file. */}
        <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block dark:border-slate-800">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-100 dark:bg-slate-900/80">
              <tr>
                <th className="px-2 py-2 text-left">File</th>
                <th className="px-2 py-2 text-left">Status</th>
                <th className="px-2 py-2 text-left">Kind</th>
                <th className="px-2 py-2 text-left">Date</th>
                <th className="px-2 py-2 text-left">Vendor Acct</th>
                <th className="px-2 py-2 text-right">Opening</th>
                <th className="px-2 py-2 text-right">Closing</th>
                <th className="px-2 py-2 text-right">Swaps</th>
                <th className="px-2 py-2 text-right">Commissions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`row-${i}-${r.fileName}`} className="border-t border-slate-200 align-top dark:border-slate-800">
                  <td className="px-2 py-1.5">{r.fileName || "-"}</td>
                  {r.success ? (
                    <>
                      <td className="px-2 py-1.5 text-emerald-600 dark:text-emerald-300">
                        {r.isDuplicate ? "DUPLICATE" : r.isOverwrite ? "OVERWRITTEN" : "OK"}
                      </td>
                      <td className="px-2 py-1.5">{r.kind || "-"}</td>
                      <td className="px-2 py-1.5">{fmtStatementDate(r.statementDateUtc)}</td>
                      <td className="px-2 py-1.5">{r.vendorAccountNumber || "-"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(r.openingEquity)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(r.closingEquity)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(r.totalSwaps)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(r.totalCommissions)}</td>
                    </>
                  ) : (
                    <td className="px-2 py-1.5 font-mono text-rose-600 dark:text-rose-300" colSpan={8}>
                      FAIL: {r.error || "Unknown error"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Phones: the same rows, one card each. */}
        <div className="space-y-2 md:hidden">
          {rows.map((r, i) => (
            <div
              key={`card-${i}-${r.fileName}`}
              className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40"
            >
              <div className="text-xs font-semibold break-words">{r.fileName || "-"}</div>
              {r.success ? (
                <dl className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Status</dt>
                    <dd className="text-emerald-600 dark:text-emerald-300">
                      {r.isDuplicate ? "DUPLICATE" : r.isOverwrite ? "OVERWRITTEN" : "OK"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Kind</dt>
                    <dd>{r.kind || "-"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Date</dt>
                    <dd>{fmtStatementDate(r.statementDateUtc)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Vendor Acct</dt>
                    <dd>{r.vendorAccountNumber || "-"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Opening</dt>
                    <dd className="tabular-nums">{fmtMoney(r.openingEquity)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Closing</dt>
                    <dd className="tabular-nums">{fmtMoney(r.closingEquity)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Swaps</dt>
                    <dd className="tabular-nums">{fmtMoney(r.totalSwaps)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Commissions</dt>
                    <dd className="tabular-nums">{fmtMoney(r.totalCommissions)}</dd>
                  </div>
                </dl>
              ) : (
                <div className="mt-2 font-mono text-xs text-rose-600 dark:text-rose-300">
                  FAIL: {r.error || "Unknown error"}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-3 sm:p-4 md:p-6 lg:p-8">
      <div className="mx-auto max-w-[1500px]">
        <h1 className="text-2xl font-bold text-foreground">LP Statements</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Upload LP-issued statements (Phase 1: CMC PDF only), inspect what is stored, and see coverage gaps per LP per
          date.
        </p>

        {notice && (
          <div
            role="status"
            className={`mb-4 rounded-lg border px-3 py-2 text-xs ${
              notice.ok
                ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
                : "border-amber-400/30 bg-amber-500/10 text-amber-700 dark:text-amber-200"
            }`}
          >
            {notice.text}
          </div>
        )}

        {/* ---------------- Upload ---------------- */}
        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">Upload statements</h2>

          <div className="mb-3 rounded-lg border-l-2 border-cyan-400/60 bg-cyan-500/5 px-3 py-2 text-xs text-muted-foreground">
            Two steps, in order. <b>Preview</b> parses the files and stores nothing. <b>Import</b> is only enabled for the
            exact files and vendor that were previewed - change either and you must preview again. Uploads are capped at{" "}
            {PROXY_BODY_LIMIT} in total.
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="lps-vendor" className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
                Vendor
              </label>
              <select
                id="lps-vendor"
                aria-label="Vendor"
                value={vendor}
                onChange={(e) => {
                  setVendor(e.target.value);
                  // Vendor decides how each file is parsed, so a preview taken
                  // under a different vendor describes different rows.
                  setPreviewRows([]);
                  setPreviewedSelection(null);
                }}
                className={inputClass}
              >
                {VENDORS.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="lps-lp" className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
                LP account
              </label>
              <select
                id="lps-lp"
                aria-label="LP account"
                value={lpAccountId}
                onChange={(e) => setLpAccountId(e.target.value)}
                className={inputClass}
              >
                <option value="">Select an LP account</option>
                {lpAccounts.map((lp) => (
                  <option key={String(lp.id)} value={String(lp.id)}>
                    {lp.lpName || "LP"} (id {lp.id})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-2">{loadPanel(lpState, "LP accounts")}</div>
          {lpState.kind === "ok" && lpAccounts.length === 0 && (
            <div className="mt-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs dark:border-slate-700 dark:bg-slate-900/40">
              <div className="text-sm font-semibold text-foreground">No LP accounts are configured yet.</div>
              <div className="mt-1 text-muted-foreground">
                Add an LP on the LP Manager page first - a statement has to be filed against one.
              </div>
            </div>
          )}

          <div className="mt-3">
            <label htmlFor="lps-files" className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
              Statement files (PDF or XLSX, multiple allowed)
            </label>
            <input
              id="lps-files"
              aria-label="Statement files"
              type="file"
              multiple
              accept="application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.pdf,.xlsx"
              onChange={(e) => pickFiles(e.target.files)}
              className="w-full text-xs"
            />
            {files.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                {files.map((f) => (
                  <li key={`${f.name}-${f.size}-${f.lastModified}`}>
                    {f.name} ({(f.size / 1024).toFixed(1)} KB)
                  </li>
                ))}
              </ul>
            )}
          </div>

          <label className="mt-3 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              aria-label="Force re-ingest"
            />
            Force re-ingest (delete the existing statement for the same LP + kind + date)
          </label>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void doPreview()}
              disabled={files.length === 0 || uploadBusy !== ""}
              className="rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 disabled:opacity-60 dark:text-cyan-200"
            >
              {uploadBusy === "preview" ? "Parsing..." : "Preview"}
            </button>
            <button
              type="button"
              onClick={() => void doImport()}
              disabled={!canImport}
              title={previewIsCurrent ? "Import the previewed statements" : "Preview these files first"}
              className="rounded-md border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 disabled:opacity-60 dark:text-emerald-200"
            >
              {uploadBusy === "import" ? "Importing..." : "Import"}
            </button>
            {!previewIsCurrent && files.length > 0 && (
              <span className="self-center text-xs text-muted-foreground">
                Import is locked until these exact files are previewed.
              </span>
            )}
          </div>

          {statementRowsTable(previewRows, "Preview - nothing stored yet")}
          {statementRowsTable(importRows, "Import result")}
        </section>

        {/* ---------------- Coverage ---------------- */}
        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">Coverage</h2>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="cov-kind" className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
                Kind
              </label>
              <select
                id="cov-kind"
                aria-label="Kind"
                value={covKind}
                onChange={(e) => setCovKind(e.target.value === "Daily" ? "Daily" : "Monthly")}
                className={inputClass}
              >
                <option value="Daily">Daily</option>
                <option value="Monthly">Monthly</option>
              </select>
            </div>
            <div>
              <label htmlFor="cov-from" className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
                From
              </label>
              <input id="cov-from" aria-label="From" type="date" value={covFrom} onChange={(e) => setCovFrom(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label htmlFor="cov-to" className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
                To
              </label>
              <input id="cov-to" aria-label="To" type="date" value={covTo} onChange={(e) => setCovTo(e.target.value)} className={inputClass} />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void loadCoverage()}
            className="mt-3 rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700"
          >
            Load coverage
          </button>

          <div className="mt-3">{loadPanel(covState, "coverage")}</div>

          {covState.kind === "ok" && coverage && coverage.lps.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center dark:border-slate-700 dark:bg-slate-900/40">
              <div className="text-sm font-semibold text-foreground">No statements in the selected range.</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Widen the From/To window, or upload the statements above. This is an answer, not a failure.
              </div>
            </div>
          )}

          {covState.kind === "ok" && coverage && coverage.lps.length > 0 && covRange && (
            <>
              {/* The gap headline. A missing month is the operator's signal to go
                  and chase the LP for it, so it is said in words at the top and
                  not left as a number in a column nobody scrolls to. */}
              <div
                role="status"
                className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
                  totalMissing > 0
                    ? "border-rose-400/40 bg-rose-500/10 text-rose-700 dark:text-rose-200"
                    : "border-emerald-400/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
                }`}
              >
                {totalMissing > 0 ? (
                  <>
                    <b>
                      {totalMissing} missing {covRange.kind === "Monthly" ? "month" : "day"}
                      {totalMissing === 1 ? "" : "s"}
                    </b>{" "}
                    across {lpsWithGaps} of {gaps.length} LP{gaps.length === 1 ? "" : "s"} between {covRange.from} and{" "}
                    {covRange.to}. Each one is a statement that was never uploaded.
                  </>
                ) : (
                  <>
                    No gaps: every {covRange.kind === "Monthly" ? "month" : "day"} between {covRange.from} and{" "}
                    {covRange.to} has a statement for all {gaps.length} LP{gaps.length === 1 ? "" : "s"}.
                  </>
                )}
              </div>

              <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                Missing {covRange.kind === "Monthly" ? "months" : "days"} in range
              </div>

              {/* Wide screens: one row per LP. */}
              <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block dark:border-slate-800">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-900/80">
                    <tr>
                      <th className="px-2 py-2 text-left">LP</th>
                      <th className="px-2 py-2 text-left">Missing</th>
                      <th className="px-2 py-2 text-right">Missing count</th>
                      <th className="px-2 py-2 text-right">Present count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gaps.map((g, i) => (
                      <tr key={`gap-${i}`} className="border-t border-slate-200 align-top dark:border-slate-800">
                        <td className="px-2 py-1.5">
                          {g.lp.lpName || "LP"}{" "}
                          <span className="text-[10px] text-muted-foreground">({g.lp.lpVendor || "-"})</span>
                        </td>
                        <td className="px-2 py-1.5 break-words">
                          {g.missing.length === 0 ? (
                            <span className="text-emerald-600 dark:text-emerald-300">-- all present --</span>
                          ) : (
                            g.missing.join(", ")
                          )}
                        </td>
                        <td
                          className={`px-2 py-1.5 text-right tabular-nums ${
                            g.missing.length > 0 ? "font-semibold text-rose-600 dark:text-rose-300" : "text-muted-foreground"
                          }`}
                        >
                          {g.missing.length}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{g.presentCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Phones: the same rows, one card each. */}
              <div className="space-y-2 md:hidden">
                {gaps.map((g, i) => (
                  <div
                    key={`gap-card-${i}`}
                    className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40"
                  >
                    <div className="text-xs font-semibold">
                      {g.lp.lpName || "LP"}{" "}
                      <span className="text-[10px] font-normal text-muted-foreground">({g.lp.lpVendor || "-"})</span>
                    </div>
                    <dl className="mt-2 space-y-1 text-xs">
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Missing count</dt>
                        <dd className={g.missing.length > 0 ? "font-semibold text-rose-600 dark:text-rose-300" : ""}>
                          {g.missing.length}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Present count</dt>
                        <dd>{g.presentCount}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Missing</dt>
                        <dd className="mt-0.5 break-words">
                          {g.missing.length === 0 ? (
                            <span className="text-emerald-600 dark:text-emerald-300">-- all present --</span>
                          ) : (
                            g.missing.join(", ")
                          )}
                        </dd>
                      </div>
                    </dl>
                  </div>
                ))}
              </div>

              {/* The matrix itself. Scrolls sideways on a wide range; the LP
                  column is the row label so it stays first. */}
              <div className="mt-4 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800" style={{ maxHeight: "60vh" }}>
                <table className="text-[11px]">
                  <thead className="bg-slate-100 dark:bg-slate-900/80">
                    <tr>
                      <th className="sticky left-0 z-10 bg-slate-100 px-2 py-2 text-left dark:bg-slate-900/80">LP</th>
                      {(gaps[0]?.buckets || []).map((b) => (
                        <th key={`h-${b}`} className="whitespace-nowrap px-2 py-2 text-center">
                          {b}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {gaps.map((g, i) => {
                      const byBucket: Record<string, CoverageStatement> = {};
                      for (const s of g.lp.statements) byBucket[bucketOfStatement(covRange.kind, s.statementDate)] = s;
                      return (
                        <tr key={`m-${i}`} className="border-t border-slate-200 dark:border-slate-800">
                          <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-2 py-1.5 dark:bg-slate-950/70">
                            {g.lp.lpName || "LP"}{" "}
                            <span className="text-[10px] text-muted-foreground">({g.lp.lpVendor || "-"})</span>
                          </td>
                          {g.buckets.map((b) => {
                            const cell = byBucket[b];
                            if (!cell) {
                              return (
                                <td
                                  key={`c-${i}-${b}`}
                                  className="bg-rose-500/10 px-2 py-1.5 text-center text-muted-foreground"
                                  title={`${g.lp.lpName || "LP"} ${b}: missing`}
                                >
                                  -
                                </td>
                              );
                            }
                            return (
                              <td key={`c-${i}-${b}`} className="bg-emerald-500/15 px-1 py-1 text-center">
                                <button
                                  type="button"
                                  onClick={() => void openDetail(String(cell.id))}
                                  title={`Opening ${fmtMoney(cell.openingEquity)} / Closing ${fmtMoney(
                                    cell.closingEquity,
                                  )} / Swaps ${fmtMoney(cell.totalSwaps)} / Commissions ${fmtMoney(cell.totalCommissions)}`}
                                  aria-label={`Statement ${cell.id} for ${g.lp.lpName || "LP"} ${b}`}
                                  className="px-1 font-bold text-emerald-700 dark:text-emerald-300"
                                >
                                  ok
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        {/* ---------------- Statement detail ---------------- */}
        {(detail || detailState.kind !== "ok") && (
          <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-primary">
                Statement {detail ? detail.id : ""}
              </h2>
              <button
                type="button"
                onClick={() => {
                  setDetail(null);
                  setDetailState({ kind: "ok" });
                }}
                className="rounded border border-slate-300 px-2 py-1 text-[11px] dark:border-slate-700"
              >
                Close
              </button>
            </div>

            {loadPanel(detailState, "statement detail")}

            {detail && detailState.kind === "ok" && (
              <>
                <dl className="space-y-1 text-xs">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Kind</dt>
                    <dd>{detail.data.header.statementKind || "-"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Date</dt>
                    <dd>{fmtStatementDate(detail.data.header.statementDate)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Vendor Acct</dt>
                    <dd>{detail.data.header.vendorAccountNumber || "-"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Opening</dt>
                    <dd className="tabular-nums">{fmtMoney(detail.data.header.openingEquity)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Closing</dt>
                    <dd className="tabular-nums">{fmtMoney(detail.data.header.closingEquity)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Total Swaps</dt>
                    <dd className="tabular-nums">{fmtMoney(detail.data.header.totalSwaps)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Total Commissions</dt>
                    <dd className="tabular-nums">{fmtMoney(detail.data.header.totalCommissions)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Imported (Dubai)</dt>
                    <dd>{formatDubaiInstant(detail.data.header.importedAtUtc)}</dd>
                  </div>
                </dl>

                <div className="mt-3 mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  Per-product lines
                </div>
                {detail.data.productLines.length === 0 ? (
                  <div className="text-xs text-muted-foreground">This statement carries no per-product lines.</div>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                    <table className="min-w-full text-xs">
                      <thead className="bg-slate-100 dark:bg-slate-900/80">
                        <tr>
                          <th className="px-2 py-2 text-left">Product</th>
                          <th className="px-2 py-2 text-right">Commission</th>
                          <th className="px-2 py-2 text-right">Holding Costs</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.data.productLines.map((p, i) => (
                          <tr key={`pl-${i}`} className="border-t border-slate-200 dark:border-slate-800">
                            <td className="px-2 py-1.5">{p.product || "-"}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(p.commission)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(p.holdingCosts)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
};

export default LpStatementsPage;
