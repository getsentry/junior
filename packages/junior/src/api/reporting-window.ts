/** Shared UTC day/hour windows for dashboard activity series. */

export const HOUR_MS = 60 * 60 * 1_000;
export const DAY_MS = 24 * HOUR_MS;
export const WINDOW_HOURS = 24;

/** Start of the UTC calendar day containing `valueMs`. */
export function startOfUtcDay(valueMs: number): Date {
  const date = new Date(valueMs);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

/** Start of the UTC hour containing `valueMs`. */
export function startOfUtcHour(valueMs: number): Date {
  const date = new Date(valueMs);
  date.setUTCMinutes(0, 0, 0);
  return date;
}

/** UTC day key `YYYY-MM-DD`. */
export function utcDayKey(value: Date | number): string {
  const date = typeof value === "number" ? new Date(value) : value;
  return date.toISOString().slice(0, 10);
}

/** UTC hour key `YYYY-MM-DDTHH`. */
export function utcHourKey(value: Date | number): string {
  const date = typeof value === "number" ? new Date(value) : value;
  return date.toISOString().slice(0, 13);
}

/** Inclusive trailing UTC day window ending on today's UTC day. */
export function trailingUtcDayWindow(nowMs: number, dayCount: number) {
  const end = startOfUtcDay(nowMs);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (dayCount - 1));
  return { end, start };
}

/** Inclusive trailing UTC hour window ending on the current UTC hour. */
export function trailingUtcHourWindow(
  nowMs: number,
  hourCount = WINDOW_HOURS,
) {
  const end = startOfUtcHour(nowMs);
  const start = new Date(end.getTime() - (hourCount - 1) * HOUR_MS);
  return { end, start };
}

/** Fill a fixed UTC day window from a sparse map. */
export function fillUtcDays<T>(args: {
  count: number;
  empty(date: string): T;
  nowMs: number;
  rows: Map<string, T>;
}): T[] {
  const { end, start } = trailingUtcDayWindow(args.nowMs, args.count);
  const items: T[] = [];
  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = utcDayKey(cursor);
    items.push(args.rows.get(date) ?? args.empty(date));
  }
  return items;
}

/** Fill a fixed UTC hour window from a sparse map. */
export function fillUtcHours<T>(args: {
  count?: number;
  empty(date: string): T;
  nowMs: number;
  rows: Map<string, T>;
}): T[] {
  const hourCount = args.count ?? WINDOW_HOURS;
  const { end, start } = trailingUtcHourWindow(args.nowMs, hourCount);
  const items: T[] = [];
  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setTime(cursor.getTime() + HOUR_MS)
  ) {
    const date = utcHourKey(cursor);
    items.push(args.rows.get(date) ?? args.empty(date));
  }
  return items;
}

/** PostgreSQL TO_CHAR pattern for UTC day keys. */
export const PG_UTC_DAY = "YYYY-MM-DD";

/** PostgreSQL TO_CHAR pattern for UTC hour keys. */
export const PG_UTC_HOUR = 'YYYY-MM-DD"T"HH24';
