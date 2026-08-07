import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import {
  mention,
  reactionEmojis,
  slackEvals,
  visibleAssistantText,
  visibleThreadReplies,
} from "../../../src/helpers";

describeEval("Conversation Actions", slackEvals, (it) => {
  it("when the request is reaction-only, add a reaction without reply clutter", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [mention("give me a heart reaction")],
    });
    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "addReaction" }),
      ]),
    );
    const emojis = reactionEmojis(result.session);
    // Final Slack reaction set after processing lifecycle: processing emoji
    // removed, completed emoji added, plus the user-requested reaction.
    expect(emojis).not.toContain("eyes");
    expect(emojis).toEqual(expect.arrayContaining(["white_check_mark"]));
    expect(emojis).toContain("heart");
    expect(visibleThreadReplies(result.session)).toEqual([]);
    expect(visibleAssistantText(result.session)).not.toContain(NO_REPLY_MARKER);
  });
});
