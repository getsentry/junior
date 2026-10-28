import { describe, expect, it, vi } from "vitest";

const { turnSpanAttributes } = vi.hoisted(() => ({
  turnSpanAttributes: [] as Array<Record<string, unknown>>,
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
        callback: (
          setSpanAttributes: (attributes: Record<string, unknown>) => void,
        ) => Promise<unknown>,
      ) =>
        await callback((attributes) => {
          if (op === "chat.turn") turnSpanAttributes.push(attributes);
        }),
    ),
  };
});

import {
  createSlackTurnRuntime,
  type SlackTurnRuntimeDependencies,
} from "@/chat/providers/slack/runtime";
import { getTurnInputSpanAttributes } from "@/chat/providers/slack/turn-input-timing";
import {
  createTestDestination,
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

const TURN_STARTED_AT_MS = 1_700_000_010_000;

function createDeps(): SlackTurnRuntimeDependencies<unknown> {
  return {
    assistantUserName: "test-bot",
    cancelWatches: vi.fn().mockResolvedValue(undefined),
    getBotUserId: () => "U0APP",
    modelId: "test-model",
    now: () => TURN_STARTED_AT_MS,
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

describe("Slack turn input timing", () => {
  it("rounds durations and leaves out negative clock skew", () => {
    expect(
      getTurnInputSpanAttributes(
        {
          count: 3,
          oldestCreatedAtMs: 1_000.4,
          oldestReceivedAtMs: 1_250,
        },
        1_900,
      ),
    ).toEqual({
      "app.turn.input_count": 3,
      "app.turn.delivery_lag_ms": 250,
      "app.turn.wait_ms": 650,
    });
    expect(
      getTurnInputSpanAttributes(
        { count: 1, oldestCreatedAtMs: 2_000, oldestReceivedAtMs: 1_500 },
        1_000,
      ),
    ).toEqual({ "app.turn.input_count": 1 });
  });

  it.each(["handleNewMention", "handleSubscribedMessage"] as const)(
    "%s measures wait_ms to the chat.turn start",
    async (handler) => {
      turnSpanAttributes.length = 0;
      const runtime = createSlackTurnRuntime(createDeps());
      const thread = await createTestThread({});
      const message = createTestMessage({
        text: "<@U0APP> hey",
        isMention: true,
      });

      await runtime[handler](thread, message, {
        destination: createTestDestination(thread),
        turnInput: {
          count: 2,
          oldestCreatedAtMs: TURN_STARTED_AT_MS - 4_000,
          oldestReceivedAtMs: TURN_STARTED_AT_MS - 3_000,
        },
      });

      expect(turnSpanAttributes).toContainEqual({
        "app.turn.input_count": 2,
        "app.turn.delivery_lag_ms": 1_000,
        "app.turn.wait_ms": 3_000,
      });
    },
  );
});
