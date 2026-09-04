// The window each report cadence covers, for LABELLING A BUTTON BEFORE IT IS
// PRESSED. This is a deliberate mirror of previousFullDayUtc /
// previousFullWeekUtc / previousFullMonthUtc in reports/reportShared.js.
//
// WHY A MIRROR RATHER THAN AN IMPORT: reportShared.js is server-side ESM that
// pulls in chartjs-node-canvas, node-cron and fs/promises the moment it loads,
// so it cannot enter the browser bundle.
//
// WHY DUPLICATING IS SAFE HERE: nothing is computed from these dates. The
// request carries a cadence, the SERVER resolves the real window, and the
// response echoes the fromYmd/toYmd that were actually used -- which is what
// the panel then reports. A drift between this file and the server would
// mislabel a button, never a sent email.

export type ReportCadence = "daily" | "weekly" | "monthly";

export const REPORT_CADENCES: readonly ReportCadence[] = ["daily", "weekly", "monthly"];

export type ReportPeriod = { fromYmd: string; toYmd: string };

const ymd = (date: Date): string => date.toISOString().slice(0, 10);

// Yesterday, whole. The day in progress is excluded: a figure that is still
// moving is not a report.
function previousFullDayUtc(now: Date): ReportPeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - 1);
  return { fromYmd: ymd(start), toYmd: ymd(start) };
}

// The last complete Saturday-to-Friday week; the week in progress is excluded.
function previousFullWeekUtc(now: Date): ReportPeriod {
  const daysSinceSaturday = (now.getUTCDay() + 1) % 7;
  const currentSaturday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  currentSaturday.setUTCDate(currentSaturday.getUTCDate() - daysSinceSaturday);

  const start = new Date(currentSaturday);
  start.setUTCDate(start.getUTCDate() - 7);
  const end = new Date(currentSaturday);
  end.setUTCDate(end.getUTCDate() - 1);

  return { fromYmd: ymd(start), toYmd: ymd(end) };
}

// Day 0 of a month is the last day of the month before it, so the end needs no
// table of month lengths and gets February right in a leap year.
function previousFullMonthUtc(now: Date): ReportPeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { fromYmd: ymd(start), toYmd: ymd(end) };
}

export function previousFullPeriodUtc(cadence: ReportCadence, now: Date = new Date()): ReportPeriod {
  if (cadence === "daily") return previousFullDayUtc(now);
  if (cadence === "monthly") return previousFullMonthUtc(now);
  return previousFullWeekUtc(now);
}

// "covers 2026-09-03" for a single day, "covers 2026-09-01 to 2026-09-30" for a
// range. Collapsing the equal case matters: a daily test send otherwise reads
// "covers 2026-09-03 to 2026-09-03", which invites the reader to look for the
// difference between the two dates.
export function describePeriod({ fromYmd, toYmd }: ReportPeriod): string {
  return fromYmd === toYmd ? `covers ${fromYmd}` : `covers ${fromYmd} to ${toYmd}`;
}
