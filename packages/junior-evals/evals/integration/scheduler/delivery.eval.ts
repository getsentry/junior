import { describe, expect } from "vitest";
import { heartbeat } from "@junior-evals/fixture/inputs";
import {
  insertScheduledAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Scheduled Delivery", () => {
  test("when a due reminder says me, mention its creator", async ({ run }) => {
    await insertScheduledAutomation({
      credentialMode: "system",
      destination: slackChannel(),
      due: true,
      once: true,
      task: "Remind me to do healthchecks.",
    });

    const delivery = await run(heartbeat());

    expect(delivery.replies).toHaveLength(1);
    expect(delivery.replies[0]!.text).toContain("<@U0TEST>");
  });

  test("when a due automation has no message outcome, do the work without posting", async ({
    run,
  }) => {
    await insertScheduledAutomation({
      credentialMode: "system",
      destination: slackChannel(),
      due: true,
      once: true,
      sendTo: [],
      task: "Check the current UTC time.",
    });

    const silent = await run(heartbeat());

    expect(silent.replies).toEqual([]);
    expect(
      completedToolCalls("finishAutomationRun", silent).map(
        (call) => call.input,
      ),
    ).toEqual([expect.objectContaining({ result: "no_action" })]);
  });
});
