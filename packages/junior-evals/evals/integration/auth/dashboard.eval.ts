import { describe, expect } from "vitest";
import {
  completeAuth,
  slackMention,
  webMessage,
} from "@junior-evals/fixture/inputs";
import { completedMcpToolCalls } from "@junior-evals/fixture/results";
import { test, type Conversation } from "@junior-evals/fixture/test";

const BUDGET_ECHO = "mcp__eval-auth__budget-echo";

function turnStates(conversation: Conversation) {
  return conversation.turns.map((turn) => turn.status);
}

describe("Dashboard Authorization", () => {
  test("when a dashboard turn needs authorization, show a connect prompt and resume after it", async ({
    run,
  }) => {
    const paused = await run(webMessage("/eval-auth Look up the budget."));
    expect(turnStates(paused)).toEqual(["started"]);
    expect(paused.authorizationPrompt).toEqual(expect.any(String));

    const resumed = await paused.continue(completeAuth("eval-auth"));
    expect(turnStates(resumed)).toEqual(["succeeded"]);
    expect(resumed.authorizationPrompt).toBeUndefined();
    expect(completedMcpToolCalls(BUDGET_ECHO, resumed)).toHaveLength(1);
  });

  test("when a dashboard message in a Slack Conversation needs authorization, resume as the dashboard person", async ({
    run,
  }) => {
    const thread = await run(slackMention("Say hello."));

    const paused = await thread.continue(
      webMessage("/eval-auth Look up the budget."),
    );
    expect(turnStates(paused)).toEqual(["started"]);
    expect(paused.authorizationPrompt).toEqual(expect.any(String));

    // The credential belongs to the dashboard person, not to the Slack
    // person. A turn that resumes as the Slack person cannot do the lookup.
    const resumed = await paused.continue(completeAuth("eval-auth"));
    expect(turnStates(resumed)).toEqual(["succeeded"]);
    expect(completedMcpToolCalls(BUDGET_ECHO, resumed)).toHaveLength(1);
  });

  test("when the person sends a new message without authorizing, answer it and remove the connect prompt", async ({
    run,
  }) => {
    const paused = await run(webMessage("/eval-auth Look up the budget."));
    expect(turnStates(paused)).toEqual(["started"]);
    expect(paused.authorizationPrompt).toEqual(expect.any(String));

    const next = await paused.continue(
      webMessage("Never mind the budget. What is 17 + 25?"),
    );
    expect(turnStates(next).at(-1)).toBe("succeeded");
    expect(next.replies.at(-1)?.text).toContain("42");
    expect(next.authorizationPrompt).toBeUndefined();
  });
});
