import { ChartJSNodeCanvas } from "chartjs-node-canvas";

export const BACKEND_BASE_URL = String(
  process.env.BACKEND_API_BASE_URL ||
  process.env.VITE_BACKEND_BASE_URL ||
  "https://api.skylinkscapital.com",
).replace(/\/+$/, "");

export function toYmdUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseRecipients(csv) {
  return String(csv || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function fmtNum(value, digits = 2) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  return safe.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function money(value) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  const abs = Math.abs(safe).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${safe < 0 ? "-" : ""}$${abs}`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function mapWithConcurrency(items, worker, limit = 8) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.max(1, limit) }).map(async () => {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

export function previousFullWeekUtc() {
  const now = new Date();
  // Monday=1 ... Sunday=0 in JS getUTCDay terms
  const day = now.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const currentMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  currentMonday.setUTCDate(currentMonday.getUTCDate() - daysSinceMonday);

  const start = new Date(currentMonday);
  start.setUTCDate(start.getUTCDate() - 7);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(currentMonday);
  end.setUTCDate(end.getUTCDate() - 1);
  end.setUTCHours(23, 59, 59, 0);

  return { start, end };
}

export function toUnixRange(fromDate, toDate) {
  const from = Math.floor(fromDate.getTime() / 1000);
  const to = Math.floor(toDate.getTime() / 1000);
  return { from, to };
}

export async function sendBrevoEmail({ subject, html, recipients, attachments = [], senderName = "Deal Match Reporter" }) {
  const apiKey = process.env.BREVO_API_KEY || "";
  const from = process.env.EMAIL_FROM || "noreply@skylinkscapital.com";
  if (!apiKey) throw new Error("BREVO_API_KEY not set");
  if (!recipients.length) throw new Error("No recipients configured");

  const to = recipients.map((email) => ({ email }));
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: { email: from, name: senderName },
      to,
      subject,
      htmlContent: html,
      ...(attachments.length ? { attachment: attachments } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Brevo HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
}

export async function renderChartBuffer(config, width = 1200, height = 700) {
  const renderer = new ChartJSNodeCanvas({
    width,
    height,
    backgroundColour: "#ffffff",
  });
  return renderer.renderToBuffer(config, "image/png");
}
