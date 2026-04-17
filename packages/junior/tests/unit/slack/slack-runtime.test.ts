import { describe, expect, it, vi } from "vitest";
import type { Attachment } from "chat";
import {
  createSlackTurnRuntime,
  type SlackTurnRuntimeDependencies,
} from "@/chat/runtime/slack-runtime";
import { RetryableTurnError } from "@/chat/runtime/turn";
import type { SubscribedReplyDecision } from "@/chat/services/subscribed-reply-policy";
import {
  createTestThread,
  createTestMessage,
} from "../../fixtures/slack-harness";

interface TestState {
  prepared: boolean;
  conversationContext?: string;
}

function createSlackInternalError(requestId: string): Error {
  return Object.assign(new Error("An API error occurred: internal_error"), {
    code: "slack_webapi_platform_error",
    data: { error: "internal_error" },
    statusCode: 500,
    headers: { "x-slack-req-id": requestId },
  });
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

    it("wraps call in withSpan with correct log context", async () => {
      const deps = createMockDeps();
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({
        author: { userId: "U-caller" },
      });

      await runtime.handleNewMention(thread, message);

      expect(deps.withSpan).toHaveBeenCalledWith(
        "chat.turn",
        "chat.turn",
        expect.objectContaining({
          assistantUserName: "test-bot",
          modelId: "test-model",
          slackUserId: "U-caller",
        }),
        expect.any(Function),
      );
    });

    it("on replyToThread failure: posts safe error and calls logException", async () => {
      const replyError = new Error("reply failed");
      const deps = createMockDeps({
        replyToThread: vi.fn().mockRejectedValue(replyError),
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({});

      await runtime.handleNewMention(thread, message);

      expect(deps.logException).toHaveBeenCalledWith(
        replyError,
        "mention_handler_failed",
        expect.any(Object),
        {},
        "onNewMention failed",
      );
      expect(thread.posts).toContain(
        "I ran into an internal error while processing that. Please try again.",
      );
    });

    it("on subscribe failure: posts safe error and calls logException", async () => {
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

      expect(deps.logException).toHaveBeenCalledWith(
        subscribeError,
        "mention_handler_failed",
        expect.any(Object),
        {},
        "onNewMention failed",
      );
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

    it("logs fallback-post failure with Slack attributes when posting error reply fails", async () => {
      const replyError = new Error("reply failed");
      const slackPostError = createSlackInternalError("req-123");
      const logException = vi.fn(() => "evt_primary");
      const deps = createMockDeps({
        replyToThread: vi.fn().mockRejectedValue(replyError),
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
        logException,
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      thread.post = vi
        .fn()
        .mockRejectedValue(slackPostError) as unknown as typeof thread.post;
      const message = createTestMessage({});

      await expect(runtime.handleNewMention(thread, message)).rejects.toBe(
        slackPostError,
      );

      expect(logException).toHaveBeenNthCalledWith(
        2,
        slackPostError,
        "mention_handler_failure_reply_post_failed",
        expect.any(Object),
        expect.objectContaining({
          "app.slack.reply_stage": "error_fallback_post",
          "app.error.original_event_id": "evt_primary",
          "app.slack.error_code": "slack_webapi_platform_error",
          "app.slack.api_error": "internal_error",
          "app.slack.request_id": "req-123",
          "http.response.status_code": 500,
        }),
        "Failed to post fallback error reply for mention handler",
      );
    });

    it("uses a generic auth-resume message for plugin auth pauses", async () => {
      const replyError = new RetryableTurnError(
        "plugin_auth_resume",
        "resume auth",
      );
      const deps = createMockDeps({
        replyToThread: vi.fn().mockRejectedValue(replyError),
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);

      await runtime.handleNewMention(
        createTestThread({}),
        createTestMessage({}),
      );

      expect(deps.logException).toHaveBeenCalledWith(
        replyError,
        "mention_handler_auth_pause",
        expect.any(Object),
        { "app.turn.retryable_reason": "plugin_auth_resume" },
        "onNewMention parked turn for auth resume",
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

    it("uses a generic auth-resume message for subscribed plugin auth pauses", async () => {
      const replyError = new RetryableTurnError(
        "plugin_auth_resume",
        "resume auth",
      );
      const deps = createMockDeps({
        replyToThread: vi.fn().mockRejectedValue(replyError),
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);

      await runtime.handleSubscribedMessage(
        createTestThread({}),
        createTestMessage({}),
      );

      expect(deps.logException).toHaveBeenCalledWith(
        replyError,
        "subscribed_message_handler_auth_pause",
        expect.any(Object),
        { "app.turn.retryable_reason": "plugin_auth_resume" },
        "onSubscribedMessage parked turn for auth resume",
      );
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

    it("when shouldReply: false, skips replyToThread and logs skip", async () => {
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
      expect(deps.logWarn).toHaveBeenCalledWith(
        "subscribed_message_reply_skipped",
        expect.any(Object),
        { "app.decision.reason": "passive conversation" },
        "Skipping subscribed message reply",
      );
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

    it("on failure: posts safe error message and calls logException", async () => {
      const err = new Error("handler boom");
      const deps = createMockDeps({
        prepareTurnState: vi.fn().mockRejectedValue(err),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      const message = createTestMessage({});

      await runtime.handleSubscribedMessage(thread, message);

      expect(deps.logException).toHaveBeenCalledWith(
        err,
        "subscribed_message_handler_failed",
        expect.any(Object),
        {},
        "onSubscribedMessage failed",
      );
      expect(thread.posts).toContain(
        "I ran into an internal error while processing that. Please try again.",
      );
    });

    it("logs fallback-post failure with Slack attributes when posting subscribed error reply fails", async () => {
      const primaryError = new Error("handler boom");
      const slackPostError = createSlackInternalError("req-456");
      const logException = vi.fn(() => "evt_subscribed");
      const deps = createMockDeps({
        prepareTurnState: vi.fn().mockRejectedValue(primaryError),
        logException,
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = createTestThread({});
      thread.post = vi
        .fn()
        .mockRejectedValue(slackPostError) as unknown as typeof thread.post;
      const message = createTestMessage({});

      await expect(
        runtime.handleSubscribedMessage(thread, message),
      ).rejects.toBe(slackPostError);

      expect(logException).toHaveBeenNthCalledWith(
        2,
        slackPostError,
        "subscribed_message_handler_failure_reply_post_failed",
        expect.any(Object),
        expect.objectContaining({
          "app.slack.reply_stage": "error_fallback_post",
          "app.error.original_event_id": "evt_subscribed",
          "app.slack.error_code": "slack_webapi_platform_error",
          "app.slack.api_error": "internal_error",
          "app.slack.request_id": "req-456",
          "http.response.status_code": 500,
        }),
        "Failed to post fallback error reply for subscribed message handler",
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

    it("on failure: calls logException without posting error", async () => {
      const err = new Error("init boom");
      const deps = createMockDeps({
        initializeAssistantThread: vi.fn().mockRejectedValue(err),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);

      await runtime.handleAssistantThreadStarted({
        threadId: "T-1",
        channelId: "C-1",
        threadTs: "1700000000.000",
      });

      expect(deps.logException).toHaveBeenCalledWith(
        err,
        "assistant_thread_started_handler_failed",
        expect.objectContaining({
          slackThreadId: "T-1",
          slackChannelId: "C-1",
        }),
        {},
        "onAssistantThreadStarted failed",
      );
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

    it("on failure: calls logException without posting error", async () => {
      const err = new Error("context boom");
      const deps = createMockDeps({
        refreshAssistantThreadContext: vi.fn().mockRejectedValue(err),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);

      await runtime.handleAssistantContextChanged({
        threadId: "T-2",
        channelId: "C-2",
        threadTs: "1700000000.100",
      });

      expect(deps.logException).toHaveBeenCalledWith(
        err,
        "assistant_context_changed_handler_failed",
        expect.objectContaining({
          slackThreadId: "T-2",
          slackChannelId: "C-2",
        }),
        {},
        "onAssistantContextChanged failed",
      );
    });
  });
});
