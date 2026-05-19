import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals } from "../helpers";

describeEval("Scheduler", slackEvals, (it) => {
  it("when asked to schedule recurring work, create a scheduled task for the active Slack context", async ({
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
          "A future or recurring task request is turned into a scheduled Junior task for the active Slack context.",
        pass: [
          "observed_tool_invocations contains slackScheduleCreateTask.",
          "The scheduled task title/objective/instructions describe checking scheduler-related GitHub issues, not creating a schedule.",
          "The tool call uses an exact next_run_at_iso and a calendar recurrence for Mondays at 9am Pacific.",
          "The reply confirms the scheduled task and mentions the cadence or next run.",
        ],
        fail: [
          "Do not ask the user to provide a channel ID.",
          "Do not use Slack chat.scheduleMessage.",
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

<execution-rules>
- Execute the scheduled task described in <scheduled-task>; do not create, update, pause, delete, or list schedules.
</execution-rules>

<current-instruction priority="highest">
Execute the scheduled task now and provide the final result for the configured destination.
</current-instruction>
</scheduled-task-run>`),
      ],
      criteria: rubric({
        contract:
          "A scheduled-task execution prompt is treated as the task to run, not as a request to schedule something.",
        pass: [
          "observed_tool_invocations does not contain slackScheduleCreateTask.",
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
