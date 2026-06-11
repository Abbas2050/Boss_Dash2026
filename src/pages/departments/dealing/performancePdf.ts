import { Chart, registerables } from "chart.js";
import jsPDF from "jspdf";
import { autoTable } from "jspdf-autotable";
import type { ReportData } from "./dealPerformanceReport";

Chart.register(...registerables);

const COLORS = { blue: "#1d4ed8", green: "#15803d", red: "#be123c", gold: "#b45309" };

const fmtMoney = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(Math.round(v)).toLocaleString()}`;

export async function renderMonthlyBarChart(opts: {
  title: string;
  labels: string[];
  values: number[];
  baseColor: string;
}): Promise<string> {
  const { title, labels, values, baseColor } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = 1100;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const maxV = values.length ? Math.max(...values) : 0;
  const minV = values.length ? Math.min(...values) : 0;
  const barColors = values.map((v) =>
    maxV !== minV && v === maxV ? COLORS.green : maxV !== minV && v === minV ? COLORS.red : baseColor,
  );

  const valueLabelPlugin = {
    id: "valueLabels",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    afterDatasetsDraw(chart: any) {
      const c = chart.ctx as CanvasRenderingContext2D;
      c.save();
      c.font = "11px Arial";
      c.fillStyle = "#0f172a";
      c.textAlign = "center";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chart.getDatasetMeta(0).data.forEach((bar: any, i: number) => {
        c.fillText(fmtMoney(values[i]), bar.x, bar.y - 4);
      });
      c.restore();
    },
  };

  const chart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ data: values, backgroundColor: barColors, borderRadius: 4, maxBarThickness: 48 }] },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        legend: { display: false },
        title: { display: true, text: title, color: "#0f172a", font: { size: 16, weight: "bold" as const } },
      },
      scales: {
        x: { ticks: { color: "#475569", font: { size: 11 } }, grid: { display: false } },
        y: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ticks: { color: "#475569", font: { size: 11 }, callback: (v: any) => fmtMoney(Number(v)) },
          grid: { color: "#e2e8f0" },
        },
      },
    },
    plugins: [valueLabelPlugin],
  });
  chart.update();
  const url = canvas.toDataURL("image/png");
  chart.destroy();
  return url;
}

export async function generatePerformancePdf(data: ReportData): Promise<void> {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 32;
  let y = margin + 6;

  // Header
  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42);
  doc.text("Deal Performance Report", margin, y);
  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  doc.text(`Sky Links Capital   ·   ${data.meta.fromYmd} to ${data.meta.toYmd}`, margin, y + 16);
  doc.text(`Generated ${data.meta.generatedAt}`, pageW - margin, y + 16, { align: "right" });
  y += 30;
  doc.setDrawColor(29, 78, 216);
  doc.setLineWidth(1.5);
  doc.line(margin, y, pageW - margin, y);
  y += 18;

  // KPI row
  const kpis: Array<[string, string]> = [
    ["Total Revenue", fmtMoney(data.totals.totalRev)],
    ["Net Revenue", fmtMoney(data.totals.netRevenue)],
    ["IB Commission", fmtMoney(data.totals.ibComm)],
    ["LP Commission", fmtMoney(data.totals.lpComm)],
    ["Total Lots", Math.round(data.totals.lots).toLocaleString()],
  ];
  const gap = 8;
  const kpiW = (pageW - margin * 2 - gap * 4) / 5;
  kpis.forEach((kpi, i) => {
    const x = margin + i * (kpiW + gap);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.8);
    doc.roundedRect(x, y, kpiW, 40, 4, 4);
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(kpi[0].toUpperCase(), x + 8, y + 14);
    doc.setFontSize(13);
    doc.setTextColor(15, 23, 42);
    doc.text(kpi[1], x + 8, y + 31);
  });
  y += 54;

  // Charts
  const labels = data.months.map((m) => m.label);
  const netUrl = await renderMonthlyBarChart({ title: "Net Revenue by Month", labels, values: data.months.map((m) => m.netRevenue), baseColor: COLORS.blue });
  const ibUrl = await renderMonthlyBarChart({ title: "IB Commission by Month", labels, values: data.months.map((m) => m.ibComm), baseColor: COLORS.red });
  const lpUrl = await renderMonthlyBarChart({ title: "LP Commission by Month", labels, values: data.months.map((m) => m.lpComm), baseColor: COLORS.gold });

  const chartW = pageW - margin * 2;
  const chartH = chartW * (360 / 1100);
  const addChart = (url: string) => {
    if (!url) return;
    if (y + chartH > pageH - margin) {
      doc.addPage();
      y = margin;
    }
    doc.addImage(url, "PNG", margin, y, chartW, chartH);
    y += chartH + 12;
  };
  addChart(netUrl);
  addChart(ibUrl);
  addChart(lpUrl);

  // Monthly breakdown table
  autoTable(doc, {
    startY: y + 4,
    head: [["Month", "Lots", "Total Rev", "Net Rev", "IB Comm", "LP Comm"]],
    body: data.months.map((m) => [
      m.label,
      Math.round(m.lots).toLocaleString(),
      fmtMoney(m.totalRev),
      fmtMoney(m.netRevenue),
      fmtMoney(m.ibComm),
      fmtMoney(m.lpComm),
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [241, 245, 249] as [number, number, number], textColor: [15, 23, 42] as [number, number, number] },
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } },
    margin: { left: margin, right: margin },
  });

  // Top clients table
  autoTable(doc, {
    head: [["Login", "Name", "Lots", "Total Rev", "IB Comm", "Net Rev"]],
    body: data.topClients.map((c) => [
      c.login,
      c.name || "-",
      Math.round(c.lots).toLocaleString(),
      fmtMoney(c.totalRev),
      fmtMoney(c.ibComm),
      fmtMoney(c.netRevenue),
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [241, 245, 249] as [number, number, number], textColor: [15, 23, 42] as [number, number, number] },
    columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } },
    margin: { left: margin, right: margin },
  });

  // Warnings (if any)
  if (data.warnings.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const yW = (doc as any).lastAutoTable.finalY + 14;
    doc.setFontSize(8);
    doc.setTextColor(190, 18, 60);
    doc.text(`Warnings: ${data.warnings.join("; ")}`, margin, yW);
  }

  // Footnote clarifying the IB Commission basis
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const footY = ((doc as any).lastAutoTable?.finalY || y) + (data.warnings.length ? 28 : 14);
  doc.setFontSize(7);
  doc.setTextColor(148, 163, 184);
  doc.text(
    "Monthly IB Commission = period IB transactions (transfers & withdrawals). The IB Commission KPI/total also includes current IB wallet balance.",
    margin,
    footY,
  );

  doc.save(`deal-performance-report-${data.meta.fromYmd}_${data.meta.toYmd}.pdf`);
}
