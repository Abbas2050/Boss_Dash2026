// Dubai Time Utilities
// Dubai is UTC+4 (Gulf Standard Time)

const DUBAI_OFFSET_MINUTES = 4 * 60;

/**
 * Get current date in Dubai timezone
 */
export function getDubaiDate(): Date {
  const now = new Date();
  const dubaiOffset = DUBAI_OFFSET_MINUTES; // Dubai is UTC+4 (in minutes)
  const localOffset = now.getTimezoneOffset(); // Local timezone offset in minutes
  const diffMinutes = dubaiOffset + localOffset;
  
  // Adjust to Dubai time
  return new Date(now.getTime() + diffMinutes * 60000);
}

/**
 * Get start of day (00:00:00) in Dubai timezone.
 * If no date provided, uses current Dubai date.
 * Expects input to already be Dubai-adjusted (from getDubaiDate or quick filters).
 */
export function getDubaiDayStart(date?: Date): Date {
  const d = date ? new Date(date) : getDubaiDate();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get end of day (23:59:59) in Dubai timezone.
 * If no date provided, uses current Dubai date.
 * Expects input to already be Dubai-adjusted (from getDubaiDate or quick filters).
 */
export function getDubaiDayEnd(date?: Date): Date {
  const d = date ? new Date(date) : getDubaiDate();
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * Convert any date to Dubai timezone
 */
export function convertToDubaiTime(date: Date): Date {
  const dubaiOffset = DUBAI_OFFSET_MINUTES; // Dubai is UTC+4 (in minutes)
  const localOffset = date.getTimezoneOffset(); // Local timezone offset in minutes
  const diffMinutes = dubaiOffset + localOffset;
  
  return new Date(date.getTime() + diffMinutes * 60000);
}

/**
 * Convert a Dubai-local Date to UTC.
 * Useful for MT5 endpoints that expect UTC timestamps.
 */
export function convertDubaiToUtc(date: Date): Date {
  return new Date(date.getTime() - DUBAI_OFFSET_MINUTES * 60000);
}

/**
 * Get start of day in Dubai, converted to UTC.
 */
export function getDubaiDayStartUtc(date?: Date): Date {
  const d = getDubaiDayStart(date);
  return convertDubaiToUtc(d);
}

/**
 * Get end of day in Dubai, converted to UTC.
 */
export function getDubaiDayEndUtc(date?: Date): Date {
  const d = getDubaiDayEnd(date);
  return convertDubaiToUtc(d);
}

/**
 * Format date for API (YYYY-MM-DD HH:MM:SS).
 * Expects input to already be Dubai-adjusted. Does NOT re-convert.
 */
export function formatDateTimeForAPI(date: Date, isEndOfDay: boolean = false): string {
  const d = new Date(date);

  if (isEndOfDay) {
    d.setHours(23, 59, 59);
  } else {
    d.setHours(0, 0, 0);
  }

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// ── Rendering an instant in Dubai wall-clock time, regardless of the viewer's
// machine timezone ──────────────────────────────────────────────────────────
//
// The functions above compute a Dubai-shifted Date by adding the difference
// between Dubai's fixed UTC+4 offset and the machine's own offset, then read
// it back with plain getHours()/getFullYear() etc. -- correct for building
// UTC day-boundaries to send to an API, but not what a render helper needs.
//
// These use Intl's `timeZone` option instead, which asks the runtime to
// format a UTC instant AS IF viewed from Asia/Dubai directly. That is the
// only way to make what a viewer reads on screen independent of where their
// browser or the server happens to be -- this dashboard is read on a phone
// that isn't necessarily in Dubai, but the business runs on Dubai time, and
// every report scheduler in reports/ already targets Asia/Dubai.
//
// This also fixes a specific bug: `wallet/walletMonitor.js` used to strip the
// trailing "Z" off its ISO timestamp before sending it, producing a
// zone-less string like "2026-09-01 21:22:35". JavaScript's `Date`
// constructor parses a zone-less date-time as LOCAL time, not UTC, so that
// UTC instant got rendered as if it were already Dubai time -- shifting the
// displayed clock by the viewer's UTC offset and sometimes landing on the
// wrong calendar day. walletMonitor.js now sends a real "...Z" instant; these
// helpers are how the frontend turns that instant into Dubai wall-clock text.

export const DUBAI_TIME_ZONE = 'Asia/Dubai';

function parseInstant(input: string | number | Date | null | undefined): Date | null {
  if (input === null || input === undefined || input === '') return null;
  const dt = input instanceof Date ? input : new Date(input);
  return Number.isFinite(dt.getTime()) ? dt : null;
}

/**
 * "Sep 02, 01:22:35" -- Dubai calendar date/time for an instant, used for the
 * report-updated freshness stamps.
 */
export function formatDubaiInstant(input: string | number | Date | null | undefined): string {
  const dt = parseInstant(input);
  if (!dt) return '—';
  return dt.toLocaleString('en-US', {
    timeZone: DUBAI_TIME_ZONE,
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * "01:22" -- Dubai clock only (no date), used for the Equity/FAB-sheet
 * freshness stamps that sit alongside the wallet stamp.
 */
export function formatDubaiClock(input: string | number | Date | null | undefined): string {
  const dt = parseInstant(input);
  if (!dt) return '—';
  return dt.toLocaleTimeString('en-US', {
    timeZone: DUBAI_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * "2026-09-02" -- the Dubai CALENDAR date an instant falls on. Not
 * `.toISOString().slice(0, 10)`, which is the UTC calendar date and can
 * disagree with Dubai's near local midnight (UTC+4 means Dubai's date rolls
 * over 4 hours before UTC's does).
 */
export function dubaiCalendarDate(input: string | number | Date | null | undefined): string | null {
  const dt = parseInstant(input);
  if (!dt) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DUBAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(dt);
  const byType: Record<string, string> = {};
  for (const part of parts) byType[part.type] = part.value;
  if (!byType.year || !byType.month || !byType.day) return null;
  return `${byType.year}-${byType.month}-${byType.day}`;
}
