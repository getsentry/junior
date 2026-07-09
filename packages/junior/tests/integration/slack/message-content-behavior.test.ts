import { afterEach, describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  getPersistedThreadState,
  persistThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { commitMessages } from "@/chat/conversations/projection";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { flattenAgentRunRequestForTest } from "../../fixtures/agent-runner";

interface CapturedCall {
  contextConversation?: string;
  piMessages?: PiMessage[];
  prompt: string;
}

function completedReply(text: string) {
  return completedAgentRun({
    text,
    diagnostics: {
      assistantMessageCount: 1,
      modelId: "fake-agent-model",
      outcome: "success" as const,
      toolCalls: [],
      toolErrorCount: 0,
      toolResultCount: 0,
      usedPrimaryText: true,
    },
  });
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
          agentRunner: {
            run: async (request) => {
              const prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              calls.push({
                prompt,
                contextConversation: context?.conversationContext,
              });
              return completedReply("Summary sent.");
            },
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0BEHAVIOR:1700005000.000" });
    const message = createTestMessage({
      id: "m-content-strip",
      text: "<@U0APP>   please summarize the deploy status",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("please summarize the deploy status");
  });

  it("preserves non-leading mention tokens in user content", async () => {
    const calls: CapturedCall[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const prompt = request.input.messageText;

              calls.push({ prompt });
              return completedReply("Done.");
            },
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0BEHAVIOR:1700005001.000" });
    const message = createTestMessage({
      id: "m-content-preserve",
      text: "<@U0APP> remind me to message <@U0ONCALL> after deploy",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("message <@U0ONCALL> after deploy");
  });

  it("passes legacy attachment text into the current turn prompt", async () => {
    const calls: CapturedCall[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              calls.push({
                prompt,
                contextConversation: context?.conversationContext,
              });
              return completedReply("Alert reviewed.");
            },
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0BEHAVIOR:1700005002.500" });
    const message = createTestMessage({
      id: "m-content-legacy-attachment",
      text: "<@U0APP>",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
      raw: {
        channel: "C0BEHAVIOR",
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

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

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
          agentRunner: {
            run: async () => {
              replyCalled = true;
              return completedReply("Should not happen");
            },
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0BEHAVIOR:1700005002.000" });
    const message = createTestMessage({
      id: "m-content-self",
      text: "<@U0APP> do not respond",
      isMention: true,
      threadId: thread.id,
      author: {
        userId: "U0BOT",
        isMe: true,
      },
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

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
          agentRunner: {
            run: async (request) => {
              const prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

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
                await upsertAgentTurnSessionRecord({
                  conversationId: context.correlation.conversationId,
                  sessionId: context.correlation.turnId,
                  sliceId: 1,
                  state: "completed",
                  piMessages: storedFirstTurnHistory,
                });
              }
              return completedReply(
                calls.length === 1 ? "First response." : "Second response.",
              );
            },
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0BEHAVIOR:1700005003.000" });
    const first = createTestMessage({
      id: "m-content-context-1",
      text: "<@U0APP> I need the budget by Friday",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
    });
    const second = createTestMessage({
      id: "m-content-context-2",
      text: "<@U0APP> what did I just ask?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
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

  it("auto compacts oversized reusable Pi history before the next turn", async () => {
    const calls: CapturedCall[] = [];
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
    const thread = createTestThread({ id: "slack:C0BEHAVIOR:1700005005.000" });
    await commitMessages({
      conversationId: thread.id,
      messages: priorMessages,
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
          agentRunner: {
            run: async (request) => {
              const prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              calls.push({
                prompt,
                contextConversation: context?.conversationContext,
                piMessages: context?.piMessages,
              });
              return completedReply("Done.");
            },
          },
        },
      },
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-content-auto-compact",
        text: "<@U0APP> continue",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
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
    const calls: CapturedCall[] = [];
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
    const thread = createTestThread({ id: "slack:C0BEHAVIOR:1700005006.000" });
    await commitMessages({
      conversationId: thread.id,
      messages: priorMessages,
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
          agentRunner: {
            run: async (request) => {
              const prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              calls.push({
                prompt,
                contextConversation: context?.conversationContext,
                piMessages: context?.piMessages,
              });
              return completedReply("Done.");
            },
          },
        },
      },
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-content-active-session-record",
        text: "<@U0APP> continue",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.piMessages).toEqual(expectedActiveMessages);
  });
});
