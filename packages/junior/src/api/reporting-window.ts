/** Shared UTC day/hour/six-hour windows for dashboard activity series. */

export const HOUR_MS = 60 * 60 * 1_000;
export const SIX_HOUR_MS = 6 * HOUR_MS;
export const DAY_MS = 24 * HOUR_MS;
/** Trailing hours kept for 24h charts. */
export const WINDOW_HOURS = 24;
/**
 * Trailing hours kept so 7d charts can roll hours into 6h buckets.
 * 7 days * 24 hours = 168 inclusive hour points ending on the current hour.
 */
export const WINDOW_SEVEN_DAY_HOURS = 7 * 24;
/** Trailing 6h buckets for 7d charts (7 * 4). */
export const WINDOW_SIX_HOURS = 7 * 4;

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

/** Start of the UTC 6-hour bucket containing `valueMs` (00/06/12/18). */
export function startOfUtcSixHour(valueMs: number): Date {
  const date = startOfUtcHour(valueMs);
  date.setUTCHours(Math.floor(date.getUTCHours() / 6) * 6, 0, 0, 0);
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

/** UTC 6-hour bucket key `YYYY-MM-DDTHH` at 00/06/12/18. */
export function utcSixHourKey(value: Date | number): string {
  return utcHourKey(startOfUtcSixHour(
    typeof value === "number" ? value : value.getTime(),
  ));
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

/** Inclusive trailing UTC 6-hour window ending on the current 6h bucket. */
export function trailingUtcSixHourWindow(
  nowMs: number,
  bucketCount = WINDOW_SIX_HOURS,
) {
  const end = startOfUtcSixHour(nowMs);
  const start = new Date(end.getTime() - (bucketCount - 1) * SIX_HOUR_MS);
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

/** Fill a fixed UTC 6-hour window from a map of known rows. */
export function fillUtcSixHours<T>(args: {
  count?: number;
  empty(date: string): T;
  nowMs: number;
  rows: Map<string, T>;
}): T[] {
  const bucketCount = args.count ?? WINDOW_SIX_HOURS;
  const { end, start } = trailingUtcSixHourWindow(args.nowMs, bucketCount);
  const items: T[] = [];
  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setTime(cursor.getTime() + SIX_HOUR_MS)
  ) {
    const date = utcSixHourKey(cursor);
    items.push(args.rows.get(date) ?? args.empty(date));
  }
  return items;
}

/**
 * Sum hour rows into trailing 6-hour buckets.
 * Adds number fields. Keeps other fields from the first row in the bucket.
 * Sets `date` to the 6-hour bucket key.
 */
export function sumUtcHoursIntoSixHours<T extends { date: string }>(args: {
  empty(date: string): T;
  hours: readonly T[];
  nowMs: number;
  count?: number;
}): T[] {
  const bucketCount = args.count ?? WINDOW_SIX_HOURS;
  const bySix = new Map<string, T>();
  for (const hour of args.hours) {
    const key = utcSixHourKey(Date.parse(`${hour.date}:00:00.000Z`));
    const current = bySix.get(key) ?? args.empty(key);
    const next = { ...current, date: key } as T;
    for (const [field, value] of Object.entries(hour)) {
      if (field === "date") continue;
      if (typeof value === "number") {
        const prior = (next as Record<string, unknown>)[field];
        (next as Record<string, unknown>)[field] =
          (typeof prior === "number" ? prior : 0) + value;
      }
    }
    bySix.set(key, next);
  }
  return fillUtcSixHours({
    count: bucketCount,
    empty: args.empty,
    nowMs: args.nowMs,
    rows: bySix,
  });
}

/** PostgreSQL TO_CHAR pattern for UTC day keys. */
export const PG_UTC_DAY = "YYYY-MM-DD";

/** PostgreSQL TO_CHAR pattern for UTC hour keys. */
export const PG_UTC_HOUR = 'YYYY-MM-DD"T"HH24';
