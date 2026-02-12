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
