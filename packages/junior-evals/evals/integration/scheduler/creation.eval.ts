import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Schedule Creation", () => {
  test("when asked for a simple one-off reminder, create it without asking for confirmation", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("send me a direct reminder in 1 minute to wash my hands"),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply confirms that a one-off reminder to wash hands was scheduled.",
          "The reply does not ask the user to confirm first.",
        ],
        fail: [
          "Do not ask the user to confirm the reminder before creating it.",
          "Do not ask the user to provide a channel ID.",
          "Do not describe the reminder as a recurring schedule.",
        ],
      }),
    );

    const creates = completedToolCalls(
      "slackScheduleCreateAutomation",
      conversation,
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toMatchObject({
      outcomes: [{ action: "send_message", destination: "task_creator" }],
      schedule: {
        kind: "one_off",
        timing: { type: "after", value: 1, unit: "minute" },
      },
    });
    expect(creates[0]!.input).not.toHaveProperty("nextRunAt");
  });

  test("when asked for a terse one-off reminder, create it without recurrence", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("remind me to drink water in 1m"),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply confirms that a one-off reminder to drink water was scheduled.",
          "The reply does not ask the user to retry with a different one-time format.",
        ],
        fail: [
          "Do not reject the request as an invalid one-off task format.",
          "Do not ask the user to confirm the reminder before creating it.",
          "Do not describe the reminder as a recurring schedule.",
        ],
      }),
    );

    const creates = completedToolCalls(
      "slackScheduleCreateAutomation",
      conversation,
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toMatchObject({
      schedule: {
        kind: "one_off",
        timing: { type: "after", value: 1, unit: "minute" },
      },
    });
    expect(creates[0]!.input).not.toHaveProperty("nextRunAt");
  });

  test("when a reminder for the requester posts to the channel, name the requester exactly", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "every Friday at 4pm Pacific, remind me in this channel to submit my timesheet",
      ),
    );

    const creates = completedToolCalls(
      "slackScheduleCreateAutomation",
      conversation,
    );
    expect(creates).toHaveLength(1);
    // The task runs later without this request, so "me" must become a mention.
    const { instruction } = creates[0]!.input as { instruction?: string };
    expect(instruction).toContain("<@U0TEST>");
    expect(instruction).not.toMatch(/\b(?:me|my)\b/i);
  });

  test("when asked to tell the channel something later, preserve the future work in the schedule", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("in 2 minutes tell the channel standup moved"),
    );

    const creates = completedToolCalls(
      "slackScheduleCreateAutomation",
      conversation,
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toMatchObject({
      outcomes: [
        { action: "send_message", destination: "current_conversation" },
      ],
      schedule: {
        kind: "one_off",
        timing: { type: "after", value: 2, unit: "minute" },
      },
    });
    const { instruction } = creates[0]!.input as { instruction?: string };
    expect(instruction).toMatch(/\bstandup\b/i);
    expect(instruction).toMatch(/\bmoved\b/i);
    expect(instruction).not.toMatch(/\bschedul(?:e|ing)\b/i);
    expect(creates[0]!.input).not.toHaveProperty("nextRunAt");
  });

  test("when asked for nightly fix PRs, omit success notifications by default", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "every night at 2am Pacific, open PRs to fix failing CI checks in getsentry/junior.",
      ),
    );

    const creates = completedToolCalls(
      "slackScheduleCreateAutomation",
      conversation,
    );
    expect(creates).toHaveLength(1);
    const { outcomes } = creates[0]!.input as { outcomes?: unknown[] };
    expect(outcomes ?? []).toEqual([]);
    expect(creates[0]!.input).toMatchObject({
      schedule: {
        kind: "recurring",
        frequency: "daily",
        time: "02:00",
        timezone: "America/Los_Angeles",
      },
    });
  });

  test("when asked to schedule clear recurring work, create it in the active channel", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "schedule this every Monday at 9am Pacific: check open GitHub issues about the scheduler and post a short digest here.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The created task describes checking scheduler-related GitHub issues, not creating a schedule.",
          "The reply confirms the recurring schedule was created for Monday at 9am Pacific.",
        ],
        fail: [
          "Do not ask the user to confirm before creating the clear recurring task.",
          "Do not ask the user to provide a channel ID.",
          "Do not only give instructions for how the user can set up an external cron.",
        ],
      }),
    );

    const creates = completedToolCalls(
      "slackScheduleCreateAutomation",
      conversation,
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toMatchObject({
      outcomes: [
        { action: "send_message", destination: "current_conversation" },
      ],
      schedule: {
        kind: "recurring",
        frequency: "weekly",
        time: "09:00",
        weekdays: ["monday"],
      },
    });
  });
});
