import { describe, expect } from "vitest";
import { mention, threadMessage } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

describe("Conversation Routing", () => {
  test("when a thread message explicitly mentions Junior, post a direct reply", async ({
    run,
  }) => {
    const conversation = await run(mention("What is 2+2?"), {
      history: [
        threadMessage("Quick math check before standup.", {
          author: { fullName: "Sam Example", userId: "U0SAM", userName: "sam" },
        }),
      ],
    });
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["The reply answers with 4."],
        fail: ["Do not return sandbox setup failure text."],
      }),
    );

    expect(conversation.replies).toHaveLength(1);
    expect(conversation.replies[0]!.text.length).toBeLessThanOrEqual(800);
  });

  test("when asked to post in another named channel, explain the limitation instead", async ({
    run,
  }) => {
    const conversation = await run(
      mention(
        "post this in #discuss-design-engineering instead: Heads up, design review starts in 10 minutes.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply clearly says the assistant can only post to the current channel or cannot post to #discuss-design-engineering from here.",
        ],
        fail: [
          "Do not send a direct channel post to the current channel.",
          "Do not claim the message was posted to #discuss-design-engineering.",
        ],
      }),
    );

    expect(conversation.replies.length).toBeGreaterThan(0);
  });
});
