import { describe, expect, it } from "vitest";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

describe("Slack behavior: assistant context channel routing", () => {
  it("prefers assistantContextChannelId over DM channel for tool execution context", async () => {
    const capturedToolChannelIds: Array<string | undefined> = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            capturedToolChannelIds.push(context?.toolChannelId);
            return {
              text: "Canvas draft prepared.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:D_DM_THREAD:1700007000.000",
      state: {
        artifacts: {
          assistantContextChannelId: "C_SHARED_CONTEXT",
        },
      },
    });
    const message = createTestMessage({
      id: "m-assistant-context-1",
      text: "<@U_APP> create a shared canvas update",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleNewMention(thread, message);

    expect(capturedToolChannelIds).toEqual(["C_SHARED_CONTEXT"]);
  });
});
