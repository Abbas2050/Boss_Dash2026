import { authHeaders } from "@/lib/auth";

// The FAB workbook's two balances. Unwrapped through a function that THROWS
// naming the endpoint and what arrived, because the Revenue Share page was built
// against a wrongly-assumed shape and rendered an empty table with no error at
// all. A loud failure on deploy day beats a silent blank.
//
// This sheet does not exist yet, so the shape below is a contract, not an
// observation. Expect to correct it the first time the real sheet is connected.

const ENDPOINT = "/api/fab-accounts";

export interface FabAccounts {
  fabOperating: number | null;
  fabHolding: number | null;
  fetchedAt: string;
  source: { spreadsheetId: string; tab: string; cells: Record<string, string> };
}

function describeShape(payload: unknown): string {
  if (payload === null || payload === undefined) return String(payload);
  if (Array.isArray(payload)) return `array of ${payload.length}`;
  if (typeof payload !== "object") return typeof payload;
  const keys = Object.keys(payload as object);
  return keys.length ? `object with keys: ${keys.join(", ")}` : "object with no keys";
}

// null means the server read the cell and could not make a number of it. A number
// is a balance, zero included. Anything else is a contract breach.
function balance(payload: Record<string, unknown>, key: keyof FabAccounts): number | null {
  const raw = payload[key];
  if (raw === null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  throw new Error(
    `${ENDPOINT} returned an unusable ${key}: ${JSON.stringify(raw)}. Expected a finite number or null. Received ${describeShape(payload)}.`,
  );
}

export function unwrapFabAccounts(payload: unknown): FabAccounts {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${ENDPOINT} returned ${describeShape(payload)}; expected an object.`);
  }
  const obj = payload as Record<string, unknown>;
  if (obj.ok === false) {
    throw new Error(`${ENDPOINT} reported a failure: ${String(obj.error || "unknown")} ${String(obj.message || "")}`.trim());
  }
  if (!("fabOperating" in obj) || !("fabHolding" in obj)) {
    throw new Error(
      `${ENDPOINT} is missing fabOperating and/or fabHolding. Received ${describeShape(payload)}.`,
    );
  }
  const source = (obj.source || {}) as FabAccounts["source"];
  return {
    fabOperating: balance(obj, "fabOperating"),
    fabHolding: balance(obj, "fabHolding"),
    fetchedAt: String(obj.fetchedAt || ""),
    source: {
      spreadsheetId: String(source.spreadsheetId || ""),
      tab: String(source.tab || ""),
      cells: (source.cells || {}) as Record<string, string>,
    },
  };
}

export async function fetchFabAccounts(): Promise<FabAccounts> {
  const response = await fetch(`${ENDPOINT}?_ts=${Date.now()}`, {
    cache: "no-store",
    headers: { "cache-control": "no-cache", ...authHeaders() },
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // A 200 carrying an SPA fallback page surfaces as "Unexpected token '<'"
    // without this, and never names the endpoint.
    throw new Error(`${ENDPOINT} returned HTTP ${response.status} with a body that is not JSON.`);
  }
  return unwrapFabAccounts(payload);
}
