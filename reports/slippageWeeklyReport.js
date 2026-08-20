import cron from "node-cron";
import {
  BACKEND_BASE_URL,
  toYmdUtc,
  parseRecipients,
  alreadySentFor,
  recordSentFor,
  fmtNum,
  money,
  escapeHtml,
  previousFullWeekUtc,
  sendBrevoEmail,
  renderChartBuffer,
} from "./reportShared.js";

const DEFAULT_SCHEDULE = "30 9 * * 6"; // 09:30 every Saturday (UAE time)
const DEFAULT_TIMEZONE = "Asia/Dubai";

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

// ── email HTML (dark theme) ──────────────────────────────────────────────────

function slipCls(value) {
  const n = Number(value) || 0;
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "muted";
}

// Builds one table cell carrying its own visible row label. The label span is
// hidden at the desktop breakpoint, where the real <thead> takes over.
// Right-aligned cells are numeric and get `num` (never wraps); everything else
// gets `txt` (wraps between words only).
function dataCell(label, value, { align = "left", cls = "", nowrap = false } = {}) {
  const kind = align === "right" ? "num" : nowrap ? "key" : "txt";
  const valueCls = cls ? ` ${cls}` : "";
  return `<td class="${kind}" data-label="${escapeHtml(label)}"><span class="lbl">${escapeHtml(label)}</span><span class="val${valueCls}">${value}</span></td>`;
}

// Full-width cell (TOTAL label, empty-state notice) — no label/value split.
function spanCell(value, { colspan = 1, align = "left", cls = "" } = {}) {
  return `<td class="txt" colspan="${colspan}" style="text-align:${align};"><span class="val${cls ? ` ${cls}` : ""}">${value}</span></td>`;
}

function buildSlippageEmailHtml({ fromYmd, toYmd, buckets, kpis }) {
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

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      /* ── Mobile-first base: stacked & fluid so it stays responsive even in
         clients that honor <style> but strip @media (Gmail app for non-Google
         accounts, several webmail clients). Desktop layout is restored in the
         @media (min-width) block below. ── */
      body { margin:0; padding:0; background:#0b1220; color:#e2e8f0; font-family: Arial, Helvetica, sans-serif; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
      /* box-sizing on the layout wrappers: without it, width:100% + padding
         overflows the viewport and the whole email scrolls sideways. */
      .outer, .wrap, .header, .content { box-sizing:border-box; }
      .outer { width:100%; background:#0b1220; padding:8px 4px; }
      /* 980px is what Zoho actually gives the message body; pinning the canvas
         there makes the card-per-row maths deterministic instead of depending
         on the reader's window size. */
      .wrap { width:100%; max-width: 980px; margin: 0 auto; background:#111a2c; border:1px solid #1f2a44; border-radius:10px; overflow:hidden; }
      .header { padding:14px 16px; background:linear-gradient(135deg,#0b1a33,#132a4f); color:#eaf4ff; }
      .header-grid { width:100%; border-collapse:collapse; }
      .header-grid td { display:block; width:100% !important; box-sizing:border-box; }
      .header-left { vertical-align:top; text-align:left; }
      .header-right { vertical-align:top; text-align:left; margin-top:10px; }
      .title { margin:0; font-size:19px; font-weight:700; letter-spacing:0.2px; }
      .subtitle { margin:6px 0 0; font-size:12px; color:#93c5fd; }
      .header-meta { margin:0; font-size:11px; line-height:1.55; color:#9fb8d6; }
      .content { padding:16px; }
      /* ── Single layout, NO @media ────────────────────────────────────────
         Zoho strips @media entirely, so there is no breakpoint to switch on and
         one layout has to read well at both 375px and desktop width.
         Card grids use inline-block cells with a px cap: several fit a desktop
         row and collapse to one per line on a phone. That trick only works for
         small counts — a 10-across row can never also be 1-across — so the data
         is split into narrower tables instead. */
      /* Five cards, and one of them holds "-$12,480.55" — too wide for a fifth
         of a phone screen. Capped at 150px they sit five-across on desktop and
         fall to two-across (filling the width) on a phone. */
      .kpis { width:100%; border-collapse:collapse; margin:0 0 8px; font-size:0; text-align:center; }
      .kpis td { display:inline-block; width:100%; max-width:182px; margin:0 3px 6px; vertical-align:top; box-sizing:border-box; font-size:12px; text-align:left; }
      .kpi { background:#0f1a30; border:1px solid #223255; border-radius:10px; padding:10px 12px; }
      .kpi-label { font-size:11px; text-transform:uppercase; letter-spacing:0.4px; color:#8ea4c6; margin:0 0 6px; }
      .kpi-value { font-size:17px; font-weight:700; color:#e2e8f0; margin:0; }
      .kpi-sub { font-size:11px; color:#8ea4c6; margin:4px 0 0; }
      .section-title { margin: 2px 0 8px; font-size:14px; color:#e2e8f0; font-weight:700; }
      /* The full table needs ~940px to stay legible. On a desktop-width email it
         simply fills the width; on a phone the wrapper scrolls sideways rather
         than crushing ten columns into 375px, which mangled the figures.
         Numeric cells never wrap. */
      /* BASE = the real table. Zoho ignores @media (verified in production from
         both directions), so there is no breakpoint to switch on — the table has
         to be the default or a desktop reader never gets one. The wrapper keeps
         a phone usable: it scrolls sideways instead of crushing 10 columns. */
      /* Cells flow instead of scrolling. Zoho strips overscroll-behavior and
         touch-action, so a horizontally scrolling table could not be made
         safe on Android -- the swipe chained out and flipped to the next
         email. inline-block cells line up in columns on a wide screen and
         stack on a phone, with no media query. See reportShared.js. */
      .tscroll { width:100%; overflow-x:auto; margin:0 0 16px; }
      table.data { border-collapse:collapse; width:100%; font-size:12px; }
      table.data thead { display:none; }
      table.data tbody tr { display:block; box-sizing:border-box; border-bottom:1px solid #223255; padding:4px 0; }
      table.data tbody tr:nth-child(even) { background:#101c33; }
      table.data tr.total-row { background:#16233f; }
      table.data tr.total-row td { font-weight:700; color:#e2e8f0; }
      table.data td, table.data th { display:inline-block; box-sizing:border-box; width:100%; max-width:156px; vertical-align:top; border:0; padding:4px 8px; text-align:left; }
      table.data td .lbl { display:block; font-size:9px; font-weight:700; letter-spacing:0.4px; text-transform:uppercase; color:#8ea4c6; }
      table.data td .val { display:block; font-size:12px; }
      table.data td.num .val { white-space:nowrap; }
      table.data td.key .val { white-space:nowrap; }
      .muted-key { font-style:italic; color:#7186a8; }
      .pos { color:#34d399; font-weight:700; }
      .neg { color:#f87171; font-weight:700; }
      .muted { color:#7186a8; }
      .chart-wrap { margin: 6px 0 16px; text-align:center; }
      .chart-wrap img { max-width:100%; border-radius:8px; border:1px solid #223255; }
      .foot { border-top:1px solid #223255; margin-top:14px; padding-top:10px; color:#8ea4c6; font-size:12px; line-height:1.5; }
    </style>
  </head>
  <body>
    <div class="outer">
      <div class="wrap">
        <div class="header">
          <table class="header-grid" role="presentation">
            <tr>
              <td class="header-left" width="48%">
                <div class="header-meta">
                  Period: <strong>${escapeHtml(fromYmd)}</strong> to <strong>${escapeHtml(toYmd)}</strong><br/>
                  Scope: all groups, all logins, all symbols<br/>
                  Excludes internal accounts (matches Slippage tab)
                </div>
              </td>
              <td class="header-right" width="52%">
                <h1 class="title">Weekly Slippage Report</h1>
                <div class="subtitle">Management Reporting | LP Slippage Analytics</div>
              </td>
            </tr>
          </table>
        </div>
        <div class="content">
          <table class="kpis" role="presentation">
            <tr>
              <td class="kpi" width="20%">
                <p class="kpi-label">Total Lots</p>
                <p class="kpi-value">${fmtNum(kpis.totalLots, 2)}</p>
              </td>
              <td class="kpi" width="20%">
                <p class="kpi-label">Total Net LP Slippage USD</p>
                <p class="kpi-value ${slipCls(kpis.totalNetSlipUsd)}">${money(kpis.totalNetSlipUsd)}</p>
              </td>
              <td class="kpi" width="20%">
                <p class="kpi-label">Best LP (lowest USD/lot)</p>
                <p class="kpi-value">${kpis.bestLp ? escapeHtml(kpis.bestLp.key) : "-"}</p>
                <p class="kpi-sub">${kpis.bestLp ? `${fmtNum(kpis.bestLp.costPerLot, 2)} USD/lot` : "0.00 USD/lot"}</p>
              </td>
              <td class="kpi" width="20%">
                <p class="kpi-label">Worst LP (highest USD/lot)</p>
                <p class="kpi-value">${kpis.worstLp ? escapeHtml(kpis.worstLp.key) : "-"}</p>
                <p class="kpi-sub">${kpis.worstLp ? `${fmtNum(kpis.worstLp.costPerLot, 2)} USD/lot` : "0.00 USD/lot"}</p>
              </td>
              <td class="kpi" width="20%">
                <p class="kpi-label">Worst Client (highest USD slippage)</p>
                <p class="kpi-value">${kpis.worstClient ? escapeHtml(kpis.worstClient) : "-"}</p>
                <p class="kpi-sub">${kpis.worstClient ? `${money(kpis.worstClientCost)}` : "0.00 USD"}</p>
              </td>
            </tr>
          </table>

          <p class="section-title">By-LP Summary</p>
          <div class="tscroll">
          <table class="data">
            <thead>
              <tr>
                <th width="10%">LP</th>
                <th width="8%">Lots</th>
                <th width="9%">LP Avg Slip (pts)</th>
                <th width="9%">LP Avg Slip (USD)</th>
                <th width="10%">LP Total Slip (USD)</th>
                <th width="9%">Client Avg Slip (pts)</th>
                <th width="9%">Client Avg Slip (USD)</th>
                <th width="10%">Client Total Slip (USD)</th>
                <th width="10%">Client Cost (USD)</th>
                <th width="8%">Net Positive USD</th>
                <th width="8%">Net Negative USD</th>
              </tr>
            </thead>
            <tbody>
              <tr class="total-row">
                ${spanCell("TOTAL")}
                ${dataCell("Lots", fmtNum(rollupTotals.lots, 2), { align: "right" })}
                ${dataCell("LP Avg Slip (pts)", fmtNum(totalLpAvgPts, 2), { align: "right", cls: slipCls(totalLpAvgPts) })}
                ${dataCell("LP Avg Slip (USD)", money(totalLpAvgUsd), { align: "right", cls: slipCls(totalLpAvgUsd) })}
                ${dataCell("LP Total Slip (USD)", money(rollupTotals.netSlipUsd), { align: "right", cls: slipCls(rollupTotals.netSlipUsd) })}
                ${dataCell("Client Avg Slip (pts)", fmtNum(totalClientAvgPts, 2), { align: "right", cls: slipCls(totalClientAvgPts) })}
                ${dataCell("Client Avg Slip (USD)", money(totalClientAvgUsd), { align: "right", cls: slipCls(totalClientAvgUsd) })}
                ${dataCell("Client Total Slip (USD)", money(rollupTotals.clientSumUsd), { align: "right", cls: slipCls(rollupTotals.clientSumUsd) })}
                ${dataCell("Client Cost (USD)", money(rollupTotals.clientCostSumUsd), { align: "right", cls: slipCls(rollupTotals.clientCostSumUsd) })}
                ${dataCell("Net Positive USD", money(rollupTotals.netPosUsd), { align: "right", cls: "pos" })}
                ${dataCell("Net Negative USD", money(rollupTotals.netNegUsd), { align: "right", cls: "neg" })}
              </tr>
              ${bodyRows || `<tr>${spanCell("No slippage rows for this week.", { colspan: 11, align: "center" })}</tr>`}
            </tbody>
          </table>
          </div>

          <p class="section-title" style="margin-top:16px;">Net Slippage by LP</p>
          <div class="chart-wrap" style="color:#8ea4c6;font-size:12px;">
            See the attached chart <strong>slippage-by-lp.png</strong> for Net Slippage by LP.
          </div>

          <div class="foot">
            Automated report generated by the Slippage Reporting pipeline.<br/>
            Net Slippage USD = &Sigma; LP P/L impact per LP. Avg Slip pts averaged only over rows with an LP fill (lpPrice &gt; 0).
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

// ── chart attachment ─────────────────────────────────────────────────────────

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
          backgroundColor: top.map((b) => (Number(b.netSlipUsd) || 0) < 0 ? "#f87171" : "#34d399"),
          borderRadius: 5,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: false,
      animation: false,
      backgroundColor: "#111a2c",
      scales: {
        x: {
          ticks: { color: "#cfe0fb", callback: (v) => `$${Math.round(v).toLocaleString()}` },
          grid: { color: "#223255" },
        },
        y: { ticks: { color: "#cfe0fb" }, grid: { display: false } },
      },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `Net Slippage by LP (${fromYmd} to ${toYmd})`,
          color: "#e2e8f0",
          font: { size: 20, weight: "700" },
        },
        subtitle: {
          display: true,
          text: "Top 15 LPs by |Net Slippage USD| - worst (red) to best (green)",
          color: "#9fb8d6",
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
  const runUrl = `${BACKEND_BASE_URL}/SlippageReport/Run?${params.toString()}`;
  const resp = await fetch(runUrl, { signal: AbortSignal.timeout(45_000) });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`SlippageReport/Run HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const report = await resp.json();
  return Array.isArray(report?.rows) ? report.rows : [];
}

export async function runWeeklySlippageEmailReport({ fromDate, toDate, recipients: recipientsOverride } = {}) {
  const week = fromDate && toDate ? { start: fromDate, end: toDate } : previousFullWeekUtc();
  const fromYmd = toYmdUtc(week.start);
  const toYmd = toYmdUtc(week.end);

  const rows = await fetchSlippageRows(fromYmd, toYmd);
  const { buckets } = aggregateByLp(rows);
  const kpis = computeKpis(buckets, rows);

  // Explicit recipients (e.g. the on-demand test button) take precedence over the configured list.
  // An explicit recipient list means the on-demand test button, which must
  // always send. Everything else is the cron or a RUN_ON_START boot, and a
  // window that already went out must not go again -- an app pool that
  // recycles nightly would otherwise mail this every morning.
  const isScheduledRun = !(Array.isArray(recipientsOverride) && recipientsOverride.length);

  const recipients = Array.isArray(recipientsOverride) && recipientsOverride.length
    ? recipientsOverride.map((e) => String(e).trim()).filter(Boolean)
    : parseRecipients(process.env.SLIPPAGE_ALERT_RECIPIENTS || "");
  if (!recipients.length) {
    console.warn("[SlippageWeekly] No recipients configured. Skipping.");
    return { ok: false, reason: "no-recipients", lps: buckets.length, fromYmd, toYmd };
  }

  // Same window, already sent: this is a restart, not a new week.
  const windowKey = `${fromYmd}..${toYmd}`;
  if (isScheduledRun && (await alreadySentFor("slippage", windowKey))) {
    console.log(`[SlippageWeekly] ${windowKey} already sent; skipping (restart, not a new week).`);
    return { ok: false, reason: "already-sent", fromYmd, toYmd };
  }

  const subject = `Weekly Slippage Report (${fromYmd} to ${toYmd})`;
  const html = buildSlippageEmailHtml({ fromYmd, toYmd, buckets, kpis });
  const attachments = await buildSlippageChartAttachments(buckets, fromYmd, toYmd);
  await sendBrevoEmail({ subject, html, recipients, attachments, senderName: "Slippage Reporter" });

  if (isScheduledRun) await recordSentFor("slippage", windowKey);

  console.log(`[SlippageWeekly] Sent to ${recipients.join(", ")} | lps=${buckets.length} | period=${fromYmd}..${toYmd}`);
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

export function startWeeklySlippageScheduler() {
  const enabled = String(process.env.WEEKLY_SLIPPAGE_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    console.log("[SlippageWeekly] disabled by WEEKLY_SLIPPAGE_ENABLED=false");
    return;
  }

  const schedule = String(process.env.WEEKLY_SLIPPAGE_CRON || DEFAULT_SCHEDULE);
  const timezone = String(process.env.WEEKLY_SLIPPAGE_TIMEZONE || DEFAULT_TIMEZONE);
  if (!cron.validate(schedule)) {
    console.error(`[SlippageWeekly] Invalid cron expression: "${schedule}"`);
    return;
  }

  cron.schedule(
    schedule,
    async () => {
      try {
        await runWeeklySlippageEmailReport();
      } catch (error) {
        console.error("[SlippageWeekly] run failed:", error?.message || error);
      }
    },
    { timezone },
  );

  console.log(`[SlippageWeekly] scheduled with expression "${schedule}" (${timezone})`);

  // See the note in weeklyBusinessSummary.js: an unset recipient list fails
  // silently on schedule while test sends keep working.
  if (!parseRecipients(process.env.SLIPPAGE_ALERT_RECIPIENTS || "").length) {
    console.error(
      "[SlippageWeekly] WILL NOT SEND: SLIPPAGE_ALERT_RECIPIENTS is not set. " +
        "Scheduled runs skip silently; test sends still work because they pass recipients explicitly.",
    );
  }

  if (String(process.env.WEEKLY_SLIPPAGE_RUN_ON_START || "false").toLowerCase() === "true") {
    runWeeklySlippageEmailReport().catch((error) => {
      console.error("[SlippageWeekly] startup run failed:", error?.message || error);
    });
  }
}
