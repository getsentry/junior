import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource, type Destination } from "@sentry/junior-plugin-api";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { buildDeterministicTurnId } from "@/chat/runtime/turn";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import { resetSlackApiMockState } from "../../msw/handlers/slack-api";
import {
  createTestThread,
  createTestMessage,
} from "../../fixtures/slack-harness";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import { resetConversationTitleStateForTests } from "@/chat/services/conversation-title";
import { resetAssistantTitleProjectionForTests } from "@/chat/slack/assistant-thread/title";
import { neverRunAgentRunner } from "../../fixtures/agent-runner";
import {
  createConversationWorkQueueTestAdapter,
  type ConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";
import { mockTitleModel } from "../../fixtures/title-model";
import { mockTurnRouterModel } from "../../fixtures/turn-router-model";

const emptyThreadReplies = async () => [];
const ORIGINAL_AI_GATEWAY_API_KEY = process.env.AI_GATEWAY_API_KEY;

function createRuntime(
  args: {
    queue?: ConversationWorkQueueTestAdapter;
    services?: JuniorRuntimeServiceOverrides;
  } = {},
) {
  const services = args.services ?? {};
  return createTestChatRuntime({
    queue: args.queue,
    services: {
      ...services,
      visionContext: {
        listThreadReplies: emptyThreadReplies,
        ...(services.visionContext ?? {}),
      },
    },
  });
}

function createSlackSourceForTest(channelId: string) {
  return createSlackSource({
    teamId: "T123",
    channelId,
    threadTs: "1700000000.000",

    visibility: "private",
  });
}

function slackDestination(channelId: string) {
  return {
    platform: "slack",
    teamId: "T123",
    channelId,
  } satisfies Destination;
}

function createAwaitingContinuationState(args: {
  activeSessionId: string;
  userMessageId?: string;
}) {
  return {
    conversation: {
      schemaVersion: 1,
      compactions: [],
      piMessages: [],
      messages: [
        {
          id: args.userMessageId ?? "msg-original",
          role: "user",
          text: "please keep working",
          createdAtMs: 1,
          author: {
            userId: "U-test",
          },
        },
      ],
      processing: {
        activeTurnId: args.activeSessionId,
      },
      vision: {
        byFileId: {},
      },
    },
  };
}

function turnPiMessages(text: string) {
  return [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text }],
      timestamp: 1,
    },
  ];
}

// ── Tests ────────────────────────────────────────────────────────────

describe("bot handlers (integration)", () => {
  beforeEach(async () => {
    process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
    mockTurnRouterModel();
    mockTitleModel("Test conversation");
    resetConversationTitleStateForTests();
    resetAssistantTitleProjectionForTests();
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    if (ORIGINAL_AI_GATEWAY_API_KEY === undefined) {
      delete process.env.AI_GATEWAY_API_KEY;
    } else {
      process.env.AI_GATEWAY_API_KEY = ORIGINAL_AI_GATEWAY_API_KEY;
    }
    resetSlackApiMockState();
    resetConversationTitleStateForTests();
    resetAssistantTitleProjectionForTests();
    vi.restoreAllMocks();
    await disconnectStateAdapter();
  });

  it("reschedules an awaiting continuation for repeated delivery of the active message", async () => {
    const conversationId = "slack:C9TIMEDUP:1700000000.000";
    const destination = slackDestination("C9TIMEDUP");
    const activeSessionId = "turn_msg-duplicate";
    await upsertTurnRecord({
      conversationId,
      destination,
      turnId: activeSessionId,
      sliceId: 1,
      state: "paused",
      resumeReason: "yield",
      source: createSlackSourceForTest("C9TIMEDUP"),
      piMessages: turnPiMessages("please keep working"),
      turnStartMessageIndex: 0,
    });
    const queue = createConversationWorkQueueTestAdapter();
    const { slackRuntime } = createRuntime({
      queue,
      services: {
        agentRunner: neverRunAgentRunner(),
      },
    });

    const thread = await createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({
        activeSessionId,
        userMessageId: "msg-duplicate",
      }),
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-duplicate",
        threadId: conversationId,
        text: "please keep working",
        isMention: true,
      }),
      { destination },
    );

    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId,
        idempotencyKey: expect.stringContaining(
          `agent-continue:${conversationId}:${activeSessionId}:1:`,
        ),
      }),
    ]);
  });

  it("does not start a new turn when rescheduling an active continuation fails", async () => {
    const conversationId = "slack:C9TIMEFAIL:1700000000.000";
    const destination = slackDestination("C9TIMEFAIL");
    const activeSessionId = "turn_msg-original";
    await upsertTurnRecord({
      conversationId,
      destination,
      turnId: activeSessionId,
      sliceId: 1,
      state: "paused",
      resumeReason: "yield",
      source: createSlackSourceForTest("C9TIMEFAIL"),
      piMessages: turnPiMessages("please keep working"),
      turnStartMessageIndex: 0,
    });
    const queue = createConversationWorkQueueTestAdapter();
    queue.rejectSends();
    const { slackRuntime } = createRuntime({
      queue,
      services: {
        agentRunner: neverRunAgentRunner(),
      },
    });

    const thread = await createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({ activeSessionId }),
    });

    const followUp = createTestMessage({
      id: "msg-retry-fail",
      threadId: conversationId,
      text: "what happened?",
      isMention: true,
    });
    await slackRuntime.handleNewMention(thread, followUp, { destination });

    expect(queue.queuedMessages()).toEqual([]);
    await expect(
      getTurnRecord(conversationId, buildDeterministicTurnId(followUp.id)),
    ).resolves.toBeUndefined();
    await expect(
      getTurnRecord(conversationId, activeSessionId),
    ).resolves.toMatchObject({ state: "paused" });
    expect(thread.posts).toEqual([
      expect.stringContaining(
        "I ran into an internal error while processing that.",
      ),
    ]);
  });
});
