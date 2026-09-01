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
// The workbook has one tab per month ("SEP 2026") and one row per day, with the
// date in column A, FAB Operating in column B and FAB Holding in column C. So
// neither the tab nor the row is fixed: both are resolved from today's date on
// every read.
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

// Hardcoded rather than derived from Intl. `toLocaleString(.., { month: "short" })`
// is at the mercy of whichever ICU build the host node was compiled against --
// it has shipped "Sept" for September in some versions, and a tab name of
// "SEPT 2026" would miss the real "SEP 2026" tab. A treasury read must not
// depend on the runtime's month abbreviations.
const MONTH_ABBREVIATIONS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

// Everything scheduled in this project runs on Dubai time, and the balance rows
// are filled in by people sitting in Dubai. Reading "today" off the server's own
// clock would mean the row silently changes over at whatever hour the host
// happens to think midnight is -- on a UTC host that is 4am Dubai, so the first
// four hours of every Dubai morning would read yesterday's row.
//
// formatToParts, not a formatted string that gets re-parsed: parsing a rendered
// date back into a Date is precisely the ambiguity this module exists to avoid.
export function dubaiCalendarDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

// Google Sheets counts days from 1899-12-30 (the Lotus 1-2-3 epoch, leap-year
// bug and all), so serial 1 is 1899-12-31. Date.UTC both sides means no local
// timezone and no DST hour ever enters the arithmetic.
const SHEETS_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86400000;

export function toSheetsSerial({ year, month, day }) {
  return Math.round((Date.UTC(year, month - 1, day) - SHEETS_EPOCH_UTC) / MS_PER_DAY);
}

export function tabNameForDate({ year, month }, pattern = "{MON} {YYYY}") {
  return pattern
    .replace("{MON}", MONTH_ABBREVIATIONS[month - 1])
    .replace("{YYYY}", String(year));
}

// The date the human will look for, written unambiguously. Error messages are
// read by someone comparing them against a sheet displaying MM/DD/YYYY, so give
// them the ISO form and let them count -- "01/09" in a log would restate the
// exact ambiguity that caused the bug.
function isoDate({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// A1 notation: A -> 1, B -> 2, ... AA -> 27.
export function columnLetterToIndex(letter) {
  let index = 0;
  for (const char of String(letter).toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index;
}

export function columnIndexToLetter(index) {
  let letter = "";
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

// "SEP 2026" contains a space, and an unquoted space in A1 notation is a parse
// error, not a lookup miss -- the old fixed "Sheet1" tab never needed this.
function quoteTab(tab) {
  return `'${String(tab).replace(/'/g, "''")}'`;
}

// The FALLBACK path, for when a string arrives anyway. The read below asks for
// UNFORMATTED_VALUE precisely so this is not the primary route: stripping
// everything but [0-9.-] out of a display string turns a European-formatted
// "1.234,56" into 1.23456 -- a wrong number rather than a loud failure, on a
// workbook whose locale nobody has seen. An empty or unreadable cell is still
// NOT zero: zero is a real balance, and conflating the two is how a treasury
// figure silently loses a term.
export function parseSheetNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  // Accounting number format renders a zero balance as a lone dash (hyphen,
  // en dash or em dash). It is a real zero, not a missing cell -- this used
  // to return null here, which made this workbook disagree with the wallet
  // workbook (pspClients.js._isCellReadable), where the sheet owner has
  // confirmed the same dash means zero.
  if (/^[-–—]$/.test(text)) return 0;
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
  const where = tab ? ` (tab "${tab}")` : "";
  const base = `FAB accounts sheet ${spreadsheetId}${where}`;
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

// Tab titles are matched case-insensitively on their trimmed form, and the
// workbook's own spelling is what gets used from then on. "Sep 2026" typed by
// hand is the same month as "SEP 2026", and refusing to read a sheet that is
// plainly there -- while a balance figure goes unavailable -- would be the worse
// failure. `source` reports the title actually used, so nothing is hidden.
function findTabTitle(titles, wanted) {
  const target = wanted.trim().toLowerCase();
  return titles.find((title) => String(title).trim().toLowerCase() === target) || null;
}

export async function readFabAccounts({ now = new Date() } = {}) {
  const spreadsheetId = String(process.env.FAB_ACCOUNTS_SHEET_ID || "").trim();
  if (!spreadsheetId) throw new Error("FAB_ACCOUNTS_SHEET_ID not configured");

  const { tabNamePattern, firstDataRow, columns } = loadFabAccountsMapping();
  const today = dubaiCalendarDate(now);
  const expectedTab = tabNameForDate(today, tabNamePattern);
  const todaySerial = toSheetsSerial(today);
  const { sheets, account } = getService();

  // The tab list is fetched first rather than inferred from a failed range read,
  // because "nobody has created OCT 2026 yet" is a different problem with a
  // different owner than "the sheet is not shared with us", and the message has
  // to be able to say which.
  let meta;
  try {
    meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
  } catch (error) {
    throw new Error(describeSheetError(error, { spreadsheetId, tab: expectedTab, account }));
  }

  const titles = (meta?.data?.sheets || [])
    .map((sheet) => sheet?.properties?.title)
    .filter((title) => typeof title === "string" && title.trim());
  const tab = findTabTitle(titles, expectedTab);
  if (!tab) {
    throw new Error(
      `FAB accounts sheet ${spreadsheetId}: no tab named "${expectedTab}" for ${isoDate(today)}. ` +
        `Tabs present: ${titles.length ? titles.join(", ") : "(none)"}. ` +
        `Create "${expectedTab}" with the dates in column ${columns.date} from row ${firstDataRow}.`,
    );
  }

  // One range spanning every column of interest, so the date and its two
  // balances are read in a single consistent snapshot. Reading them separately
  // would let a row inserted mid-read pair today's date with yesterday's money.
  const indexes = {
    date: columnLetterToIndex(columns.date),
    fabOperating: columnLetterToIndex(columns.fabOperating),
    fabHolding: columnLetterToIndex(columns.fabHolding),
  };
  const firstIndex = Math.min(indexes.date, indexes.fabOperating, indexes.fabHolding);
  const lastIndex = Math.max(indexes.date, indexes.fabOperating, indexes.fabHolding);
  const range =
    `${quoteTab(tab)}!${columnIndexToLetter(firstIndex)}${firstDataRow}:${columnIndexToLetter(lastIndex)}`;

  let response;
  try {
    // UNFORMATTED_VALUE does two jobs here. It returns each balance's underlying
    // number instead of its rendered text, so the sheet's locale, currency
    // symbol and thousands separator never reach parseSheetNumber -- a
    // comma-decimal workbook reads "1.234,56" and parses to 1.23456. And it
    // returns column A as a Sheets serial number rather than "09/01/2026",
    // which is the only way to know whether that means 1 September or 9 January.
    response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
  } catch (error) {
    throw new Error(describeSheetError(error, { spreadsheetId, tab, account }));
  }

  const rows = response?.data?.values || [];
  const offsetOf = (key) => indexes[key] - firstIndex;

  // Search, never arithmetic. Today's row happens to sit at day-of-month + 2 in
  // the sheet as it stands, and the moment anyone inserts a row above it that
  // stops being true while still returning a number -- the wallet workbook next
  // door accumulated three generations of cell addresses learning exactly this.
  //
  // The comparison is serial against serial. Math.floor because a cell that
  // carries a time component comes back as 46266.5 and is still that day.
  let matchOffset = -1;
  let numericDates = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const cell = rows[i]?.[offsetOf("date")];
    if (typeof cell !== "number" || !Number.isFinite(cell)) continue;
    numericDates += 1;
    if (Math.floor(cell) === todaySerial) {
      matchOffset = i;
      break;
    }
  }

  if (matchOffset < 0) {
    // A column of text that merely looks like dates is its own diagnosis: no
    // serial can ever match, and the fix is to retype column A as real dates
    // rather than to go hunting for a missing row.
    const hint = numericDates
      ? `${numericDates} dated row(s) were found, none of them today's.`
      : `Column ${columns.date} holds no date values at all -- the dates there are probably text, not real dates.`;
    throw new Error(
      `FAB accounts sheet ${spreadsheetId} (tab "${tab}"): no row for ${isoDate(today)} ` +
        `(Sheets serial ${todaySerial}) in column ${columns.date} from row ${firstDataRow}. ${hint}`,
    );
  }

  const rowNumber = firstDataRow + matchOffset;
  const cells = {
    fabOperating: `${columns.fabOperating}${rowNumber}`,
    fabHolding: `${columns.fabHolding}${rowNumber}`,
  };
  const row = rows[matchOffset] || [];

  // A blank balance is null, not zero. Today's row is created empty and filled
  // in later in the day, so "not typed yet" is the normal state for hours at a
  // time -- the page shows that as unavailable. A genuine 0 typed into the cell
  // is a real balance and must come back as 0.
  const fabOperating = parseSheetNumber(row[offsetOf("fabOperating")]);
  const fabHolding = parseSheetNumber(row[offsetOf("fabHolding")]);

  return {
    fabOperating,
    fabHolding,
    fetchedAt: new Date().toISOString(),
    // The resolved tab and the real A1 addresses, so a figure on the page can be
    // traced to the exact cell it came from without opening the server.
    source: { spreadsheetId, tab, cells },
  };
}
