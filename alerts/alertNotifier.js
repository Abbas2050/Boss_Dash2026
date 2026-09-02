// Generic alert sender (email via Brevo, optional Telegram), independent of the wallet report.

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

function getRecipients() {
  const csv = process.env.ALERT_RECIPIENTS || process.env.WALLET_RECIPIENTS || "";
  return csv.split(",").map((r) => r.trim()).filter(Boolean).map((email) => ({ email }));
}

async function postBrevo({ subject, html }) {
  const apiKey = process.env.BREVO_API_KEY || "";
  const from = process.env.EMAIL_FROM || "noreply@skylinkscapital.com";
  const recipients = getRecipients();
  if (!apiKey) return { ok: false, reason: "BREVO_API_KEY not set" };
  if (!recipients.length) return { ok: false, reason: "ALERT_RECIPIENTS not set" };

  const res = await fetch(BREVO_URL, {
    method: "POST",
    headers: { accept: "application/json", "api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ sender: { email: from, name: "SLC Alerts" }, to: recipients, subject, htmlContent: html }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, reason: `Brevo HTTP ${res.status}: ${body.slice(0, 200)}` };
  }
  return { ok: true };
}

/** Send an alert email with a single retry. Never throws. */
export async function sendAlertEmail({ subject, html }) {
  try {
    let result = await postBrevo({ subject, html });
    if (!result.ok && result.reason && result.reason.startsWith("Brevo HTTP")) {
      result = await postBrevo({ subject, html }); // one retry on HTTP failure
    }
    if (!result.ok) console.warn(`[Alerts] email skipped/failed: ${result.reason}`);
    else console.log(`[Alerts] email sent: ${subject}`);
    return result;
  } catch (e) {
    console.error("[Alerts] email error:", e?.message || e);
    return { ok: false, reason: String(e?.message || e) };
  }
}

/** Optional Telegram. Never throws. */
export async function sendAlertTelegram(text) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
    const channelId = process.env.TELEGRAM_CHANNEL_ID || "";
    if (!botToken || !channelId) return { ok: false, reason: "telegram not configured" };
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ chat_id: channelId, text }),
      signal: AbortSignal.timeout(20000),
    });
    return res.ok ? { ok: true } : { ok: false, reason: `Telegram HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

const esc = (v) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const fmt = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function buildLpMarginEmail(rows) {
  const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Dubai" });
  const body = rows
    .map(
      (r) =>
        `<tr><td style="padding:6px;border-bottom:1px solid #eee">${esc(r.lpName || "-")}</td>` +
        `<td style="padding:6px;border-bottom:1px solid #eee"><b>${esc(r.login ?? "-")}</b></td>` +
        `<td style="padding:6px;border-bottom:1px solid #eee;color:#c62828"><b>${fmt(r.marginLevel)}%</b></td>` +
        `<td style="padding:6px;border-bottom:1px solid #eee">${fmt(r.equity)}</td>` +
        `<td style="padding:6px;border-bottom:1px solid #eee">${fmt(r.freeMargin)}</td></tr>`,
    )
    .join("");
  const html = `<div style="font-family:Arial,sans-serif">
    <h2 style="color:#c62828">⚠ LP Margin Alert — ${rows.length} account(s) below threshold</h2>
    <p style="color:#666">${when} (Asia/Dubai)</p>
    <table style="border-collapse:collapse;width:100%">
      <thead><tr style="background:#f5f5f5;text-align:left">
        <th style="padding:6px">LP Name</th><th style="padding:6px">Login</th>
        <th style="padding:6px">Margin Level</th><th style="padding:6px">Equity</th><th style="padding:6px">Free Margin</th>
      </tr></thead><tbody>${body}</tbody></table>
    <p style="color:#999;font-size:12px">Automated alert from SLC Dashboard.</p></div>`;
  return { subject: `[ALERT] LP Margin — ${rows.length} account(s) below threshold`, html };
}

// The two down alerts below describe two different incidents and deliberately
// share no wording beyond the timestamp. "Data backend unreachable" was sent
// for a backend that was up and answering every request, and it cost an
// operator a night looking at a healthy backend: the real fault was that our
// own hub connection was negotiating without a credential and being refused.
// Whoever reads these has to be able to tell, from the subject line alone,
// whether to page the backend team or to check our own configuration.

/** The backend is not answering at all: timeout, DNS, refused socket, 5xx. */
export function buildBackendDownEmail({ repeat = false } = {}) {
  const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Dubai" });
  const still = repeat ? "still " : "";
  return {
    subject: `[ALERT] Data backend ${still}unreachable`,
    html: `<div style="font-family:Arial,sans-serif"><h2 style="color:#c62828">⚠ Data backend ${still}unreachable</h2>
      <p>The dashboard cannot reach the data backend at all — the connection timed out, was refused,
      or the backend answered with a server error. Live LP margin alerts are not being delivered.</p>
      <p>This is a fault on the backend side or on the network between us and it; there is nothing to
      change on the dashboard. Check that the backend host is serving, then wait — the dashboard keeps
      retrying and will email again when the connection is restored.</p>
      <p style="color:#666">${when} (Asia/Dubai)</p></div>`,
  };
}

/**
 * The backend is up and answering, and is refusing OUR credentials (401/403 on
 * the hub negotiate, or a refused token exchange). Nothing is wrong with the
 * backend; something is wrong with our configuration.
 *
 * No token, key or credential value appears anywhere in this email. It names
 * the variables to look at, never their contents.
 */
export function buildBackendAuthFailedEmail({ repeat = false } = {}) {
  const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Dubai" });
  const still = repeat ? "still " : "";
  return {
    subject: `[ALERT] Data backend ${still}rejecting dashboard credentials`,
    html: `<div style="font-family:Arial,sans-serif"><h2 style="color:#c62828">⚠ Data backend ${still}rejecting our credentials</h2>
      <p>The data backend is reachable and answering, but it refused the dashboard's authentication
      (HTTP 401/403) when opening the live alerts connection. The backend is healthy — the dashboard's
      credentials are the problem. Live LP margin alerts are not being delivered.</p>
      <p>Check on the dashboard server: <b>BACKEND_API_KEY</b> and <b>BACKEND_CLIENT_ID</b> (these are
      exchanged for the short-lived token the connection presents), and <b>SIGNALR_TOKEN</b> if it is
      set, since an explicit value there overrides the exchange and a stale one will be refused
      forever. A key that was rotated on the backend side needs to be updated here and the server
      restarted.</p>
      <p style="color:#666">${when} (Asia/Dubai)</p></div>`,
  };
}

export function buildBackendRecoveredEmail() {
  const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Dubai" });
  return {
    subject: "[ALERT] Data backend recovered",
    html: `<div style="font-family:Arial,sans-serif"><h2 style="color:#2e7d32">✓ Data backend recovered</h2>
      <p>The connection to the data backend has been restored.</p>
      <p style="color:#666">${when} (Asia/Dubai)</p></div>`,
  };
}
