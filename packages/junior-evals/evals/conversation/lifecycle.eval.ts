import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import {
  mention,
  rubric,
  slackEvals,
  slackSideEffects,
  threadMessage,
  threadStart,
  visibleThreadReplies,
} from "../../src/helpers";

describeEval("Lifecycle and Resilience", slackEvals, (it) => {
  it("when an assistant thread starts, set title and prompts without posting a reply", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [threadStart()],
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(0);
    expect(slackSideEffects(result)).toMatchObject({
      suggestedPromptCalls: 1,
      threadTitleCalls: 1,
    });
  });

  it("when a tool call is interrupted at a turn deadline, continue the task to completion", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        timeout_resume: { tool_name: "systemTime", arguments: {} },
      },
      initialEvents: [
        mention(
          "Tell me the current UTC time. If the previous attempt was interrupted, continue and finish the request.",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The final reply reports the current time in UTC.",
          "The assistant continues after the interrupted tool call and finishes the original request.",
        ],
        fail: [
          "The reply only reports that the work was interrupted or timed out.",
          "The assistant asks the user to retry instead of completing the task.",
        ],
      }),
    });

    expect(toolCalls(result.session)).toContainEqual(
      expect.objectContaining({ name: "systemTime", status: "ok" }),
    );
    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });
});
