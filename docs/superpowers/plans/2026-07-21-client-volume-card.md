# Client Volume Chart + Values (Dealing LP Card) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Live Equity Trend (date)" chart in the homepage **Dealing (LP)** card with a stacked Equity-vs-CFD client-volume chart, two new value tiles, and its own Today/Yest/Week/Month range presets.

**Architecture:** A new focused lib (`src/lib/clientVolumeApi.ts`) owns the `/ClientVolume/Run` fetch plus a **pure, unit-tested** `resolveVolumeRange()` for the presets. The Dealing (LP) card consumes it: two tiles read the totals, a stacked recharts area reads the daily series, and single-day ranges fall back to a stacked bar so they don't render blank.

**Tech Stack:** React + TypeScript + Vite, recharts (already a dependency), vitest.

**Spec:** `docs/superpowers/specs/2026-07-21-client-volume-card-design.md`

## Global Constraints

- **"Equity Volume" = `totalStocksLots`** (cyan). **"CFD Volume" = `totalCfdLots`** (violet). This is the only split the endpoint provides.
- Endpoint: `GET ${BACKEND_BASE_URL}/ClientVolume/Run?from=YYYY-MM-DD&to=YYYY-MM-DD&group=*`.
- `BACKEND_BASE_URL` is defined **exactly** as in `src/pages/departments/dealing/ClientVolumeTab.tsx:15`:
  ```ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const BACKEND_BASE_URL = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com").replace(/\/+$/, "");
  ```
- Preset dates are formatted **`YYYY-MM-DD` in local time** (the endpoint's dates are MT5 server-local). Never use `toISOString()` for these — it shifts to UTC and can land on the wrong day.
- **Week starts Monday** (Sunday belongs to the week that began the preceding Monday). **Month** = 1st → today.
- **Default preset on first render: `today`** — which is a single-day range, so the card opens on the stacked-bar fallback.
- **Single-day fallback is required:** when `byDate.length < 2`, render a stacked `BarChart` instead of the `AreaChart` (a one-point area draws nothing).
- Only the **LP branch** (`isLpMode`) of `AccountsDepartment` changes. The Accounts card (`!isLpMode`) and `DealingDepartment.tsx` (Dealing (Client)) must be untouched.
- `ClientVolumeTab.tsx` is **not** refactored (decided). Its inline fetch stays.
- Colours: Equity `hsl(186 100% 50%)` (cyan), CFD `#a78bfa` (violet) — used consistently across tiles, chart and legend.
- `npx tsc --noEmit -p tsconfig.json` must stay clean after every task.
- Branch `feat/client-volume-card` off `main`. Never push (Abbas pushes).

## Existing code anchors

- `src/components/dashboard/AccountsDepartment.tsx`
  - line **10**: `import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';`
  - line **166**: `const isLpMode = mode === 'lp';`
  - props include `refreshKey: number` (and `fromDate`/`toDate`, which this block deliberately ignores)
  - line **568**: `{isLpMode ? (` — start of the LP-only branch
  - lines **644–681**: the block to replace — wrapper `<div className="rounded-lg border border-primary/20 bg-gradient-to-br from-primary/10 via-background to-success/10 p-2">`, the `Live Equity Trend (date)` label, the `h-32` chart, and the 3-dot legend, ending `</div>` at 681
  - line **682**: `<div className="space-y-1 pt-2 border-t border-border/30">` — the LP MetricRows that must remain
  - Existing tile idiom to match: `<div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">` with `<div className="text-xs text-muted-foreground mb-1">Label</div>` and `<div className="font-mono font-semibold text-sm sm:text-base">value</div>`
  - Existing legend idiom to match: `<span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-green-500" />LP WD</span>`
- `lpEquityChartSeries` (line ~543) feeds only the old chart. **Leave it defined** — other code may reference it; removing it is out of scope.

---

## Task 1: `clientVolumeApi.ts` — pure range presets

**Files:** Create `src/lib/clientVolumeApi.ts`; Test `src/lib/clientVolumeApi.test.ts`.

**Interfaces:**
- Produces: `type VolumeRangePreset = "today" | "yesterday" | "week" | "month"`; `resolveVolumeRange(preset: VolumeRangePreset, now: Date): { from: string; to: string }`; `formatLocalYmd(d: Date): string`.

- [ ] **Step 1: Write the failing test** — `src/lib/clientVolumeApi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveVolumeRange, formatLocalYmd } from "./clientVolumeApi";

// 2026-07-21 is a Tuesday. Constructed via local-time args on purpose.
const tue = new Date(2026, 6, 21, 15, 30, 0);

describe("formatLocalYmd", () => {
  it("formats local date parts, not UTC", () => {
    expect(formatLocalYmd(new Date(2026, 6, 21, 23, 59, 0))).toBe("2026-07-21");
    expect(formatLocalYmd(new Date(2026, 0, 5, 0, 30, 0))).toBe("2026-01-05");
  });
});

describe("resolveVolumeRange", () => {
  it("today = same day both ends", () => {
    expect(resolveVolumeRange("today", tue)).toEqual({ from: "2026-07-21", to: "2026-07-21" });
  });

  it("yesterday = previous day both ends", () => {
    expect(resolveVolumeRange("yesterday", tue)).toEqual({ from: "2026-07-20", to: "2026-07-20" });
  });

  it("week = Monday of the current week through today", () => {
    expect(resolveVolumeRange("week", tue)).toEqual({ from: "2026-07-20", to: "2026-07-21" });
  });

  it("week on a Sunday uses the Monday that began that week", () => {
    const sun = new Date(2026, 6, 26, 9, 0, 0); // Sunday 26 Jul 2026
    expect(resolveVolumeRange("week", sun)).toEqual({ from: "2026-07-20", to: "2026-07-26" });
  });

  it("week on a Monday starts that same day", () => {
    const mon = new Date(2026, 6, 20, 9, 0, 0);
    expect(resolveVolumeRange("week", mon)).toEqual({ from: "2026-07-20", to: "2026-07-20" });
  });

  it("month = 1st through today", () => {
    expect(resolveVolumeRange("month", tue)).toEqual({ from: "2026-07-01", to: "2026-07-21" });
  });

  it("month on the 1st is a single day", () => {
    const first = new Date(2026, 6, 1, 8, 0, 0);
    expect(resolveVolumeRange("month", first)).toEqual({ from: "2026-07-01", to: "2026-07-01" });
  });

  it("yesterday crosses a month boundary", () => {
    const firstOfAug = new Date(2026, 7, 1, 8, 0, 0);
    expect(resolveVolumeRange("yesterday", firstOfAug)).toEqual({ from: "2026-07-31", to: "2026-07-31" });
  });

  it("yesterday crosses a year boundary", () => {
    const newYear = new Date(2027, 0, 1, 8, 0, 0);
    expect(resolveVolumeRange("yesterday", newYear)).toEqual({ from: "2026-12-31", to: "2026-12-31" });
  });

  it("week crosses a month boundary", () => {
    const thu = new Date(2026, 7, 6, 9, 0, 0); // Thu 6 Aug 2026; that week's Monday is 3 Aug
    expect(resolveVolumeRange("week", thu)).toEqual({ from: "2026-08-03", to: "2026-08-06" });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing)

Run: `npx vitest run src/lib/clientVolumeApi.test.ts`

- [ ] **Step 3: Create `src/lib/clientVolumeApi.ts`** with the range logic only:

```ts
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
```

- [ ] **Step 4: Run it — expect PASS (11 tests)**

Run: `npx vitest run src/lib/clientVolumeApi.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/clientVolumeApi.ts src/lib/clientVolumeApi.test.ts
git commit -m "feat(client-volume): pure range-preset resolver for the LP card"
```

---

## Task 2: `clientVolumeApi.ts` — fetch + normalization

**Files:** Modify `src/lib/clientVolumeApi.ts`; Modify `src/lib/clientVolumeApi.test.ts`.

**Interfaces:**
- Consumes: `formatLocalYmd`, `VolumeRangePreset` (Task 1).
- Produces: `type ClientVolumeDay = { date: string; lots: number; stocksLots: number; cfdLots: number }`; `type ClientVolumeSummary = { fromDate: string; toDate: string; totalLots: number; totalStocksLots: number; totalCfdLots: number; byDate: ClientVolumeDay[] }`; `fetchClientVolume(params: { from: string; to: string; group?: string; signal?: AbortSignal }): Promise<ClientVolumeSummary>`.

- [ ] **Step 1: Append the failing tests** to `src/lib/clientVolumeApi.test.ts`:

```ts
import { afterEach, vi } from "vitest";
import { fetchClientVolume } from "./clientVolumeApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe("fetchClientVolume", () => {
  it("requests the documented URL with group=* by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ byDate: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchClientVolume({ from: "2026-07-01", to: "2026-07-21" });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/ClientVolume/Run?");
    expect(url).toContain("from=2026-07-01");
    expect(url).toContain("to=2026-07-21");
    expect(url).toContain("group=*");
  });

  it("coerces numeric strings and fills missing fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({
      fromDate: "2026-07-01",
      toDate: "2026-07-21",
      totalLots: "84767.16",
      totalStocksLots: "72321",
      totalCfdLots: null,
      byDate: [{ date: "2026-07-20", lots: "483.5", stocksLots: null, cfdLots: "483.5" }],
    })));

    const r = await fetchClientVolume({ from: "2026-07-01", to: "2026-07-21" });

    expect(r.totalLots).toBe(84767.16);
    expect(r.totalStocksLots).toBe(72321);
    expect(r.totalCfdLots).toBe(0);
    expect(r.byDate).toEqual([{ date: "2026-07-20", lots: 483.5, stocksLots: 0, cfdLots: 483.5 }]);
  });

  it("returns an empty byDate when the field is missing or not an array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ totalLots: 0 })));
    const r = await fetchClientVolume({ from: "2026-07-01", to: "2026-07-21" });
    expect(r.byDate).toEqual([]);
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }));
    await expect(fetchClientVolume({ from: "2026-07-01", to: "2026-07-21" })).rejects.toThrow(/502/);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`fetchClientVolume` not exported)

Run: `npx vitest run src/lib/clientVolumeApi.test.ts`

- [ ] **Step 3: Append the implementation** to `src/lib/clientVolumeApi.ts`:

```ts
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
```

- [ ] **Step 4: Run it — expect PASS (15 tests total in the file)**

Run: `npx vitest run src/lib/clientVolumeApi.test.ts`
Then: `npx tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/clientVolumeApi.ts src/lib/clientVolumeApi.test.ts
git commit -m "feat(client-volume): fetchClientVolume with defensive normalization"
```

---

## Task 3: Swap the block into the Dealing (LP) card

**Files:** Modify `src/components/dashboard/AccountsDepartment.tsx`.

**Interfaces:**
- Consumes: `fetchClientVolume`, `resolveVolumeRange`, types `ClientVolumeSummary` / `VolumeRangePreset` (Tasks 1–2).

- [ ] **Step 1: Extend the recharts import** — replace line 10 exactly:

```ts
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
```

- [ ] **Step 2: Add the lib import** near the other `@/lib` imports:

```ts
import { fetchClientVolume, resolveVolumeRange, type ClientVolumeSummary, type VolumeRangePreset } from '@/lib/clientVolumeApi';
```

- [ ] **Step 3: Add state + fetch effect** immediately after `const isLpMode = mode === 'lp';` (line 166):

```tsx
  const [volumePreset, setVolumePreset] = useState<VolumeRangePreset>('today');
  const [volume, setVolume] = useState<ClientVolumeSummary | null>(null);
  const [volumeLoading, setVolumeLoading] = useState(false);
  const [volumeError, setVolumeError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLpMode) return;
    const controller = new AbortController();
    const { from, to } = resolveVolumeRange(volumePreset, new Date());
    setVolumeLoading(true);
    setVolumeError(null);
    fetchClientVolume({ from, to, signal: controller.signal })
      .then((data) => setVolume(data))
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setVolumeError(err instanceof Error ? err.message : 'Failed to load client volume');
      })
      .finally(() => {
        if (!controller.signal.aborted) setVolumeLoading(false);
      });
    return () => controller.abort();
  }, [isLpMode, volumePreset, refreshKey]);

  const volumeSeries = volume?.byDate ?? [];
  const volumeIsSingleDay = volumeSeries.length < 2;
  const volumeHasData = volumeSeries.length > 0;
  const fmtLots = (n: number) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDayLabel = (value: string) => {
    const parts = String(value || '').split('-');
    if (parts.length !== 3) return String(value || '');
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  };
  const VOLUME_PRESETS: Array<{ key: VolumeRangePreset; label: string; title: string }> = [
    { key: 'today', label: 'Today', title: 'Today' },
    { key: 'yesterday', label: 'Yest', title: 'Yesterday' },
    { key: 'week', label: 'Week', title: 'This week (from Monday)' },
    { key: 'month', label: 'Month', title: 'This month (from the 1st)' },
  ];
```

(`useState`/`useEffect` are already imported in this file.)

- [ ] **Step 4: Replace lines 644–681** — the entire old block, from `<div className="rounded-lg border border-primary/20 bg-gradient-to-br from-primary/10 via-background to-success/10 p-2">` through the legend's closing `</div>` — with:

```tsx
          <div className="rounded-lg border border-primary/20 bg-gradient-to-br from-primary/10 via-background to-success/10 p-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">Client Volume</div>
              <div className="flex items-center gap-1">
                {VOLUME_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    title={p.title}
                    aria-pressed={volumePreset === p.key}
                    onClick={() => setVolumePreset(p.key)}
                    className={`rounded px-1.5 py-0.5 text-[10px] transition focus:outline-none focus-visible:ring-1 focus-visible:ring-primary ${
                      volumePreset === p.key
                        ? 'bg-primary/20 text-primary font-semibold'
                        : 'text-muted-foreground hover:text-foreground hover:bg-primary/10'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-2 grid grid-cols-2 gap-2">
              <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/20">
                <div className="text-xs text-muted-foreground mb-1">Equity Volume</div>
                <div className="font-mono font-semibold text-sm sm:text-base text-cyan-600 dark:text-cyan-300">
                  {volume ? fmtLots(volume.totalStocksLots) : '—'}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-violet-500/10 border border-violet-500/20">
                <div className="text-xs text-muted-foreground mb-1">CFD Volume</div>
                <div className="font-mono font-semibold text-sm sm:text-base text-violet-600 dark:text-violet-300">
                  {volume ? fmtLots(volume.totalCfdLots) : '—'}
                </div>
              </div>
            </div>

            {volumeError && (
              <div className="mb-1 text-[11px] text-warning/90">{volumeError}</div>
            )}

            <div className="h-32">
              {!volumeHasData ? (
                <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
                  {volumeLoading ? 'Loading…' : 'No client volume in this range.'}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  {volumeIsSingleDay ? (
                    <BarChart data={volumeSeries}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.16} />
                      <XAxis dataKey="date" tickFormatter={fmtDayLabel} tick={{ fontSize: 10 }} />
                      <YAxis hide domain={[0, 'auto']} />
                      <Tooltip
                        cursor={{ fill: 'rgba(148,163,184,0.12)' }}
                        contentStyle={{
                          background: 'rgba(15,23,42,0.92)',
                          border: '1px solid rgba(148,163,184,0.35)',
                          borderRadius: 8,
                          color: '#e2e8f0',
                          fontSize: 11,
                        }}
                        labelStyle={{ color: '#cbd5e1' }}
                        formatter={(value: number, name: string) => [
                          `${fmtLots(Number(value))} lots`,
                          name === 'stocksLots' ? 'Equity' : 'CFD',
                        ]}
                        labelFormatter={(label) => fmtDayLabel(String(label))}
                      />
                      <Bar dataKey="stocksLots" stackId="vol" fill="hsl(186 100% 50%)" radius={[0, 0, 0, 0]} maxBarSize={54} />
                      <Bar dataKey="cfdLots" stackId="vol" fill="#a78bfa" radius={[3, 3, 0, 0]} maxBarSize={54} />
                    </BarChart>
                  ) : (
                    <AreaChart data={volumeSeries}>
                      <defs>
                        <linearGradient id="cvEquityGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="hsl(186 100% 50%)" stopOpacity={0.42} />
                          <stop offset="100%" stopColor="hsl(186 100% 50%)" stopOpacity={0.04} />
                        </linearGradient>
                        <linearGradient id="cvCfdGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.42} />
                          <stop offset="100%" stopColor="#a78bfa" stopOpacity={0.04} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.16} />
                      <XAxis dataKey="date" tickFormatter={fmtDayLabel} tick={{ fontSize: 10 }} minTickGap={22} />
                      <YAxis hide domain={[0, 'auto']} />
                      <Tooltip
                        contentStyle={{
                          background: 'rgba(15,23,42,0.92)',
                          border: '1px solid rgba(148,163,184,0.35)',
                          borderRadius: 8,
                          color: '#e2e8f0',
                          fontSize: 11,
                        }}
                        labelStyle={{ color: '#cbd5e1' }}
                        formatter={(value: number, name: string) => [
                          `${fmtLots(Number(value))} lots`,
                          name === 'stocksLots' ? 'Equity' : 'CFD',
                        ]}
                        labelFormatter={(label) => fmtDayLabel(String(label))}
                      />
                      <Area
                        type="monotone"
                        dataKey="stocksLots"
                        stackId="vol"
                        stroke="hsl(186 100% 50%)"
                        strokeWidth={2.2}
                        fill="url(#cvEquityGradient)"
                        isAnimationActive
                      />
                      <Area
                        type="monotone"
                        dataKey="cfdLots"
                        stackId="vol"
                        stroke="#a78bfa"
                        strokeWidth={2.2}
                        fill="url(#cvCfdGradient)"
                        isAnimationActive
                      />
                    </AreaChart>
                  )}
                </ResponsiveContainer>
              )}
            </div>

            <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-cyan-400" />Equity</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-violet-400" />CFD</span>
              {volumeLoading && volumeHasData && <span className="text-muted-foreground/70">updating…</span>}
            </div>
          </div>
```

- [ ] **Step 5: Verify the surrounding structure is intact**

Run: `grep -n "Live Equity Trend\|Client Volume\|space-y-1 pt-2 border-t border-border/30" src/components/dashboard/AccountsDepartment.tsx | head`
Expected: **no** `Live Equity Trend` match; one `Client Volume` match; the LP MetricRows wrapper still present immediately after the new block.

- [ ] **Step 6: Typecheck + full suite**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
```
Expected: tsc clean; all tests pass (the new `clientVolumeApi.test.ts` included).

- [ ] **Step 7: Commit**

```bash
git add src/components/dashboard/AccountsDepartment.tsx
git commit -m "feat(dealing-lp): Equity vs CFD client volume chart, values and range presets"
```

---

## Task 4: Verify in the running app

- [ ] **Step 1: Build + start**

```bash
npm run build
npm run local:restart
```
Expected: build succeeds; frontend `200` on `http://localhost:8080`, backend `200` on `http://localhost:3001/health`.

- [ ] **Step 2: Manual checks** on `http://localhost:8080` → **Dealing (LP)** card:
  - The block is titled **Client Volume**; **Today** is the active pill on load.
  - **Equity Volume** and **CFD Volume** tiles show numbers (either may legitimately be `0.00`).
  - **Today / Yest** render a single stacked bar; **Week / Month** render the stacked area.
  - Hovering shows the day plus Equity and CFD lots.
  - The **Accounts** card and the **Dealing (Client)** card are unchanged, and the LP MetricRows (Total Uncovered, LP Accounts, …) still sit below the new block.

- [ ] **Step 3: Sanity-check the numbers against the source tab**

Open `http://localhost:8080/departments/dealing?tab=client-volume`, set the same date range as a preset, and confirm Stocks/CFD lots match the card's two tiles.

- [ ] **Step 4: Stop**

```bash
npm run local:stop
```

---

## Self-review notes (applied)

- **Spec coverage:** placement in the LP-only branch replacing lines 644–681 (T3) ✓; `clientVolumeApi.ts` with `fetchClientVolume` + pure `resolveVolumeRange` (T1, T2) ✓; presets Today/Yest/Week/Month with Monday-start weeks and month-from-1st (T1) ✓; default `today` (T3 Step 3) ✓; two tiles reading `totalStocksLots`/`totalCfdLots` in the card's tile idiom (T3) ✓; stacked area with gradients + dark tooltip + legend (T3) ✓; single-day bar fallback (T3, `volumeIsSingleDay`) ✓; loading / empty / error states (T3) ✓; abortable refetch on preset change and `refreshKey` (T3) ✓; colours cyan/violet used across tiles, chart and legend ✓; unit tests for Sunday, 1st-of-month, month and year boundaries, and fetch normalization (T1, T2) ✓; `ClientVolumeTab` untouched ✓.
- **Type consistency:** `VolumeRangePreset`, `ClientVolumeSummary`, `ClientVolumeDay`, `fetchClientVolume`, `resolveVolumeRange`, `formatLocalYmd` are defined in Tasks 1–2 and consumed with identical names in Task 3. Chart `dataKey`s (`stocksLots`, `cfdLots`, `date`) match `ClientVolumeDay` exactly.
- **Ordering:** Task 1 provides `formatLocalYmd` before Task 2's fetch uses the same module; Task 3 imports only what Tasks 1–2 export. Task 2's tests import `vi`/`afterEach` in addition to Task 1's imports — appended to the same file, so both import lines coexist.
- **Deliberate non-change:** `lpEquityChartSeries` stays defined even though its only consumer is removed, to keep the diff contained; if `tsc` flags it as unused, leave it (it is a `const`, not an unused import, so it will not error).
