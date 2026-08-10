import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import { rubric, scheduledTaskDue, slackEvals } from "../../src/helpers";
import { expectNoToolCalls, REMINDER_ONLY_FORBIDDEN_TOOLS } from "./helpers";

describeEval("Scheduled Delivery", slackEvals, (it) => {
  it("when a one-off reminder becomes due, deliver the reminder outcome", async ({
    run,
  }) => {
    const result = await run({
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
    expectNoToolCalls(result.session, REMINDER_ONLY_FORBIDDEN_TOOLS);
  });

  it("when a recurring scheduled task becomes due, deliver that occurrence", async ({
    run,
  }) => {
    const result = await run({
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
    expectNoToolCalls(result.session, REMINDER_ONLY_FORBIDDEN_TOOLS);
  });
});
