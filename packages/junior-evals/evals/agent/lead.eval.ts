import { describe, expect } from "vitest";
import { webMessage } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

// The Lead could write a short draft in its own reply. The case measures
// whether it hands the work to a Conversation instead.
describe("Lead", () => {
  test("when a person asks their Lead for work, it starts a Conversation for it and does not do it itself", async ({
    run,
  }) => {
    const conversation = await run(
      webMessage(
        "can you write a short changelog entry for the new CSV export on the billing page? three bullets max",
        { lead: true },
      ),
    );

    expect(
      completedToolCalls("startConversation", conversation).length +
        completedToolCalls("messageAgent", conversation).length,
    ).toBeGreaterThan(0);
  });
});
