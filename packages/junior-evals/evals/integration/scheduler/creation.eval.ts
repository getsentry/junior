import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import { getDb } from "@/chat/db";
import { listScheduledAutomationsForTeam } from "@/chat/scheduled-automations/tasks";
import { mention, rubric, slackEvals } from "../../../src/helpers";
import { scheduledAutomationCreateCalls } from "./helpers";

describeEval("Schedule Creation", slackEvals, (it) => {
  it("when asked for a simple one-off reminder, create it without asking for confirmation", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [mention("@bot remind me in 1 minute to wash my hands")],
      criteria: rubric({
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
    });
    const createCalls = scheduledAutomationCreateCalls(result.session);
    expect(createCalls).toHaveLength(1);
    const createCall = createCalls[0]!;
    expect(createCall.arguments).toMatchObject({
      outcomes: [
        { action: "send_message", destination: { platform: "slack" } },
      ],
      schedule: {
        kind: "one_off",
        timing: { type: "after", value: 1, unit: "minute" },
      },
    });
    expect(createCall.arguments).not.toHaveProperty("next_run_at");
  });

  it("when asked for a terse one-off reminder, create it without recurrence", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [mention("@bot remind me to drink water in 1m")],
      criteria: rubric({
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
    });
    const createCalls = scheduledAutomationCreateCalls(result.session);
    expect(createCalls).toHaveLength(1);
    const createCall = createCalls[0]!;
    expect(createCall.arguments).toMatchObject({
      outcomes: [
        { action: "send_message", destination: { platform: "slack" } },
      ],
      schedule: {
        kind: "one_off",
        timing: { type: "after", value: 1, unit: "minute" },
      },
    });
    expect(createCall.arguments).not.toHaveProperty("next_run_at");
  });

  it("when asked to tell the channel something later, preserve the future work in the schedule", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention("@bot in 2 minutes tell the channel standup moved"),
      ],
    });
    const createCalls = scheduledAutomationCreateCalls(result.session);
    expect(createCalls).toHaveLength(1);
    const createCall = createCalls[0]!;
    expect(createCall.arguments).toMatchObject({
      outcomes: [
        { action: "send_message", destination: { platform: "slack" } },
      ],
      schedule: {
        kind: "one_off",
        timing: { type: "after", value: 2, unit: "minute" },
      },
    });
    expect(createCall.arguments).not.toHaveProperty("next_run_at");
    expect(createCall.arguments?.task).toMatch(/\bstandup\b/i);
    expect(createCall.arguments?.task).toMatch(/\bmoved\b/i);
    expect(createCall.arguments?.task).not.toMatch(/\bschedul(?:e|ing)\b/i);
  });

  it("when asked for recurring maintenance, keep successful work silent", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "@bot every night at 2am, close stale draft pull requests in getsentry/junior. do the work without posting a status message.",
        ),
      ],
    });
    const createCalls = scheduledAutomationCreateCalls(result.session);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.arguments?.outcomes ?? []).toEqual([]);
  });

  it("when asked to schedule clear recurring work, create it in the active channel", async ({
    run,
  }) => {
    const thread = {
      channel_type: "channel" as const,
      channel_id: "CSCHEDCREATE",
      id: "thread-scheduler-create-here",
      thread_ts: "1700000000.903000",
    };
    const result = await run({
      initialEvents: [
        mention(
          "@bot schedule this every Monday at 9am Pacific: check open GitHub issues about the scheduler and post a short digest here.",
          { thread },
        ),
      ],
      criteria: rubric({
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
    });
    const createCalls = scheduledAutomationCreateCalls(result.session);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.arguments).toMatchObject({
      outcomes: [
        { action: "send_message", destination: { platform: "slack" } },
      ],
      schedule: {
        kind: "recurring",
        frequency: "weekly",
        time: "09:00",
        weekdays: ["monday"],
      },
    });
    const stored = (
      await listScheduledAutomationsForTeam(getDb(), "TEVAL")
    ).find((task) => task.task.text.toLowerCase().includes("scheduler"));
    expect(stored).toMatchObject({
      destination: {
        platform: "slack",
        teamId: "TEVAL",
        channelId: thread.channel_id,
      },
    });
  });
});
