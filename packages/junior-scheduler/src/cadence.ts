import type {
  ScheduledCalendarFrequency,
  ScheduledLocalTime,
  ScheduledTask,
  ScheduledTaskRecurrence,
} from "./types";

/** Parse an ISO timestamp into a finite Unix timestamp in milliseconds. */
export function parseScheduleTimestamp(value: string): number | undefined {
  const trimmed = value.trim();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      trimmed,
    );
  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return undefined;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

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
}): number {
  const localAsUtcMs = Date.UTC(
    args.date.year,
    args.date.month - 1,
    args.date.day,
    args.time.hour,
    args.time.minute,
    0,
  );
  let timestampMs =
    localAsUtcMs - getTimeZoneOffsetMs(localAsUtcMs, args.timezone);

  for (let index = 0; index < 3; index += 1) {
    const next = localAsUtcMs - getTimeZoneOffsetMs(timestampMs, args.timezone);
    if (next === timestampMs) {
      break;
    }
    timestampMs = next;
  }

  return timestampMs;
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

function formatLocalDate(date: LocalDate): string {
  return [
    String(date.year).padStart(4, "0"),
    String(date.month).padStart(2, "0"),
    String(date.day).padStart(2, "0"),
  ].join("-");
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
}): number {
  return localDateTimeToTimestampMs({
    date: args.date,
    time: args.recurrence.time,
    timezone: args.timezone,
  });
}

function getDailyNextRunAtMs(args: {
  afterMs: number;
  recurrence: ScheduledTaskRecurrence;
  scheduledForMs: number;
  timezone: string;
}): number | undefined {
  const start = parseLocalDate(args.recurrence.startDate);
  if (!start) {
    return undefined;
  }

  let candidateDate = addDays(
    getLocalDate(args.scheduledForMs, args.timezone),
    args.recurrence.interval,
  );
  if (compareDate(candidateDate, start) < 0) {
    candidateDate = start;
  }

  let candidate = buildCandidate({
    date: candidateDate,
    recurrence: args.recurrence,
    timezone: args.timezone,
  });
  while (candidate <= args.afterMs) {
    candidateDate = addDays(candidateDate, args.recurrence.interval);
    candidate = buildCandidate({
      date: candidateDate,
      recurrence: args.recurrence,
      timezone: args.timezone,
    });
  }
  return candidate;
}

function getWeeklyNextRunAtMs(args: {
  afterMs: number;
  recurrence: ScheduledTaskRecurrence;
  scheduledForMs: number;
  timezone: string;
}): number | undefined {
  const start = parseLocalDate(args.recurrence.startDate);
  if (!start) {
    return undefined;
  }

  const weekdays = normalizeWeekdays(args.recurrence.weekdays);
  if (weekdays.length === 0) {
    return undefined;
  }

  let candidateDate = addDays(
    getLocalDate(args.scheduledForMs, args.timezone),
    1,
  );
  for (let attempts = 0; attempts < 3660; attempts += 1) {
    const weeksSinceStart = Math.floor(
      (Date.UTC(
        candidateDate.year,
        candidateDate.month - 1,
        candidateDate.day,
      ) -
        Date.UTC(start.year, start.month - 1, start.day)) /
        (7 * 24 * 60 * 60 * 1000),
    );
    const isInCycle =
      weeksSinceStart >= 0 && weeksSinceStart % args.recurrence.interval === 0;
    if (isInCycle && weekdays.includes(getLocalDateWeekday(candidateDate))) {
      const candidate = buildCandidate({
        date: candidateDate,
        recurrence: args.recurrence,
        timezone: args.timezone,
      });
      if (candidate > args.afterMs) {
        return candidate;
      }
    }
    candidateDate = addDays(candidateDate, 1);
  }

  return undefined;
}

function getMonthlyNextRunAtMs(args: {
  afterMs: number;
  recurrence: ScheduledTaskRecurrence;
  scheduledForMs: number;
  timezone: string;
}): number | undefined {
  const start = parseLocalDate(args.recurrence.startDate);
  const dayOfMonth = args.recurrence.dayOfMonth;
  if (!start || !dayOfMonth) {
    return undefined;
  }

  const scheduledDate = getLocalDate(args.scheduledForMs, args.timezone);
  let monthIndex = scheduledDate.year * 12 + scheduledDate.month - 1;
  const startMonthIndex = start.year * 12 + start.month - 1;

  for (let attempts = 0; attempts < 1200; attempts += 1) {
    monthIndex += args.recurrence.interval;
    if (monthIndex < startMonthIndex) {
      monthIndex = startMonthIndex;
    }
    const year = Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    if (dayOfMonth > daysInMonth(year, month)) {
      continue;
    }
    const candidate = buildCandidate({
      date: { year, month, day: dayOfMonth },
      recurrence: args.recurrence,
      timezone: args.timezone,
    });
    if (candidate > args.afterMs) {
      return candidate;
    }
  }

  return undefined;
}

function getYearlyNextRunAtMs(args: {
  afterMs: number;
  recurrence: ScheduledTaskRecurrence;
  scheduledForMs: number;
  timezone: string;
}): number | undefined {
  const start = parseLocalDate(args.recurrence.startDate);
  const month = args.recurrence.month;
  const dayOfMonth = args.recurrence.dayOfMonth;
  if (!start || !month || !dayOfMonth) {
    return undefined;
  }

  const scheduledDate = getLocalDate(args.scheduledForMs, args.timezone);
  let year = scheduledDate.year;

  for (let attempts = 0; attempts < 100; attempts += 1) {
    year += args.recurrence.interval;
    if (year < start.year) {
      year = start.year;
    }
    if (dayOfMonth > daysInMonth(year, month)) {
      continue;
    }
    const candidate = buildCandidate({
      date: { year, month, day: dayOfMonth },
      recurrence: args.recurrence,
      timezone: args.timezone,
    });
    if (candidate > args.afterMs) {
      return candidate;
    }
  }

  return undefined;
}

/** Build a calendar recurrence anchored to an exact first run timestamp. */
export function buildCalendarRecurrence(args: {
  frequency: ScheduledCalendarFrequency;
  interval?: number;
  nextRunAtMs: number;
  timezone: string;
  weekdays?: number[];
}): ScheduledTaskRecurrence {
  const interval = args.interval && args.interval > 0 ? args.interval : 1;
  const parts = getZonedDateTimeParts(args.nextRunAtMs, args.timezone);
  const time = { hour: parts.hour, minute: parts.minute };
  const startDate = formatLocalDate(parts);

  if (args.frequency === "weekly") {
    const weekdays = normalizeWeekdays(args.weekdays);
    return {
      frequency: args.frequency,
      interval,
      startDate,
      time,
      weekdays: weekdays.length > 0 ? weekdays : [parts.weekday],
    };
  }

  if (args.frequency === "monthly") {
    return {
      dayOfMonth: parts.day,
      frequency: args.frequency,
      interval,
      startDate,
      time,
    };
  }

  if (args.frequency === "yearly") {
    return {
      dayOfMonth: parts.day,
      frequency: args.frequency,
      interval,
      month: parts.month,
      startDate,
      time,
    };
  }

  return {
    frequency: args.frequency,
    interval,
    startDate,
    time,
  };
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

  if (recurrence.frequency === "daily") {
    return getDailyNextRunAtMs({
      recurrence,
      timezone: task.schedule.timezone,
      scheduledForMs,
      afterMs,
    });
  }

  if (recurrence.frequency === "weekly") {
    return getWeeklyNextRunAtMs({
      recurrence,
      timezone: task.schedule.timezone,
      scheduledForMs,
      afterMs,
    });
  }

  if (recurrence.frequency === "monthly") {
    return getMonthlyNextRunAtMs({
      recurrence,
      timezone: task.schedule.timezone,
      scheduledForMs,
      afterMs,
    });
  }

  return getYearlyNextRunAtMs({
    recurrence,
    timezone: task.schedule.timezone,
    scheduledForMs,
    afterMs,
  });
}
