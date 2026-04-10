/**
 * Wallet Notifier - Node.js port of OtherProject/backofficetool/src/wallet_notifier.php
 * Sends daily balance reports via Brevo (email) and Telegram Bot.
 */

const CRYPTO_WIDGETS = ['bitpace', 'letknowpay', 'ownbit', 'heropayment', 'googlesheets_match2pay', 'googlesheets_deusxpay', 'googlesheets_openpayed'];
const BANK_WIDGETS   = ['googlesheets_goldsouq', 'googlesheets_fab', 'googlesheets_mbme'];

// ─────────────────────────────────────────────────────────────────────────────
// Email via Brevo API
// ─────────────────────────────────────────────────────────────────────────────
function buildEmailHtml(widgets, total, date, bankReceivable, cryptoReceivable, netAllCurrent, netAfterExpected, extras = {}) {
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toBeDepositedIntoLPsK20 = Number(extras.toBeDepositedIntoLPsK20 ?? 0);
  const toBeDepositedIntoLPsK21 = Number(extras.toBeDepositedIntoLPsK21 ?? 0);
  const differenceBetweenActualAndExpected = Number(extras.differenceBetweenActualAndExpected ?? 0);

  let rows = '';
  let cryptoSubtotal = 0;
  for (const id of CRYPTO_WIDGETS) {
    if (!widgets[id]) continue;
    cryptoSubtotal += widgets[id].balance ?? 0;
    const tick = widgets[id].status === 'ok' ? '✓' : '✗';
    rows += `<tr><td>${tick} ${widgets[id].name}</td><td>$${fmt(widgets[id].balance)}</td></tr>`;
  }
  rows += `<tr style="background:#fff3cd;font-weight:bold;"><td>🔐 SUBTOTAL CRYPTO</td><td>$${fmt(cryptoSubtotal)}</td></tr>`;
  for (const id of BANK_WIDGETS) {
    if (!widgets[id]) continue;
    const tick = widgets[id].status === 'ok' ? '✓' : '✗';
    rows += `<tr><td>${tick} ${widgets[id].name}</td><td>$${fmt(widgets[id].balance)}</td></tr>`;
  }

  const updatedTime = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai' });

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
      <tr class="total-row"><td>💎 TOTAL COMBINED</td><td>$${fmt(total)}</td></tr>
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
  <div class="footer"><p>This is an automated daily report from the PSP Wallet Monitoring System.</p><p>Please do not reply to this email.</p></div>
</div>
</body>
</html>`;
}

export async function sendDailyEmailReport(widgets, total, date, bankReceivable, cryptoReceivable, netAllCurrent, netAfterExpected, extras = {}) {
  const apiKey = process.env.BREVO_API_KEY || '';
  const from   = process.env.EMAIL_FROM || process.env.WALLET_FROM || 'noreply@skylinkscapital.com';
  const recipientsCsv = process.env.WALLET_RECIPIENTS || process.env.ALERT_RECIPIENTS || '';

  if (!apiKey) { console.warn('[Notifier] BREVO_API_KEY not set — skipping email'); return false; }
  if (!recipientsCsv) { console.warn('[Notifier] WALLET_RECIPIENTS not set — skipping email'); return false; }

  const recipients = recipientsCsv.split(',').map((r) => ({ email: r.trim() })).filter((r) => r.email);
  const subject = `[WALLET] Closing Balance - ${date} - Total: $${Number(total).toFixed(2)}`;
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
    console.error(`[Notifier] Brevo email failed HTTP ${res.status}:`, body.slice(0, 200));
    return false;
  }

  console.log('[Notifier] Daily wallet email sent to', recipients.map((r) => r.email).join(', '));
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram Bot API
// ─────────────────────────────────────────────────────────────────────────────
function buildTelegramMessage(widgets, total, date, bankReceivable, cryptoReceivable, netAllCurrent, netAfterExpected, extras = {}) {
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const line = '─'.repeat(30);
  const toBeDepositedIntoLPsK20 = Number(extras.toBeDepositedIntoLPsK20 ?? 0);
  const toBeDepositedIntoLPsK21 = Number(extras.toBeDepositedIntoLPsK21 ?? 0);
  const differenceBetweenActualAndExpected = Number(extras.differenceBetweenActualAndExpected ?? 0);

  let msg = `💎 *Closing Balance Report*\n📅 ${date}\n\n`;

  let cryptoSubtotal = 0;
  for (const id of CRYPTO_WIDGETS) {
    if (!widgets[id]) continue;
    cryptoSubtotal += widgets[id].balance ?? 0;
    const icon = widgets[id].status === 'ok' ? '✅' : '❌';
    msg += `${icon} *${widgets[id].name}:* \`$${fmt(widgets[id].balance)}\`\n`;
  }

  msg += `${line}\n`;
  msg += `🔐 *SUBTOTAL CRYPTO:* \`$${fmt(cryptoSubtotal)}\`\n`;
  msg += `${line}\n`;

  for (const id of BANK_WIDGETS) {
    if (!widgets[id]) continue;
    const icon = widgets[id].status === 'ok' ? '✅' : '❌';
    msg += `${icon} *${widgets[id].name}:* \`$${fmt(widgets[id].balance)}\`\n`;
  }

  msg += `${line}\n`;
  msg += `💎 *TOTAL COMBINED:* \`$${fmt(total)}\`\n`;
  msg += `📊 *To be received in BANK:* \`$${fmt(bankReceivable)}\`\n`;
  msg += `🔐 *To be received in CRYPTO:* \`$${fmt(cryptoReceivable)}\`\n`;
  msg += `🏦 *To be deposited into LPs (Bank - USD):* \`$${fmt(toBeDepositedIntoLPsK20)}\`\n`;
  msg += `🏦 *To be deposited into LPs (Crypto USDT):* \`$${fmt(toBeDepositedIntoLPsK21)}\`\n`;
  msg += `⚖️ *Difference between actual and expected (J29):* \`$${fmt(differenceBetweenActualAndExpected)}\`\n`;
  msg += `🧮 *Net all Current Balance:* \`$${fmt(netAllCurrent)}\`\n`;
  msg += `📈 *Net Balance after expected funds:* \`$${fmt(netAfterExpected)}\``;

  return msg;
}

export async function sendDailyTelegramReport(widgets, total, date, bankReceivable, cryptoReceivable, netAllCurrent, netAfterExpected, extras = {}) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const channelId = process.env.TELEGRAM_CHANNEL_ID || '';

  if (!botToken || !channelId) { console.warn('[Notifier] TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID not set — skipping Telegram'); return false; }

  const message = buildTelegramMessage(widgets, total, date, bankReceivable, cryptoReceivable, netAllCurrent, netAfterExpected, extras);

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'accept': 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: channelId, text: message, parse_mode: 'Markdown' }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[Notifier] Telegram send failed HTTP ${res.status}:`, body.slice(0, 200));
    return false;
  }

  console.log('[Notifier] Daily wallet Telegram report sent');
  return true;
}
