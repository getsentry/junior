import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      conversationId,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
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
    await persistThreadStateById(conversationId, {
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
          resumeTurn: async (args) => {
            const prepared = await args.beforeStart?.();
            expect(prepared).toBeTruthy();
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
});
