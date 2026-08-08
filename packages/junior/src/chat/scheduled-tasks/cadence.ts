/** Calendar arithmetic for core-owned scheduled tasks. */
import type {
  ScheduledLocalTime,
  ScheduledTask,
  ScheduledTaskRecurrence,
} from "./types";

export interface ZonedDateTimeParts {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  weekday: number;
  year: number;
}

interface LocalDate {
  day: number;
  month: number;
  year: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  const existing = FORMATTERS.get(timezone);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  FORMATTERS.set(timezone, formatter);
  return formatter;
}

function normalizeHour(hour: number): number {
  return hour === 24 ? 0 : hour;
}

function getLocalDateWeekday(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function getWeekStart(date: LocalDate): LocalDate {
  return addDays(date, -((getLocalDateWeekday(date) + 6) % 7));
}

/** Resolve a UTC timestamp into calendar parts for a named time zone. */
export function getZonedDateTimeParts(
  timestampMs: number,
  timezone: string,
): ZonedDateTimeParts {
  const parts = getFormatter(timezone).formatToParts(new Date(timestampMs));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(values.get("year"));
  const month = Number(values.get("month"));
  const day = Number(values.get("day"));
  const hour = normalizeHour(Number(values.get("hour")));
  const minute = Number(values.get("minute"));
  const second = Number(values.get("second"));

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: getLocalDateWeekday({ year, month, day }),
  };
}

function getTimeZoneOffsetMs(timestampMs: number, timezone: string): number {
  const parts = getZonedDateTimeParts(timestampMs, timezone);
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) - timestampMs
  );
}

function localDateTimeToTimestampMs(args: {
  date: LocalDate;
  time: ScheduledLocalTime;
  timezone: string;
}): number | undefined {
  const localAsUtcMs = Date.UTC(
    args.date.year,
    args.date.month - 1,
    args.date.day,
    args.time.hour,
    args.time.minute,
    0,
  );
  const offsets = new Set<number>();
  for (const probeDeltaMs of [
    -36 * 60 * 60 * 1000,
    -12 * 60 * 60 * 1000,
    0,
    12 * 60 * 60 * 1000,
    36 * 60 * 60 * 1000,
  ]) {
    offsets.add(
      getTimeZoneOffsetMs(localAsUtcMs + probeDeltaMs, args.timezone),
    );
  }

  const matches = [...offsets]
    .map((offsetMs) => localAsUtcMs - offsetMs)
    .filter((timestampMs) => {
      const parts = getZonedDateTimeParts(timestampMs, args.timezone);
      return (
        parts.year === args.date.year &&
        parts.month === args.date.month &&
        parts.day === args.date.day &&
        parts.hour === args.time.hour &&
        parts.minute === args.time.minute
      );
    });

  if (matches.length === 0) {
    return undefined;
  }
  return Math.min(...matches);
}

/** Resolve local time, rejecting DST gaps and choosing the earlier instant in a fold. */
export function resolveLocalScheduleAtMs(args: {
  date: string;
  time: ScheduledLocalTime;
  timezone: string;
}): number | undefined {
  const date = parseLocalDate(args.date);
  if (!date) {
    return undefined;
  }
  return localDateTimeToTimestampMs({
    date,
    time: args.time,
    timezone: args.timezone,
  });
}

function daysBetween(left: LocalDate, right: LocalDate): number {
  return Math.floor(
    (Date.UTC(right.year, right.month - 1, right.day) -
      Date.UTC(left.year, left.month - 1, left.day)) /
      (24 * 60 * 60 * 1000),
  );
}

function weeklyRecurrenceMatchesDate(
  date: LocalDate,
  start: LocalDate,
  recurrence: ScheduledTaskRecurrence,
): boolean {
  if (compareDate(date, start) < 0) {
    return false;
  }
  return (
    normalizeWeekdays(recurrence.weekdays).includes(
      getLocalDateWeekday(date),
    ) &&
    Math.floor(daysBetween(getWeekStart(start), getWeekStart(date)) / 7) %
      recurrence.interval ===
      0
  );
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

function findNextRunAtMs(args: {
  afterMs: number;
  recurrence: ScheduledTaskRecurrence;
  searchFrom: LocalDate;
  timezone: string;
}): number | undefined {
  const start = parseLocalDate(args.recurrence.startDate);
  const interval = args.recurrence.interval;
  if (!start || !Number.isInteger(interval) || interval <= 0) {
    return undefined;
  }

  const searchFrom =
    compareDate(args.searchFrom, start) < 0 ? start : args.searchFrom;
  if (args.recurrence.frequency === "daily") {
    const offsetDays = daysBetween(start, searchFrom);
    let candidateDate = addDays(
      start,
      Math.ceil(offsetDays / interval) * interval,
    );
    const gregorianCycleDays = 146_097;
    const candidateCount =
      gregorianCycleDays / greatestCommonDivisor(gregorianCycleDays, interval);
    for (let attempts = 0; attempts < candidateCount; attempts += 1) {
      const candidate = buildCandidate({
        date: candidateDate,
        recurrence: args.recurrence,
        timezone: args.timezone,
      });
      if (candidate !== undefined && candidate > args.afterMs) {
        return candidate;
      }
      candidateDate = addDays(candidateDate, interval);
    }
    return undefined;
  }

  if (args.recurrence.frequency === "weekly") {
    if (normalizeWeekdays(args.recurrence.weekdays).length === 0) {
      return undefined;
    }
    let candidateDate = searchFrom;
    const gregorianCycleDays = 146_097;
    const cadenceDays = interval * 7;
    const searchDays =
      (gregorianCycleDays * cadenceDays) /
      greatestCommonDivisor(gregorianCycleDays, cadenceDays);
    for (let attempts = 0; attempts < searchDays; attempts += 1) {
      if (weeklyRecurrenceMatchesDate(candidateDate, start, args.recurrence)) {
        const candidate = buildCandidate({
          date: candidateDate,
          recurrence: args.recurrence,
          timezone: args.timezone,
        });
        if (candidate !== undefined && candidate > args.afterMs) {
          return candidate;
        }
      }
      candidateDate = addDays(candidateDate, 1);
    }
    return undefined;
  }

  if (
    args.recurrence.frequency === "monthly" ||
    args.recurrence.frequency === "quarterly"
  ) {
    const startMonth = start.year * 12 + start.month - 1;
    const searchMonth = searchFrom.year * 12 + searchFrom.month - 1;
    const intervalMonths =
      args.recurrence.frequency === "quarterly" ? interval * 3 : interval;
    let candidateMonth =
      startMonth +
      Math.ceil((searchMonth - startMonth) / intervalMonths) * intervalMonths;
    const gregorianCycleMonths = 4_800;
    const candidateCount =
      gregorianCycleMonths /
      greatestCommonDivisor(gregorianCycleMonths, intervalMonths);
    for (let attempts = 0; attempts < candidateCount; attempts += 1) {
      const candidateDate = {
        year: Math.floor(candidateMonth / 12),
        month: (candidateMonth % 12) + 1,
        day: args.recurrence.dayOfMonth ?? 0,
      };
      if (compareDate(candidateDate, searchFrom) >= 0) {
        const candidate = buildCandidate({
          date: candidateDate,
          recurrence: args.recurrence,
          timezone: args.timezone,
        });
        if (candidate !== undefined && candidate > args.afterMs) {
          return candidate;
        }
      }
      candidateMonth += intervalMonths;
    }
    return undefined;
  }

  let candidateYear =
    start.year +
    Math.ceil((searchFrom.year - start.year) / interval) * interval;
  const candidateCount = 400 / greatestCommonDivisor(400, interval);
  for (let attempts = 0; attempts < candidateCount; attempts += 1) {
    const candidateDate = {
      year: candidateYear,
      month: args.recurrence.month ?? 0,
      day: args.recurrence.dayOfMonth ?? 0,
    };
    if (compareDate(candidateDate, searchFrom) >= 0) {
      const candidate = buildCandidate({
        date: candidateDate,
        recurrence: args.recurrence,
        timezone: args.timezone,
      });
      if (candidate !== undefined && candidate > args.afterMs) {
        return candidate;
      }
    }
    candidateYear += interval;
  }
  return undefined;
}

/** Compute the first recurring calendar occurrence strictly after a timestamp. */
export function getFirstRunAtMs(args: {
  afterMs: number;
  recurrence: ScheduledTaskRecurrence;
  timezone: string;
}): number | undefined {
  return findNextRunAtMs({
    ...args,
    searchFrom: getLocalDate(args.afterMs, args.timezone),
  });
}

function compareDate(left: LocalDate, right: LocalDate): number {
  return (
    Date.UTC(left.year, left.month - 1, left.day) -
    Date.UTC(right.year, right.month - 1, right.day)
  );
}

function addDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseLocalDate(value: string): LocalDate | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return undefined;
  }

  return { year, month, day };
}

function getLocalDate(timestampMs: number, timezone: string): LocalDate {
  const parts = getZonedDateTimeParts(timestampMs, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function normalizeWeekdays(values: number[] | undefined): number[] {
  return [
    ...new Set((values ?? []).filter((value) => value >= 0 && value <= 6)),
  ].sort((a, b) => a - b);
}

function buildCandidate(args: {
  date: LocalDate;
  recurrence: ScheduledTaskRecurrence;
  timezone: string;
}): number | undefined {
  return localDateTimeToTimestampMs({
    date: args.date,
    time: args.recurrence.time,
    timezone: args.timezone,
  });
}

/** Return the next fire time after a completed run, when the task recurs. */
export function getNextRunAtMs(
  task: ScheduledTask,
  scheduledForMs: number,
  afterMs: number = scheduledForMs,
): number | undefined {
  if (task.schedule.kind !== "recurring") {
    return undefined;
  }

  const recurrence = task.schedule.recurrence;
  if (
    !recurrence ||
    !Number.isFinite(recurrence.interval) ||
    recurrence.interval <= 0
  ) {
    return undefined;
  }

  const timezone = task.schedule.timezone;
  const afterDate = getLocalDate(afterMs, timezone);
  const nextScheduledDate = addDays(getLocalDate(scheduledForMs, timezone), 1);
  return findNextRunAtMs({
    afterMs,
    recurrence,
    searchFrom:
      compareDate(afterDate, nextScheduledDate) < 0
        ? nextScheduledDate
        : afterDate,
    timezone,
  });
}
