import fs from "node:fs/promises";
import path from "node:path";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import { getWeeklyDealMatchDataset } from "../reports/dealMatchWeeklyReport.js";

const WIDTH = 1100;
const HEIGHT = 620;
const BG = "#f8fafc";
const C = {
  blue: "#1e3a8a",
  teal: "#0f766e",
  green: "#15803d",
  gold: "#b45309",
  red: "#b91c1c",
  slate: "#334155",
  grid: "#e2e8f0",
};

const fmtMoney = (v) =>
  `${v < 0 ? "-" : ""}$${Math.abs(Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const fmtNum = (v, d = 2) => (Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

function baseOptions(title, subtitle) {
  return {
    responsive: false,
    animation: false,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: C.slate, font: { size: 12 } } },
      title: { display: true, text: title, color: C.blue, font: { size: 24, weight: "700" }, padding: { top: 12, bottom: 4 } },
      subtitle: {
        display: Boolean(subtitle),
        text: subtitle || "",
        color: "#64748b",
        font: { size: 12, weight: "500" },
        padding: { bottom: 8 },
      },
    },
    layout: { padding: { left: 12, right: 12, top: 6, bottom: 12 } },
  };
}

async function renderChart(config, filePath, width = WIDTH, height = HEIGHT) {
  const renderer = new ChartJSNodeCanvas({ width, height, backgroundColour: BG });
  const buffer = await renderer.renderToBuffer(config, "image/png");
  await fs.writeFile(filePath, buffer);
}

function topN(rows, key, n = 10) {
  return [...rows].sort((a, b) => (Number(b[key]) || 0) - (Number(a[key]) || 0)).slice(0, n);
}

function segmentCounts(rows) {
  const positive = rows.map((r) => Number(r.netRev) || 0).filter((v) => v > 0).sort((a, b) => a - b);
  const q50 = positive[Math.floor(positive.length * 0.5)] || 0;
  const q75 = positive[Math.floor(positive.length * 0.75)] || 0;
  const counts = { high: 0, medium: 0, low: 0, negative: 0 };
  for (const r of rows) {
    const v = Number(r.netRev) || 0;
    if (v <= 0) counts.negative += 1;
    else if (v >= q75) counts.high += 1;
    else if (v >= q50) counts.medium += 1;
    else counts.low += 1;
  }
  return counts;
}

async function makeSummaryBanner(rows, outFile) {
  const totalClients = rows.length;
  const totals = rows.reduce(
    (a, r) => {
      a.lots += Number(r.lots) || 0;
      a.totalRev += Number(r.totalRev) || 0;
      a.netRev += Number(r.netRev) || 0;
      return a;
    },
    { lots: 0, totalRev: 0, netRev: 0 },
  );
  const avgNet = totalClients ? totals.netRev / totalClients : 0;
  const top = [...rows].sort((a, b) => (Number(b.netRev) || 0) - (Number(a.netRev) || 0))[0];
  const bannerValues = [totalClients, totals.lots, totals.totalRev, totals.netRev, avgNet];
  const maxVal = Math.max(...bannerValues.map((v) => Math.abs(v || 0)), 1);
  const scaled = bannerValues.map((v) => (Number(v) || 0) / maxVal);
  const topLabel = top ? `${top.login} - ${top.name}` : "-";

  await renderChart(
    {
      type: "bar",
      data: {
        labels: ["Total Clients", "Total Lots", "Total Revenue", "Total Net Revenue", "Average Net Revenue"],
        datasets: [
          {
            label: "KPI Scale",
            data: scaled,
            backgroundColor: ["#1d4ed8", "#0891b2", "#0ea5e9", "#16a34a", "#22c55e"],
            borderRadius: 6,
          },
        ],
      },
      options: {
        ...baseOptions("Weekly Deal Match KPI Banner", `Top Net Revenue Client: ${topLabel}`),
        indexAxis: "y",
        plugins: { ...baseOptions().plugins, legend: { display: false }, title: baseOptions("Weekly Deal Match KPI Banner").plugins.title, subtitle: baseOptions("", `Top Net Revenue Client: ${topLabel}`).plugins.subtitle },
        scales: {
          x: { display: false, min: 0, max: 1.05, grid: { display: false } },
          y: { ticks: { color: C.slate, font: { size: 13, weight: "600" } }, grid: { display: false } },
        },
      },
      plugins: [
        {
          id: "banner-values",
          afterDatasetsDraw(chart) {
            const { ctx } = chart;
            ctx.save();
            ctx.fillStyle = "#0f172a";
            ctx.font = "700 13px Arial";
            const labels = [
              String(totalClients),
              fmtNum(totals.lots, 2),
              fmtMoney(totals.totalRev),
              fmtMoney(totals.netRev),
              fmtMoney(avgNet),
            ];
            chart.getDatasetMeta(0).data.forEach((bar, i) => {
              ctx.fillText(labels[i], bar.x + 10, bar.y + 4);
            });
            ctx.restore();
          },
        },
      ],
    },
    outFile,
    1100,
    360,
  );
}

async function main() {
  const dataset = await getWeeklyDealMatchDataset({ limit: 100 });
  const rows = dataset.rows || [];
  const outDir = path.join(process.cwd(), "storage", "reports", "dealmatch-email-charts");
  await fs.mkdir(outDir, { recursive: true });

  const label = (r) => `${r.login}`;
  const byNet = topN(rows, "netRev", 10);
  const byTotal = topN(rows, "totalRev", 10);

  const valueLabelPlugin = {
    id: "value-label-plugin",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.fillStyle = "#334155";
      ctx.font = "600 11px Arial";
      chart.data.datasets.forEach((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        meta.data.forEach((bar, i) => {
          const v = Number(ds.data[i]) || 0;
          ctx.fillText(fmtMoney(v), bar.x - 20, bar.y - 8);
        });
      });
      ctx.restore();
    },
  };

  await renderChart(
    {
      type: "bar",
      data: {
        labels: byNet.map((r) => label(r)),
        datasets: [
          {
            label: "Net Revenue",
            data: byNet.map((r) => Number(r.netRev) || 0),
            backgroundColor: byNet.map((_, i) => (i === 0 ? C.gold : i < 3 ? C.teal : "#93c5fd")),
            borderRadius: 6,
          },
        ],
      },
      options: {
        ...baseOptions("Top 10 Clients by Net Revenue", "Top 3 highlighted"),
        indexAxis: "y",
        scales: {
          x: { ticks: { color: C.slate, callback: (v) => fmtMoney(v) }, grid: { color: C.grid } },
          y: { ticks: { color: C.slate }, grid: { display: false } },
        },
      },
    },
    path.join(outDir, "01_top10_net_revenue.png"),
  );

  await renderChart(
    {
      type: "bar",
      data: {
        labels: byTotal.map((r) => label(r)),
        datasets: [{ label: "Total Revenue", data: byTotal.map((r) => Number(r.totalRev) || 0), backgroundColor: "#0ea5e9", borderRadius: 6 }],
      },
      options: {
        ...baseOptions("Top 10 Clients by Total Revenue", "Highest Total Rev contributors"),
        plugins: { ...baseOptions().plugins, legend: { display: false }, title: baseOptions("Top 10 Clients by Total Revenue").plugins.title, subtitle: baseOptions("", "Highest Total Rev contributors").plugins.subtitle },
        scales: {
          x: { ticks: { color: C.slate }, grid: { display: false } },
          y: { ticks: { color: C.slate, callback: (v) => fmtMoney(v) }, grid: { color: C.grid } },
        },
      },
      plugins: [valueLabelPlugin],
    },
    path.join(outDir, "02_top10_total_revenue.png"),
  );

  await renderChart(
    {
      type: "scatter",
      data: {
        datasets: [
          {
            label: "Clients",
            data: rows.map((r) => ({ x: Number(r.lots) || 0, y: Number(r.netRev) || 0 })),
            pointRadius: 4,
            pointBackgroundColor: rows.map((r) => ((Number(r.netRev) || 0) >= 0 ? C.teal : C.red)),
          },
        ],
      },
      options: {
        ...baseOptions("Lots vs Net Revenue", "X: Lots, Y: Net Revenue"),
        scales: {
          x: { title: { display: true, text: "Lots", color: C.slate }, ticks: { color: C.slate }, grid: { color: C.grid } },
          y: { title: { display: true, text: "Net Revenue", color: C.slate }, ticks: { color: C.slate, callback: (v) => fmtMoney(v) }, grid: { color: C.grid } },
        },
      },
    },
    path.join(outDir, "03_lots_vs_net_revenue.png"),
  );

  const totals = rows.reduce(
    (a, r) => {
      a.markup += Number(r.markup) || 0;
      a.client += Number(r.clientComm) || 0;
      a.lp += Math.abs(Number(r.lpComm) || 0);
      a.ib += Math.abs(Number(r.ibCommission) || 0);
      a.net += Math.abs(Number(r.netRev) || 0);
      return a;
    },
    { markup: 0, client: 0, lp: 0, ib: 0, net: 0 },
  );

  await renderChart(
    {
      type: "doughnut",
      data: {
        labels: ["Markup", "Client Comm", "LP Comm", "IB Commission", "Net Revenue"],
        datasets: [{ data: [totals.markup, totals.client, totals.lp, totals.ib, totals.net], backgroundColor: ["#0ea5e9", "#14b8a6", "#f59e0b", "#ef4444", "#16a34a"] }],
      },
      options: {
        ...baseOptions("Revenue Breakdown", "Composition of key revenue components"),
        plugins: { ...baseOptions().plugins, legend: { position: "right", labels: { color: C.slate } }, title: baseOptions("Revenue Breakdown").plugins.title, subtitle: baseOptions("", "Composition of key revenue components").plugins.subtitle },
      },
    },
    path.join(outDir, "04_revenue_breakdown.png"),
  );

  await renderChart(
    {
      type: "bar",
      data: {
        labels: byTotal.map((r) => label(r)),
        datasets: [
          { label: "Total Revenue", data: byTotal.map((r) => Number(r.totalRev) || 0), backgroundColor: "#38bdf8" },
          { label: "Net Revenue", data: byTotal.map((r) => Number(r.netRev) || 0), backgroundColor: "#10b981" },
        ],
      },
      options: {
        ...baseOptions("Gross Revenue vs Net Revenue", "Top clients comparison"),
        scales: {
          x: { ticks: { color: C.slate }, grid: { display: false } },
          y: { ticks: { color: C.slate, callback: (v) => fmtMoney(v) }, grid: { color: C.grid } },
        },
      },
    },
    path.join(outDir, "05_gross_vs_net_revenue.png"),
  );

  const seg = segmentCounts(rows);
  await renderChart(
    {
      type: "doughnut",
      data: {
        labels: ["High Profit", "Medium Profit", "Low Profit", "Negative/Weak"],
        datasets: [{ data: [seg.high, seg.medium, seg.low, seg.negative], backgroundColor: ["#15803d", "#0ea5e9", "#f59e0b", "#ef4444"] }],
      },
      options: {
        ...baseOptions("Profitability Segmentation", "Client count by profitability tier"),
        plugins: { ...baseOptions().plugins, legend: { position: "right", labels: { color: C.slate } }, title: baseOptions("Profitability Segmentation").plugins.title, subtitle: baseOptions("", "Client count by profitability tier").plugins.subtitle },
      },
    },
    path.join(outDir, "06_profitability_segmentation.png"),
  );

  const totalRev = rows.reduce((s, r) => s + (Number(r.totalRev) || 0), 0);
  const lpCost = rows.reduce((s, r) => s + Math.abs(Number(r.lpComm) || 0), 0);
  const ibCost = rows.reduce((s, r) => s + Math.abs(Number(r.ibCommission) || 0), 0);
  const netRevenue = rows.reduce((s, r) => s + (Number(r.netRev) || 0), 0);

  await renderChart(
    {
      type: "bar",
      data: {
        labels: ["Start Total Rev", "- LP Comm", "- IB Commission", "End Net Revenue"],
        datasets: [
          {
            label: "Revenue Walk",
            data: [totalRev, -lpCost, -ibCost, netRevenue],
            backgroundColor: ["#0ea5e9", "#f59e0b", "#ef4444", "#16a34a"],
            borderRadius: 6,
          },
        ],
      },
      options: {
        ...baseOptions("IB Commission Impact (Waterfall Style)", "How gross revenue converts to net revenue"),
        plugins: { ...baseOptions().plugins, legend: { display: false }, title: baseOptions("IB Commission Impact (Waterfall Style)").plugins.title, subtitle: baseOptions("", "How gross revenue converts to net revenue").plugins.subtitle },
        scales: {
          x: { ticks: { color: C.slate }, grid: { display: false } },
          y: { ticks: { color: C.slate, callback: (v) => fmtMoney(v) }, grid: { color: C.grid } },
        },
      },
      plugins: [valueLabelPlugin],
    },
    path.join(outDir, "07_ib_commission_impact.png"),
  );

  await makeSummaryBanner(rows, path.join(outDir, "08_summary_banner.png"));

  const manifest = {
    generatedAt: new Date().toISOString(),
    period: { from: dataset.fromYmd, to: dataset.toYmd },
    requestedClients: 100,
    usedClients: rows.length,
    totalAvailable: dataset.totalAvailable,
    outputDir: outDir,
    files: [
      "01_top10_net_revenue.png",
      "02_top10_total_revenue.png",
      "03_lots_vs_net_revenue.png",
      "04_revenue_breakdown.png",
      "05_gross_vs_net_revenue.png",
      "06_profitability_segmentation.png",
      "07_ib_commission_impact.png",
      "08_summary_banner.png",
    ],
  };
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
