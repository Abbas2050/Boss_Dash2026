import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.join(__dirname, "../storage");
const CONFIG_FILE = path.join(STORAGE_DIR, "fab_accounts_mapping.json");

// How to find the two balances in the FAB workbook. This is CONFIG, not code,
// and deliberately so: the wallet mapping next door carries three generations of
// cell addresses because someone inserting a row silently shifted every
// reference. A layout change here is fixed by editing a JSON file, not by
// shipping a release.
//
// There are no fixed cell addresses any more, and there must not be. The
// workbook has one tab per month and one row per day, so the cell that holds
// today's balance moves every single day. What is stable, and therefore what is
// configured, is the SHAPE: which columns hold what, where the data starts, and
// how the monthly tab is named.
//
// The real sheet, verified by opening it:
//
//         A                 B                       C
//   1   zz                Balance in USD
//   2   Date              Skylinks Capital LLC    Skylink holdings
//   3   09/01/2026        0                       0
//   4   09/02/2026        ...                     ...
//
// Column B is FAB Operating, column C is FAB Holding -- confirmed by the sheet
// owner, and worth stating here because the two column headers do not contain
// the words "operating" or "holding" and nothing in the sheet would catch a swap.
export const DEFAULT_FAB_ACCOUNTS_MAPPING = {
  // {MON} is the uppercase three-letter month, {YYYY} the four-digit year, so
  // September 2026 resolves to "SEP 2026".
  tabNamePattern: "{MON} {YYYY}",
  // Rows 1 and 2 are headers; the first day of the month is on row 3. This is
  // only the place the SEARCH starts -- the row that is actually read is found
  // by matching the date in column A, never by counting from here.
  firstDataRow: 3,
  columns: { date: "A", fabOperating: "B", fabHolding: "C" },
};

// A1 column letters only. Three letters is past column ZZ and far beyond
// anything this workbook will ever have, so a longer "letter" is a typo, not a
// column.
const COLUMN_PATTERN = /^[A-Za-z]{1,3}$/;

function readColumn(raw, fallback) {
  return typeof raw === "string" && COLUMN_PATTERN.test(raw.trim()) ? raw.trim().toUpperCase() : fallback;
}

export function loadFabAccountsMapping() {
  const defaults = DEFAULT_FAB_ACCOUNTS_MAPPING;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    // Absent or corrupt. The defaults describe the sheet as it stands today, and
    // a wrong shape fails loudly at read time rather than returning a plausible
    // number from the wrong place.
    raw = null;
  }

  // A pattern missing either placeholder would resolve every month to the same
  // tab -- the read would keep succeeding while quietly returning last month's
  // numbers. Reject it and use the default rather than accept a silent wrong
  // answer.
  const patternCandidate = typeof raw?.tabNamePattern === "string" ? raw.tabNamePattern.trim() : "";
  const tabNamePattern =
    patternCandidate.includes("{MON}") && patternCandidate.includes("{YYYY}")
      ? patternCandidate
      : defaults.tabNamePattern;

  const rowCandidate = Number(raw?.firstDataRow);
  const firstDataRow =
    Number.isInteger(rowCandidate) && rowCandidate >= 1 ? rowCandidate : defaults.firstDataRow;

  const columns = {
    date: readColumn(raw?.columns?.date, defaults.columns.date),
    fabOperating: readColumn(raw?.columns?.fabOperating, defaults.columns.fabOperating),
    fabHolding: readColumn(raw?.columns?.fabHolding, defaults.columns.fabHolding),
  };

  return { tabNamePattern, firstDataRow, columns };
}
