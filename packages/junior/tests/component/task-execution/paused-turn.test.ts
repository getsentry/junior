import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { getConversationStore } from "@/chat/db";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import { neverRunAgentRunner } from "../../fixtures/agent-runner";
import { SLACK_DESTINATION } from "../../fixtures/conversation-work";

const SLACK_SOURCE = createSlackSource({
  teamId: SLACK_DESTINATION.teamId,
  channelId: SLACK_DESTINATION.channelId,
  threadTs: "1712345.0005",
  visibility: "private",
});

const ORIGINAL_ENV = vi.hoisted(() => {
  const original = {
    JUNIOR_STATE_ADAPTER: process.env.JUNIOR_STATE_ADAPTER,
  };
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  return original;
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

const agentRunnerShouldNotRun = neverRunAgentRunner();

async function seedConversationRouting(args: {
  conversationId: string;
  threadTs: string;
}): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId: args.conversationId,
    destination: SLACK_DESTINATION,
    sessionSource: createSlackSource({
      teamId: SLACK_DESTINATION.teamId,
      channelId: SLACK_DESTINATION.channelId,
      threadTs: args.threadTs,
      visibility: "private",
    }),
    visibility: "private",
  });
}

describe("paused turn runner callbacks", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    restoreEnv("JUNIOR_STATE_ADAPTER", ORIGINAL_ENV.JUNIOR_STATE_ADAPTER);
    vi.restoreAllMocks();
  });

  it("fails the session when delivery succeeded but completion state did not persist", async () => {
    const conversationId = "slack:C123:1712345.0005";
    const sessionId = "turn_msg_5";
    const sessionRecord = await upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
      destination: SLACK_DESTINATION,
      source: SLACK_SOURCE,
      resumeReason: "timeout",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
    });
    await seedConversationRouting({
      conversationId,
      threadTs: "1712345.0005",
    });
    await persistThreadStateById(conversationId, {
      artifacts: {
        listColumnMap: {},
      },
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [
          {
            id: "msg.5",
            role: "user",
            text: "resume this request",
            createdAtMs: 1,
            author: {
              userId: "U123",
            },
          },
        ],
        processing: {
          activeTurnId: sessionId,
        },
        vision: {
          byFileId: {},
        },
      },
    });

    const { runPausedTurn } = await import("@/chat/task-execution/paused-turn");

    await expect(
      runPausedTurn(
        {
          conversationId,
          destination: SLACK_DESTINATION,
          turnId: sessionId,
          expectedVersion: sessionRecord.version,
        },
        {
          agentRunner: agentRunnerShouldNotRun,
          resumeTurn: async (args) => {
            const prepared = await args.beforeStart?.();
            if (!prepared) {
              throw new Error("Expected the continuation to prepare");
            }
            if (!prepared.replyContext) {
              throw new Error("Expected prepared paused-turn reply context");
            }
            // Redis no longer stores execution actor; bare author + team rebuild.
            expect(prepared.replyContext.routing.actor).toEqual({
              platform: "slack",
              teamId: "T123",
              userId: "U123",
            });
            // Missing checkpoint flag fails closed to conversation-only.
            expect(prepared.replyContext.routing.publishExternally).toBe(false);
            const runArgs = { ...args, ...prepared };
            await runArgs.onPostDeliveryCommitFailure?.(
              new Error("completion state did not persist"),
            );
            return true;
          },
        },
      ),
    ).resolves.toBe(true);
    await expect(
      getTurnRecord(conversationId, sessionId),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage:
        "Continued agent reply was delivered but completion state did not persist",
    });
  });

  it("keeps checkpoint publishExternally on resume routing", async () => {
    const conversationId = "slack:C123:1712345.0006";
    const sessionId = "turn_msg_6";
    const sessionRecord = await upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
      destination: SLACK_DESTINATION,
      source: SLACK_SOURCE,
      resumeReason: "timeout",
      publishExternally: true,
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
    });
    await seedConversationRouting({
      conversationId,
      threadTs: "1712345.0006",
    });
    await persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [
          {
            id: "msg.6",
            role: "user",
            text: "resume this request",
            createdAtMs: 1,
            author: {
              userId: "U123",
            },
          },
        ],
        processing: {
          activeTurnId: sessionId,
        },
        vision: {
          byFileId: {},
        },
      },
    });

    const { runPausedTurn } = await import("@/chat/task-execution/paused-turn");
    let seenPublishExternally: boolean | undefined;

    await expect(
      runPausedTurn(
        {
          conversationId,
          destination: SLACK_DESTINATION,
          turnId: sessionId,
          expectedVersion: sessionRecord.version,
        },
        {
          agentRunner: agentRunnerShouldNotRun,
          resumeTurn: async (args) => {
            const prepared = await args.beforeStart?.();
            if (!prepared || !prepared.replyContext) {
              throw new Error("Expected prepared paused-turn reply context");
            }
            seenPublishExternally =
              prepared.replyContext.routing.publishExternally;
            return true;
          },
        },
      ),
    ).resolves.toBe(true);
    expect(seenPublishExternally).toBe(true);
  });

  it("fails before continuing when sql conversation source is missing", async () => {
    const conversationId = "slack:C123:1712345.0007";
    const sessionId = "turn_msg_7";
    // Destination-only upsert leaves sessionSource unset so resume hard-fails
    // at the SQL routing boundary instead of rebuilding from redis/source.
    const sessionRecord = await upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
      destination: SLACK_DESTINATION,
      resumeReason: "timeout",
      actor: {
        platform: "slack",
        teamId: SLACK_DESTINATION.teamId,
        userId: "U123",
        userName: "stored-user",
      },
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
    });
    await persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [
          {
            id: "msg.7",
            role: "user",
            text: "resume this request",
            createdAtMs: 1,
            author: {
              userId: "U123",
            },
          },
        ],
        processing: {
          activeTurnId: sessionId,
        },
        vision: {
          byFileId: {},
        },
      },
    });

    const { runPausedTurn } = await import("@/chat/task-execution/paused-turn");

    await expect(
      runPausedTurn(
        {
          conversationId,
          destination: SLACK_DESTINATION,
          turnId: sessionId,
          expectedVersion: sessionRecord.version,
        },
        {
          agentRunner: agentRunnerShouldNotRun,
          resumeTurn: async (args) => {
            await args.beforeStart?.();
            throw new Error("Expected continuation preparation to fail");
          },
        },
      ),
    ).rejects.toThrow(
      `Conversation ${conversationId} is missing durable routing metadata`,
    );
    await expect(
      getTurnRecord(conversationId, sessionId),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage: `Conversation ${conversationId} is missing durable routing metadata`,
    });
  });

  it("loads continuation source from sql conversation metadata", async () => {
    const conversationId = "slack:C123:1712345.0008";
    const sessionId = "turn_msg_8";
    const sessionSource = createSlackSource({
      teamId: SLACK_DESTINATION.teamId,
      channelId: SLACK_DESTINATION.channelId,
      threadTs: "1712345.0008",
      visibility: "private",
    });
    const sessionRecord = await upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
      resumeReason: "timeout",
      actor: {
        platform: "slack",
        teamId: SLACK_DESTINATION.teamId,
        userId: "U123",
        userName: "stored-user",
        fullName: "Stored User",
        email: "stored@example.com",
      },
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
    });
    await getConversationStore().recordActivity({
      conversationId,
      destination: SLACK_DESTINATION,
      sessionSource,
      visibility: "private",
    });
    await persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [
          {
            id: "msg.8",
            role: "user",
            text: "resume this request",
            createdAtMs: 1,
            author: {
              userId: "U123",
            },
          },
        ],
        processing: {
          activeTurnId: sessionId,
        },
        vision: {
          byFileId: {},
        },
      },
    });

    const { runPausedTurn } = await import("@/chat/task-execution/paused-turn");

    await expect(
      runPausedTurn(
        {
          conversationId,
          destination: SLACK_DESTINATION,
          turnId: sessionId,
          expectedVersion: sessionRecord.version,
        },
        {
          agentRunner: agentRunnerShouldNotRun,
          resumeTurn: async (args) => {
            const prepared = await args.beforeStart?.();
            if (!prepared) {
              throw new Error("Expected the continuation to prepare");
            }
            if (!prepared.replyContext) {
              throw new Error("Expected prepared paused-turn reply context");
            }
            expect(prepared.replyContext.routing.source).toEqual(sessionSource);
            return true;
          },
        },
      ),
    ).resolves.toBe(true);
    await expect(
      getTurnRecord(conversationId, sessionId),
    ).resolves.toMatchObject({
      state: "paused",
    });
  });

  it("fails before continuing when the turn user message has no author id", async () => {
    const conversationId = "slack:C123:1712345.0006";
    const sessionId = "turn_msg_6";
    const sessionRecord = await upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
      destination: SLACK_DESTINATION,
      resumeReason: "timeout",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
    });
    await seedConversationRouting({
      conversationId,
      threadTs: "1712345.0006",
    });
    await persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [
          {
            id: "msg.6",
            role: "user",
            text: "resume this request",
            createdAtMs: 1,
            author: {},
          },
        ],
        processing: {
          activeTurnId: sessionId,
        },
        vision: {
          byFileId: {},
        },
      },
    });

    const { runPausedTurn } = await import("@/chat/task-execution/paused-turn");

    // Missing author identity must never throw out of the continue callback
    // (issue #727: a throw NACKs the queue delivery and wedges the
    // conversation); it terminally fails the session instead.
    await expect(
      runPausedTurn(
        {
          conversationId,
          destination: SLACK_DESTINATION,
          turnId: sessionId,
          expectedVersion: sessionRecord.version,
        },
        {
          agentRunner: agentRunnerShouldNotRun,
          resumeTurn: async (args) => {
            const prepared = await args.beforeStart?.();
            if (prepared !== false) {
              throw new Error("Expected continuation preparation to fail");
            }
            return true;
          },
        },
      ),
    ).resolves.toBe(true);
    await expect(
      getTurnRecord(conversationId, sessionId),
    ).resolves.toMatchObject({
      state: "failed",
    });
  });
});
