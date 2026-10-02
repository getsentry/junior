import { describe, expect } from "vitest";
import { mention } from "../../../src/fixture/inputs";
import { completedToolCalls } from "../../../src/fixture/results";
import { test } from "../../../src/fixture/test";

describe("Conversation Actions", () => {
  test("when the request is reaction-only, add a reaction without reply clutter", async ({
    run,
  }) => {
    const conversation = await run(mention("give me a heart reaction"));

    expect(completedToolCalls("addReaction", conversation)).not.toHaveLength(0);
    expect(conversation.reactions).toEqual(
      expect.arrayContaining(["heart", "white_check_mark"]),
    );
    expect(conversation.replies).toEqual([]);
  });
});
