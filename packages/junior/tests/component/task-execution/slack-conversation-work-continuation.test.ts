import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import {
  getConversationWorkState,
  requestConversationWork,
} from "@/chat/task-execution/store";
import { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import { processConversationWork } from "@/chat/task-execution/worker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONVERSATION_ID,
  createConversationWorkQueueTestAdapter,
  createSlackAdapterFixture,
} from "../../fixtures/conversation-work";

describe("Slack conversation work continuations", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("terminalizes invalid idle continuation metadata", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();

    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: 1_000,
      state,
    });
    await upsertAgentTurnSessionRecord({
      conversationId: CONVERSATION_ID,
      sessionId: "turn-invalid-timeout",
      sliceId: 1,
      state: "awaiting_resume",
      resumeReason: "timeout",
      piMessages: [],
    });

    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        state,
        run: createSlackConversationWorker({
          getSlackAdapter: () => slackAdapter,
          runtime: {
            handleNewMention: async () => {
              throw new Error("injected messages should not replay");
            },
            handleSubscribedMessage: async () => {
              throw new Error("injected messages should not replay");
            },
          },
          state,
        }),
      }),
    ).resolves.toEqual({ status: "completed" });

    const recovered = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(recovered?.lease).toBeUndefined();
    expect(recovered?.needsRun).toBe(false);
    expect(recovered?.messages).toEqual([]);
    await expect(
      getAgentTurnSessionRecord(CONVERSATION_ID, "turn-invalid-timeout"),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage:
        "Awaiting turn continuation metadata could not be materialized",
    });
  });

  it("terminalizes stale idle continuations skipped by resume startup", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const sessionId = "turn_1712345_0001";

    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: 1_000,
      state,
    });
    await upsertAgentTurnSessionRecord({
      conversationId: CONVERSATION_ID,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      resumeReason: "timeout",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "original request" }],
          timestamp: 1_000,
        },
      ],
    });
    await persistThreadStateById(CONVERSATION_ID, {
      artifacts: {
        listColumnMap: {},
      },
      conversation: {
        schemaVersion: 1,
        backfill: {},
        compactions: [],
        piMessages: [],
        messages: [
          {
            id: "1712345.0001",
            role: "user",
            text: "original request",
            createdAtMs: 1_000,
            author: {
              userId: "U123",
            },
          },
        ],
        processing: {
          activeTurnId: "turn-newer",
        },
        stats: {
          compactedMessageCount: 0,
          estimatedContextTokens: 0,
          totalMessageCount: 1,
          updatedAtMs: 1_000,
        },
        vision: {
          byFileId: {},
        },
      },
    });

    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        state,
        run: createSlackConversationWorker({
          getSlackAdapter: () => slackAdapter,
          runtime: {
            handleNewMention: async () => {
              throw new Error("injected messages should not replay");
            },
            handleSubscribedMessage: async () => {
              throw new Error("injected messages should not replay");
            },
          },
          state,
        }),
      }),
    ).resolves.toEqual({ status: "completed" });

    const recovered = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(recovered?.lease).toBeUndefined();
    expect(recovered?.needsRun).toBe(false);
    expect(recovered?.messages).toEqual([]);
    await expect(
      getAgentTurnSessionRecord(CONVERSATION_ID, sessionId),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage: "Awaiting turn continuation was stale before resuming",
    });
  });
});
