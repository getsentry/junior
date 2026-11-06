import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Conversation Actions", () => {
  test("when asked for an eyes reaction, keep it after the turn", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "add an eyes reaction to this message so the team knows you are watching it",
      ),
    );

    expect(completedToolCalls("addReaction", conversation)).not.toHaveLength(0);
    // The requested emoji is also the processing reaction. Junior keeps it,
    // so the turn does not replace it with the completed reaction.
    expect(conversation.reactions).toEqual(["eyes"]);
  });
});
