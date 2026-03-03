import { afterEach, describe, expect, it } from "vitest";
import { appSlackRuntime, bot } from "@/chat/bot";
import { FakeSlackAdapter } from "../../fixtures/slack-harness";

describe("Slack behavior: assistant lifecycle", () => {
  const originalGetAdapter = (bot as unknown as { getAdapter: (name: string) => unknown }).getAdapter.bind(bot);

  afterEach(() => {
    (bot as unknown as { getAdapter: (name: string) => unknown }).getAdapter = originalGetAdapter;
  });

  it("sets thread metadata for assistant thread started events", async () => {
    const slackAdapter = new FakeSlackAdapter();

    (bot as unknown as { getAdapter: (name: string) => unknown }).getAdapter = (name: string) => {
      if (name === "slack") {
        return slackAdapter;
      }
      return originalGetAdapter(name);
    };

    await appSlackRuntime.handleAssistantThreadStarted({
      threadId: "slack:C_LIFECYCLE:1700006000.000",
      channelId: "C_LIFECYCLE",
      threadTs: "1700006000.000",
      userId: "U_TEST"
    });

    expect(slackAdapter.titleCalls).toEqual([
      {
        channelId: "C_LIFECYCLE",
        threadTs: "1700006000.000",
        title: "Junior"
      }
    ]);
    expect(slackAdapter.promptCalls).toHaveLength(1);
    expect(slackAdapter.promptCalls[0]?.prompts).toHaveLength(3);
  });
});
