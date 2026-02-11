// Dubai Time Utilities
// Dubai is UTC+4 (Gulf Standard Time)

/**
 * Get current date in Dubai timezone
 */
export function getDubaiDate(): Date {
  const now = new Date();
  const dubaiOffset = 4 * 60; // Dubai is UTC+4 (in minutes)
  const localOffset = now.getTimezoneOffset(); // Local timezone offset in minutes
  const diffMinutes = dubaiOffset + localOffset;
  
  // Adjust to Dubai time
  return new Date(now.getTime() + diffMinutes * 60000);
}

/**
 * Get start of day (00:00:00) in Dubai timezone
 */
export function getDubaiDayStart(date?: Date): Date {
  const d = date ? new Date(date) : getDubaiDate();
  const dubaiDate = convertToDubaiTime(d);
  dubaiDate.setHours(0, 0, 0, 0);
  return dubaiDate;
}

/**
 * Get end of day (23:59:59) in Dubai timezone
 */
export function getDubaiDayEnd(date?: Date): Date {
  const d = date ? new Date(date) : getDubaiDate();
  const dubaiDate = convertToDubaiTime(d);
  dubaiDate.setHours(23, 59, 59, 999);
  return dubaiDate;
}

/**
 * Convert any date to Dubai timezone
 */
export function convertToDubaiTime(date: Date): Date {
  const dubaiOffset = 4 * 60; // Dubai is UTC+4 (in minutes)
  const localOffset = date.getTimezoneOffset(); // Local timezone offset in minutes
  const diffMinutes = dubaiOffset + localOffset;
  
  return new Date(date.getTime() + diffMinutes * 60000);
}

/**
 * Format date for API (YYYY-MM-DD HH:MM:SS) in Dubai time
 */
export function formatDateTimeForAPI(date: Date, isEndOfDay: boolean = false): string {
  const dubaiTime = convertToDubaiTime(date);
  
  if (isEndOfDay) {
    dubaiTime.setHours(23, 59, 59);
  } else {
    dubaiTime.setHours(0, 0, 0);
  }
  
  const year = dubaiTime.getFullYear();
  const month = String(dubaiTime.getMonth() + 1).padStart(2, '0');
  const day = String(dubaiTime.getDate()).padStart(2, '0');
  const hours = String(dubaiTime.getHours()).padStart(2, '0');
  const minutes = String(dubaiTime.getMinutes()).padStart(2, '0');
  const seconds = String(dubaiTime.getSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
