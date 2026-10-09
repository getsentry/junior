import { describe, expect } from "vitest";
import { heartbeat, slackMention } from "@junior-evals/fixture/inputs";
import {
  insertScheduledAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import {
  completedToolCalls,
  toolCallsOf,
  toolOutput,
} from "@junior-evals/fixture/results";
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

  test("when a person replies to a delivered reminder, answer in its thread as a normal chat reply", async ({
    run,
  }) => {
    await insertScheduledAutomation({
      credentialMode: "system",
      destination: slackChannel(),
      due: true,
      once: true,
      task: "Post this reminder: Submit timesheets by 5pm today.",
    });

    const delivery = await run(heartbeat());
    expect(delivery.replies).toHaveLength(1);

    const followUp = await delivery.continue(
      slackMention("What time are they due? Answer with the time only."),
    );

    expect(followUp.turns.map((turn) => turn.status)).toEqual(["succeeded"]);
    expect(followUp.replies).toHaveLength(1);
    expect(followUp.replies[0]!.text).toMatch(/5\s*pm/i);
    // The reply is a chat Turn. It does not end with a declared result.
    expect(toolCallsOf("finishAutomationRun", followUp)).toEqual([]);
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
      completedToolCalls("finishAutomationRun", silent).map(toolOutput),
    ).toEqual([expect.objectContaining({ result: "no_action" })]);
  });
});
