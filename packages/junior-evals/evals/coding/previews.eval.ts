import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { completedToolCalls, toolOutput } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Coding Previews", () => {
  test("when changing a web app's UI, share a preview URL without being asked", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "/web-app-fixture the prices on the menu are hard to read. make them bigger and line them up on the right",
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
