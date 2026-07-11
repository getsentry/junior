import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import {
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import { neverRunAgentRunner } from "../../fixtures/agent-runner";
import { SLACK_DESTINATION } from "../../fixtures/conversation-work";

const SLACK_SOURCE = createSlackSource({
  teamId: SLACK_DESTINATION.teamId,
  channelId: SLACK_DESTINATION.channelId,
  threadTs: "1712345.0005",
  type: "priv",
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

describe("agent continuation runner callbacks", () => {
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
    const sessionRecord = await upsertAgentTurnSessionRecord({
      modelId: "test/model",
      conversationId,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
      source: SLACK_SOURCE,
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
    await persistThreadStateById(conversationId, {
      artifacts: {
        listColumnMap: {},
      },
      conversation: {
        schemaVersion: 1,
        backfill: {},
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
        stats: {
          compactedMessageCount: 0,
          estimatedContextTokens: 0,
          totalMessageCount: 1,
          updatedAtMs: 1,
        },
        vision: {
          byFileId: {},
        },
      },
    });

    const { continueSlackAgentRun } =
      await import("@/chat/runtime/agent-continue-runner");

    await expect(
      continueSlackAgentRun(
        {
          conversationId,
          destination: SLACK_DESTINATION,
          sessionId,
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
              throw new Error("Expected prepared continuation reply context");
            }
            expect(prepared.replyContext.routing.actor).toEqual({
              email: "stored@example.com",
              fullName: "Stored User",
              platform: "slack",
              teamId: "T123",
              userId: "U123",
              userName: "stored-user",
            });
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
      getAgentTurnSessionRecord(conversationId, sessionId),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage:
        "Continued agent reply was delivered but completion state did not persist",
    });
  });

  it("fails before continuing when a continuation record is missing source", async () => {
    const conversationId = "slack:C123:1712345.0007";
    const sessionId = "turn_msg_7";
    const sessionRecord = await upsertAgentTurnSessionRecord({
      modelId: "test/model",
      conversationId,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
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
        backfill: {},
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
        stats: {
          compactedMessageCount: 0,
          estimatedContextTokens: 0,
          totalMessageCount: 1,
          updatedAtMs: 1,
        },
        vision: {
          byFileId: {},
        },
      },
    });

    const { continueSlackAgentRun } =
      await import("@/chat/runtime/agent-continue-runner");

    await expect(
      continueSlackAgentRun(
        {
          conversationId,
          destination: SLACK_DESTINATION,
          sessionId,
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
      getAgentTurnSessionRecord(conversationId, sessionId),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage: "Stored Slack source missing for continuation",
    });
  });

  it("fails before continuing when stored actor and message author differ", async () => {
    const conversationId = "slack:C123:1712345.0006";
    const sessionId = "turn_msg_6";
    const sessionRecord = await upsertAgentTurnSessionRecord({
      modelId: "test/model",
      conversationId,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
      resumeReason: "timeout",
      actor: {
        platform: "slack",
        teamId: SLACK_DESTINATION.teamId,
        userId: "U999",
        userName: "wrong-user",
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
        backfill: {},
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
        stats: {
          compactedMessageCount: 0,
          estimatedContextTokens: 0,
          totalMessageCount: 1,
          updatedAtMs: 1,
        },
        vision: {
          byFileId: {},
        },
      },
    });

    const { continueSlackAgentRun } =
      await import("@/chat/runtime/agent-continue-runner");

    // A mismatched stored actor must never throw out of the continue
    // callback (issue #727: a throw NACKs the queue delivery and wedges the
    // conversation); it terminally fails the session instead.
    await expect(
      continueSlackAgentRun(
        {
          conversationId,
          destination: SLACK_DESTINATION,
          sessionId,
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
      getAgentTurnSessionRecord(conversationId, sessionId),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage: "Stored Slack actor missing for continuation",
    });
  });
});
