import { afterEach, describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestDestination,
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack/harness";

interface RuntimeCall {
  contextConversation?: string;
  piMessages?: PiMessage[];
}

describe("Slack behavior: Pi history", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("passes durable Pi history into the next turn", async () => {
    const calls: RuntimeCall[] = [];
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
    const { slackRuntime } = createTestChatRuntime({
      adapters: {
        classifySubscribedReply: async () => {
          return {
            object: {
              should_reply: true,
              confidence: 1,
              reason: "direct mention follow-up",
            },
            text: '{"should_reply":true,"confidence":1,"reason":"direct mention follow-up"}',
          } as never;
        },
        generateAssistantReply: async (_prompt, context) => {
          calls.push({
            contextConversation: context?.conversationContext,
            piMessages: context?.piMessages,
          });
          if (
            calls.length === 1 &&
            context?.correlation?.conversationId &&
            context.correlation.turnId
          ) {
            await upsertAgentTurnSessionRecord({
              conversationId: context.correlation.conversationId,
              sessionId: context.correlation.turnId,
              sliceId: 1,
              state: "completed",
              piMessages: storedFirstTurnHistory,
            });
          }
          return successfulAssistantReply(
            calls.length === 1 ? "First response." : "Second response.",
          );
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

    await slackRuntime.handleNewMention(thread, first, {
      destination: createTestDestination(thread),
    });

    const persistedState = await getPersistedThreadState(thread.id);
    const conversation = coerceThreadConversationState(persistedState);
    conversation.processing.activeTurnId = "missing-active-turn";
    await persistThreadStateById(thread.id, { conversation });

    await slackRuntime.handleSubscribedMessage(thread, second, {
      destination: createTestDestination(thread),
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.contextConversation ?? "").toContain("budget by Friday");
    expect(calls[1]?.piMessages).toEqual(storedFirstTurnHistory);
  });
});
