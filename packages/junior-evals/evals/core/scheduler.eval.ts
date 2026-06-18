import { describeEval } from "vitest-evals";
import { mention, rubric, scheduledTaskDue, slackEvals } from "../helpers";

describeEval("Scheduler", slackEvals, (it) => {
  it("when asked for a specific one-off reminder, preserve the future work in the schedule", async ({
    run,
  }) => {
    await run({
      events: [
        mention(
          "@bot remind me in 2 minutes to tell the channel standup moved",
        ),
      ],
      criteria: rubric({
        contract:
          "A one-off reminder request is scheduled with the future reminder work preserved as the task.",
        pass: [
          "The observed slackScheduleCreateTask tool call has schedule_kind=one_off.",
          "The observed slackScheduleCreateTask tool call omits recurrence.",
          "The observed slackScheduleCreateTask task is the reminder work to perform later, not instructions for how to create or manage a schedule.",
        ],
        fail: [
          "Do not store task text that tells Junior to schedule a reminder later.",
          "Do not ask the user to confirm before creating this clear reminder.",
        ],
      }),
    });
  });

  it("when a one-off reminder becomes due, deliver the reminder outcome", async ({
    run,
  }) => {
    await run({
      events: [
        scheduledTaskDue("Post this reminder: Standup moved to 10:30 today.", {
          schedule: "Once at noon UTC",
          schedule_kind: "one_off",
        }),
      ],
      criteria: rubric({
        contract:
          "A due one-off scheduled task is executed now and posts the requested reminder outcome to the destination channel.",
        pass: [
          "The channel_posts output contains a Slack channel message saying standup moved to 10:30 today.",
          "The delivered message is the reminder content itself, not a schedule creation confirmation.",
          "The delivered message does not ask for clarification or confirmation.",
        ],
        fail: [
          "Do not use webSearch, webFetch, bash, callMcpTool, sandbox, or Slack history tools for this reminder-only task.",
          "Do not say that a reminder was scheduled or will be scheduled.",
          "Do not omit the 10:30 standup update.",
          "Do not ask the user what to do with the reminder.",
        ],
      }),
    });
  });

  it("when a recurring scheduled task becomes due, deliver that occurrence", async ({
    run,
  }) => {
    await run({
      events: [
        scheduledTaskDue(
          "Post this reminder: Submit timesheets by 5pm today.",
          {
            recurrence: "weekly",
            schedule: "Weekly on Monday at noon UTC",
            schedule_kind: "recurring",
          },
        ),
      ],
      criteria: rubric({
        contract:
          "A due recurring scheduled task is executed for the current occurrence and posts the requested reminder outcome to the destination channel.",
        pass: [
          "The channel_posts output contains a Slack channel message reminding people to submit timesheets by 5pm today.",
          "The delivered message treats this as the current due occurrence.",
          "The delivered message is not just a confirmation that a recurring task exists.",
        ],
        fail: [
          "Do not use webSearch, webFetch, bash, callMcpTool, sandbox, or Slack history tools for this reminder-only task.",
          "Do not say only that a weekly reminder was scheduled.",
          "Do not omit the timesheets by 5pm content.",
          "Do not ask the user to confirm the recurring task before posting.",
        ],
      }),
    });
  });
});
