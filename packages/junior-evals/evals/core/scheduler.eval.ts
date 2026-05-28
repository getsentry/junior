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

  it("when asked to schedule recurring work, draft the task for confirmation before creating it", async ({
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
          "A future or recurring task request is normalized into a scheduled task draft for the active Slack context before it is persisted.",
        pass: [
          "The draft task title/objective/instructions describe checking scheduler-related GitHub issues, not creating a schedule.",
          "The reply asks the user to confirm the normalized cadence or next run before creating the schedule.",
        ],
        fail: [
          "Do not persist a scheduled task before user confirmation.",
          "Do not ask the user to provide a channel ID.",
          "Do not only give instructions for how the user can set up an external cron.",
        ],
      }),
    });
  });
});
