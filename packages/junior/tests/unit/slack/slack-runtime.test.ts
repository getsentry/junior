import { describe, expect, it, vi } from "vitest";
import {
  createSlackTurnRuntime,
  type SlackTurnRuntimeDependencies,
} from "@/chat/runtime/slack-runtime";
import type { SubscribedReplyDecision } from "@/chat/services/subscribed-reply-policy";
import {
  createTestThread,
  createTestMessage,
  createTestDestination,
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
    recordSkippedSteeringMessage: vi.fn().mockResolvedValue(undefined),
    recordSkippedSubscribedTurn: vi.fn().mockResolvedValue(undefined),
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

      await runtime.handleNewMention(thread, message, {
        destination: createTestDestination(thread),
      });

      expect(thread.subscribeCalls).toBe(1);
      expect(deps.replyToThread).toHaveBeenCalledWith(
        thread,
        message,
        expect.objectContaining({
          explicitMention: true,
          onToolInvocation: expect.any(Function),
          queuedMessages: [],
        }),
      );
    });

    it("forwards queued SDK context as ordered turn messages", async () => {
      const deps = createMockDeps({
        stripLeadingBotMention: vi.fn((text: string) =>
          text.replace("<@U0APP> ", ""),
        ),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const skipped = createTestMessage({
        id: "m-skipped",
        text: "<@U0APP> first queued bit",
        isMention: true,
      });
      const latest = createTestMessage({
        id: "m-latest",
        text: "<@U0APP> latest queued bit",
        isMention: true,
      });

      await runtime.handleNewMention(thread, latest, {
        destination: createTestDestination(thread),
        messageContext: {
          skipped: [skipped],
          totalSinceLastHandler: 2,
        },
      });

      expect(deps.replyToThread).toHaveBeenCalledWith(
        thread,
        latest,
        expect.objectContaining({
          queuedMessages: [
            {
              explicitMention: true,
              message: skipped,
              rawText: "<@U0APP> first queued bit",
              userText: "first queued bit",
            },
          ],
        }),
      );
    });
  });

  describe("handleSubscribedMessage", () => {
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

      await runtime.handleSubscribedMessage(thread, message, {
        destination: createTestDestination(thread),
      });

      expect(deps.stripLeadingBotMention).toHaveBeenCalledWith(
        "<@U123> stripped text",
        { stripLeadingSlackMentionToken: true },
      );
      expect(deps.prepareTurnState).toHaveBeenCalledWith(
        expect.objectContaining({
          text: {
            rawText: "<@U123> stripped text",
            userText: "stripped text",
          },
        }),
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

      await runtime.handleSubscribedMessage(thread, message, {
        destination: createTestDestination(thread),
      });

      expect(deps.decideSubscribedReply).toHaveBeenCalledWith(
        expect.objectContaining({ conversationContext: "some context" }),
      );
    });

    it("prepares resource-event notifications without a requester", async () => {
      const deps = createMockDeps({
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({
        author: { userId: "UJRNEVENT", isBot: true },
        raw: { event_type: "resource_event" },
      });

      await runtime.handleSubscribedMessage(thread, message, {
        destination: createTestDestination(thread),
      });

      expect(deps.prepareTurnState).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            requesterId: undefined,
          }),
        }),
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
