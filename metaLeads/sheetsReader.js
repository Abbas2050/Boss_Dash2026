/**
 * Reading a Meta Lead Ads sheet, and nothing else.
 *
 * The service account is the one wallet/fabAccountsSheet.js already uses --
 * same Google identity, same read-only scope -- and the three lead workbooks
 * have to be shared with it. Nothing else is shared: a layout change in one
 * workbook must not be able to break another's read.
 *
 * This module does not know what a lead is. It answers cells.
 *
 * Design: ../docs/superpowers/specs/2026-11-06-meta-leads-to-fxbo-design.md
 */
import { google } from "googleapis";
import { COLUMN_COUNT } from "./columns.js";

let cachedClient = null;

function defaultSheetsClient() {
  if (cachedClient) return cachedClient;
  const raw = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GA4_SERVICE_ACCOUNT_JSON not configured");
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  cachedClient = google.sheets({ version: "v4", auth });
  return cachedClient;
}

/** 0 -> "A", 17 -> "R", 26 -> "AA". */
export function columnLetter(index) {
  let n = Number(index);
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}

const LAST_COLUMN = columnLetter(COLUMN_COUNT - 1);

/**
 * A1 notation for every column of the export from `fromRow` down.
 *
 * The tab name is always quoted and its apostrophes doubled: "Leads 2026"
 * breaks an unquoted range, and Sheets reads `''` inside quotes as one
 * apostrophe.
 */
export function buildRange(tabName, fromRow) {
  const quoted = String(tabName ?? "Sheet1").replace(/'/g, "''");
  return `'${quoted}'!A${fromRow}:${LAST_COLUMN}`;
}

async function getValues(sheets, spreadsheetId, range) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    majorDimension: "ROWS",
  });
  const values = response?.data?.values;
  return Array.isArray(values) ? values : [];
}

/**
 * The header row, and the rows from `fromRow` down.
 *
 * `fromRow === 1` is the full read: one call brings the header and every row
 * back together. Anything higher is the windowed read the worker does every
 * minute, and then the header is fetched on its own -- one extra call per
 * sheet per minute, which is the price of still being able to notice that the
 * columns moved without pulling the whole sheet back to find out.
 */
export async function readHeaderAndRows({ spreadsheetId, tabName, fromRow }, deps = {}) {
  const sheets = (deps.getSheetsClient || defaultSheetsClient)();
  const start = Math.max(1, Number(fromRow) || 1);

  if (start === 1) {
    const cells = await getValues(sheets, spreadsheetId, buildRange(tabName, 1));
    return { header: cells[0] ?? [], rows: cells.slice(1), firstRowNumber: 2 };
  }

  const headerCells = await getValues(sheets, spreadsheetId, `${buildRange(tabName, 1)}1`);
  const rows = await getValues(sheets, spreadsheetId, buildRange(tabName, start));
  return { header: headerCells[0] ?? [], rows, firstRowNumber: start };
}
