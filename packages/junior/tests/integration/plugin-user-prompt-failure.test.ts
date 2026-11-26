import { afterEach, describe, expect, it } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createApp, defineJuniorPlugins } from "@/app";
import { createAgent } from "../fixtures/agent";
import { closeConversationFixture } from "../fixtures/conversation";
import { mockTitleModel } from "../fixtures/title-model";

describe("a plugin whose Turn context fails", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("says in the Turn context that its context could not load", async () => {
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "broken",
            displayName: "Broken",
            description: "A plugin whose Turn context fails",
          },
          hooks: {
            userPrompt() {
              throw new Error("lookup failed");
            },
          },
        }),
      ]),
    });
    mockTitleModel("Conversation title");
    const agent = await createAgent({ responses: ["Reply."] });

    await agent.run("first");

    expect(JSON.stringify(agent.snapshot().messages)).toContain(
      '<plugin-contribution plugin=\\"broken\\" id=\\"userPrompt:0\\">\\nThe context of this plugin could not load for this Turn.',
    );
  });
});
