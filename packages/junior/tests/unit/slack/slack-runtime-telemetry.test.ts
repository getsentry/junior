import { describe, expect, it, vi } from "vitest";

const { addReactionToMessage, spans } = vi.hoisted(() => ({
  addReactionToMessage:
    vi.fn<typeof import("@/chat/slack/outbound").addReactionToMessage>(),
  // Ops of the spans that are open, outermost first.
  spans: { open: [] as string[] },
}));

vi.mock("@/chat/slack/outbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/slack/outbound")>()),
  addReactionToMessage,
}));

vi.mock("@/chat/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/logging")>();
  return {
    ...actual,
    withSpan: vi.fn(
      async (
        _name: string,
        op: string,
        _context: unknown,
        callback: (setSpanAttributes: () => void) => Promise<unknown>,
      ) => {
        spans.open.push(op);
        try {
          return await callback(() => undefined);
        } finally {
          spans.open.pop();
        }
      },
    ),
  };
});

import {
  createSlackTurnRuntime,
  type SlackTurnRuntimeDependencies,
} from "@/chat/providers/slack/runtime";
import {
  createTestDestination,
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

function createDeps(): SlackTurnRuntimeDependencies<unknown> {
  return {
    assistantUserName: "test-bot",
    cancelWatches: vi.fn().mockResolvedValue(undefined),
    getBotUserId: () => "U0APP",
    modelId: "test-model",
    now: () => 1_700_000_000_000,
    initializeAssistantThread: vi.fn().mockResolvedValue(undefined),
    refreshAssistantThreadContext: vi.fn().mockResolvedValue(undefined),
    onSubscribedMessageSkipped: vi.fn().mockResolvedValue(undefined),
    recordSkippedSteeringMessage: vi.fn().mockResolvedValue(undefined),
    recordSkippedSubscribedTurn: vi.fn().mockResolvedValue(undefined),
    persistPreparedState: vi.fn().mockResolvedValue(undefined),
    prepareTurnState: vi.fn().mockResolvedValue({}),
    executeSlackTurn: vi.fn().mockResolvedValue(undefined),
    decideSubscribedReply: vi
      .fn()
      .mockResolvedValue({ shouldReply: true, reason: "test" }),
    getPreparedConversationContext: vi.fn(() => undefined),
  };
}

describe("Slack turn telemetry", () => {
  it("adds the mention processing reaction under chat.turn", async () => {
    const openSpansAtReaction: string[][] = [];
    addReactionToMessage.mockImplementation(async () => {
      openSpansAtReaction.push([...spans.open]);
      return { ok: true };
    });
    const thread = await createTestThread({});

    await createSlackTurnRuntime(createDeps()).handleNewMention(
      thread,
      createTestMessage({ text: "hey bot" }),
      { destination: createTestDestination(thread) },
    );

    expect(openSpansAtReaction).toEqual([["chat.turn"]]);
  });
});
