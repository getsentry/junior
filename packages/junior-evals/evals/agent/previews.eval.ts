import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { completedToolCalls, toolOutput } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

// This suite has no fixture skills, so this case covers a request with no repo.
// `evals/coding/previews.eval.ts` covers a UI change in a repo checkout.
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
