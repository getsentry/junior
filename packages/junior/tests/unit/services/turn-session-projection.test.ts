import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  cleanupTurnSessionRecordTest,
  setupTurnSessionRecordTest,
} from "../../fixtures/turn-session-record";

beforeEach(setupTurnSessionRecordTest);

afterEach(cleanupTurnSessionRecordTest);

describe("turn session projection records", () => {
  it("materializes auth completion events appended after the pause record", async () => {
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { recordAuthorizationCompleted } =
      await import("@/chat/state/session-log");

    const userMessage: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "list my orgs" }],
      timestamp: 1,
    } as PiMessage;

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-auth-complete",
      sessionId: "turn-auth-complete",
      sliceId: 1,
      state: "awaiting_resume",
      piMessages: [userMessage],
      resumeReason: "auth",
      errorMessage: "plugin auth pause",
    });
    await recordAuthorizationCompleted({
      conversationId: "conversation-auth-complete",
      kind: "plugin",
      provider: "sentry",
      requesterId: "U123",
      authorizationId: "auth-1",
      ttlMs: 60_000,
    });

    await expect(
      getAgentTurnSessionRecord(
        "conversation-auth-complete",
        "turn-auth-complete",
      ),
    ).resolves.toMatchObject({
      state: "awaiting_resume",
      piMessages: [
        userMessage,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: 'Authorization completed for provider "sentry". Continue the blocked request and retry the provider operation if needed.',
            },
          ],
        },
      ],
    });
  });

  it("keeps older turn records pinned to their committed projection after reset", async () => {
    const {
      failAgentTurnSessionRecord,
      getAgentTurnSessionRecord,
      upsertAgentTurnSessionRecord,
    } = await import("@/chat/state/turn-session");
    const { loadProjection } = await import("@/chat/state/session-log");
    const oldRequest: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "old request" }],
      timestamp: 1,
    };
    const newRequest: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "new request" }],
      timestamp: 2,
    };
    const newFollowup: PiMessage = {
      role: "assistant",
      content: [{ type: "text", text: "new followup" }],
      timestamp: 3,
    } as PiMessage;

    const oldRecord = await upsertAgentTurnSessionRecord({
      conversationId: "conversation-projection-pin",
      sessionId: "turn-old",
      sliceId: 1,
      state: "awaiting_resume",
      resumeReason: "timeout",
      piMessages: [oldRequest],
    });
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-projection-pin",
      sessionId: "turn-new",
      sliceId: 1,
      state: "completed",
      piMessages: [newRequest, newFollowup],
    });

    await expect(
      getAgentTurnSessionRecord("conversation-projection-pin", "turn-old"),
    ).resolves.toMatchObject({
      piMessages: [oldRequest],
    });

    await failAgentTurnSessionRecord({
      conversationId: "conversation-projection-pin",
      sessionId: "turn-old",
      expectedVersion: oldRecord.version,
      errorMessage: "stale timeout callback",
    });

    await expect(
      loadProjection({
        conversationId: "conversation-projection-pin",
      }),
    ).resolves.toEqual([newRequest, newFollowup]);
  });
});
