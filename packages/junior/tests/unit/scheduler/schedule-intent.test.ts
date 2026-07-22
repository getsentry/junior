import { describe, expect, it } from "vitest";
import { type ScheduledTask } from "@sentry/junior-scheduler";
import { getNextRunAtMs } from "../../../../junior-scheduler/src/cadence";
import { compileScheduleIntent } from "../../../../junior-scheduler/src/schedule-intent";

const DEFAULT_TIMEZONE = "America/Los_Angeles";

describe("schedule intent compiler", () => {
  it("resolves relative one-offs from the trusted server clock", () => {
    const nowMs = Date.parse("2026-05-28T02:17:48.005Z");

    expect(
      compileScheduleIntent({
        defaultTimezone: DEFAULT_TIMEZONE,
        intent: {
          kind: "one_off",
          timing: { type: "after", value: 1, unit: "minute" },
        },
        nowMs,
      }),
    ).toMatchObject({
      nextRunAtMs: Date.parse("2026-05-28T02:18:48.005Z"),
      schedule: {
        description: "In 1 minute",
        kind: "one_off",
        timezone: DEFAULT_TIMEZONE,
      },
    });
  });

  it("materializes the next matching local recurring occurrence", () => {
    const compiled = compileScheduleIntent({
      defaultTimezone: DEFAULT_TIMEZONE,
      intent: {
        kind: "recurring",
        frequency: "weekly",
        time: "09:00",
        weekdays: ["monday"],
      },
      nowMs: Date.parse("2026-05-24T12:00:00.000Z"),
    });

    expect(compiled).toMatchObject({
      nextRunAtMs: Date.parse("2026-05-25T16:00:00.000Z"),
      schedule: {
        kind: "recurring",
        recurrence: {
          frequency: "weekly",
          interval: 1,
          startDate: "2026-05-25",
          time: { hour: 9, minute: 0 },
          weekdays: [1],
        },
      },
    });
  });

  it("skips a nonexistent spring-forward recurring time", () => {
    const compiled = compileScheduleIntent({
      defaultTimezone: DEFAULT_TIMEZONE,
      intent: {
        kind: "recurring",
        frequency: "daily",
        time: "02:30",
        start_date: "2026-03-08",
      },
      nowMs: Date.parse("2026-03-08T08:00:00.000Z"),
    });

    expect(compiled.nextRunAtMs).toBe(Date.parse("2026-03-09T09:30:00.000Z"));
  });

  it("uses the first instant when a fall-back local time repeats", () => {
    const compiled = compileScheduleIntent({
      defaultTimezone: DEFAULT_TIMEZONE,
      intent: {
        kind: "recurring",
        frequency: "daily",
        time: "01:30",
        start_date: "2026-11-01",
      },
      nowMs: Date.parse("2026-11-01T07:00:00.000Z"),
    });

    expect(compiled.nextRunAtMs).toBe(Date.parse("2026-11-01T08:30:00.000Z"));
  });

  it("finds the next valid monthly and leap-year occurrences", () => {
    const monthly = compileScheduleIntent({
      defaultTimezone: DEFAULT_TIMEZONE,
      intent: {
        kind: "recurring",
        frequency: "monthly",
        day_of_month: 31,
        time: "09:00",
      },
      nowMs: Date.parse("2026-04-30T12:00:00.000Z"),
    });
    const yearly = compileScheduleIntent({
      defaultTimezone: DEFAULT_TIMEZONE,
      intent: {
        kind: "recurring",
        frequency: "yearly",
        month: 2,
        day_of_month: 29,
        time: "09:00",
      },
      nowMs: Date.parse("2026-03-01T12:00:00.000Z"),
    });

    expect(monthly.nextRunAtMs).toBe(Date.parse("2026-05-31T16:00:00.000Z"));
    expect(yearly.nextRunAtMs).toBe(Date.parse("2028-02-29T17:00:00.000Z"));
  });

  it("supports yearly intervals beyond the old search horizon", () => {
    const compiled = compileScheduleIntent({
      defaultTimezone: DEFAULT_TIMEZONE,
      intent: {
        kind: "recurring",
        frequency: "yearly",
        interval: 365,
        month: 1,
        day_of_month: 1,
        start_date: "2026-01-01",
        time: "09:00",
      },
      nowMs: Date.parse("2026-03-01T12:00:00.000Z"),
    });

    expect(compiled.nextRunAtMs).toBe(Date.parse("2391-01-01T17:00:00.000Z"));
  });

  it("skips a nonexistent local time when advancing an existing task", () => {
    const compiled = compileScheduleIntent({
      defaultTimezone: DEFAULT_TIMEZONE,
      intent: {
        kind: "recurring",
        frequency: "daily",
        time: "02:30",
        start_date: "2026-03-07",
      },
      nowMs: Date.parse("2026-03-07T08:00:00.000Z"),
    });
    const task: ScheduledTask = {
      id: "sched_dst",
      createdAtMs: Date.parse("2026-03-07T08:00:00.000Z"),
      createdBy: { slackUserId: "U123" },
      credentialMode: "system",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
      },
      nextRunAtMs: compiled.nextRunAtMs,
      schedule: compiled.schedule,
      status: "active",
      task: { text: "Post the daily reminder." },
      updatedAtMs: Date.parse("2026-03-07T08:00:00.000Z"),
    };

    expect(getNextRunAtMs(task, compiled.nextRunAtMs)).toBe(
      Date.parse("2026-03-09T09:30:00.000Z"),
    );
  });

  it("anchors an unanchored interval at the next matching occurrence", () => {
    const compiled = compileScheduleIntent({
      defaultTimezone: DEFAULT_TIMEZONE,
      intent: {
        kind: "recurring",
        frequency: "yearly",
        interval: 4,
        month: 2,
        day_of_month: 29,
        time: "09:00",
      },
      nowMs: Date.parse("2025-03-01T12:00:00.000Z"),
    });

    expect(compiled.nextRunAtMs).toBe(Date.parse("2028-02-29T17:00:00.000Z"));
    expect(compiled.schedule.recurrence).toMatchObject({
      interval: 4,
      startDate: "2028-02-29",
    });
  });

  it("does not schedule before a future recurrence start date", () => {
    const monthly = compileScheduleIntent({
      defaultTimezone: DEFAULT_TIMEZONE,
      intent: {
        kind: "recurring",
        frequency: "monthly",
        day_of_month: 1,
        start_date: "2027-06-15",
        time: "09:00",
      },
      nowMs: Date.parse("2026-03-01T12:00:00.000Z"),
    });
    const yearly = compileScheduleIntent({
      defaultTimezone: DEFAULT_TIMEZONE,
      intent: {
        kind: "recurring",
        frequency: "yearly",
        month: 1,
        day_of_month: 1,
        start_date: "2027-06-15",
        time: "09:00",
      },
      nowMs: Date.parse("2026-03-01T12:00:00.000Z"),
    });

    expect(monthly.nextRunAtMs).toBe(Date.parse("2027-07-01T16:00:00.000Z"));
    expect(yearly.nextRunAtMs).toBe(Date.parse("2028-01-01T17:00:00.000Z"));
  });

  it("rejects a nonexistent one-off local time", () => {
    expect(() =>
      compileScheduleIntent({
        defaultTimezone: DEFAULT_TIMEZONE,
        intent: {
          kind: "one_off",
          timing: { type: "at", date: "2026-03-08", time: "02:30" },
        },
        nowMs: Date.parse("2026-03-08T08:00:00.000Z"),
      }),
    ).toThrow("does not exist in that timezone");
  });
});
