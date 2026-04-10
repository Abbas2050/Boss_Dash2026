import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.join(__dirname, '../storage');
const CONFIG_FILE = path.join(STORAGE_DIR, 'google_sheets_wallet_mapping.json');

export const DEFAULT_GOOGLE_SHEETS_FIELDS = [
  { key: 'match2pay', label: 'Match2Pay', cell: 'K8', required: true },
  { key: 'deusXpay', label: 'DeusXpay', cell: 'K9', required: true },
  { key: 'openPayed', label: 'OpenPayed', cell: 'K10', required: true },
  { key: 'goldSouq', label: 'Gold Souq', cell: 'K12', required: true },
  { key: 'fabAed', label: 'FAB AED', cell: 'K15', required: true },
  { key: 'fabUsd', label: 'FAB USD', cell: 'K16', required: true },
  { key: 'mbme', label: 'MBME', cell: 'K17', required: true },
  { key: 'bankReceivable', label: 'To be received in BANK', cell: 'K19', required: true },
  { key: 'cryptoReceivable', label: 'To be received in CRYPTO', cell: 'K20', required: true },
  { key: 'toBeDepositedIntoLPsK20', label: 'To be deposited into LPs (Bank - USD)', cell: 'K21', required: true },
  { key: 'toBeDepositedIntoLPsK21', label: 'To be deposited into LPs (Crypto USDT)', cell: 'K22', required: true },
  { key: 'netAllCurrentBalance', label: 'Net all Current Balance', cell: 'J25', required: true },
  { key: 'netBalanceAfterExpectedFunds', label: 'Net Balance after expected funds', cell: 'J27', required: true },
  { key: 'differenceBetweenActualAndExpected', label: 'Difference between actual and expected', cell: 'J29', required: true },
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
];

const LEGACY_REQUIRED_CELL_BY_KEY = Object.fromEntries(
  LEGACY_GOOGLE_SHEETS_FIELDS.map((field) => [field.key, field.cell])
);

const DEFAULT_REQUIRED_FIELD_BY_KEY = Object.fromEntries(
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
    byKey.set(f.key, f);
  }

  for (const req of DEFAULT_GOOGLE_SHEETS_FIELDS) {
    if (!byKey.has(req.key)) {
      byKey.set(req.key, { ...req });
    } else {
      const existing = byKey.get(req.key);
      const legacyCell = LEGACY_REQUIRED_CELL_BY_KEY[req.key];
      const normalizedExistingCell = normalizeCell(existing?.cell);
      const shouldMigrateLegacyCell = legacyCell && normalizedExistingCell === normalizeCell(legacyCell);

      byKey.set(req.key, {
        ...existing,
        cell: shouldMigrateLegacyCell ? DEFAULT_REQUIRED_FIELD_BY_KEY[req.key].cell : existing.cell,
        required: true,
      });
    }
  }

  const requiredOrder = DEFAULT_GOOGLE_SHEETS_FIELDS.map((f) => f.key);
  const requiredFirst = [];
  for (const reqKey of requiredOrder) {
    requiredFirst.push(byKey.get(reqKey));
    byKey.delete(reqKey);
  }

  const custom = Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
  return [...requiredFirst, ...custom];
}

export function getDefaultGoogleSheetsMappingConfig() {
  return {
    fields: DEFAULT_GOOGLE_SHEETS_FIELDS.map((f) => ({ ...f })),
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
