import { afterEach, describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { persistThreadState } from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { commitMessages } from "@/chat/state/session-log";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestDestination,
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

interface RuntimeCall {
  piMessages?: PiMessage[];
}

describe("Slack behavior: context compaction", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("auto compacts oversized reusable Pi history before the next turn", async () => {
    const calls: RuntimeCall[] = [];
    const priorMessages: PiMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<runtime-turn-context>\nbootstrap instructions that must be replaced after compaction\n</runtime-turn-context>",
          },
          { type: "text", text: "old context ".repeat(5_000) },
        ],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old answer ".repeat(1_000) }],
        timestamp: 2,
      },
    ] as PiMessage[];
    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700005005.000" });
    await commitMessages({
      conversationId: thread.id,
      messages: priorMessages,
      ttlMs: 60_000,
    });
    const conversation = coerceThreadConversationState({});
    await persistThreadState(thread, { conversation });

    const { slackAdapter, slackRuntime } = createTestChatRuntime({
      services: {
        contextCompactor: {
          completeText: async () =>
            ({
              text: "Compacted summary: old context is still relevant.",
            }) as never,
          autoCompactionTriggerTokens: 100,
        },
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            calls.push({
              piMessages: context?.piMessages,
            });
            return successfulAssistantReply("Done.");
          },
        },
      },
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-content-auto-compact",
        text: "<@U_APP> continue",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(calls).toHaveLength(1);
    const compactingStatusIndex = slackAdapter.statusCalls.findIndex((call) =>
      call.loadingMessages?.includes("Compacting context"),
    );
    expect(compactingStatusIndex).toBeGreaterThanOrEqual(0);
    expect(
      slackAdapter.statusCalls.findIndex(
        (call, index) =>
          index > compactingStatusIndex &&
          Boolean(call.text) &&
          !call.loadingMessages?.includes("Compacting context"),
      ),
    ).toBeGreaterThan(compactingStatusIndex);
    expect(calls[0]?.piMessages?.length).toBeLessThan(priorMessages.length + 1);
    expect(JSON.stringify(calls[0]?.piMessages)).toContain(
      "Context handoff summary",
    );
    expect(JSON.stringify(calls[0]?.piMessages)).toContain(
      "old context is still relevant",
    );
    expect(JSON.stringify(calls[0]?.piMessages)).not.toContain(
      "bootstrap instructions",
    );
    expect(JSON.stringify(calls[0]?.piMessages)).not.toContain(
      "<runtime-turn-context>",
    );
  });

  it("keeps active-turn Pi history instead of compacting older completed history", async () => {
    const calls: RuntimeCall[] = [];
    const activeMessages: PiMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<runtime-turn-context>\nstale active turn bootstrap\n</runtime-turn-context>",
          },
          { type: "text", text: "active session record tool context" },
        ],
        timestamp: 3,
      },
    ] as PiMessage[];
    const expectedActiveMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "active session record tool context" }],
        timestamp: 3,
      },
    ] as PiMessage[];
    const priorMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "older context ".repeat(5_000) }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "older answer ".repeat(1_000) }],
        timestamp: 2,
      },
    ] as PiMessage[];
    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700005006.000" });
    await commitMessages({
      conversationId: thread.id,
      messages: priorMessages,
      ttlMs: 60_000,
    });
    await upsertAgentTurnSessionRecord({
      conversationId: thread.id,
      sessionId: "turn-active-crashed",
      sliceId: 1,
      state: "running",
      piMessages: activeMessages,
    });
    const conversation = coerceThreadConversationState({});
    conversation.processing.activeTurnId = "turn-active-crashed";
    await persistThreadState(thread, { conversation });

    const { slackRuntime } = createTestChatRuntime({
      services: {
        contextCompactor: {
          completeText: async () => {
            throw new Error("active session record history should not compact");
          },
          autoCompactionTriggerTokens: 100,
        },
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            calls.push({
              piMessages: context?.piMessages,
            });
            return successfulAssistantReply("Done.");
          },
        },
      },
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-content-active-session-record",
        text: "<@U_APP> continue",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.piMessages).toEqual(expectedActiveMessages);
  });
});
