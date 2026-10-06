import { describe, expect } from "vitest";
import { mention, reply } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

describe("Thread Continuity", () => {
  test("when a follow-up asks about the prior turn, recall the earlier budget context", async ({
    run,
  }) => {
    const conversation = await run(mention("what did i just ask?"), {
      history: [
        mention("I need the budget by Friday."),
        reply("Got it: budget due Friday."),
      ],
    });
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply explicitly references the earlier budget context, including budget and/or Friday.",
        ],
        fail: ["Do not return sandbox setup failure text."],
      }),
    );

    expect(conversation.replies).toHaveLength(1);
  });
});
