import { describe, expect, it, vi } from "vitest";
import type { Attachment } from "chat";
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
  conversationContext?: string;
}

function createMockDeps(
  overrides?: Partial<SlackTurnRuntimeDependencies<TestState>>,
): SlackTurnRuntimeDependencies<TestState> {
  return {
    assistantUserName: "test-bot",
    modelId: "test-model",
    now: () => 1700000000000,
    getErrorReference: () => null,
    getChannelId: (_thread, message) => message.threadId?.split(":")[1],
    getThreadId: (_thread, message) => message.threadId,
    getRunId: () => undefined,
    initializeAssistantThread: vi.fn().mockResolvedValue(undefined),
    refreshAssistantThreadContext: vi.fn().mockResolvedValue(undefined),
    logException: vi.fn(),
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
        explicitMention: true,
      });
    });

    it("posts a safe error when replyToThread fails", async () => {
      const replyError = new Error("reply failed");
      const deps = createMockDeps({
        replyToThread: vi.fn().mockRejectedValue(replyError),
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({});

      await runtime.handleNewMention(thread, message);

      expect(thread.posts).toContain(
        "I ran into an internal error while processing that. Please try again.",
      );
    });

    it("posts a safe error when subscribe fails", async () => {
      const subscribeError = new Error("subscribe failed");
      const deps = createMockDeps({
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      // Override subscribe to throw
      thread.subscribe = async () => {
        throw subscribeError;
      };
      const message = createTestMessage({});

      await runtime.handleNewMention(thread, message);

      expect(thread.posts).toContain(
        "I ran into an internal error while processing that. Please try again.",
      );
    });

    it("includes sentry event id when available", async () => {
      const replyError = new Error("reply failed");
      const deps = createMockDeps({
        replyToThread: vi.fn().mockRejectedValue(replyError),
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
        logException: vi.fn(() => "evt_123"),
        getErrorReference: () => ({
          eventId: "evt_123",
          traceId: "trace_ignored",
        }),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({});

      await runtime.handleNewMention(thread, message);

      expect(thread.posts).toContain(
        "I ran into an internal error while processing that. Reference: `event_id=evt_123 trace_id=trace_ignored`.",
      );
    });

    it("falls back to trace id when sentry event id is unavailable", async () => {
      const replyError = new Error("reply failed");
      const deps = createMockDeps({
        replyToThread: vi.fn().mockRejectedValue(replyError),
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
        logException: vi.fn(() => undefined),
        getErrorReference: () => ({ traceId: "trace_123" }),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({});

      await runtime.handleNewMention(thread, message);

      expect(thread.posts).toContain(
        "I ran into an internal error while processing that. Reference: `trace_id=trace_123`.",
      );
    });
  });

  describe("handleSubscribedMessage", () => {
    it("calls prepareTurnState → persistPreparedState → shouldReply → replyToThread in order", async () => {
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
          callOrder.push("shouldReply");
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
        "shouldReply",
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

    it("when shouldReply: false, skips replyToThread", async () => {
      const deps = createMockDeps({
        decideSubscribedReply: vi.fn(async () => ({
          shouldReply: false,
          reason: "passive conversation",
        })),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({});

      await runtime.handleSubscribedMessage(thread, message);

      expect(deps.replyToThread).not.toHaveBeenCalled();
      expect(deps.recordSkippedSubscribedMessage).not.toHaveBeenCalled();
      expect(deps.onSubscribedMessageSkipped).toHaveBeenCalledWith(
        expect.objectContaining({
          thread,
          message,
          decision: { shouldReply: false, reason: "passive conversation" },
          completedAtMs: 1700000000000,
        }),
      );
    });

    it("preflight-skips messages addressed to another party before preparing turn state", async () => {
      const deps = createMockDeps();
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({
        text: "@Cursor can you take this one?",
        isMention: false,
      });

      await runtime.handleSubscribedMessage(thread, message);

      expect(deps.prepareTurnState).not.toHaveBeenCalled();
      expect(deps.persistPreparedState).not.toHaveBeenCalled();
      expect(deps.decideSubscribedReply).not.toHaveBeenCalled();
      expect(deps.replyToThread).not.toHaveBeenCalled();
      expect(deps.onSubscribedMessageSkipped).toHaveBeenCalledWith(
        expect.objectContaining({
          thread,
          message,
          decision: {
            shouldReply: false,
            reason: "directed_to_other_party:named_mention:Cursor",
          },
          completedAtMs: 1700000000000,
        }),
      );
      expect(deps.recordSkippedSubscribedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          thread,
          message,
          userText: "@Cursor can you take this one?",
          decision: {
            shouldReply: false,
            reason: "directed_to_other_party:named_mention:Cursor",
          },
          completedAtMs: 1700000000000,
        }),
      );
    });

    it("unsubscribes when subscribed-thread routing returns thread opt-out", async () => {
      const deps = createMockDeps({
        decideSubscribedReply: vi.fn(async () => ({
          shouldReply: false,
          shouldUnsubscribe: true,
          reason: "thread_opt_out:user asked junior to stop participating",
        })),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      await thread.subscribe();
      const message = createTestMessage({
        text: "<@U123> leave this thread alone",
        isMention: true,
      });

      await runtime.handleSubscribedMessage(thread, message);

      expect(thread.subscribed).toBe(false);
      expect(deps.prepareTurnState).toHaveBeenCalled();
      expect(deps.persistPreparedState).toHaveBeenCalled();
      expect(deps.decideSubscribedReply).toHaveBeenCalled();
      expect(deps.replyToThread).not.toHaveBeenCalled();
      expect(thread.posts).toEqual([
        "Understood. I'll stay out of this thread unless someone @mentions me again.",
      ]);
    });

    it("passes conversationContext from getPreparedConversationContext to shouldReply", async () => {
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

    it("passes explicitMention: true for classifier-approved subscribed mentions", async () => {
      const deps = createMockDeps({
        decideSubscribedReply: vi.fn(async () => ({
          shouldReply: true,
          reason: "llm_classifier:follow_up_question",
        })),
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({ isMention: true });

      await runtime.handleSubscribedMessage(thread, message);

      expect(deps.replyToThread).toHaveBeenCalledWith(thread, message, {
        explicitMention: true,
        preparedState: { prepared: true },
      });
    });

    it("passes hasAttachments: true when message has attachments", async () => {
      const deps = createMockDeps({
        decideSubscribedReply: vi.fn(async (args) => ({
          shouldReply: Boolean(args.hasAttachments),
          reason: args.hasAttachments ? "attachment" : "empty message",
        })),
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({
        text: "",
        attachments: [
          {
            type: "image",
            url: "https://example.com/img.png",
          } satisfies Attachment,
        ],
      });

      await runtime.handleSubscribedMessage(thread, message);

      expect(deps.decideSubscribedReply).toHaveBeenCalledWith(
        expect.objectContaining({ hasAttachments: true }),
      );
      expect(deps.replyToThread).toHaveBeenCalled();
    });

    it("passes hasAttachments: false when message has no attachments", async () => {
      const deps = createMockDeps({
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({ text: "hello" });

      await runtime.handleSubscribedMessage(thread, message);

      expect(deps.decideSubscribedReply).toHaveBeenCalledWith(
        expect.objectContaining({ hasAttachments: false }),
      );
    });

    it("on failure, posts a safe error message", async () => {
      const err = new Error("handler boom");
      const deps = createMockDeps({
        prepareTurnState: vi.fn().mockRejectedValue(err),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({});

      await runtime.handleSubscribedMessage(thread, message);

      expect(thread.posts).toContain(
        "I ran into an internal error while processing that. Please try again.",
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
