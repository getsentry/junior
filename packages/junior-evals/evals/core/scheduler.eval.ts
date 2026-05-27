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

  it("when executing a scheduled-task prompt, perform the task instead of creating another schedule", async ({
    run,
  }) => {
    await run({
      events: [
        mention(`@bot <scheduled-task-run>
This is an autonomous scheduled run. Treat the stored task contract as the user request for this turn.

<scheduled-task>
- id: sched_eval
- title: Weekly scheduler digest
- objective: Summarize open scheduler issues.
<instructions>
- Check for open scheduler issues.
- Post a concise digest.
</instructions>
</scheduled-task>

<current-instruction priority="highest">
Execute the scheduled task now and provide the final result for the configured destination.
</current-instruction>
</scheduled-task-run>`),
      ],
      overrides: {
        disable_schedule_tools: true,
      },
      criteria: rubric({
        contract:
          "A scheduled-task execution prompt is treated as the task to run, not as a request to schedule something.",
        pass: [
          "The assistant attempts to produce or explain a scheduler issue digest.",
        ],
        fail: [
          "Do not create, edit, delete, or list scheduled tasks.",
          "Do not say the task has been scheduled.",
        ],
      }),
    });
  });
});
