import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import {
  slackEvals,
  slackSideEffects,
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
});
