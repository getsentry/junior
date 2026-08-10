import { describeEval } from "vitest-evals";
import { rubric, scheduledTaskDue, slackEvals } from "../../src/helpers";

describeEval("Scheduled Delivery", slackEvals, (it) => {
  it("when a one-off reminder becomes due, deliver the reminder outcome", async ({
    run,
  }) => {
    await run({
      initialEvents: [
        scheduledTaskDue("Post this reminder: Standup moved to 10:30 today.", {
          schedule: "Once at noon UTC",
          schedule_kind: "one_off",
        }),
      ],
      criteria: rubric({
        pass: [
          "Junior posts a Slack message saying standup moved to 10:30 today.",
          "The delivered message is the reminder content itself, not a schedule creation confirmation.",
          "The delivered message does not ask for clarification or confirmation.",
        ],
        fail: [
          "Do not say that a reminder was scheduled or will be scheduled.",
          "Do not omit the 10:30 standup update.",
          "Do not ask the user what to do with the reminder.",
        ],
      }),
    });
  });

  it("when a reminder addresses its creator, use the known creator mention", async ({
    run,
  }) => {
    await run({
      initialEvents: [
        scheduledTaskDue("Remind me to do healthchecks.", {
          schedule: "Once at noon UTC",
          schedule_kind: "one_off",
        }),
      ],
      criteria: rubric({
        pass: [
          "Junior reminds the scheduled task creator to do healthchecks.",
          "The reminder addresses the creator with the known Slack mention for user U0TEST.",
        ],
        fail: [
          "Do not address a different person.",
          "Do not resolve the creator by name or ask which person the task means.",
          "Do not omit the healthchecks reminder.",
        ],
      }),
    });
  });

  it("when a recurring scheduled task becomes due, deliver that occurrence", async ({
    run,
  }) => {
    await run({
      initialEvents: [
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
        pass: [
          "Junior posts a Slack message reminding people to submit timesheets by 5pm today.",
          "The delivered message treats this as the current due occurrence.",
          "The delivered message is not just a confirmation that a recurring task exists.",
        ],
        fail: [
          "Do not say only that a weekly reminder was scheduled.",
          "Do not omit the timesheets by 5pm content.",
          "Do not ask the user to confirm the recurring task before posting.",
        ],
      }),
    });
  });
});
