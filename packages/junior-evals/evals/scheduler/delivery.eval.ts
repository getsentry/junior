import { describe, expect } from "vitest";
import { heartbeat } from "@junior-evals/fixture/inputs";
import {
  insertScheduledAutomation,
  slackChannel,
  slackDirectMessage,
} from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

describe("Scheduled Delivery", () => {
  test("when a one-off reminder becomes due, deliver the reminder outcome", async ({
    run,
  }) => {
    await insertScheduledAutomation({
      credentialMode: "system",
      destination: slackChannel(),
      due: true,
      once: true,
      task: "Post this reminder: Standup moved to 10:30 today.",
    });

    const delivery = await run(heartbeat());
    await expect(delivery).toSatisfyJudge(
      RubricJudge,
      rubric({
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
    );

    expect(delivery.replies).toHaveLength(1);
    // The task names nobody, so the reminder mentions nobody.
    expect(delivery.replies[0]!.text).not.toMatch(/<@[UW]/);
  });

  test("when a recurring scheduled automation becomes due, deliver that occurrence", async ({
    run,
  }) => {
    await insertScheduledAutomation({
      credentialMode: "system",
      destination: slackChannel(),
      due: true,
      task: "Post this reminder: Submit timesheets by 5pm today.",
    });

    const delivery = await run(heartbeat());
    await expect(delivery).toSatisfyJudge(
      RubricJudge,
      rubric({
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
    );

    expect(delivery.replies).toHaveLength(1);
    expect(delivery.replies[0]!.text).not.toMatch(/<@[UW]/);
  });

  test("when a due reminder goes to its creator's DM, deliver the reminder itself", async ({
    run,
  }) => {
    await insertScheduledAutomation({
      credentialMode: "system",
      destination: slackChannel(),
      due: true,
      once: true,
      sendTo: [slackDirectMessage()],
      task: "Remind me to revisit the launch checklist before Thursday's review.",
    });

    const delivery = await run(heartbeat());
    await expect(delivery).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "Junior posts one reminder to revisit the launch checklist before Thursday's review.",
          "The reminder speaks to its recipient directly, by mention or as you, not about them in the third person.",
        ],
        fail: [
          "Do not say that Junior could not send a direct message or can only reply in another conversation.",
          "Do not ask someone else to pass the reminder on.",
          "Do not ask the user a question or for confirmation.",
        ],
      }),
    );

    expect(delivery.replies).toHaveLength(1);
  });
});
