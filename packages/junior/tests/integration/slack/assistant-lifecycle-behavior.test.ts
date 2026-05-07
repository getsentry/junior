import { describe, expect, it } from "vitest";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import { FakeSlackAdapter } from "../../fixtures/slack-harness";

describe("Slack behavior: assistant lifecycle", () => {
  it("sets thread metadata for assistant thread started events", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createTestChatRuntime({ slackAdapter });

    await slackRuntime.handleAssistantThreadStarted({
      threadId: "slack:C_LIFECYCLE:1700006000.000",
      channelId: "C_LIFECYCLE",
      threadTs: "1700006000.000",
      userId: "U_TEST",
    });

    expect(slackAdapter.titleCalls).toEqual([
      {
        channelId: "C_LIFECYCLE",
        threadTs: "1700006000.000",
        title: "Junior",
      },
    ]);
    expect(slackAdapter.promptCalls).toHaveLength(1);
    expect(slackAdapter.promptCalls[0]?.prompts).toHaveLength(3);
  });

  it("does not reset the thread title on assistant context changes", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createTestChatRuntime({ slackAdapter });

    await slackRuntime.handleAssistantContextChanged({
      threadId: "slack:C_LIFECYCLE:1700006000.000",
      channelId: "C_LIFECYCLE",
      threadTs: "1700006000.000",
      userId: "U_TEST",
      context: {
        channelId: "C_CONTEXT",
      },
    });

    expect(slackAdapter.titleCalls).toEqual([]);
    expect(slackAdapter.promptCalls).toHaveLength(1);
    expect(slackAdapter.promptCalls[0]?.threadTs).toBe("1700006000.000");
  });
});
