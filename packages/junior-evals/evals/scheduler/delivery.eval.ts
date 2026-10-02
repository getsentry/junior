import { describe, expect } from "vitest";
import { heartbeat } from "../../src/fixture/inputs";
import {
  insertScheduledAutomation,
  slackChannel,
} from "../../src/fixture/insert";
import { rubric } from "../../src/fixture/judge";
import { test } from "../../src/fixture/test";

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

    const delivery = await run(heartbeat(), {
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

    expect(delivery.replies).toHaveLength(1);
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

    const delivery = await run(heartbeat(), {
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

    expect(delivery.replies).toHaveLength(1);
  });
});
