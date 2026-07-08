import cron from "node-cron";
import {
  BACKEND_BASE_URL,
  toYmdUtc,
  parseRecipients,
  fmtNum,
  money,
  escapeHtml,
  previousFullWeekUtc,
  sendBrevoEmail,
  renderChartBuffer,
} from "./reportShared.js";

const DEFAULT_SCHEDULE = "30 20 * * 5"; // 20:30 every Friday (UAE time)
const DEFAULT_TIMEZONE = "Asia/Dubai";

// ── aggregation (mirrors src/pages/departments/dealing/SlippageReportTab.tsx) ──

function aggregateByLp(rows) {
  const map = new Map();
  for (const r of rows) {
    const raw = r?.lpsid;
    const key = String(raw || "").trim() || "Unattributed";
    let agg = map.get(key);
    if (!agg) {
      agg = { key, count: 0, lots: 0, netSlipUsd: 0, netPosUsd: 0, netNegUsd: 0, sumSlipPts: 0, slipPtsCount: 0 };
      map.set(key, agg);
    }
    const lots = Number(r?.fillVolume) || 0;
    const usd = Number(r?.lpPlImpact) || 0;
    const pts = Number(r?.lpSlipPoints) || 0;
    const hasLpFill = Number(r?.lpPrice) > 0;

    agg.count += 1;
    agg.lots += lots;
    agg.netSlipUsd += usd;
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
      sumSlipPts: a.sumSlipPts,
      slipPtsCount: a.slipPtsCount,
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

function buildSlippageEmailHtml({ fromYmd, toYmd, buckets, kpis }) {
  const bodyRows = buckets
    .map((b) => {
      const isUnattributed = b.key === "Unattributed";
      return `<tr>
        <td data-label="LP" class="${isUnattributed ? "muted-key" : ""}">${escapeHtml(b.key)}</td>
        <td data-label="Lots" style="text-align:right;">${fmtNum(b.lots, 2)}</td>
        <td data-label="Net Slippage USD" style="text-align:right;" class="${slipCls(b.netSlipUsd)}">${money(b.netSlipUsd)}</td>
        <td data-label="Avg Slip pts" style="text-align:right;" class="${slipCls(b.avgSlipPts)}">${fmtNum(b.avgSlipPts, 2)}</td>
        <td data-label="Net Positive USD" style="text-align:right;" class="pos">${money(b.netPosUsd)}</td>
        <td data-label="Net Negative USD" style="text-align:right;" class="neg">${money(b.netNegUsd)}</td>
      </tr>`;
    })
    .join("");

  const rollupTotals = buckets.reduce(
    (acc, b) => {
      acc.lots += b.lots;
      acc.netSlipUsd += b.netSlipUsd;
      acc.netPosUsd += b.netPosUsd;
      acc.netNegUsd += b.netNegUsd;
      return acc;
    },
    { lots: 0, netSlipUsd: 0, netPosUsd: 0, netNegUsd: 0 },
  );

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { margin:0; padding:0; background:#0b1220; color:#e2e8f0; font-family: Arial, Helvetica, sans-serif; }
      .outer { width:100%; background:#0b1220; padding:20px 10px; }
      .wrap { max-width: 980px; margin: 0 auto; background:#111a2c; border:1px solid #1f2a44; border-radius:14px; overflow:hidden; }
      .header { padding:18px 20px; background:linear-gradient(135deg,#0b1a33,#132a4f); color:#eaf4ff; }
      .header-grid { width:100%; border-collapse:collapse; }
      .header-left { vertical-align:top; text-align:left; }
      .header-right { vertical-align:top; text-align:right; }
      .title { margin:0; font-size:22px; font-weight:700; letter-spacing:0.2px; }
      .subtitle { margin:6px 0 0; font-size:13px; color:#93c5fd; }
      .header-meta { margin:0; font-size:11px; line-height:1.55; color:#9fb8d6; }
      .content { padding:18px 20px 16px; }
      .kpis { width:100%; border-collapse:separate; border-spacing:8px; margin: 0 0 14px; }
      .kpi { background:#0f1a30; border:1px solid #223255; border-radius:10px; padding:10px 12px; }
      .kpi-label { font-size:11px; text-transform:uppercase; letter-spacing:0.4px; color:#8ea4c6; margin:0 0 6px; }
      .kpi-value { font-size:17px; font-weight:700; color:#e2e8f0; margin:0; }
      .kpi-sub { font-size:11px; color:#8ea4c6; margin:4px 0 0; }
      .section-title { margin: 2px 0 8px; font-size:14px; color:#e2e8f0; font-weight:700; }
      table.data { border-collapse: collapse; width: 100%; font-size: 12px; }
      table.data th, table.data td { border: 1px solid #223255; padding: 8px; }
      table.data th { background: #16233f; color:#cfe0fb; text-align:left; font-weight:700; }
      table.data tbody tr:nth-child(even) { background:#101c33; }
      table.data tfoot td { font-weight:700; background:#16233f; color:#e2e8f0; }
      .muted-key { font-style:italic; color:#7186a8; }
      .pos { color:#34d399; font-weight:700; }
      .neg { color:#f87171; font-weight:700; }
      .muted { color:#7186a8; }
      .chart-wrap { margin: 6px 0 16px; text-align:center; }
      .chart-wrap img { max-width:100%; border-radius:8px; border:1px solid #223255; }
      .foot { border-top:1px solid #223255; margin-top:14px; padding-top:10px; color:#8ea4c6; font-size:12px; line-height:1.5; }
      @media only screen and (max-width: 680px) {
        .outer { padding:8px 2px; }
        .wrap { border-radius:8px; }
        .header { padding:12px; }
        .header-grid, .header-grid tbody, .header-grid tr, .header-grid td { display:block !important; width:100% !important; }
        .header-right { text-align:left !important; margin-top:10px; }
        .content { padding:10px; }
        .kpis, .kpis tbody, .kpis tr, .kpis td { display:block !important; width:100% !important; }
        .kpis { border-spacing:0; }
        .kpi { display:block; margin:0 0 8px; }
        table.data, table.data thead, table.data tbody, table.data th, table.data td, table.data tr, table.data tfoot { display:block !important; width:100% !important; }
        table.data thead { display:none !important; }
        table.data tr { margin:0 0 10px; border:1px solid #223255; border-radius:8px; overflow:hidden; }
        table.data td { border:0; border-bottom:1px solid #1a2740; padding:7px 8px 7px 42%; position:relative; text-align:right !important; min-height:18px; font-size:11px; }
        table.data td:last-child { border-bottom:0; }
        table.data td:before { position:absolute; left:8px; top:7px; width:36%; text-align:left; font-weight:700; color:#8ea4c6; content: attr(data-label); white-space:nowrap; }
      }
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
          <table class="data">
            <thead>
              <tr>
                <th>LP</th>
                <th>Lots</th>
                <th>Net Slippage USD</th>
                <th>Avg Slip pts</th>
                <th>Net Positive USD</th>
                <th>Net Negative USD</th>
              </tr>
            </thead>
            <tbody>
              ${bodyRows || `<tr><td data-label="Notice" colspan="6" style="text-align:center;color:#8ea4c6;">No slippage rows for this week.</td></tr>`}
            </tbody>
            <tfoot>
              <tr>
                <td data-label="LP">TOTAL</td>
                <td data-label="Lots" style="text-align:right;">${fmtNum(rollupTotals.lots, 2)}</td>
                <td data-label="Net Slippage USD" style="text-align:right;" class="${slipCls(rollupTotals.netSlipUsd)}">${money(rollupTotals.netSlipUsd)}</td>
                <td data-label="Avg Slip pts" style="text-align:right;">-</td>
                <td data-label="Net Positive USD" style="text-align:right;" class="pos">${money(rollupTotals.netPosUsd)}</td>
                <td data-label="Net Negative USD" style="text-align:right;" class="neg">${money(rollupTotals.netNegUsd)}</td>
              </tr>
            </tfoot>
          </table>

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

export async function runWeeklySlippageEmailReport({ fromDate, toDate } = {}) {
  const week = fromDate && toDate ? { start: fromDate, end: toDate } : previousFullWeekUtc();
  const fromYmd = toYmdUtc(week.start);
  const toYmd = toYmdUtc(week.end);

  const rows = await fetchSlippageRows(fromYmd, toYmd);
  const { buckets } = aggregateByLp(rows);
  const kpis = computeKpis(buckets, rows);

  const recipients = parseRecipients(process.env.SLIPPAGE_ALERT_RECIPIENTS || "");
  if (!recipients.length) {
    console.warn("[SlippageWeekly] No recipients configured. Skipping.");
    return { ok: false, reason: "no-recipients", lps: buckets.length, fromYmd, toYmd };
  }

  const subject = `Weekly Slippage Report (${fromYmd} to ${toYmd})`;
  const html = buildSlippageEmailHtml({ fromYmd, toYmd, buckets, kpis });
  const attachments = await buildSlippageChartAttachments(buckets, fromYmd, toYmd);
  await sendBrevoEmail({ subject, html, recipients, attachments, senderName: "Slippage Reporter" });

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

  if (String(process.env.WEEKLY_SLIPPAGE_RUN_ON_START || "false").toLowerCase() === "true") {
    runWeeklySlippageEmailReport().catch((error) => {
      console.error("[SlippageWeekly] startup run failed:", error?.message || error);
    });
  }
}
