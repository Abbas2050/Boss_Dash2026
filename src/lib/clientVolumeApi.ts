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
