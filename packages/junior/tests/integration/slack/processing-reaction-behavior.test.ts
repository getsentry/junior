import { describe, expect, it } from "vitest";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";

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

function reactionCall(name: string, timestamp: string) {
  return expect.objectContaining({
    params: expect.objectContaining({
      channel: "C_PROCESSING",
      timestamp,
      name,
    }),
  });
}

describe("Slack behavior: processing reaction", () => {
  it("adds eyes before mention work and marks the message complete after the reply", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            expect(slackApiOutbox.reactionAdds()).toHaveLength(1);
            expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
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
      { destination: createTestDestination(thread) },
    );

    expect(slackApiOutbox.reactionAdds()).toEqual([
      reactionCall("eyes", "1700007001.000000"),
      reactionCall("white_check_mark", "1700007001.000000"),
    ]);
    expect(slackApiOutbox.reactionRemovals()).toEqual([
      reactionCall("eyes", "1700007001.000000"),
    ]);
  });

  it("does not add eyes when a subscribed message is skipped", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            expect(slackApiOutbox.reactionAdds()).toHaveLength(0);
            expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
            return {
              object: {
                should_reply: false,
                confidence: 0,
                reason: "side conversation",
              },
              text: '{"should_reply":false,"confidence":0,"reason":"side conversation"}',
            } as never;
          },
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
      { destination: createTestDestination(thread) },
    );

    expect(thread.posts).toHaveLength(0);
    expect(slackApiOutbox.reactionAdds()).toHaveLength(0);
    expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
  });

  it("adds eyes after a subscribed message is approved and marks the message complete after the reply", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            expect(slackApiOutbox.reactionAdds()).toHaveLength(0);
            expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
            return {
              object: {
                should_reply: true,
                should_unsubscribe: false,
                confidence: 1,
                reason: "direct follow-up",
              },
              text: '{"should_reply":true,"should_unsubscribe":false,"confidence":1,"reason":"direct follow-up"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            expect(slackApiOutbox.reactionAdds()).toHaveLength(1);
            expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
            return {
              text: "Done.",
              diagnostics: successDiagnostics(),
            };
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_PROCESSING:1700007150.000000",
    });
    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "1700007151.000000",
        text: "can you check this next?",
        isMention: false,
        threadId: thread.id,
        raw: {
          channel: "C_PROCESSING",
          ts: "1700007151.000000",
          thread_ts: "1700007150.000000",
        },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(slackApiOutbox.reactionAdds()).toEqual([
      reactionCall("eyes", "1700007151.000000"),
      reactionCall("white_check_mark", "1700007151.000000"),
    ]);
    expect(slackApiOutbox.reactionRemovals()).toEqual([
      reactionCall("eyes", "1700007151.000000"),
    ]);
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
      { destination: createTestDestination(thread) },
    );

    expect(slackApiOutbox.reactionAdds()).toHaveLength(1);
    expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
  });
});
