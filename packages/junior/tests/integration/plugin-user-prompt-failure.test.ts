import { afterEach, describe, expect, it } from "vitest";
import {
  defineJuniorPlugin,
  type PromptMessage,
} from "@sentry/junior-plugin-api";
import { createApp, defineJuniorPlugins } from "@/app";
import { createAgent } from "../fixtures/agent";
import { closeConversationFixture } from "../fixtures/conversation";
import { mockTitleModel } from "../fixtures/title-model";

describe("a plugin whose Turn context fails", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  async function turnContext(userPrompt: () => PromptMessage[]) {
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "broken",
            displayName: "Broken",
            description: "A plugin whose Turn context fails",
          },
          hooks: { userPrompt },
        }),
      ]),
    });
    mockTitleModel("Conversation title");
    const agent = await createAgent({ responses: ["Reply."] });
    await agent.run("first");
    return JSON.stringify(agent.snapshot().messages);
  }

  const note =
    '<plugin-contribution plugin=\\"broken\\" id=\\"userPrompt:0\\">\\nThe context of this plugin could not load for this Turn.';

  it("says in the Turn context that its context could not load", async () => {
    const text = await turnContext(() => {
      throw new Error("lookup failed");
    });

    expect(text).toContain(note);
  });

  it("says so when its context does not fit the shared budget", async () => {
    const text = await turnContext(() =>
      Array.from({ length: 3 }, () => ({ text: "x".repeat(6_000) })),
    );

    expect(text).toContain(note);
    expect(text).not.toContain("x".repeat(6_000));
  });
});
