import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.join(__dirname, '../storage');
const CONFIG_FILE = path.join(STORAGE_DIR, 'google_sheets_wallet_mapping.json');

export const DEFAULT_GOOGLE_SHEETS_FIELDS = [
  { key: 'match2pay', label: 'Match2Pay', cell: 'K9', required: true },
  { key: 'deusXpay', label: 'DeusXpay', cell: 'K10', required: true },
  { key: 'openPayed', label: 'OpenPayed', cell: 'K11', required: true },
  { key: 'goldSouq', label: 'Gold Souq', cell: 'K13', required: true },
  { key: 'fabAed', label: 'FAB AED', cell: 'K16', required: true },
  { key: 'fabUsd', label: 'FAB USD', cell: 'K17', required: true },
  { key: 'mbme', label: 'MBME', cell: 'K18', required: true },
  { key: 'bankReceivable', label: 'To be received in BANK', cell: 'K20', required: true },
  { key: 'cryptoReceivable', label: 'To be received in CRYPTO', cell: 'K21', required: true },
  { key: 'toBeDepositedIntoLPsK20', label: 'To be deposited into LPs (Bank - USD)', cell: 'K22', required: true },
  { key: 'toBeDepositedIntoLPsK21', label: 'To be deposited into LPs (Crypto USDT)', cell: 'K23', required: true },
  { key: 'netAllCurrentBalance', label: 'Net all Current Balance', cell: 'J26', required: true },
  { key: 'netBalanceAfterExpectedFunds', label: 'Net Balance after expected funds', cell: 'J28', required: true },
  { key: 'differenceBetweenActualAndExpected', label: 'Difference between actual and expected', cell: 'J30', required: true },
  { key: 'creditByLPs', label: 'Credit by LPs', cell: 'J31', required: true },
  // The one field that is not required, and the reason `required` now carries
  // weight past the settings screen. Every other field above is a TERM of a
  // balance: if its cell is blank we have lost a number and cannot say what the
  // total is. This one is a subtractive ADJUSTMENT, so a blank cell is a real
  // and complete answer -- nothing was deducted from Gold Souq today -- and
  // reporting it as unreadable is what made the Excess Funds section say it
  // "could not read Gold Souq" while the Closing Balance Report card directly
  // above it showed the balance perfectly. Read `required: false` as "blank
  // means zero"; further adjustment cells belong here with the same flag.
  //
  // The key still says J31 because it is persisted in
  // storage/google_sheets_wallet_mapping.json and drives the legacy-cell
  // migration below; the cell it actually reads is the `cell` property, and
  // anything that shows a user which cell this came from must read it there --
  // hence a label with no row number baked into it.
  { key: 'goldSouqDeductionJ31', label: 'Gold Souq Deduction', cell: 'J32', required: false },
];

// Cells as they stood before the 'Own Bit New' row was inserted at row 6.
const PRE_OWNBIT_NEW_FIELDS = [
  { key: 'match2pay', cell: 'K8' },
  { key: 'deusXpay', cell: 'K9' },
  { key: 'openPayed', cell: 'K10' },
  { key: 'goldSouq', cell: 'K12' },
  { key: 'fabAed', cell: 'K15' },
  { key: 'fabUsd', cell: 'K16' },
  { key: 'mbme', cell: 'K17' },
  { key: 'bankReceivable', cell: 'K19' },
  { key: 'cryptoReceivable', cell: 'K20' },
  { key: 'toBeDepositedIntoLPsK20', cell: 'K21' },
  { key: 'toBeDepositedIntoLPsK21', cell: 'K22' },
  { key: 'netAllCurrentBalance', cell: 'J25' },
  { key: 'netBalanceAfterExpectedFunds', cell: 'J27' },
  { key: 'differenceBetweenActualAndExpected', cell: 'J29' },
  { key: 'creditByLPs', cell: 'J30' },
  { key: 'goldSouqDeductionJ31', cell: 'J31' },
];

const LEGACY_GOOGLE_SHEETS_FIELDS = [
  { key: 'match2pay', cell: 'K8' },
  { key: 'deusXpay', cell: 'K9' },
  { key: 'openPayed', cell: 'K10' },
  { key: 'goldSouq', cell: 'K11' },
  { key: 'fabAed', cell: 'K14' },
  { key: 'fabUsd', cell: 'K15' },
  { key: 'mbme', cell: 'K16' },
  { key: 'bankReceivable', cell: 'K18' },
  { key: 'cryptoReceivable', cell: 'K19' },
  { key: 'toBeDepositedIntoLPsK20', cell: 'K20' },
  { key: 'toBeDepositedIntoLPsK21', cell: 'K21' },
  { key: 'netAllCurrentBalance', cell: 'J24' },
  { key: 'netBalanceAfterExpectedFunds', cell: 'J26' },
  { key: 'differenceBetweenActualAndExpected', cell: 'J28' },
  { key: 'creditByLPs', cell: 'J29' },
  { key: 'goldSouqDeductionJ31', cell: 'J30' },
];

// Every superseded cell per key, newest generation first. A saved config is
// migrated forward when its cell matches ANY of them, so a sheet that skipped a
// generation still lands on the current mapping instead of silently reading the
// wrong row.
const LEGACY_CELLS_BY_KEY = (() => {
  const byKey = {};
  for (const generation of [PRE_OWNBIT_NEW_FIELDS, LEGACY_GOOGLE_SHEETS_FIELDS]) {
    for (const field of generation) {
      (byKey[field.key] ||= []).push(String(field.cell).toUpperCase());
    }
  }
  return byKey;
})();

const DEFAULT_FIELD_BY_KEY = Object.fromEntries(
  DEFAULT_GOOGLE_SHEETS_FIELDS.map((field) => [field.key, field])
);

function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function normalizeCell(cell) {
  return String(cell || '').trim().toUpperCase();
}

function normalizeKey(key) {
  return String(key || '').trim();
}

function normalizeLabel(label, key) {
  const txt = String(label || '').trim();
  return txt || key;
}

function validateField(field) {
  const key = normalizeKey(field?.key);
  const label = normalizeLabel(field?.label, key);
  const cell = normalizeCell(field?.cell);
  const required = Boolean(field?.required);

  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid field key '${key}'. Use letters, numbers and underscore only.`);
  }
  if (!/^[A-Z]{1,3}[1-9][0-9]*$/.test(cell)) {
    throw new Error(`Invalid cell '${cell}' for field '${key}'. Use format like K18 or J24.`);
  }
  return { key, label, cell, required };
}

function mergeWithRequiredDefaults(fields) {
  const byKey = new Map();

  for (const rawField of fields || []) {
    const f = validateField(rawField);
    byKey.set(f.key, { ...f, builtIn: false });
  }

  for (const def of DEFAULT_GOOGLE_SHEETS_FIELDS) {
    if (!byKey.has(def.key)) {
      byKey.set(def.key, { ...def, builtIn: true });
    } else {
      const existing = byKey.get(def.key);
      const legacyCells = LEGACY_CELLS_BY_KEY[def.key] || [];
      const normalizedExistingCell = normalizeCell(existing?.cell);
      const shouldMigrateLegacyCell = legacyCells.includes(normalizedExistingCell);

      byKey.set(def.key, {
        ...existing,
        cell: shouldMigrateLegacyCell ? DEFAULT_FIELD_BY_KEY[def.key].cell : existing.cell,
        // The default wins over whatever was saved, because `required` is no
        // longer a cosmetic badge -- it decides whether a blank cell is a lost
        // number or a real zero. A config written before the Gold Souq
        // deduction became optional carries required:true for it, and honouring
        // that would keep the old veto alive on every machine that ever saved.
        required: DEFAULT_FIELD_BY_KEY[def.key].required,
        // Separate from `required` on purpose: this one is "part of the
        // standard mapping", which is what protects a row from being deleted or
        // reduced to a custom field in the settings screen. Tying that
        // protection to `required` would have unprotected the deduction row the
        // moment blank-means-zero was expressed as required:false.
        builtIn: true,
      });
    }
  }

  const defaultOrder = DEFAULT_GOOGLE_SHEETS_FIELDS.map((f) => f.key);
  const defaultsFirst = [];
  for (const defKey of defaultOrder) {
    defaultsFirst.push(byKey.get(defKey));
    byKey.delete(defKey);
  }

  const custom = Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
  return [...defaultsFirst, ...custom];
}

export function getDefaultGoogleSheetsMappingConfig() {
  return {
    fields: DEFAULT_GOOGLE_SHEETS_FIELDS.map((f) => ({ ...f, builtIn: true })),
    updatedAt: null,
    source: 'default',
  };
}

export function loadGoogleSheetsMappingConfig() {
  const fallback = getDefaultGoogleSheetsMappingConfig();

  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return fallback;
    }

    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const fields = mergeWithRequiredDefaults(parsed?.fields || []);

    return {
      fields,
      updatedAt: parsed?.updatedAt || null,
      source: 'file',
    };
  } catch (error) {
    console.error('[GoogleSheetsMappingConfig] Failed to load config:', error?.message || error);
    return fallback;
  }
}

export function saveGoogleSheetsMappingConfig(nextConfig) {
  const fields = mergeWithRequiredDefaults(nextConfig?.fields || []);
  const payload = {
    fields,
    updatedAt: new Date().toISOString(),
  };

  ensureStorageDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(payload, null, 2));

  return {
    ...payload,
    source: 'file',
  };
}

export function resetGoogleSheetsMappingConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }
  } catch (error) {
    console.error('[GoogleSheetsMappingConfig] Failed to reset config:', error?.message || error);
  }
  return getDefaultGoogleSheetsMappingConfig();
}
