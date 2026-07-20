import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import { mention, rubric, slackEvals } from "../../src/helpers";
import { scheduledTaskCreateCall } from "./helpers";

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
    const createCall = scheduledTaskCreateCall(result.session);
    expect(createCall.arguments).toMatchObject({ schedule_kind: "one_off" });
    expect(createCall.arguments).not.toHaveProperty("recurrence");
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
    const createCall = scheduledTaskCreateCall(result.session);
    expect(createCall.arguments).toMatchObject({ schedule_kind: "one_off" });
    expect(createCall.arguments).not.toHaveProperty("recurrence");
  });

  it("when asked for a specific one-off reminder, preserve the future work in the schedule", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "@bot remind me in 2 minutes to tell the channel standup moved",
        ),
      ],
      criteria: rubric({
        pass: [
          "The observed scheduler_slackScheduleCreateTask task is the reminder work to perform later, not instructions for how to create or manage a schedule.",
        ],
        fail: [
          "Do not store task text that tells Junior to schedule a reminder later.",
          "Do not ask the user to confirm before creating this clear reminder.",
        ],
      }),
    });
    const createCall = scheduledTaskCreateCall(result.session);
    expect(createCall.arguments).toMatchObject({ schedule_kind: "one_off" });
    expect(createCall.arguments).not.toHaveProperty("recurrence");
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
    expect(scheduledTaskCreateCall(result.session).arguments).toMatchObject({
      schedule_kind: "recurring",
      recurrence: "weekly",
    });
  });
});
