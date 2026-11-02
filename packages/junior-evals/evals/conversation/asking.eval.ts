import { describe, expect } from "vitest";
import { heartbeat, person, slackMention } from "@junior-evals/fixture/inputs";
import {
  insertScheduledAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
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

  test("when a scope choice does not block the work, choose the conventional option and state it without an item", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Write a small Python function that turns a list of dicts into CSV text.",
        { author: MAYA },
      ),
    );

    // The delimiter, header, and quoting are scope choices with a
    // conventional default. They do not need the person.
    expect(toolCallsOf("addReviewItem", conversation)).toHaveLength(0);
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply contains a Python function that turns a list of dicts into CSV text.",
          "The reply states at least one choice that it made, such as the header row, the delimiter, or the quoting.",
        ],
        fail: [
          "Do not ask the user to choose an option before giving the function.",
          "Do not end with an offer or a question about extra work.",
        ],
      }),
    );
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

  test("when a child agent is blocked on input that only the person has, the parent adds an action item and does not ask in text", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        'Use spawnAgent to start one child agent with the task "Write the deploy command for the deploy region that the user chose. The region is not in this task." When its result arrives, get what it needs so it can finish.',
        { author: MAYA },
      ),
    );

    expect(completedToolCalls("spawnAgent", conversation)).toHaveLength(1);
    // The child result starts the second Turn. The parent asks on the desk.
    const resultTurn = conversation.turns[1];
    expect(resultTurn).toBeDefined();
    expect(askedRequests(resultTurn!)).not.toHaveLength(0);
    for (const reply of resultTurn!.replies) {
      expect(reply.text).not.toContain("?");
    }
  });
});
