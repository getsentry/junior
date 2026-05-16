import { describe, expect, it } from "vitest";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";

function successDiagnostics(toolCalls: string[] = []) {
  return {
    assistantMessageCount: 1,
    modelId: "fake-agent-model",
    outcome: "success" as const,
    toolCalls,
    toolErrorCount: 0,
    toolResultCount: toolCalls.length,
    usedPrimaryText: true,
  };
}

describe("Slack behavior: processing reaction", () => {
  it("adds eyes before mention work and removes it after the reply", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            expect(getCapturedSlackApiCalls("reactions.add")).toHaveLength(1);
            expect(getCapturedSlackApiCalls("reactions.remove")).toHaveLength(
              0,
            );
            return {
              text: "Done.",
              diagnostics: successDiagnostics(),
            };
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_PROCESSING:1700007000.000000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700007001.000000",
        text: "<@U_APP> handle this",
        isMention: true,
        threadId: thread.id,
        raw: {
          channel: "C_PROCESSING",
          ts: "1700007001.000000",
          thread_ts: "1700007000.000000",
        },
      }),
    );

    expect(getCapturedSlackApiCalls("reactions.add")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C_PROCESSING",
          timestamp: "1700007001.000000",
          name: "eyes",
        }),
      }),
    ]);
    expect(getCapturedSlackApiCalls("reactions.remove")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C_PROCESSING",
          timestamp: "1700007001.000000",
          name: "eyes",
        }),
      }),
    ]);
  });

  it("removes eyes when a subscribed message is skipped", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () =>
            ({
              object: {
                should_reply: false,
                confidence: 0,
                reason: "side conversation",
              },
              text: '{"should_reply":false,"confidence":0,"reason":"side conversation"}',
            }) as never,
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            throw new Error("assistant should not run for skipped message");
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_PROCESSING:1700007100.000000",
    });
    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "1700007101.000000",
        text: "sounds good, thanks",
        isMention: false,
        threadId: thread.id,
        raw: {
          channel: "C_PROCESSING",
          ts: "1700007101.000000",
          thread_ts: "1700007100.000000",
        },
      }),
    );

    expect(thread.posts).toHaveLength(0);
    expect(getCapturedSlackApiCalls("reactions.add")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("reactions.remove")).toHaveLength(1);
  });

  it("keeps eyes when the assistant explicitly adds an eyes reaction", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            context?.onToolInvocation?.({
              toolName: "slackMessageAddReaction",
              params: { emoji: ":eyes:" },
            });
            return {
              text: "Done.",
              diagnostics: successDiagnostics(["slackMessageAddReaction"]),
            };
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_PROCESSING:1700007200.000000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700007201.000000",
        text: "<@U_APP> add eyes to this",
        isMention: true,
        threadId: thread.id,
        raw: {
          channel: "C_PROCESSING",
          ts: "1700007201.000000",
          thread_ts: "1700007200.000000",
        },
      }),
    );

    expect(getCapturedSlackApiCalls("reactions.add")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("reactions.remove")).toHaveLength(0);
  });
});
