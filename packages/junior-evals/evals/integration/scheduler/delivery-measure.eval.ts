// TEMPORARY: measures the scheduled delivery flake. Removed before review.
import { describe, expect } from "vitest";
import { heartbeat } from "@junior-evals/fixture/inputs";
import {
  insertScheduledAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import { test } from "@junior-evals/fixture/test";

describe("Scheduled Delivery measure", () => {
  for (let i = 0; i < 40; i++) {
    test(`delivers a reminder through reply #${i}`, async ({ run }) => {
      await insertScheduledAutomation({
        credentialMode: "system",
        destination: slackChannel(),
        due: true,
        once: true,
        task: "Post this reminder: Submit timesheets by 5pm today.",
      });
      const delivery = await run(heartbeat());
      expect(delivery.replies).toHaveLength(1);
    });
  }
});
