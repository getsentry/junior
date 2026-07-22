import { describeEval } from "vitest-evals";
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

  it("when a sandbox command is interrupted at a turn deadline, continue the task to completion", async ({
    run,
  }) => {
    const command =
      "printf 'timeout continuation completed\\n' > /tmp/timeout-continuation-result.txt && cat /tmp/timeout-continuation-result.txt";
    await run({
      overrides: {
        timeout_resume: { command },
      },
      initialEvents: [
        mention(
          "Run the requested sandbox command and report its exact output when the work is complete.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The final reply reports the exact output `timeout continuation completed`.",
          "The assistant reconciles the interrupted command and finishes the original request.",
        ],
        fail: [
          "The reply only reports that the work was interrupted or timed out.",
          "The assistant asks the user to retry instead of completing the task.",
        ],
      }),
    });
  });
});
