/**
 * Owns model-facing schedule intent and materializes it against the trusted
 * server clock into the canonical schedule persisted by core.
 */
import { z } from "zod";
import {
  getFirstRunAtMs,
  getZonedDateTimeParts,
  resolveLocalScheduleAtMs,
} from "./cadence";
import type {
  ScheduledLocalTime,
  ScheduledTaskRecurrence,
  ScheduledTaskSchedule,
} from "./types";

const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a local date in YYYY-MM-DD format.");
const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use local time in HH:MM format.");
const timezoneSchema = z
  .string()
  .min(1)
  .max(80)
  .describe(
    "IANA timezone, for example America/Los_Angeles. Omit or use null for the scheduler default.",
  )
  .nullable()
  .optional();
const weekdaySchema = z.enum([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]);

const oneOffScheduleIntentSchema = z
  .object({
    kind: z.literal("one_off").describe("A schedule that runs once."),
    timezone: timezoneSchema,
    timing: z
      .discriminatedUnion("type", [
        z
          .object({
            type: z
              .literal("after")
              .describe("Run after a relative delay from the server clock."),
            value: z.number().int().positive().max(100_000),
            unit: z.enum(["second", "minute", "hour", "day", "week"]),
          })
          .strict(),
        z
          .object({
            type: z
              .literal("at")
              .describe("Run at an explicit local calendar date and time."),
            date: localDateSchema.describe(
              "Requested local calendar date in YYYY-MM-DD format.",
            ),
            time: localTimeSchema.describe(
              "Requested local wall-clock time in HH:MM format.",
            ),
          })
          .strict(),
      ])
      .describe("Relative delay or explicit local time for the one-off run."),
  })
  .strict();

const recurringScheduleIntentSchema = z
  .object({
    kind: z.literal("recurring").describe("A repeating calendar schedule."),
    frequency: z
      .enum(["daily", "weekly", "monthly", "yearly"])
      .describe("Recurring tasks can run at most once per day."),
    interval: z
      .number()
      .int()
      .positive()
      .max(365)
      .describe("Repeat every N frequency units. Defaults to 1.")
      .nullable()
      .optional(),
    time: localTimeSchema.describe(
      "Local wall-clock time for each occurrence in HH:MM format.",
    ),
    weekdays: z
      .array(weekdaySchema)
      .min(1)
      .max(7)
      .describe("Required for weekly schedules.")
      .nullable()
      .optional(),
    day_of_month: z
      .number()
      .int()
      .min(1)
      .max(31)
      .describe("Required for monthly and yearly schedules.")
      .nullable()
      .optional(),
    month: z
      .number()
      .int()
      .min(1)
      .max(12)
      .describe("Required for yearly schedules, where January is 1.")
      .nullable()
      .optional(),
    start_date: localDateSchema
      .describe(
        "Optional local calendar date that anchors the recurrence. Omit to start with the next matching occurrence.",
      )
      .nullable()
      .optional(),
    timezone: timezoneSchema,
  })
  .strict()
  .superRefine((schedule, context) => {
    if (schedule.frequency === "weekly" && schedule.weekdays == null) {
      context.addIssue({
        code: "custom",
        message: "Weekly schedules require weekdays.",
        path: ["weekdays"],
      });
    }
    if (
      (schedule.frequency === "monthly" || schedule.frequency === "yearly") &&
      schedule.day_of_month == null
    ) {
      context.addIssue({
        code: "custom",
        message: `${schedule.frequency} schedules require day_of_month.`,
        path: ["day_of_month"],
      });
    }
    if (schedule.frequency === "yearly" && schedule.month == null) {
      context.addIssue({
        code: "custom",
        message: "Yearly schedules require month.",
        path: ["month"],
      });
    }
    if (schedule.frequency !== "weekly" && schedule.weekdays != null) {
      context.addIssue({
        code: "custom",
        message: "weekdays applies only to weekly schedules.",
        path: ["weekdays"],
      });
    }
    if (
      schedule.frequency !== "monthly" &&
      schedule.frequency !== "yearly" &&
      schedule.day_of_month != null
    ) {
      context.addIssue({
        code: "custom",
        message: "day_of_month applies only to monthly or yearly schedules.",
        path: ["day_of_month"],
      });
    }
    if (schedule.frequency !== "yearly" && schedule.month != null) {
      context.addIssue({
        code: "custom",
        message: "month applies only to yearly schedules.",
        path: ["month"],
      });
    }
  });

export const scheduleIntentSchema = z.union([
  oneOffScheduleIntentSchema,
  recurringScheduleIntentSchema,
]);
export type ScheduleIntent = z.infer<typeof scheduleIntentSchema>;

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const;

const DURATION_MS = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
} as const;

function parseLocalTime(value: string): ScheduledLocalTime {
  const [hour, minute] = value.split(":").map(Number);
  return { hour: hour!, minute: minute! };
}

function localDateAt(timestampMs: number, timezone: string): string {
  const parts = getZonedDateTimeParts(timestampMs, timezone);
  return [parts.year, parts.month, parts.day]
    .map((value, index) =>
      index === 0
        ? String(value).padStart(4, "0")
        : String(value).padStart(2, "0"),
    )
    .join("-");
}

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function plural(value: number, unit: string): string {
  return value === 1 ? unit : `${unit}s`;
}

function formatWeekdays(weekdays: readonly string[]): string {
  const labels = weekdays.map(
    (weekday) => `${weekday[0]!.toUpperCase()}${weekday.slice(1)}`,
  );
  if (labels.length < 2) {
    return labels[0] ?? "";
  }
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function recurringDescription(
  schedule: z.infer<typeof recurringScheduleIntentSchema>,
  timezone: string,
): string {
  const interval = schedule.interval ?? 1;
  const cadenceUnit = {
    daily: "day",
    weekly: "week",
    monthly: "month",
    yearly: "year",
  }[schedule.frequency];
  const cadence = interval === 1 ? cadenceUnit : `${interval} ${cadenceUnit}s`;
  let detail = "";
  if (schedule.frequency === "weekly") {
    detail = ` on ${formatWeekdays(schedule.weekdays!)}`;
  } else if (schedule.frequency === "monthly") {
    detail = ` on day ${schedule.day_of_month}`;
  } else if (schedule.frequency === "yearly") {
    detail = ` on ${String(schedule.month).padStart(2, "0")}-${String(
      schedule.day_of_month,
    ).padStart(2, "0")}`;
  }
  return `Every ${cadence}${detail} at ${schedule.time} (${timezone})`;
}

export interface CompiledScheduleIntent {
  nextRunAtMs: number;
  schedule: ScheduledTaskSchedule;
}

export class ScheduleIntentError extends Error {}

/** Materialize model-interpreted schedule intent against the trusted server clock. */
export function compileScheduleIntent(args: {
  defaultTimezone: string;
  intent: ScheduleIntent;
  nowMs: number;
}): CompiledScheduleIntent {
  const timezone = args.intent.timezone ?? args.defaultTimezone;
  if (!isValidTimeZone(timezone)) {
    throw new ScheduleIntentError("timezone must be a valid IANA time zone.");
  }

  if (args.intent.kind === "one_off") {
    if (args.intent.timing.type === "after") {
      const nextRunAtMs =
        args.nowMs +
        args.intent.timing.value * DURATION_MS[args.intent.timing.unit];
      return {
        nextRunAtMs,
        schedule: {
          description: `In ${args.intent.timing.value} ${plural(
            args.intent.timing.value,
            args.intent.timing.unit,
          )}`,
          kind: "one_off",
          timezone,
        },
      };
    }

    const nextRunAtMs = resolveLocalScheduleAtMs({
      date: args.intent.timing.date,
      time: parseLocalTime(args.intent.timing.time),
      timezone,
    });
    if (nextRunAtMs === undefined) {
      throw new ScheduleIntentError(
        "The requested local date or time does not exist in that timezone.",
      );
    }
    if (nextRunAtMs <= args.nowMs) {
      throw new ScheduleIntentError(
        "The requested one-off schedule must be in the future.",
      );
    }
    return {
      nextRunAtMs,
      schedule: {
        description: `Once on ${args.intent.timing.date} at ${args.intent.timing.time} (${timezone})`,
        kind: "one_off",
        timezone,
      },
    };
  }

  const recurrence: ScheduledTaskRecurrence = {
    frequency: args.intent.frequency,
    interval: args.intent.interval ?? 1,
    startDate: args.intent.start_date ?? localDateAt(args.nowMs, timezone),
    time: parseLocalTime(args.intent.time),
    ...(args.intent.frequency === "weekly"
      ? {
          weekdays: [
            ...new Set(
              args.intent.weekdays!.map((weekday) => WEEKDAY_INDEX[weekday]),
            ),
          ].sort((left, right) => left - right),
        }
      : undefined),
    ...(args.intent.frequency === "monthly" ||
    args.intent.frequency === "yearly"
      ? { dayOfMonth: args.intent.day_of_month ?? undefined }
      : undefined),
    ...(args.intent.frequency === "yearly"
      ? { month: args.intent.month ?? undefined }
      : undefined),
  };
  const searchRecurrence = args.intent.start_date
    ? recurrence
    : { ...recurrence, interval: 1 };
  const nextRunAtMs = getFirstRunAtMs({
    afterMs: args.nowMs,
    recurrence: searchRecurrence,
    timezone,
  });
  if (nextRunAtMs === undefined) {
    throw new ScheduleIntentError(
      "The recurring schedule has no valid future occurrence.",
    );
  }
  const materializedRecurrence = args.intent.start_date
    ? recurrence
    : { ...recurrence, startDate: localDateAt(nextRunAtMs, timezone) };
  return {
    nextRunAtMs,
    schedule: {
      description: recurringDescription(args.intent, timezone),
      kind: "recurring",
      recurrence: materializedRecurrence,
      timezone,
    },
  };
}
