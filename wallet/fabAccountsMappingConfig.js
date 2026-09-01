import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.join(__dirname, "../storage");
const CONFIG_FILE = path.join(STORAGE_DIR, "fab_accounts_mapping.json");

// Where the two balances sit in the FAB workbook. This is CONFIG, not code, and
// deliberately so: the existing wallet mapping carries three generations of cell
// addresses because someone inserting a row silently shifted every reference. A
// row inserted here is fixed by editing a JSON file, not by shipping a release.
//
// These defaults are placeholders until the real sheet is supplied. A wrong cell
// fails loudly -- readFabAccounts throws naming the sheet and cell -- rather than
// returning a plausible number from the wrong place.
export const DEFAULT_FAB_ACCOUNTS_MAPPING = {
  tab: "Sheet1",
  cells: { fabOperating: "B2", fabHolding: "B3" },
};

export function loadFabAccountsMapping() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const tab = typeof raw?.tab === "string" && raw.tab.trim() ? raw.tab.trim() : DEFAULT_FAB_ACCOUNTS_MAPPING.tab;
    const cells = { ...DEFAULT_FAB_ACCOUNTS_MAPPING.cells };
    for (const key of Object.keys(cells)) {
      const cell = raw?.cells?.[key];
      if (typeof cell === "string" && /^[A-Z]+[0-9]+$/i.test(cell.trim())) cells[key] = cell.trim().toUpperCase();
    }
    return { tab, cells };
  } catch {
    // Absent or corrupt: the defaults are as good a guess as anything, and the
    // read will fail loudly if they are wrong.
    return { tab: DEFAULT_FAB_ACCOUNTS_MAPPING.tab, cells: { ...DEFAULT_FAB_ACCOUNTS_MAPPING.cells } };
  }
}

export function saveFabAccountsMapping(next) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const current = loadFabAccountsMapping();
  const merged = {
    tab: typeof next?.tab === "string" && next.tab.trim() ? next.tab.trim() : current.tab,
    cells: { ...current.cells },
  };
  for (const key of Object.keys(merged.cells)) {
    const cell = next?.cells?.[key];
    if (typeof cell === "string" && /^[A-Z]+[0-9]+$/i.test(cell.trim())) merged.cells[key] = cell.trim().toUpperCase();
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

export function resetFabAccountsMapping() {
  try {
    fs.unlinkSync(CONFIG_FILE);
  } catch {
    // Already absent; loadFabAccountsMapping falls back to the defaults.
  }
  return loadFabAccountsMapping();
}
