import {
  backendFetch,
  toYmdUtc,
  alreadySentFor,
  recordSentFor,
  fmtNum,
  money,
  escapeHtml,
  previousFullWeekUtc,
  sendBrevoEmail,
  renderChartBuffer,
  CADENCES,
  resolveRecipients,
  emailShell,
  kpiGrid,
  dataTable,
  dataCell,
  spanCell,
} from "./reportShared.js";
import { extractVolume, fetchVolumeReport, renderVolumeSection } from "./volumeSection.js";

// The weekly key is bare because sends already recorded in the send log use it.
// A daily that reused it would make Saturday's weekly skip as "already sent".
export const SLIPPAGE_GUARD_KEYS = {
  daily: "slippage-daily",
  weekly: "slippage",
  monthly: "slippage-monthly",
};

// Each cadence may have its own audience, and falls back to the one list this
// report has always used -- so the new sends work with no environment change.
export const SLIPPAGE_RECIPIENT_VARS = {
  daily: ["DAILY_SLIPPAGE_RECIPIENTS", "SLIPPAGE_ALERT_RECIPIENTS"],
  weekly: ["SLIPPAGE_ALERT_RECIPIENTS"],
  monthly: ["MONTHLY_SLIPPAGE_RECIPIENTS", "SLIPPAGE_ALERT_RECIPIENTS"],
};

export function slippageSubject(cadence, fromYmd, toYmd) {
  const word = CADENCES[cadence].subjectWord;
  // A single day rendered as "2026-08-31 to 2026-08-31" reads like a bug.
  const period = fromYmd === toYmd ? fromYmd : `${fromYmd} to ${toYmd}`;
  return `${word} Slippage Report (${period})`;
}

// ── aggregation (mirrors src/pages/departments/dealing/SlippageReportTab.tsx) ──

function aggregateByLp(rows) {
  const map = new Map();
  for (const r of rows) {
    const raw = r?.lpsid;
    const key = String(raw || "").trim() || "Unattributed";
    let agg = map.get(key);
    if (!agg) {
      agg = { key, count: 0, lots: 0, netSlipUsd: 0, netPosUsd: 0, netNegUsd: 0, sumSlipPts: 0, slipPtsCount: 0, clientSumUsd: 0, clientSumPts: 0, clientCostSumUsd: 0 };
      map.set(key, agg);
    }
    const lots = Number(r?.fillVolume) || 0;
    const usd = Number(r?.lpPlImpact) || 0;
    const pts = Number(r?.lpSlipPoints) || 0;
    const hasLpFill = Number(r?.lpPrice) > 0;
    const clientUsd = Number(r?.clientPlImpact) || 0;
    // Client Cost = the client's all-in cost above LP market (slippage minus the
    // MT5 markup we earned back). Documented on the reference report as
    // reconciling with Centroid bridge "Client Order Slippage Ext" (col 33).
    const clientCost = Number(r?.clientCostUsd) || 0;
    const clientPts = Number(r?.clientSlipPoints) || 0;

    agg.count += 1;
    agg.lots += lots;
    agg.netSlipUsd += usd;
    agg.clientSumUsd += clientUsd;
    agg.clientCostSumUsd += clientCost;
    agg.clientSumPts += clientPts;
    if (usd > 0) agg.netPosUsd += usd;
    else if (usd < 0) agg.netNegUsd += usd;
    if (hasLpFill) {
      agg.sumSlipPts += pts;
      agg.slipPtsCount += 1;
    }
  }

  const buckets = [];
  for (const a of map.values()) {
    buckets.push({
      key: a.key,
      count: a.count,
      lots: a.lots,
      netSlipUsd: a.netSlipUsd,
      netPosUsd: a.netPosUsd,
      netNegUsd: a.netNegUsd,
      avgSlipPts: a.slipPtsCount > 0 ? a.sumSlipPts / a.slipPtsCount : 0,
      lpAvgSlipUsd: a.slipPtsCount > 0 ? a.netSlipUsd / a.slipPtsCount : 0,
      clientAvgSlipPts: a.count > 0 ? a.clientSumPts / a.count : 0,
      clientAvgSlipUsd: a.count > 0 ? a.clientSumUsd / a.count : 0,
      clientTotalSlipUsd: a.clientSumUsd,
      clientTotalCostUsd: a.clientCostSumUsd,
      sumSlipPts: a.sumSlipPts,
      slipPtsCount: a.slipPtsCount,
      clientSumUsd: a.clientSumUsd,
      clientCostSumUsd: a.clientCostSumUsd,
      clientSumPts: a.clientSumPts,
    });
  }
  // Worst net slippage first (most negative), mirroring the tab.
  buckets.sort((a, b) => a.netSlipUsd - b.netSlipUsd);

  const sumSlipPts = buckets.reduce((s, b) => s + b.sumSlipPts, 0);
  const slipPtsCount = buckets.reduce((s, b) => s + b.slipPtsCount, 0);
  const rollup = {
    key: "TOTAL",
    count: buckets.reduce((s, b) => s + b.count, 0),
    lots: buckets.reduce((s, b) => s + b.lots, 0),
    netSlipUsd: buckets.reduce((s, b) => s + b.netSlipUsd, 0),
    avgSlipPts: slipPtsCount > 0 ? sumSlipPts / slipPtsCount : 0,
    netPosUsd: buckets.reduce((s, b) => s + b.netPosUsd, 0),
    netNegUsd: buckets.reduce((s, b) => s + b.netNegUsd, 0),
    sumSlipPts,
    slipPtsCount,
  };

  return { buckets, rollup };
}

function computeKpis(buckets, rows) {
  const totalLots = buckets.reduce((s, b) => s + b.lots, 0);
  const totalNetSlipUsd = buckets.reduce((s, b) => s + b.netSlipUsd, 0);

  // costPerLot: positive = cost paid per lot, negative = gain. Best = lowest, Worst = highest.
  const ranked = buckets
    .filter((b) => b.key !== "Unattributed" && b.lots > 0)
    .map((b) => ({ ...b, costPerLot: b.lots > 0 ? -b.netSlipUsd / b.lots : 0 }))
    .sort((a, b) => a.costPerLot - b.costPerLot);
  const bestLp = ranked[0] ?? null;
  const worstLp = ranked.length > 1 ? ranked[ranked.length - 1] : null;

  const byClient = new Map();
  for (const r of rows) {
    const key = String(r?.extLogin || "").trim();
    if (!key) continue;
    byClient.set(key, (byClient.get(key) || 0) + (Number(r?.clientPlImpact) || 0));
  }
  let worstClient = null;
  let worstClientCost = 0;
  for (const [key, gain] of byClient) {
    const cost = -gain;
    if (cost > worstClientCost) {
      worstClientCost = cost;
      worstClient = key;
    }
  }

  return { totalLots, totalNetSlipUsd, bestLp, worstLp, worstClient, worstClientCost };
}

// ── email HTML ───────────────────────────────────────────────────────────────
//
// This report used to carry its own hand-rolled stylesheet pinned to a dark
// palette. The reader opens these on a phone in Zoho and asked for it to stop
// being a black page; the Business Summary family, which he does not complain
// about, has always been the shared light shell. So the private shell is gone
// and everything below composes `emailShell` from reportShared.js instead —
// the same stylesheet, the same cell helpers, one place to fix a rendering bug.
//
// The private `dataCell` and `spanCell` copies went with it. They were
// character-for-character the shared ones minus the `bold` option, and a
// hand-copied helper is exactly how the two shells drifted apart in the first
// place.

function slipCls(value) {
  const n = Number(value) || 0;
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "muted";
}

export function buildSlippageEmailHtml({ fromYmd, toYmd, buckets, kpis, mt5Volume = null, volumeError = null, periodNoun = "week", cadence = "weekly" }) {
  const bodyRows = buckets
    .map(
      (b) => `<tr>
        ${dataCell("LP", escapeHtml(b.key), { nowrap: true, cls: b.key === "Unattributed" ? "muted-key" : "" })}
        ${dataCell("Lots", fmtNum(b.lots, 2), { align: "right" })}
        ${dataCell("LP Avg Slip (pts)", fmtNum(b.avgSlipPts, 2), { align: "right", cls: slipCls(b.avgSlipPts) })}
        ${dataCell("LP Avg Slip (USD)", money(b.lpAvgSlipUsd), { align: "right", cls: slipCls(b.lpAvgSlipUsd) })}
        ${dataCell("LP Total Slip (USD)", money(b.netSlipUsd), { align: "right", cls: slipCls(b.netSlipUsd) })}
        ${dataCell("Client Avg Slip (pts)", fmtNum(b.clientAvgSlipPts, 2), { align: "right", cls: slipCls(b.clientAvgSlipPts) })}
        ${dataCell("Client Avg Slip (USD)", money(b.clientAvgSlipUsd), { align: "right", cls: slipCls(b.clientAvgSlipUsd) })}
        ${dataCell("Client Total Slip (USD)", money(b.clientTotalSlipUsd), { align: "right", cls: slipCls(b.clientTotalSlipUsd) })}
        ${dataCell("Client Cost (USD)", money(b.clientTotalCostUsd), { align: "right", cls: slipCls(b.clientTotalCostUsd) })}
        ${dataCell("Net Positive USD", money(b.netPosUsd), { align: "right", cls: "pos" })}
        ${dataCell("Net Negative USD", money(b.netNegUsd), { align: "right", cls: "neg" })}
      </tr>`,
    )
    .join("");

  const rollupTotals = buckets.reduce(
    (acc, b) => {
      acc.lots += b.lots;
      acc.netSlipUsd += b.netSlipUsd;
      acc.netPosUsd += b.netPosUsd;
      acc.netNegUsd += b.netNegUsd;
      acc.sumSlipPts += b.sumSlipPts;
      acc.slipPtsCount += b.slipPtsCount;
      acc.clientSumUsd += b.clientSumUsd;
      acc.clientCostSumUsd += b.clientCostSumUsd;
      acc.clientSumPts += b.clientSumPts;
      acc.count += b.count;
      return acc;
    },
    { lots: 0, netSlipUsd: 0, netPosUsd: 0, netNegUsd: 0, sumSlipPts: 0, slipPtsCount: 0, clientSumUsd: 0, clientSumPts: 0, clientCostSumUsd: 0, count: 0 },
  );
  const totalLpAvgPts = rollupTotals.slipPtsCount > 0 ? rollupTotals.sumSlipPts / rollupTotals.slipPtsCount : 0;
  const totalLpAvgUsd = rollupTotals.slipPtsCount > 0 ? rollupTotals.netSlipUsd / rollupTotals.slipPtsCount : 0;
  const totalClientAvgPts = rollupTotals.count > 0 ? rollupTotals.clientSumPts / rollupTotals.count : 0;
  const totalClientAvgUsd = rollupTotals.count > 0 ? rollupTotals.clientSumUsd / rollupTotals.count : 0;

  const totalRow = `${spanCell("TOTAL")}
                ${dataCell("Lots", fmtNum(rollupTotals.lots, 2), { align: "right" })}
                ${dataCell("LP Avg Slip (pts)", fmtNum(totalLpAvgPts, 2), { align: "right", cls: slipCls(totalLpAvgPts) })}
                ${dataCell("LP Avg Slip (USD)", money(totalLpAvgUsd), { align: "right", cls: slipCls(totalLpAvgUsd) })}
                ${dataCell("LP Total Slip (USD)", money(rollupTotals.netSlipUsd), { align: "right", cls: slipCls(rollupTotals.netSlipUsd) })}
                ${dataCell("Client Avg Slip (pts)", fmtNum(totalClientAvgPts, 2), { align: "right", cls: slipCls(totalClientAvgPts) })}
                ${dataCell("Client Avg Slip (USD)", money(totalClientAvgUsd), { align: "right", cls: slipCls(totalClientAvgUsd) })}
                ${dataCell("Client Total Slip (USD)", money(rollupTotals.clientSumUsd), { align: "right", cls: slipCls(rollupTotals.clientSumUsd) })}
                ${dataCell("Client Cost (USD)", money(rollupTotals.clientCostSumUsd), { align: "right", cls: slipCls(rollupTotals.clientCostSumUsd) })}
                ${dataCell("Net Positive USD", money(rollupTotals.netPosUsd), { align: "right", cls: "pos" })}
                ${dataCell("Net Negative USD", money(rollupTotals.netNegUsd), { align: "right", cls: "neg" })}`;

  // Five cards, and one of them holds "-$12,480.55" — too wide for a fifth of a
  // phone screen. Capped at 182px they sit five-across on a desktop row and
  // fall to two-across, filling the width, on a phone. No media query: Zoho
  // strips them, so the single layout has to read at both widths.
  const cards = kpiGrid(
    [
      { label: "Total Lots", value: fmtNum(kpis.totalLots, 2) },
      { label: "Total Net LP Slippage USD", value: money(kpis.totalNetSlipUsd), cls: slipCls(kpis.totalNetSlipUsd) },
      {
        label: "Best LP (lowest USD/lot)",
        value: kpis.bestLp ? escapeHtml(kpis.bestLp.key) : "-",
        note: kpis.bestLp ? `${fmtNum(kpis.bestLp.costPerLot, 2)} USD/lot` : "0.00 USD/lot",
      },
      {
        label: "Worst LP (highest USD/lot)",
        value: kpis.worstLp ? escapeHtml(kpis.worstLp.key) : "-",
        note: kpis.worstLp ? `${fmtNum(kpis.worstLp.costPerLot, 2)} USD/lot` : "0.00 USD/lot",
      },
      {
        label: "Worst Client (highest USD slippage)",
        value: kpis.worstClient ? escapeHtml(kpis.worstClient) : "-",
        note: kpis.worstClient ? `${money(kpis.worstClientCost)}` : "0.00 USD",
      },
    ],
    { maxWidth: 182 },
  );

  const body = `
          ${cards}

          <p class="section-title">By-LP Summary</p>
          ${dataTable({
            headers: [
              { label: "LP", width: "10%" },
              { label: "Lots", width: "8%" },
              { label: "LP Avg Slip (pts)", width: "9%" },
              { label: "LP Avg Slip (USD)", width: "9%" },
              { label: "LP Total Slip (USD)", width: "10%" },
              { label: "Client Avg Slip (pts)", width: "9%" },
              { label: "Client Avg Slip (USD)", width: "9%" },
              { label: "Client Total Slip (USD)", width: "10%" },
              { label: "Client Cost (USD)", width: "10%" },
              { label: "Net Positive USD", width: "8%" },
              { label: "Net Negative USD", width: "8%" },
            ],
            totalRow,
            bodyRows,
            emptyText: `No slippage rows for this ${periodNoun}.`,
          })}

          ${renderVolumeSection(mt5Volume, { theme: "light", unavailableReason: volumeError })}

          <p class="section-title" style="margin-top:16px;">Net Slippage by LP</p>
          <p class="note">
            See the attached chart <strong>slippage-by-lp.png</strong> for Net Slippage by LP.
          </p>`;

  return emailShell({
    theme: "light",
    title: `${CADENCES[cadence].subjectWord} Slippage Report`,
    subtitle: "Management Reporting | LP Slippage Analytics",
    metaLines: [
      `Period: <strong>${escapeHtml(fromYmd)}</strong> to <strong>${escapeHtml(toYmd)}</strong>`,
      "Scope: all groups, all logins, all symbols",
      "Excludes internal accounts (matches Slippage tab)",
    ],
    body,
    footerLines: [
      "Automated report generated by the Slippage Reporting pipeline.",
      "Net Slippage USD = &Sigma; LP P/L impact per LP. Avg Slip pts averaged only over rows with an LP fill (lpPrice &gt; 0).",
    ],
  });
}

// ── chart attachment ─────────────────────────────────────────────────────────

// The chart's palette, matching the light email around it.
//
// It was drawn for a dark card: a #111a2c canvas fill, #cfe0fb ticks, and
// pastel #f87171 / #34d399 bars. Two things were wrong with that. The canvas
// fill never applied — `renderChartBuffer` hands ChartJSNodeCanvas a white
// backgroundColour and `options.backgroundColor` is not a Chart.js root option
// — so the pale-blue ticks and washed pastel bars were already being drawn on
// white, which is most of why the attachment looked as bad as the email.
//
// These are the same semantic values the Deal Match charts use (its CH map) and
// the same red and green the shared stylesheet gives .neg and .pos, so a bar
// and a table cell reporting the same loss are now the same colour.
const CH = {
  ink: "#0f172a",
  grid: "#e2e8f0",
  axis: "#334155",
  muted: "#64748b",
  loss: "#b91c1c",
  gain: "#15803d",
};

async function buildSlippageChartAttachments(buckets, fromYmd, toYmd) {
  const top = [...buckets]
    .sort((a, b) => Math.abs(Number(b.netSlipUsd) || 0) - Math.abs(Number(a.netSlipUsd) || 0))
    .slice(0, 15)
    // Re-sort ascending (worst first) for readable bar ordering.
    .sort((a, b) => a.netSlipUsd - b.netSlipUsd);

  const config = {
    type: "bar",
    data: {
      labels: top.map((b) => b.key),
      datasets: [
        {
          label: "Net Slippage USD",
          data: top.map((b) => Number(b.netSlipUsd) || 0),
          backgroundColor: top.map((b) => ((Number(b.netSlipUsd) || 0) < 0 ? CH.loss : CH.gain)),
          borderRadius: 5,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: false,
      animation: false,
      scales: {
        x: {
          ticks: { color: CH.axis, callback: (v) => `$${Math.round(v).toLocaleString()}` },
          grid: { color: CH.grid },
        },
        y: { ticks: { color: CH.axis }, grid: { display: false } },
      },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `Net Slippage by LP (${fromYmd} to ${toYmd})`,
          color: CH.ink,
          font: { size: 20, weight: "700" },
        },
        subtitle: {
          display: true,
          text: "Top 15 LPs by |Net Slippage USD| - worst (red) to best (green)",
          color: CH.muted,
          font: { size: 12 },
        },
      },
    },
  };

  const buffer = await renderChartBuffer(config, 1200, 700);
  // Delivered as a plain downloadable attachment (matches the Deal Match report;
  // Brevo's transactional API does not reliably support cid: inline images).
  return [
    {
      name: "slippage-by-lp.png",
      content: buffer.toString("base64"),
    },
  ];
}

// ── fetch + orchestration ────────────────────────────────────────────────────

async function fetchSlippageRows(fromYmd, toYmd) {
  const params = new URLSearchParams({ group: "*", from: fromYmd, to: toYmd });
  const resp = await backendFetch(`/SlippageReport/Run?${params.toString()}`, { timeoutMs: 45_000 });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`SlippageReport/Run HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const report = await resp.json();
  return Array.isArray(report?.rows) ? report.rows : [];
}

export async function runSlippageEmailReport({
  cadence = "weekly",
  fromDate,
  toDate,
  recipients: recipientsOverride,
} = {}) {
  const spec = CADENCES[cadence];
  if (!spec) throw new Error(`Unknown cadence "${cadence}"`);
  const label = `Slippage${cadence[0].toUpperCase()}${cadence.slice(1)}`;

  const period = fromDate && toDate ? { start: fromDate, end: toDate } : spec.period();
  const fromYmd = toYmdUtc(period.start);
  const toYmd = toYmdUtc(period.end);

  const rows = await fetchSlippageRows(fromYmd, toYmd);
  const { buckets } = aggregateByLp(rows);
  const kpis = computeKpis(buckets, rows);

  // The volume funnel is the only figure in this report that needs
  // DealMatch/Run, and it is supplementary. Its own try/catch, because a new
  // enrichment must never be able to suppress a report that works today: if the
  // call fails or times out the section says so by name and every slippage
  // figure above it still goes out. It also roughly doubles this report's
  // runtime -- DealMatch/Run costs ~40s whatever window it is asked for -- which
  // is the accepted price of the answer.
  let mt5Volume = null;
  let volumeError = null;
  try {
    mt5Volume = extractVolume(await fetchVolumeReport(period.start, period.end));
  } catch (error) {
    volumeError = error?.message || String(error);
    console.warn(`[${label}] volume lookup failed:`, volumeError);
  }

  // Explicit recipients (e.g. the on-demand test button) take precedence over the configured list.
  // An explicit recipient list means the on-demand test button, which must
  // always send. Everything else is the cron or a RUN_ON_START boot, and a
  // window that already went out must not go again -- an app pool that
  // recycles nightly would otherwise mail this every morning.
  const isScheduledRun = !(Array.isArray(recipientsOverride) && recipientsOverride.length);
  const recipients = Array.isArray(recipientsOverride) && recipientsOverride.length
    ? recipientsOverride.map((e) => String(e).trim()).filter(Boolean)
    : resolveRecipients(SLIPPAGE_RECIPIENT_VARS[cadence]);
  if (!recipients.length) {
    console.warn(`[${label}] No recipients configured. Skipping.`);
    return { ok: false, reason: "no-recipients", lps: buckets.length, fromYmd, toYmd };
  }

  // Same window, already sent: this is a restart, not a new period.
  const windowKey = spec.windowKey(fromYmd, toYmd);
  if (isScheduledRun && (await alreadySentFor(SLIPPAGE_GUARD_KEYS[cadence], windowKey))) {
    console.log(`[${label}] ${windowKey} already sent; skipping (restart, not a new ${spec.noun}).`);
    return { ok: false, reason: "already-sent", fromYmd, toYmd };
  }

  const subject = slippageSubject(cadence, fromYmd, toYmd);
  const html = buildSlippageEmailHtml({ fromYmd, toYmd, buckets, kpis, mt5Volume, volumeError, periodNoun: spec.noun, cadence });
  const attachments = await buildSlippageChartAttachments(buckets, fromYmd, toYmd);
  await sendBrevoEmail({ subject, html, recipients, attachments, senderName: "Slippage Reporter" });

  if (isScheduledRun) await recordSentFor(SLIPPAGE_GUARD_KEYS[cadence], windowKey);

  console.log(`[${label}] Sent to ${recipients.join(", ")} | lps=${buckets.length} | period=${fromYmd}..${toYmd}`);
  return { ok: true, lps: buckets.length, fromYmd, toYmd };
}

export async function getWeeklySlippageDataset({ fromDate, toDate } = {}) {
  const week = fromDate && toDate ? { start: fromDate, end: toDate } : previousFullWeekUtc();
  const fromYmd = toYmdUtc(week.start);
  const toYmd = toYmdUtc(week.end);

  const rows = await fetchSlippageRows(fromYmd, toYmd);
  const { buckets } = aggregateByLp(rows);
  const kpis = computeKpis(buckets, rows);

  return { fromYmd, toYmd, kpis, buckets };
}
