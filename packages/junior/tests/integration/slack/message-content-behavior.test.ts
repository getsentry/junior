import { afterEach, describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionCheckpoint } from "@/chat/state/turn-session-store";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

interface CapturedCall {
  contextConversation?: string;
  piMessages?: PiMessage[];
  prompt: string;
}

describe("Slack behavior: message content", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("strips leading Slack mention token before invoking the agent", async () => {
    const calls: CapturedCall[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            return {
              object: {
                should_reply: true,
                confidence: 1,
                reason: "direct mention follow-up",
              },
              text: '{"should_reply":true,"confidence":1,"reason":"direct mention follow-up"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async (prompt, context) => {
            calls.push({
              prompt,
              contextConversation: context?.conversationContext,
            });
            return {
              text: "Summary sent.",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700005000.000" });
    const message = createTestMessage({
      id: "m-content-strip",
      text: "<@U_APP>   please summarize the deploy status",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleNewMention(thread, message);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("please summarize the deploy status");
  });

  it("preserves non-leading mention tokens in user content", async () => {
    const calls: CapturedCall[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (prompt) => {
            calls.push({ prompt });
            return {
              text: "Done.",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700005001.000" });
    const message = createTestMessage({
      id: "m-content-preserve",
      text: "<@U_APP> remind me to message <@U_ONCALL> after deploy",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleNewMention(thread, message);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("message <@U_ONCALL> after deploy");
  });

  it("passes legacy attachment text into the current turn prompt", async () => {
    const calls: CapturedCall[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (prompt, context) => {
            calls.push({
              prompt,
              contextConversation: context?.conversationContext,
            });
            return {
              text: "Alert reviewed.",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700005002.500" });
    const message = createTestMessage({
      id: "m-content-legacy-attachment",
      text: "<@U_APP>",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
      raw: {
        channel: "C_BEHAVIOR",
        ts: "1700005002.500",
        thread_ts: "1700005002.500",
        attachments: [
          {
            fallback: "Deploy failed on production",
            title: "Production deploy",
            text: "OOM on pod-42",
            fields: [{ title: "Service", value: "checkout" }],
            footer: "Datadog Monitor",
          },
        ],
      },
    });

    await slackRuntime.handleNewMention(thread, message);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("Production deploy");
    expect(calls[0]?.prompt).toContain("OOM on pod-42");
    expect(calls[0]?.prompt).toContain("Service: checkout");
  });

  it("does not invoke the agent for self-authored mention messages", async () => {
    let replyCalled = false;

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCalled = true;
            return {
              text: "Should not happen",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700005002.000" });
    const message = createTestMessage({
      id: "m-content-self",
      text: "<@U_APP> do not respond",
      isMention: true,
      threadId: thread.id,
      author: {
        userId: "U_BOT",
        isMe: true,
      },
    });

    await slackRuntime.handleNewMention(thread, message);

    expect(replyCalled).toBe(false);
    expect(thread.posts).toHaveLength(0);
  });

  it("passes durable Pi history into the next turn", async () => {
    const calls: CapturedCall[] = [];
    const storedFirstTurnHistory: PiMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<runtime-turn-context>\nold runtime facts\n</runtime-turn-context>",
          },
          { type: "text", text: "I need the budget by Friday" },
        ],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "First response." }],
        timestamp: 2,
      },
    ] as PiMessage[];
    const expectedHistory: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "I need the budget by Friday" }],
        timestamp: 1,
      },
      storedFirstTurnHistory[1]!,
    ] as PiMessage[];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            return {
              object: {
                should_reply: true,
                confidence: 1,
                reason: "direct mention follow-up",
              },
              text: '{"should_reply":true,"confidence":1,"reason":"direct mention follow-up"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async (prompt, context) => {
            calls.push({
              prompt,
              contextConversation: context?.conversationContext,
              piMessages: context?.piMessages,
            });
            if (
              calls.length === 1 &&
              context?.correlation?.conversationId &&
              context.correlation.turnId
            ) {
              await upsertAgentTurnSessionCheckpoint({
                conversationId: context.correlation.conversationId,
                sessionId: context.correlation.turnId,
                sliceId: 1,
                state: "completed",
                piMessages: storedFirstTurnHistory,
              });
            }
            return {
              text: calls.length === 1 ? "First response." : "Second response.",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700005003.000" });
    const first = createTestMessage({
      id: "m-content-context-1",
      text: "<@U_APP> I need the budget by Friday",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });
    const second = createTestMessage({
      id: "m-content-context-2",
      text: "<@U_APP> what did I just ask?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleNewMention(thread, first);

    const persistedState = await getPersistedThreadState(thread.id);
    const conversation = coerceThreadConversationState(persistedState);
    conversation.processing.activeTurnId = "missing-active-turn";
    await persistThreadStateById(thread.id, { conversation });

    await slackRuntime.handleSubscribedMessage(thread, second);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.contextConversation ?? "").toContain("budget by Friday");
    expect(calls[1]?.piMessages).toEqual(expectedHistory);
  });
});
