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
    cancelEventSubscriptions: vi.fn().mockResolvedValue(undefined),
    modelId: "test-model",
    now: () => 1700000000000,
    getChannelId: (_thread, message) => message.threadId?.split(":")[1],
    getThreadId: (_thread, message) => message.threadId,
    getRunId: () => undefined,
    initializeAssistantThread: vi.fn().mockResolvedValue(undefined),
    refreshAssistantThreadContext: vi.fn().mockResolvedValue(undefined),
    failConversationTurn: vi.fn().mockResolvedValue(undefined),
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
      const thread = await createTestThread({});
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
      const thread = await createTestThread({});
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

    it.each([
      {
        name: "suppresses the fallback before ack while the mailbox can retry",
        ackBeforeFailure: false,
        isFinalAttempt: false,
        shouldPostFallback: false,
      },
      {
        name: "posts the fallback after ack even before the final attempt",
        ackBeforeFailure: true,
        isFinalAttempt: false,
        shouldPostFallback: true,
      },
      {
        name: "posts the fallback on the final attempt",
        ackBeforeFailure: false,
        isFinalAttempt: true,
        shouldPostFallback: true,
      },
    ])(
      "$name",
      async ({ ackBeforeFailure, isFinalAttempt, shouldPostFallback }) => {
        const deps = createMockDeps({
          replyToThread: vi.fn(async (_thread, _message, hooks) => {
            if (ackBeforeFailure) {
              await hooks.ack?.();
            }
            throw new Error("turn failed");
          }),
        });
        const runtime = createSlackTurnRuntime<TestState>(deps);
        const thread = await createTestThread({});
        const message = createTestMessage({ id: "m-failed-turn" });

        await runtime.handleNewMention(thread, message, {
          destination: createTestDestination(thread),
          isFinalAttempt,
        });

        const expectedFailure = {
          conversationId: message.threadId,
          createdAtMs: 1700000000000,
          eventId: "evt_test",
          failureCode: "agent_run_failed",
          turnId: "turn_m-failed-turn",
        };
        expect(thread.posts).toEqual(
          shouldPostFallback
            ? [
                "I ran into an internal error while processing that. " +
                  "Reference: `event_id=evt_test`.",
              ]
            : [],
        );
        expect(vi.mocked(deps.failConversationTurn).mock.calls).toEqual(
          shouldPostFallback ? [[expectedFailure]] : [],
        );
      },
    );
  });

  describe("handleSubscribedMessage", () => {
    it("skips non-mention passive turns before prepare when the flag is off", async () => {
      const { setExperimentalFeatures } = await import("@/chat/experimental");
      setExperimentalFeatures(undefined);
      try {
        const deps = createMockDeps({
          withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
          decideSubscribedReply: vi.fn().mockResolvedValue({
            shouldReply: false,
            reason: "passive_disabled:passive-routing",
          }),
        });
        const runtime = createSlackTurnRuntime<TestState>(deps);
        const thread = await createTestThread({});
        const message = createTestMessage({
          text: "what did you just say?",
          isMention: false,
        });

        await runtime.handleSubscribedMessage(thread, message, {
          destination: createTestDestination(thread),
        });

        expect(deps.prepareTurnState).not.toHaveBeenCalled();
        expect(deps.decideSubscribedReply).toHaveBeenCalledWith(
          expect.objectContaining({
            isExplicitMention: false,
            text: "what did you just say?",
          }),
        );
        expect(deps.recordSkippedSubscribedTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            decision: {
              shouldReply: false,
              reason: "passive_disabled:passive-routing",
            },
          }),
        );
        expect(deps.replyToThread).not.toHaveBeenCalled();
      } finally {
        setExperimentalFeatures({
          "passive-routing": true,
          subagents: true,
        });
      }
    });

    it("does not unsubscribe the thread when resource cleanup fails", async () => {
      const cleanupError = new Error("resource cleanup failed");
      const deps = createMockDeps({
        cancelEventSubscriptions: vi.fn().mockRejectedValue(cleanupError),
        decideSubscribedReply: vi.fn().mockResolvedValue({
          shouldReply: false,
          shouldUnsubscribe: true,
          reason: "explicit stop",
        }),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = await createTestThread({});
      const message = createTestMessage({});
      await thread.subscribe();

      await expect(
        runtime.handleSubscribedMessage(thread, message, {
          destination: createTestDestination(thread),
        }),
      ).resolves.toBeUndefined();

      expect(deps.cancelEventSubscriptions).toHaveBeenCalledWith({
        conversationId: thread.id,
      });
      expect(thread.subscribed).toBe(true);
      expect(thread.posts).toHaveLength(1);
      expect(thread.posts).not.toContain(
        "Understood. I'll stay out of this thread unless someone @mentions me again.",
      );
    });

    it("passes stripped text via stripLeadingBotMention to prepareTurnState", async () => {
      const deps = createMockDeps({
        stripLeadingBotMention: vi.fn(() => "stripped text"),
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = await createTestThread({});
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
      const thread = await createTestThread({});
      const message = createTestMessage({});

      await runtime.handleSubscribedMessage(thread, message, {
        destination: createTestDestination(thread),
      });

      expect(deps.decideSubscribedReply).toHaveBeenCalledWith(
        expect.objectContaining({ conversationContext: "some context" }),
      );
    });

    it("prepares resource-event notifications without a actor", async () => {
      const deps = createMockDeps({
        withSpan: vi.fn(async (_n, _o, _c, cb) => cb()),
      });
      const runtime = createSlackTurnRuntime<TestState>(deps);
      const thread = await createTestThread({});
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
            actorId: undefined,
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
