/**
 * A redeploy changes the app's options between calls, and a Conversation
 * continues on the new app with its history.
 */
import { describe, expect } from "vitest";
import { slackMention } from "./inputs";
import { test } from "./test";

describe("redeploy", () => {
  test("continues a Conversation on an app with new options", async ({
    agent,
  }) => {
    const { run, redeploy } = await agent();
    const first = await run(
      slackMention("The code word is MAPLE-7. Reply with exactly: noted"),
    );
    expect(first.reactions).toEqual(["eyes", "white_check_mark"]);

    await redeploy({
      slack: {
        processingReactionEmoji: "hourglass",
        completedReactionEmoji: "ok_hand",
      },
    });
    const second = await first.continue(
      slackMention("What is the code word? Reply with only the code word."),
    );

    expect(second.reactions).toEqual(["hourglass", "ok_hand"]);
    expect(second.replies.map((reply) => reply.text).join("\n")).toContain(
      "MAPLE-7",
    );
  });
});
