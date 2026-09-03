/**
 * Wallet Notifier - Node.js port of OtherProject/backofficetool/src/wallet_notifier.php
 * Sends daily balance reports via Brevo (email) and Telegram Bot.
 */

const CRYPTO_WIDGETS = ['bitpace', 'letknowpay', 'ownbit', 'ownbitnew', 'heropayment', 'googlesheets_match2pay', 'googlesheets_deusxpay', 'googlesheets_openpayed'];
const BANK_WIDGETS   = ['googlesheets_goldsouq', 'googlesheets_fab', 'googlesheets_mbme'];

// What a figure looks like when there is no figure. A dash means "could not
// read"; "$0.00" means the balance is zero. Those are different facts and this
// report used to print the second when it meant the first.
const UNAVAILABLE = '—';

// walletMonitor stamps a provider whose API call failed `status: 'error'` and
// publishes `balance: 0` beside it. The ✗ already says the call failed; the
// "$0.00" next to it asserted a balance nobody read, and it was that zero,
// summed into the total, that sent the alert of 2026-09-03. The two now agree.
//
// Read exactly as the ✗ is, so a row can never disagree with its own tick.
// (The scheduler reads an absent status the other way round -- as healthy --
// because there it decides whether to stay silent, and silence on an ambiguity
// loses alerts. Here the question is whether to assert a number, and asserting
// one on an ambiguity prints a lie.)
function isWidgetConnected(widget) {
  return widget?.status === 'ok';
}

// A sum is only as knowable as its terms. If any provider in the set did not
// answer, the subtotal is missing a term and is not a smaller subtotal -- it is
// unknown, and printing it would understate the treasury by whatever the silent
// provider holds.
function sumOrUnavailable(widgets, ids) {
  let sum = 0;
  for (const id of ids) {
    if (!widgets[id]) continue;
    if (!isWidgetConnected(widgets[id])) return null;
    sum += widgets[id].balance ?? 0;
  }
  return sum;
}

function disconnectedNames(widgets) {
  return [...CRYPTO_WIDGETS, ...BANK_WIDGETS]
    .filter((id) => widgets[id] && !isWidgetConnected(widgets[id]))
    .map((id) => widgets[id].name || id);
}

// The subject line. The total leads because it is the one figure that is read
// off a phone's notification preview without opening anything.
//
// When a provider is disconnected there is no total to lead with, and a precise
// dollar figure in the preview would be the most-read lie in the whole report,
// so it says so instead.
export function buildEmailSubject(total, date, widgets = {}) {
  const totalText = disconnectedNames(widgets).length
    ? UNAVAILABLE
    : `$${Number(total).toFixed(2)}`;
  return `[Total: ${totalText}] Closing Balance - ${date}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Email via Brevo API
// ─────────────────────────────────────────────────────────────────────────────
export function buildEmailHtml(widgets, total, date, bankReceivable, cryptoReceivable, netAllCurrent, netAfterExpected, extras = {}) {
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDelta = (n) => {
    const v = Number(n || 0);
    if (v > 0) return `+$${fmt(v)}`;
    if (v < 0) return `-$${fmt(Math.abs(v))}`;
    return '$0.00';
  };
  const toBeDepositedIntoLPsK20 = Number(extras.toBeDepositedIntoLPsK20 ?? 0);
  const toBeDepositedIntoLPsK21 = Number(extras.toBeDepositedIntoLPsK21 ?? 0);
  const differenceBetweenActualAndExpected = Number(extras.differenceBetweenActualAndExpected ?? 0);
  const changeItems = Array.isArray(extras.changeItems) ? extras.changeItems : [];
  const changeMap = {};
  for (const item of changeItems) changeMap[item.key] = item;

  // One row builder for both groups, so the disconnected rule cannot drift
  // between the crypto half of the table and the bank half.
  const providerRow = (id) => {
    const ch = changeMap[id];
    const connected = isWidgetConnected(widgets[id]);
    const tick = connected ? '✓' : '✗';
    const rowBg = ch ? (ch.delta > 0 ? 'background:#e8f5e9;' : 'background:#ffebee;') : '';
    const valColor = ch ? (ch.delta > 0 ? 'color:#2e7d32;font-weight:bold;' : 'color:#c62828;font-weight:bold;') : '';
    const deltaHtml = ch ? ` <span style="${valColor}font-size:11px;">(${fmtDelta(ch.delta)})</span>` : '';
    const value = connected
      ? `$${fmt(widgets[id].balance)}${deltaHtml}`
      : `${UNAVAILABLE} <span style="color:#c62828;font-size:11px;">(not connected)</span>`;
    return `<tr style="${rowBg}"><td>${tick} ${widgets[id].name}</td><td style="${connected ? valColor : ''}">${value}</td></tr>`;
  };

  let rows = '';
  for (const id of CRYPTO_WIDGETS) {
    if (!widgets[id]) continue;
    rows += providerRow(id);
  }
  const cryptoSubtotal = sumOrUnavailable(widgets, CRYPTO_WIDGETS);
  const cryptoSubtotalText = cryptoSubtotal === null ? UNAVAILABLE : `$${fmt(cryptoSubtotal)}`;
  rows += `<tr style="background:#fff3cd;font-weight:bold;"><td>🔐 SUBTOTAL CRYPTO</td><td>${cryptoSubtotalText}</td></tr>`;
  for (const id of BANK_WIDGETS) {
    if (!widgets[id]) continue;
    rows += providerRow(id);
  }

  const updatedTime = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai' });
  const changesHtml = changeItems.length
    ? `<div style="background:#fff8e1;border-left:4px solid #f9a825;padding:12px;margin:15px 0;border-radius:4px;font-size:13px;line-height:1.8"><strong>🔔 Changes Detected:</strong><br>${changeItems
        .map((item) => {
          const color = item.delta > 0 ? '#2e7d32' : '#c62828';
          const arrow = item.delta > 0 ? '▲' : '▼';
          return `${item.label}: $${fmt(item.before)} ${arrow} <strong style="color:${color}">$${fmt(item.after)}</strong> <span style="color:${color}">(${fmtDelta(item.delta)})</span>`;
        })
        .join('<br>')}</div>`
    : '';

  const chTotal = changeMap['total_balance'];
  const totalRowBg = chTotal ? (chTotal.delta > 0 ? '#e8f5e9' : '#ffebee') : '#e8f5e9';
  const totalRowColor = chTotal ? (chTotal.delta > 0 ? 'color:#2e7d32;' : 'color:#c62828;') : '';
  const totalDeltaHtml = chTotal ? ` <span style="${totalRowColor}font-size:11px;">(${fmtDelta(chTotal.delta)})</span>` : '';

  // The same rule as the rows, one level up: the total is summed from every
  // provider, so one silent provider makes it a sum with a missing term rather
  // than a smaller total. Naming who is missing is the useful half of the row.
  const offline = disconnectedNames(widgets);
  const totalText = offline.length
    ? `${UNAVAILABLE} <span style="color:#c62828;font-size:11px;">(not connected: ${offline.join(', ')})</span>`
    : `$${fmt(total)}${totalDeltaHtml}`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body{font-family:Arial,sans-serif;background:#f5f5f5}
  .container{max-width:600px;margin:20px auto;background:#fff;padding:20px;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,.1)}
  .header{border-bottom:3px solid #4CAF50;padding-bottom:10px;margin-bottom:20px}
  h1{margin:0 0 5px;color:#333}
  table{width:100%;border-collapse:collapse;margin:20px 0}
  th,td{padding:12px;text-align:left;border-bottom:1px solid #ddd}
  th{background:#4CAF50;color:#fff}
  tr:nth-child(even){background:#f9f9f9}
  .total-row{background:#e8f5e9;font-weight:bold}
  .meta-info{background:#f0f0f0;padding:12px;margin:15px 0;border-radius:4px;font-size:13px;line-height:1.8}
  .footer{color:#999;font-size:12px;margin-top:20px;padding-top:10px;border-top:1px solid #eee}
</style>
</head>
<body>
<div class="container">
  <div class="header"><h1>💎 Closing Balance Report</h1><p>${date}</p></div>
  <table>
    <thead><tr><th>PSP Name</th><th>Balance</th></tr></thead>
    <tbody>
      ${rows}
      <tr style="background:${totalRowBg};font-weight:bold;${totalRowColor}"><td>💎 TOTAL COMBINED</td><td style="${offline.length ? '' : totalRowColor}">${totalText}</td></tr>
    </tbody>
  </table>
  <div class="meta-info">
    <strong>Updated:</strong> ${updatedTime}<br>
    <strong>📊 To be received in BANK:</strong> $${fmt(bankReceivable)}<br>
    <strong>🔐 To be received in CRYPTO:</strong> $${fmt(cryptoReceivable)}<br>
    <strong>🏦 To be deposited into LPs (Bank - USD):</strong> $${fmt(toBeDepositedIntoLPsK20)}<br>
    <strong>🏦 To be deposited into LPs (Crypto USDT):</strong> $${fmt(toBeDepositedIntoLPsK21)}<br>
    <strong>⚖️ Difference between actual and expected (J29):</strong> $${fmt(differenceBetweenActualAndExpected)}<br>
    <strong>🧮 Net all Current Balance:</strong> $${fmt(netAllCurrent)}<br>
    <strong>📈 Net Balance after expected funds:</strong> $${fmt(netAfterExpected)}
  </div>
  ${changesHtml}
  <div class="footer"><p>This is an automated daily report from the PSP Wallet Monitoring System.</p><p>Please do not reply to this email.</p></div>
</div>
</body>
</html>`;
}

export async function sendDailyEmailReport(widgets, total, date, bankReceivable, cryptoReceivable, netAllCurrent, netAfterExpected, extras = {}) {
  const apiKey = process.env.BREVO_API_KEY || '';
  const from   = process.env.EMAIL_FROM || process.env.WALLET_FROM || 'noreply@skylinkscapital.com';
  const recipientsCsv = process.env.WALLET_RECIPIENTS || process.env.ALERT_RECIPIENTS || '';

  if (!apiKey) {
    const reason = 'BREVO_API_KEY not set';
    console.warn(`[Notifier] ${reason} — skipping email`);
    return { ok: false, reason };
  }
  if (!recipientsCsv) {
    const reason = 'WALLET_RECIPIENTS not set';
    console.warn(`[Notifier] ${reason} — skipping email`);
    return { ok: false, reason };
  }

  const recipients = recipientsCsv.split(',').map((r) => ({ email: r.trim() })).filter((r) => r.email);
  const subject = buildEmailSubject(total, date, widgets);
  const html = buildEmailHtml(widgets, total, date, bankReceivable, cryptoReceivable, netAllCurrent, netAfterExpected, extras);

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sender: { email: from, name: 'PSP Monitor' }, to: recipients, subject, htmlContent: html }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const body = await res.text();
    const reason = `Brevo HTTP ${res.status}: ${body.slice(0, 200)}`;
    console.error(`[Notifier] Brevo email failed HTTP ${res.status}:`, body.slice(0, 200));
    return { ok: false, reason };
  }

  console.log('[Notifier] Daily wallet email sent to', recipients.map((r) => r.email).join(', '));
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram Bot API
// ─────────────────────────────────────────────────────────────────────────────
export function buildTelegramMessage(widgets, total, date, bankReceivable, cryptoReceivable, netAllCurrent, netAfterExpected, extras = {}) {
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDelta = (n) => {
    const v = Number(n || 0);
    if (v > 0) return `+$${fmt(v)}`;
    if (v < 0) return `-$${fmt(Math.abs(v))}`;
    return '$0.00';
  };
  const line = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const changeItems = Array.isArray(extras.changeItems) ? extras.changeItems : [];
  const changeMap = {};
  for (const item of changeItems) {
    changeMap[item.key] = item;
  }
  const shortName = {
    bitpace: 'Bitpace',
    letknowpay: 'LetKnow',
    ownbit: 'OwnBit',
    ownbitnew: 'OwnBitNew',
    heropayment: 'Hero',
    googlesheets_match2pay: 'M2P',
    googlesheets_deusxpay: 'DeusX',
    googlesheets_openpayed: 'OpenPay',
    googlesheets_goldsouq: 'GoldSouq',
    googlesheets_fab: 'FAB',
    googlesheets_mbme: 'MBME',
  };

  const trendBadge = (delta) => {
    const v = Number(delta || 0);
    if (v > 0) return '🟢';
    if (v < 0) return '🔴';
    return '⚪';
  };

  const changeSuffix = (item) => {
    if (!item) return '';
    return ` ${trendBadge(item.delta)} \`${fmtDelta(item.delta)}\``;
  };

  // Same rule as the email: a disconnected provider has no figure, and a dash
  // is what this project prints when it could not read one.
  const providerLine = (id) => {
    const name = shortName[id] || widgets[id].name;
    if (!isWidgetConnected(widgets[id])) return `• ${name} \`${UNAVAILABLE}\` ✗ not connected\n`;
    return `• ${name} \`$${fmt(widgets[id].balance)}\`${changeSuffix(changeMap[id])}\n`;
  };

  let msg = `*CRYPTO*\n`;

  for (const id of CRYPTO_WIDGETS) {
    if (!widgets[id]) continue;
    msg += providerLine(id);
  }

  const cryptoSubtotal = sumOrUnavailable(widgets, CRYPTO_WIDGETS);
  msg += `C-Total \`${cryptoSubtotal === null ? UNAVAILABLE : `$${fmt(cryptoSubtotal)}`}\`\n`;
  msg += `${line}\n`;
  msg += `*BANK*\n`;

  for (const id of BANK_WIDGETS) {
    if (!widgets[id]) continue;
    msg += providerLine(id);
  }

  msg += `${line}\n`;
  const offline = disconnectedNames(widgets);
  if (offline.length) {
    msg += `*TOTAL* \`${UNAVAILABLE}\` ✗ not connected: ${offline.join(', ')}`;
  } else {
    msg += `*TOTAL* \`$${fmt(total)}\`${changeSuffix(changeMap.total_balance)}`;
  }

  return msg;
}

export async function sendDailyTelegramReport(widgets, total, date, bankReceivable, cryptoReceivable, netAllCurrent, netAfterExpected, extras = {}) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const channelId = process.env.TELEGRAM_CHANNEL_ID || '';

  if (!botToken || !channelId) {
    const reason = 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID not set';
    console.warn(`[Notifier] ${reason} — skipping Telegram`);
    return { ok: false, reason };
  }

  const message = buildTelegramMessage(widgets, total, date, bankReceivable, cryptoReceivable, netAllCurrent, netAfterExpected, extras);

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'accept': 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: channelId, text: message, parse_mode: 'Markdown' }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const body = await res.text();
    const reason = `Telegram HTTP ${res.status}: ${body.slice(0, 200)}`;
    console.error(`[Notifier] Telegram send failed HTTP ${res.status}:`, body.slice(0, 200));
    return { ok: false, reason };
  }

  console.log('[Notifier] Daily wallet Telegram report sent');
  return { ok: true };
}
