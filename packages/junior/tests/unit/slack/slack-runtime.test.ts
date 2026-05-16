import { describe, expect, it, vi } from "vitest";
import {
  createSlackTurnRuntime,
  type SlackTurnRuntimeDependencies,
} from "@/chat/runtime/slack-runtime";
import type { SubscribedReplyDecision } from "@/chat/services/subscribed-reply-policy";
import {
  createTestThread,
  createTestMessage,
} from "../../fixtures/slack-harness";

interface TestState {
  prepared: boolean;
}

function createMockDeps(
  overrides?: Partial<SlackTurnRuntimeDependencies<TestState>>,
): SlackTurnRuntimeDependencies<TestState> {
  return {
    assistantUserName: "test-bot",
    modelId: "test-model",
    now: () => 1700000000000,
    getChannelId: (_thread, message) => message.threadId?.split(":")[1],
    getThreadId: (_thread, message) => message.threadId,
    getRunId: () => undefined,
    initializeAssistantThread: vi.fn().mockResolvedValue(undefined),
    refreshAssistantThreadContext: vi.fn().mockResolvedValue(undefined),
    logException: vi.fn(() => "evt_test"),
    logWarn: vi.fn(),
    onSubscribedMessageSkipped: vi.fn().mockResolvedValue(undefined),
    recordSkippedSubscribedMessage: vi.fn().mockResolvedValue(undefined),
    persistPreparedState: vi.fn().mockResolvedValue(undefined),
    prepareTurnState: vi
      .fn()
      .mockResolvedValue({ prepared: true } satisfies TestState),
    replyToThread: vi.fn().mockResolvedValue(undefined),
    decideSubscribedReply: vi.fn().mockResolvedValue({
      shouldReply: true,
      reason: "test",
    } satisfies SubscribedReplyDecision),
    stripLeadingBotMention: vi.fn((text: string) => text),
    getPreparedConversationContext: vi.fn(() => undefined),
    withSpan: vi.fn(async (_name, _op, _ctx, cb) => cb()),
    ...overrides,
  };
}

describe("createSlackTurnRuntime", () => {
  describe("handleNewMention", () => {
    it("subscribes thread and calls replyToThread with explicitMention: true", async () => {
      const deps = createMockDeps();
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({ text: "hey bot" });

      await runtime.handleNewMention(thread, message);

      expect(thread.subscribeCalls).toBe(1);
      expect(deps.replyToThread).toHaveBeenCalledWith(thread, message, {
        beforeFirstResponsePost: undefined,
        explicitMention: true,
        onToolInvocation: expect.any(Function),
      });
    });
  });

  describe("handleSubscribedMessage", () => {
    it("calls prepareTurnState → persistPreparedState → decideSubscribedReply → replyToThread in order", async () => {
      const callOrder: string[] = [];
      const deps = createMockDeps({
        prepareTurnState: vi.fn(async () => {
          callOrder.push("prepareTurnState");
          return { prepared: true };
        }),
        persistPreparedState: vi.fn(async () => {
          callOrder.push("persistPreparedState");
        }),
        decideSubscribedReply: vi.fn(async () => {
          callOrder.push("decideSubscribedReply");
          return { shouldReply: true, reason: "test" };
        }),
        replyToThread: vi.fn(async () => {
          callOrder.push("replyToThread");
        }),
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({});

      await runtime.handleSubscribedMessage(thread, message);

      expect(callOrder).toEqual([
        "prepareTurnState",
        "persistPreparedState",
        "decideSubscribedReply",
        "replyToThread",
      ]);
    });

    it("passes stripped text via stripLeadingBotMention to prepareTurnState", async () => {
      const deps = createMockDeps({
        stripLeadingBotMention: vi.fn(() => "stripped text"),
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({
        text: "<@U123> stripped text",
        isMention: true,
      });

      await runtime.handleSubscribedMessage(thread, message);

      expect(deps.stripLeadingBotMention).toHaveBeenCalledWith(
        "<@U123> stripped text",
        { stripLeadingSlackMentionToken: true },
      );
      expect(deps.prepareTurnState).toHaveBeenCalledWith(
        expect.objectContaining({ userText: "stripped text" }),
      );
    });

    it("passes conversationContext from getPreparedConversationContext to decideSubscribedReply", async () => {
      const deps = createMockDeps({
        getPreparedConversationContext: vi.fn(() => "some context"),
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({});

      await runtime.handleSubscribedMessage(thread, message);

      expect(deps.decideSubscribedReply).toHaveBeenCalledWith(
        expect.objectContaining({ conversationContext: "some context" }),
      );
    });
  });

  describe("handleAssistantThreadStarted", () => {
    it("calls initializeAssistantThread with correct fields", async () => {
      const deps = createMockDeps();
      const runtime = createSlackTurnRuntime<TestState>(deps);

      await runtime.handleAssistantThreadStarted({
        threadId: "T-1",
        channelId: "C-1",
        threadTs: "1700000000.000",
        userId: "U-1",
      });

      expect(deps.initializeAssistantThread).toHaveBeenCalledWith({
        threadId: "T-1",
        channelId: "C-1",
        threadTs: "1700000000.000",
        sourceChannelId: undefined,
      });
    });
  });

  describe("handleAssistantContextChanged", () => {
    it("calls refreshAssistantThreadContext with correct fields", async () => {
      const deps = createMockDeps();
      const runtime = createSlackTurnRuntime<TestState>(deps);

      await runtime.handleAssistantContextChanged({
        threadId: "T-2",
        channelId: "C-2",
        threadTs: "1700000000.100",
        userId: "U-2",
      });

      expect(deps.refreshAssistantThreadContext).toHaveBeenCalledWith({
        threadId: "T-2",
        channelId: "C-2",
        threadTs: "1700000000.100",
        sourceChannelId: undefined,
      });
    });

    it("forwards source channel context when provided", async () => {
      const deps = createMockDeps();
      const runtime = createSlackTurnRuntime<TestState>(deps);

      await runtime.handleAssistantContextChanged({
        threadId: "T-2",
        channelId: "D-assistant",
        threadTs: "1700000000.100",
        userId: "U-2",
        context: {
          channelId: "C-source",
        },
      });

      expect(deps.refreshAssistantThreadContext).toHaveBeenCalledWith({
        threadId: "T-2",
        channelId: "D-assistant",
        threadTs: "1700000000.100",
        sourceChannelId: "C-source",
      });
    });
  });
});
