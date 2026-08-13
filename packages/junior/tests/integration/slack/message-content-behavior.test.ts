import { afterEach, describe, expect, it } from "vitest";
import { parseMarkdown } from "chat";
import type { PiMessage } from "@/chat/pi/messages";
import {
  getPersistedThreadState,
  persistThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { TurnInputCommitLostError } from "@/chat/runtime/turn";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { commitMessages } from "@/chat/conversations/projection";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import { upsertTurnRecord } from "@/chat/task-execution/turn-cursor";
import { getConversationEventStore } from "@/chat/db";
import { botConfig } from "@/chat/config";
import type { AgentRun } from "@/chat/agent/types";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import {
  createModelAgentRunner,
  createModelAgentRunnerForRun,
  neverRunAgentRunner,
} from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";

interface CapturedCall {
  contextConversation?: string;
  piMessages?: PiMessage[];
  prompt: string;
}

function captureAgentCall(calls: CapturedCall[], run: AgentRun): void {
  calls.push({
    prompt: run.instruction.text,
    contextConversation: run.instruction.context,
    piMessages: run.history ? [...run.history] : undefined,
  });
}

function assistantPiMessage(text: string, timestamp: number): PiMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {},
    stopReason: "stop",
    timestamp,
  } as PiMessage;
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
          agentRunner: createModelAgentRunnerForRun((run) => {
            captureAgentCall(calls, run);
            return createModelStream([{ type: "text", text: "Summary sent." }]);
          }),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700005000.000",
    });
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

  it("includes full structured link targets in agent and conversation text", async () => {
    const calls: CapturedCall[] = [];
    const fullUrl =
      "https://evals.sentry.dev/run/536be3d5-76e9-4d2c-b172-9756b5b4e6fc";

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunnerForRun((run) => {
            captureAgentCall(calls, run);
            return createModelStream([{ type: "text", text: "Reviewed." }]);
          }),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700005000.500",
    });
    const message = createTestMessage({
      id: "m-content-link-target",
      text: "<@U0APP> inspect evals.sentry.dev/run/…",
      formatted: parseMarkdown(
        `<@U0APP> inspect [evals.sentry.dev/run/…](${fullUrl})`,
      ),
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(calls[0]?.prompt).toBe(
      `inspect [evals.sentry.dev/run/…](${fullUrl})`,
    );
    const conversation = coerceThreadConversationState(await thread.getState());
    await hydrateConversationMessages({
      conversation,
      conversationId: thread.id,
    });
    expect(
      conversation.messages.find((entry) => entry.id === message.id)?.text,
    ).toBe(`inspect [evals.sentry.dev/run/…](${fullUrl})`);
  });

  it("preserves non-leading mention tokens in user content", async () => {
    const calls: CapturedCall[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunnerForRun((run) => {
            captureAgentCall(calls, run);
            return createModelStream([{ type: "text", text: "Done." }]);
          }),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700005001.000",
    });
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
          agentRunner: createModelAgentRunnerForRun((run) => {
            captureAgentCall(calls, run);
            return createModelStream([
              { type: "text", text: "Alert reviewed." },
            ]);
          }),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700005002.500",
    });
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

  it("includes nested attachment blocks from earlier thread messages", async () => {
    const calls: CapturedCall[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunnerForRun((run) => {
            captureAgentCall(calls, run);
            return createModelStream([{ type: "text", text: "Review found." }]);
          }),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700005002.750",
    });
    const reviewMessage = createTestMessage({
      id: "m-content-nested-blocks",
      text: "",
      threadId: thread.id,
      author: { userId: "U0REVIEWBOT", userName: "reviewbot", isBot: true },
      raw: {
        channel: "C0BEHAVIOR",
        ts: "1700005002.750",
        thread_ts: "1700005002.750",
        attachments: [
          {
            fallback: "[no preview available]",
            blocks: [
              {
                type: "section",
                text: { type: "plain_text", text: "Taylor Example" },
              },
              {
                type: "section",
                text: { type: "plain_text", text: "The app never loaded" },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Read full review" },
                    url: "https://example.com/review/123",
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    reviewMessage.metadata.dateSent = new Date(1_700_005_002_750);
    const currentMessage = createTestMessage({
      id: "m-content-nested-blocks-request",
      text: "<@U0APP> who left this review?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
    });
    currentMessage.metadata.dateSent = new Date(1_700_005_003_000);
    thread.recentMessages = [reviewMessage, currentMessage];

    await slackRuntime.handleNewMention(thread, currentMessage, {
      destination: createTestDestination(thread),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.contextConversation).toContain("Taylor Example");
    expect(calls[0]?.contextConversation).toContain("The app never loaded");
    expect(calls[0]?.contextConversation).toContain(
      "Read full review (https://example.com/review/123)",
    );
    expect(calls[0]?.contextConversation).not.toContain(
      "[no preview available]",
    );
    expect(calls[0]?.contextConversation).not.toContain(
      "who left this review?",
    );
  });

  it("does not invoke the agent for self-authored mention messages", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: neverRunAgentRunner(),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700005002.000",
    });
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

    expect(thread.posts).toHaveLength(0);
  });

  it("passes durable Pi history into the next turn", async () => {
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
          agentRunner: createModelAgentRunnerForRun((run) => {
            captureAgentCall(calls, run);
            return createModelStream([
              {
                type: "text",
                text:
                  calls.length === 1 ? "First response." : "Second response.",
              },
            ]);
          }),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700005003.000",
    });
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
    expect(calls[1]?.piMessages).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.piMessages)).toContain(
      "I need the budget by Friday",
    );
    expect(JSON.stringify(calls[1]?.piMessages)).toContain("First response.");
    expect(JSON.stringify(calls[1]?.piMessages)).not.toContain(
      "<runtime-turn-context>",
    );
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
      assistantPiMessage("old answer ".repeat(1_000), 2),
    ] as PiMessage[];
    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700005005.000",
    });
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
          agentRunner: createModelAgentRunnerForRun((run) => {
            captureAgentCall(calls, run);
            return createModelStream([{ type: "text", text: "Done." }]);
          }),
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
      "Context compaction summary",
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

  it("uses the projected handoff model for turn-start context limits", async () => {
    const modelIds: string[] = [];
    const priorMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "Continue after handoff." }],
        timestamp: 1,
      },
    ] as PiMessage[];
    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700005005.500",
    });
    await getConversationEventStore().replaceHistory(thread.id, {
      createdAtMs: 1,
      data: {
        type: "handoff",
        modelProfile: "handoff",
        modelId: botConfig.profiles.handoff!.modelId,
        replacementHistory: priorMessages.map((message) => ({
          item: historyItemFromPiMessage(message, { authority: "context" }),
        })),
      },
    });
    await persistThreadState(thread, {
      conversation: coerceThreadConversationState({}),
    });

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          contextCompactor: {
            maybeCompact: async (args) => {
              modelIds.push(args.modelId);
              return { compacted: false, reason: "below_threshold" };
            },
          },
          agentRunner: createModelAgentRunner(
            createModelStream([{ type: "text", text: "Done." }]),
          ),
        },
      },
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-content-handoff-model",
        text: "<@U0APP> continue",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(modelIds).toEqual([botConfig.profiles.handoff!.modelId]);
  });

  it("rejects active-turn history that conflicts with committed conversation history", async () => {
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
      assistantPiMessage("older answer ".repeat(1_000), 2),
    ] as PiMessage[];
    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700005006.000",
    });
    await commitMessages({
      conversationId: thread.id,
      messages: activeMessages,
    });
    await upsertTurnRecord({
      conversationId: thread.id,
      turnId: "turn-active-crashed",
      sliceId: 1,
      state: "running",
      piMessages: activeMessages,
    });
    await getConversationEventStore().replaceHistory(thread.id, {
      createdAtMs: 4,
      data: {
        type: "compaction",
        modelProfile: "standard",
        modelId: "test/model",
        replacementHistory: priorMessages.map((message) => ({
          item: historyItemFromPiMessage(message, { authority: "context" }),
        })),
      },
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
          agentRunner: createModelAgentRunnerForRun((run) => {
            captureAgentCall(calls, run);
            return createModelStream([{ type: "text", text: "Done." }]);
          }),
        },
      },
    });

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "m-content-active-session-record",
          text: "<@U0APP> continue",
          isMention: true,
          threadId: thread.id,
          author: { userId: "U0TESTER" },
        }),
        { destination: createTestDestination(thread) },
      ),
    ).rejects.toBeInstanceOf(TurnInputCommitLostError);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.piMessages).toEqual(expectedActiveMessages);
  });
});
