import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import {
  lastTurnReplies,
  mention,
  rubric,
  slackEvals,
  threadMessage,
} from "../../src/helpers";

describeEval("Thread Continuity", slackEvals, (it) => {
  const continuityThread = {
    id: "thread-continuity",
    channel_id: "CCONTINUITY",
    thread_ts: "17000000.1303",
  };

  it("when a follow-up asks about the prior turn, recall the earlier budget context", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention("I need the budget by Friday.", { thread: continuityThread }),
      ],
      events: [
        threadMessage("what did i just ask?", {
          thread: continuityThread,
          is_mention: true,
        }),
      ],
      criteria: rubric({
        pass: [
          "The second reply explicitly references the earlier budget context, including budget and/or Friday.",
        ],
        fail: ["Do not return sandbox setup failure text."],
      }),
    });

    expect(lastTurnReplies(result.session).length).toBeGreaterThan(0);
  });
});
