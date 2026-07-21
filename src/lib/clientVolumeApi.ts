export type VolumeRangePreset = "today" | "yesterday" | "week" | "month";

/**
 * Format a Date as YYYY-MM-DD using LOCAL parts.
 * toISOString() would shift to UTC and can land on the wrong day — the
 * ClientVolume endpoint expects MT5 server-local dates.
 */
export function formatLocalYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Presets are inclusive on both ends. Week starts Monday. */
export function resolveVolumeRange(preset: VolumeRangePreset, now: Date): { from: string; to: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (preset === "yesterday") {
    const y = new Date(today);
    y.setDate(y.getDate() - 1);
    const ymd = formatLocalYmd(y);
    return { from: ymd, to: ymd };
  }

  if (preset === "week") {
    // getDay(): 0=Sun..6=Sat. Monday-start, so Sunday is 6 days after its Monday.
    const offset = (today.getDay() + 6) % 7;
    const monday = new Date(today);
    monday.setDate(monday.getDate() - offset);
    return { from: formatLocalYmd(monday), to: formatLocalYmd(today) };
  }

  if (preset === "month") {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: formatLocalYmd(first), to: formatLocalYmd(today) };
  }

  const ymd = formatLocalYmd(today);
  return { from: ymd, to: ymd };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BACKEND_BASE_URL = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com").replace(/\/+$/, "");

export type ClientVolumeDay = {
  date: string;
  lots: number;
  stocksLots: number;
  cfdLots: number;
};

export type ClientVolumeSummary = {
  fromDate: string;
  toDate: string;
  totalLots: number;
  totalStocksLots: number;
  totalCfdLots: number;
  byDate: ClientVolumeDay[];
};

const num = (v: unknown) => Number(v) || 0;

export async function fetchClientVolume(params: {
  from: string;
  to: string;
  group?: string;
  signal?: AbortSignal;
}): Promise<ClientVolumeSummary> {
  const query = new URLSearchParams({
    from: params.from,
    to: params.to,
    group: params.group ?? "*",
  });

  const resp = await fetch(`${BACKEND_BASE_URL}/ClientVolume/Run?${query.toString()}`, { signal: params.signal });
  if (!resp.ok) throw new Error(`ClientVolume/Run failed (${resp.status})`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = await resp.json();
  const rows = Array.isArray(raw?.byDate) ? raw.byDate : [];

  return {
    fromDate: String(raw?.fromDate || params.from),
    toDate: String(raw?.toDate || params.to),
    totalLots: num(raw?.totalLots),
    totalStocksLots: num(raw?.totalStocksLots),
    totalCfdLots: num(raw?.totalCfdLots),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    byDate: rows.map((r: any) => ({
      date: String(r?.date || ""),
      lots: num(r?.lots),
      stocksLots: num(r?.stocksLots),
      cfdLots: num(r?.cfdLots),
    })),
  };
}
