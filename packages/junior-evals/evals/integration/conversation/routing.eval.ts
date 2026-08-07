import { assistantMessages, describeEval } from "vitest-evals";
import { expect } from "vitest";
import {
  mention,
  rubric,
  slackEvals,
  threadMessage,
  visibleAssistantText,
  visibleThreadReplies,
} from "../../../src/helpers";

describeEval("Conversation Routing", slackEvals, (it) => {
  it("when a thread message explicitly mentions Junior, post a direct reply", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [threadMessage("What is 2+2?", { is_mention: true })],
      criteria: rubric({
        pass: ["The reply answers with 4."],
        fail: ["Do not return sandbox setup failure text."],
      }),
    });

    const replies = visibleThreadReplies(result.session);
    expect(replies).toHaveLength(1);
    expect(visibleAssistantText(result.session).length).toBeLessThanOrEqual(
      800,
    );
  });

  it("when asked to post in another named channel, explain the limitation instead", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "@bot post this in #discuss-design-engineering instead: Heads up, design review starts in 10 minutes.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply clearly says the assistant can only post to the current channel or cannot post to #discuss-design-engineering from here.",
        ],
        fail: [
          "Do not send a direct channel post to the current channel.",
          "Do not claim the message was posted to #discuss-design-engineering.",
        ],
      }),
    });

    expect(
      assistantMessages(result.session).filter(
        (message) => message.metadata?.event_type === "channel_post",
      ),
    ).toHaveLength(0);
    expect(visibleThreadReplies(result.session).length).toBeGreaterThan(0);
  });
});
