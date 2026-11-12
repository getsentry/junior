import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { completedToolCalls, toolOutput } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

// This suite has no fixture skills. A workspace skill that says "make only the
// requested change" would hide whether Junior shares a preview by itself.
describe("Previews", () => {
  test("when asked to build a web page, share a preview URL without being asked", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Can you make me a simple one-page website for my lemonade stand, Sunny Cups? Show the menu with prices.",
      ),
    );

    const previewUrls = completedToolCalls("createPreview", conversation).map(
      (call) => (toolOutput(call) as { url?: string }).url,
    );
    expect(previewUrls).not.toHaveLength(0);
    expect(
      conversation.replies.some((reply) =>
        previewUrls.some((url) => url && reply.text.includes(url)),
      ),
    ).toBe(true);
  });
});
