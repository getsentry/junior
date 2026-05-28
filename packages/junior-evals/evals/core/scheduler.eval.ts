import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals } from "../helpers";

describeEval("Scheduler", slackEvals, (it) => {
  it("when asked for a simple one-off reminder, create it without asking for confirmation", async ({
    run,
  }) => {
    await run({
      events: [mention("@bot remind me in 1 minute to wash my hands")],
      criteria: rubric({
        contract:
          "A simple one-off reminder request is scheduled immediately for the active Slack context.",
        pass: [
          "The reply confirms that a one-off reminder to wash hands was scheduled.",
          "The schedule creation uses recurring=false and does not set recurrence.",
          "The reply does not ask the user to confirm first.",
        ],
        fail: [
          "Do not ask the user to confirm the reminder before creating it.",
          "Do not ask the user to provide a channel ID.",
          "Do not describe the reminder as a recurring schedule.",
        ],
      }),
    });
  });

  it("when asked to schedule clear recurring work, create it without confirmation", async ({
    run,
  }) => {
    await run({
      events: [
        mention(
          "@bot schedule this every Monday at 9am Pacific: check open GitHub issues about the scheduler and post a short digest here.",
        ),
      ],
      criteria: rubric({
        contract:
          "A clear future or recurring task request is normalized and scheduled immediately for the active Slack context.",
        pass: [
          "The created task describes checking scheduler-related GitHub issues, not creating a schedule.",
          "The schedule creation uses recurring=true and recurrence.frequency=weekly.",
          "The reply confirms the recurring schedule was created for Monday at 9am Pacific.",
        ],
        fail: [
          "Do not ask the user to confirm before creating the clear recurring task.",
          "Do not ask the user to provide a channel ID.",
          "Do not only give instructions for how the user can set up an external cron.",
        ],
      }),
    });
  });
});
