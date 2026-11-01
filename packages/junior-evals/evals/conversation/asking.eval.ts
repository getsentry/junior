import { describe, expect } from "vitest";
import { heartbeat, person, slackMention } from "@junior-evals/fixture/inputs";
import {
  insertScheduledAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import { completedToolCalls, toolCallsOf } from "@junior-evals/fixture/results";
import { test, type ToolCall } from "@junior-evals/fixture/test";

const MAYA = person("UMAYA", "Maya");

/** The `request` of each action item that the agent added. */
function askedRequests(conversation: { toolCalls: ToolCall[] }) {
  return completedToolCalls("addReviewItem", conversation)
    .map((call) => call.input as { kind?: string; request?: unknown })
    .filter((input) => input.kind === "action")
    .map((input) => input.request);
}

describe("Asking a Person", () => {
  test("when the work needs facts that only the person knows, ask with a review item", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Can you write my out-of-office auto-reply for my vacation? Point people to Sam for anything urgent.",
        { author: MAYA },
      ),
    );

    // The dates are Maya's. The agent asks on the desk, not in plain text.
    expect(askedRequests(conversation)).not.toHaveLength(0);
  });

  test("when an Automation run needs the creator's decision, add an action item and finish the run", async ({
    run,
  }) => {
    await insertScheduledAutomation({
      createdBy: MAYA,
      credentialMode: "system",
      destination: slackChannel(),
      due: true,
      once: true,
      task: "Wednesday is a company holiday this week. Check with me whether to cancel Wednesday's team lunch or move it to Thursday, then post the plan here.",
    });

    const delivery = await run(heartbeat());

    expect(askedRequests(delivery)).not.toHaveLength(0);
    expect(toolCallsOf("finishAutomationRun", delivery)).not.toHaveLength(0);
  });
});
