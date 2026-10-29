/**
 * Notification hours for one user.
 *
 * This module imports only zod and the browser-safe cadence helpers, so the
 * dashboard client bundle can use it.
 */
import { z } from "zod";
import { isValidTimeZone } from "../scheduled-automations/cadence";

const clockTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Saved notification hours. Weekdays use 0 for Sunday, like `Date#getDay`. */
export const notificationScheduleSchema = z
  .object({
    /** When false, Junior sends phone notifications at any time. */
    workingHoursOnly: z.boolean(),
    days: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .refine((days) => new Set(days).size === days.length, {
        message: "Days must be unique.",
      }),
    /** Local start time, `HH:MM`. */
    start: z.string().regex(clockTimePattern),
    /** Local end time, `HH:MM`. An end before the start crosses midnight. */
    end: z.string().regex(clockTimePattern),
    /** IANA timezone set by the user. Absent means the profile timezone. */
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(isValidTimeZone, { message: "Unknown timezone." })
      .optional(),
  })
  .strict()
  .refine((schedule) => schedule.start !== schedule.end, {
    message: "Start and end must differ.",
    path: ["end"],
  });

export type NotificationSchedule = z.output<typeof notificationScheduleSchema>;

/** Default hours when a user has not saved a schedule: 09:00–18:00, Mon–Fri. */
export const DEFAULT_NOTIFICATION_SCHEDULE: NotificationSchedule = {
  workingHoursOnly: true,
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
};

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours! * 60 + minutes!;
}

const weekdayIndex: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function localWeekdayAndMinutes(
  nowMs: number,
  timezone: string,
): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: timezone,
    weekday: "short",
  }).formatToParts(new Date(nowMs));
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday = weekdayIndex[value("weekday")];
  if (weekday === undefined) {
    throw new Error(`Could not read the weekday for timezone ${timezone}`);
  }
  return {
    minutes: (Number(value("hour")) % 24) * 60 + Number(value("minute")),
    weekday,
  };
}

/**
 * Return whether a notification may be sent now. A window that crosses
 * midnight belongs to the day on which it starts.
 */
export function isWithinNotificationSchedule(
  schedule: NotificationSchedule,
  timezone: string,
  nowMs: number,
): boolean {
  if (!schedule.workingHoursOnly) return true;
  const { minutes, weekday } = localWeekdayAndMinutes(nowMs, timezone);
  const start = clockMinutes(schedule.start);
  const end = clockMinutes(schedule.end);
  if (start < end) {
    return schedule.days.includes(weekday) && minutes >= start && minutes < end;
  }
  if (minutes >= start) return schedule.days.includes(weekday);
  if (minutes < end) return schedule.days.includes((weekday + 6) % 7);
  return false;
}
