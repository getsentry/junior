import { describe, expect } from "vitest";
import { heartbeat } from "../../../src/fixture/inputs";
import {
  insertScheduledAutomation,
  slackChannel,
} from "../../../src/fixture/insert";
import { test } from "../../../src/fixture/test";

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
});
