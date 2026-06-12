import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryableTurnError } from "@/chat/runtime/turn";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import {
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import { SLACK_DESTINATION } from "../../fixtures/conversation-work";

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

async function prepareAwaitingContinuation(args: {
  conversationId: string;
  messageId: string;
  requester?: Parameters<typeof upsertAgentTurnSessionRecord>[0]["requester"];
  sessionId: string;
  text?: string;
}) {
  const sessionRecord = await upsertAgentTurnSessionRecord({
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    sliceId: 2,
    state: "awaiting_resume",
    destination: SLACK_DESTINATION,
    resumeReason: "timeout",
    requester: args.requester,
    piMessages: [
      {
        role: "user",
        content: [{ type: "text", text: args.text ?? "hello" }],
        timestamp: 1,
      },
    ],
  });
  await persistThreadStateById(args.conversationId, {
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
          id: args.messageId,
          role: "user",
          text: "resume this request",
          createdAtMs: 1,
          author: {
            userId: "U123",
          },
        },
      ],
      processing: {
        activeTurnId: args.sessionId,
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
  return sessionRecord;
}

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
    const sessionRecord = await prepareAwaitingContinuation({
      conversationId,
      messageId: "msg.5",
      sessionId,
      requester: {
        slackUserId: "U123",
        slackUserName: "stored-user",
        fullName: "Stored User",
        email: "stored@example.com",
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
          resumeTurn: async (args) => {
            const prepared = await args.beforeStart?.();
            if (!prepared) {
              throw new Error("Expected the continuation to prepare");
            }
            if (!prepared.replyContext) {
              throw new Error("Expected prepared continuation reply context");
            }
            expect(prepared.replyContext.requester).toEqual({
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

  it("requeues when a resumed timeout continuation times out again", async () => {
    const conversationId = "slack:C123:1712345.0007";
    const sessionId = "turn_msg_7";
    const sessionRecord = await prepareAwaitingContinuation({
      conversationId,
      messageId: "msg.7",
      sessionId,
      requester: {
        slackUserId: "U123",
        slackUserName: "stored-user",
      },
      text: "keep going",
    });
    const scheduleAgentContinue = vi.fn(async () => undefined);
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
          scheduleAgentContinue,
          resumeTurn: async (args) => {
            const prepared = await args.beforeStart?.();
            if (!prepared) {
              throw new Error("Expected the continuation to prepare");
            }
            await prepared.onTimeoutPause?.(
              new RetryableTurnError("agent_continue", "timed out again", {
                conversationId,
                sessionId,
                version: sessionRecord.version + 1,
                sliceId: sessionRecord.sliceId + 1,
              }),
            );
            return true;
          },
        },
      ),
    ).resolves.toBe(true);

    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      destination: SLACK_DESTINATION,
      sessionId,
      expectedVersion: sessionRecord.version + 1,
    });
  });

  it("fails before continuing when stored requester and message author differ", async () => {
    const conversationId = "slack:C123:1712345.0006";
    const sessionId = "turn_msg_6";
    const sessionRecord = await prepareAwaitingContinuation({
      conversationId,
      messageId: "msg.6",
      sessionId,
      requester: {
        slackUserId: "U999",
        slackUserName: "wrong-user",
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
          resumeTurn: async (args) => {
            await args.beforeStart?.();
            throw new Error("continuation should not prepare");
          },
        },
      ),
    ).rejects.toThrow("Stored Slack requester must match actor user id");
    await expect(
      getAgentTurnSessionRecord(conversationId, sessionId),
    ).resolves.toMatchObject({
      state: "failed",
    });
  });
});
