import { describe, expect } from "vitest";
import { mention } from "@junior-evals/fixture/inputs";
import {
  insertScheduledAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

const alice = {
  fullName: "Alice Example",
  userId: "UALICE",
  userName: "alice",
};

describe("Schedule Management", () => {
  test("when asked to reschedule an existing task, replace its cadence", async ({
    run,
  }) => {
    const channel = slackChannel();
    await insertScheduledAutomation({
      createdBy: alice,
      credentialMode: "system",
      destination: channel,
      task: "Post a planning reminder in this channel.",
    });

    const proposal = await run(
      mention(
        "prepare to change the scheduled planning reminder to Tuesdays at 10am Pacific, but ask me before applying the change.",
        { author: alice, channel },
      ),
    );
    const confirmation = await proposal.continue(
      mention("Yes, apply that schedule change now.", { author: alice }),
    );
    await expect(confirmation.evalRun).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "After the requested confirmation, the reply confirms that the scheduled automation now runs every Tuesday at 10am Pacific.",
        ],
        fail: [
          "Do not claim the task still runs on Monday at 9am.",
          "Do not ask for another confirmation after the user says to apply the change.",
        ],
      }),
    );

    expect(
      completedToolCalls(
        "slackScheduleCreateAutomation",
        proposal,
        confirmation,
      ),
    ).toEqual([]);
    const updates = completedToolCalls(
      "slackScheduleUpdateAutomation",
      proposal,
      confirmation,
    );
    expect(updates).toContainEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          schedule: expect.objectContaining({
            kind: "recurring",
            frequency: "weekly",
            time: "10:00",
            weekdays: ["tuesday"],
          }),
        }),
      }),
    );
    for (const update of updates) {
      expect(update.input).not.toHaveProperty("nextRunAt");
    }
  });
});
