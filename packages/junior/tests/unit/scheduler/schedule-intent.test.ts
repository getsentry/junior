import { describe, expect, it } from "vitest";
import { type ScheduledTask } from "@/chat/scheduled-tasks";
import { getNextRunAtMs } from "@/chat/scheduled-tasks/cadence";
import { compileScheduleIntent } from "@/chat/scheduled-tasks/schedule-intent";

const DEFAULT_TIMEZONE = "America/Los_Angeles";

function scheduledTask(
  compiled: ReturnType<typeof compileScheduleIntent>,
  nowMs: number,
): ScheduledTask {
  return {
    id: "sched_test",
    conversationAccess: { audience: "channel", visibility: "public" },
    createdAtMs: nowMs,
    createdBy: { slackUserId: "U123" },
    creatorIdentityId: "identity-schedule-test",
    credentialMode: "system",
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId: "C123",
    },
    nextRunAtMs: compiled.nextRunAtMs,
    schedule: compiled.schedule,
    status: "active",
    task: { text: "Post the reminder." },
    updatedAtMs: nowMs,
  };
}

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

  it("compiles quarterly schedules as three-month calendar cadences", () => {
    const compiled = compileScheduleIntent({
      defaultTimezone: DEFAULT_TIMEZONE,
      intent: {
        kind: "recurring",
        frequency: "quarterly",
        day_of_month: 31,
        start_date: "2026-01-31",
        time: "09:00",
      },
      nowMs: Date.parse("2026-04-30T12:00:00.000Z"),
    });

    expect(compiled).toEqual({
      nextRunAtMs: Date.parse("2026-07-31T16:00:00.000Z"),
      schedule: {
        description: "Every quarter on day 31 at 09:00 (America/Los_Angeles)",
        kind: "recurring",
        recurrence: {
          dayOfMonth: 31,
          frequency: "quarterly",
          interval: 1,
          startDate: "2026-01-31",
          time: { hour: 9, minute: 0 },
        },
        timezone: "America/Los_Angeles",
      },
    });
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
      conversationAccess: { audience: "channel", visibility: "public" },
      createdAtMs: Date.parse("2026-03-07T08:00:00.000Z"),
      createdBy: { slackUserId: "U123" },
      creatorIdentityId: "identity-schedule-dst",
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

  it("starts an unanchored daily interval at the next occurrence", () => {
    const nowMs = Date.parse("2026-05-24T18:00:00.000Z");
    const compiled = compileScheduleIntent({
      defaultTimezone: DEFAULT_TIMEZONE,
      intent: {
        kind: "recurring",
        frequency: "daily",
        interval: 2,
        time: "09:00",
      },
      nowMs,
    });

    expect(compiled.nextRunAtMs).toBe(Date.parse("2026-05-25T16:00:00.000Z"));
    expect(compiled.schedule.recurrence).toMatchObject({
      interval: 2,
      startDate: "2026-05-25",
    });
    expect(
      getNextRunAtMs(scheduledTask(compiled, nowMs), compiled.nextRunAtMs),
    ).toBe(Date.parse("2026-05-27T16:00:00.000Z"));
  });

  it("anchors multi-week schedules to calendar weeks", () => {
    const nowMs = Date.parse("2026-05-26T18:00:00.000Z");
    const compiled = compileScheduleIntent({
      defaultTimezone: DEFAULT_TIMEZONE,
      intent: {
        kind: "recurring",
        frequency: "weekly",
        interval: 2,
        time: "09:00",
        weekdays: ["monday", "friday"],
      },
      nowMs,
    });
    const task = scheduledTask(compiled, nowMs);
    const secondRunAtMs = getNextRunAtMs(task, compiled.nextRunAtMs);

    expect(compiled.nextRunAtMs).toBe(Date.parse("2026-05-29T16:00:00.000Z"));
    expect(secondRunAtMs).toBe(Date.parse("2026-06-08T16:00:00.000Z"));
    expect(getNextRunAtMs(task, secondRunAtMs!)).toBe(
      Date.parse("2026-06-12T16:00:00.000Z"),
    );
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
