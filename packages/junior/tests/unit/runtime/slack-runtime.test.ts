import { describe, expect, it, vi } from "vitest";
import { createSlackTurnRuntime } from "@/chat/runtime/slack-runtime";

describe("createSlackTurnRuntime", () => {
  it("runs subscribed-thread routing and preparation inside the turn span", async () => {
    let insideSpan = false;

    const withSpan = vi.fn(
      async (
        _name: string,
        _op: string,
        _context: Record<string, unknown>,
        callback: () => Promise<void>,
      ) => {
        insideSpan = true;
        try {
          await callback();
        } finally {
          insideSpan = false;
        }
      },
    );

    const prepareTurnState = vi.fn(async () => {
      expect(insideSpan).toBe(true);
      return { prepared: true } as const;
    });
    const decideSubscribedReply = vi.fn(async () => {
      expect(insideSpan).toBe(true);
      return {
        shouldReply: false,
        reason: "side_conversation",
      };
    });

    const runtime = createSlackTurnRuntime({
      assistantUserName: "junior",
      decideSubscribedReply,
      getChannelId: () => "C123",
      getErrorReference: () => null,
      getPreparedConversationContext: () => "prior thread context",
      getRunId: () => "run_123",
      getThreadId: () => "thread_123",
      initializeAssistantThread: vi.fn(),
      logException: vi.fn(),
      logWarn: vi.fn(),
      modelId: "openai/gpt-4o-mini",
      now: () => 1,
      onSubscribedMessageSkipped: vi.fn(async () => {}),
      persistPreparedState: vi.fn(async () => {}),
      prepareTurnState,
      recordSkippedSubscribedMessage: vi.fn(async () => {}),
      refreshAssistantThreadContext: vi.fn(),
      replyToThread: vi.fn(async () => {}),
      stripLeadingBotMention: (text: string) => text,
      withSpan,
    });

    await runtime.handleSubscribedMessage(
      {
        post: vi.fn(),
        unsubscribe: vi.fn(),
      } as any,
      {
        attachments: [],
        author: {
          userId: "U123",
          userName: "alice",
        },
        isMention: false,
        text: "can you take a look at this?",
      } as any,
    );

    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(withSpan.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        conversationId: "thread_123",
        slackChannelId: "C123",
        slackThreadId: "thread_123",
        slackUserId: "U123",
        runId: "run_123",
      }),
    );
    expect(prepareTurnState).toHaveBeenCalledTimes(1);
    expect(decideSubscribedReply).toHaveBeenCalledTimes(1);
  });
});
