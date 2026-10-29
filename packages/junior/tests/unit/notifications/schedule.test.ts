import { describe, expect, it } from "vitest";
import {
  isWithinNotificationSchedule,
  notificationScheduleSchema,
  type NotificationSchedule,
} from "@/chat/notifications/schedule";

const weekdays: NotificationSchedule = {
  workingHoursOnly: true,
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
};

// 2026-10-28 is a Wednesday. 2026-10-31 is a Saturday.
describe("isWithinNotificationSchedule", () => {
  it.each<[string, NotificationSchedule, string, boolean]>([
    ["Wednesday 10:00 in Los Angeles", weekdays, "2026-10-28T17:00:00Z", true],
    ["Wednesday 08:59 in Los Angeles", weekdays, "2026-10-28T15:59:00Z", false],
    [
      "Wednesday 18:00 is the exclusive end",
      weekdays,
      "2026-10-29T01:00:00Z",
      false,
    ],
    [
      "Saturday 10:00 is not a working day",
      weekdays,
      "2026-10-31T17:00:00Z",
      false,
    ],
    [
      "notifications at any time",
      { ...weekdays, workingHoursOnly: false, days: [] },
      "2026-10-31T10:00:00Z",
      true,
    ],
    [
      "Friday 23:00 in an overnight window that starts Friday",
      { ...weekdays, days: [5], start: "22:00", end: "06:00" },
      "2026-10-31T06:00:00Z",
      true,
    ],
    [
      "Saturday 05:00 in an overnight window that starts Friday",
      { ...weekdays, days: [5], start: "22:00", end: "06:00" },
      "2026-10-31T12:00:00Z",
      true,
    ],
    [
      "Saturday 23:00 when only Friday nights are on",
      { ...weekdays, days: [5], start: "22:00", end: "06:00" },
      "2026-11-01T06:00:00Z",
      false,
    ],
  ])("%s", (_name, schedule, nowIso, expected) => {
    expect(
      isWithinNotificationSchedule(
        schedule,
        "America/Los_Angeles",
        Date.parse(nowIso),
      ),
    ).toBe(expected);
  });

  it("uses the given timezone, not the server timezone", () => {
    const nowMs = Date.parse("2026-10-28T08:00:00Z");
    expect(isWithinNotificationSchedule(weekdays, "Europe/Vienna", nowMs)).toBe(
      true,
    );
    expect(
      isWithinNotificationSchedule(weekdays, "America/Los_Angeles", nowMs),
    ).toBe(false);
  });
});

describe("notificationScheduleSchema", () => {
  it("rejects an empty window, an unknown timezone, and repeated days", () => {
    expect(
      notificationScheduleSchema.safeParse({ ...weekdays, end: "09:00" })
        .success,
    ).toBe(false);
    expect(
      notificationScheduleSchema.safeParse({
        ...weekdays,
        timezone: "Mars/Base",
      }).success,
    ).toBe(false);
    expect(
      notificationScheduleSchema.safeParse({ ...weekdays, days: [1, 1] })
        .success,
    ).toBe(false);
  });
});
