import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { listUnfinishedWork } from "@/chat/plugins/unfinished-work";

describe("plugin unfinished work", () => {
  afterEach(() => setPlugins([]));

  it("combines plugin signals and ignores conversations outside the candidate set", async () => {
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "first",
          displayName: "First",
          description: "First unfinished work plugin",
        },
        hooks: {
          unfinishedWork() {
            return { conversationIds: ["conversation-a", "not-a-candidate"] };
          },
        },
      }),
      defineJuniorPlugin({
        manifest: {
          name: "second",
          displayName: "Second",
          description: "Second unfinished work plugin",
        },
        hooks: {
          unfinishedWork() {
            return { conversationIds: ["conversation-b", "conversation-a"] };
          },
        },
      }),
    ]);

    await expect(
      listUnfinishedWork([
        "conversation-a",
        "conversation-b",
        "conversation-c",
      ]),
    ).resolves.toEqual(["conversation-a", "conversation-b"]);
  });
});
