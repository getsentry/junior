import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import { mention, rubric, slackEvals } from "../../../src/helpers";
import { scheduledTaskCreateCalls } from "./helpers";

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
    const createCalls = scheduledTaskCreateCalls(result.session);
    expect(createCalls).toHaveLength(1);
    const createCall = createCalls[0]!;
    expect(createCall.arguments).toMatchObject({
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
    const createCalls = scheduledTaskCreateCalls(result.session);
    expect(createCalls).toHaveLength(1);
    const createCall = createCalls[0]!;
    expect(createCall.arguments).toMatchObject({
      schedule: {
        kind: "one_off",
        timing: { type: "after", value: 1, unit: "minute" },
      },
    });
    expect(createCall.arguments).not.toHaveProperty("next_run_at");
  });

  it("when asked for a specific one-off reminder, preserve the future work in the schedule", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention("@bot in 2 minutes, post 'standup moved' to this channel"),
      ],
    });
    const createCalls = scheduledTaskCreateCalls(result.session);
    expect(createCalls).toHaveLength(1);
    const createCall = createCalls[0]!;
    expect(createCall.arguments).toMatchObject({
      schedule: {
        kind: "one_off",
        timing: { type: "after", value: 2, unit: "minute" },
      },
    });
    expect(createCall.arguments).not.toHaveProperty("next_run_at");
    expect(createCall.arguments?.task).toMatch(/standup moved/i);
    expect(createCall.arguments?.task).not.toMatch(/\bschedul(?:e|ing)\b/i);
  });

  it("when asked to schedule clear recurring work, create it without confirmation", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "@bot schedule this every Monday at 9am Pacific: check open GitHub issues about the scheduler and post a short digest here.",
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
    const createCalls = scheduledTaskCreateCalls(result.session);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.arguments).toMatchObject({
      schedule: {
        kind: "recurring",
        frequency: "weekly",
        time: "09:00",
        weekdays: ["monday"],
      },
    });
  });
});
