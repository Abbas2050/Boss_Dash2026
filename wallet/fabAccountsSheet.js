import { google } from "googleapis";
import { loadFabAccountsMapping } from "./fabAccountsMappingConfig.js";

// The FAB Operating and Holding balances, from a workbook that has NOTHING to do
// with the wallet workbook read by pspClients.js. Separate spreadsheet, separate
// id, separate client, separate failure path -- a layout change in one must not
// be able to break the other's read.
//
// The service account is shared, because it is the same Google identity; nothing
// else is.
//
// Design: docs/superpowers/specs/2026-09-01-excess-funds-cards-design.md

let cachedService = null;

function getService() {
  if (cachedService) return cachedService;
  const raw = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GA4_SERVICE_ACCOUNT_JSON not configured");
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  cachedService = { sheets: google.sheets({ version: "v4", auth }), account: credentials.client_email || "unknown" };
  return cachedService;
}

// Sheets returns display strings. An empty or unreadable cell is NOT zero -- zero
// is a real balance, and conflating the two is how a treasury figure silently
// loses a term.
export function parseSheetNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (/^[-–—]$/.test(text)) return null;
  if (/^(#|N\/A$)/i.test(text)) return null;
  const negative = /^\(.*\)$/.test(text);
  const digits = text.replace(/[()]/g, "").replace(/[^0-9.-]/g, "");
  if (!/[0-9]/.test(digits)) return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return negative ? -Math.abs(value) : value;
}

// The likeliest first failure is that the sheet was never shared with the service
// account. Saying so, and naming the account, saves whoever reads the log from
// having to dig the address out of the credentials JSON.
export function describeSheetError(error, { spreadsheetId, tab, account }) {
  const base = `FAB accounts sheet ${spreadsheetId} (tab "${tab}")`;
  const code = Number(error?.code);
  if (code === 403) {
    return `${base}: access denied. Share the sheet with ${account} as a Viewer.`;
  }
  if (code === 404) {
    return `${base}: not found. Check FAB_ACCOUNTS_SHEET_ID.`;
  }
  const message = String(error?.message || "unknown error");
  if (/unable to parse range/i.test(message)) {
    return `${base}: tab "${tab}" does not exist in that spreadsheet. ${message}`;
  }
  return `${base}: ${message} (service account ${account})`;
}

export async function readFabAccounts() {
  const spreadsheetId = String(process.env.FAB_ACCOUNTS_SHEET_ID || "").trim();
  if (!spreadsheetId) throw new Error("FAB_ACCOUNTS_SHEET_ID not configured");

  const { tab, cells } = loadFabAccountsMapping();
  const { sheets, account } = getService();
  const ranges = [`${tab}!${cells.fabOperating}`, `${tab}!${cells.fabHolding}`];

  let response;
  try {
    response = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });
  } catch (error) {
    throw new Error(describeSheetError(error, { spreadsheetId, tab, account }));
  }

  const valueRanges = response?.data?.valueRanges || [];
  const cellAt = (index) => valueRanges[index]?.values?.[0]?.[0];
  const fabOperating = parseSheetNumber(cellAt(0));
  const fabHolding = parseSheetNumber(cellAt(1));

  // An unreadable cell is reported as null and named. It is never zero: the page
  // shows "unavailable" for a null and a real figure for a zero.
  return {
    fabOperating,
    fabHolding,
    fetchedAt: new Date().toISOString(),
    source: { spreadsheetId, tab, cells },
  };
}
