import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  cleanupTurnSessionRecordTest,
  setupTurnSessionRecordTest,
} from "../../fixtures/turn-session-record";

beforeEach(setupTurnSessionRecordTest);

afterEach(cleanupTurnSessionRecordTest);

describe("turn session completed records", () => {
  it("does not fail a completed turn when session record persistence fails", async () => {
    const logException = vi.fn();
    vi.doMock("@/chat/logging", () => ({
      logException,
    }));
    vi.doMock("@/chat/state/turn-session", () => ({
      getAgentTurnSessionRecord: vi.fn(async () => {
        throw new Error("state adapter unavailable");
      }),
      upsertAgentTurnSessionRecord: vi.fn(),
    }));
    const { persistCompletedSessionRecord } =
      await import("@/chat/services/turn-session-record");

    await expect(
      persistCompletedSessionRecord({
        conversationId: "conversation-1",
        sessionId: "turn-1",
        sliceId: 1,
        allMessages: [
          {
            role: "user",
            content: [{ type: "text", text: "help me" }],
            timestamp: 1,
          },
        ],
        logContext: {
          channelId: "C123",
          modelId: "test-model",
          requesterId: "U123",
          threadId: "slack:C123:1",
        },
      }),
    ).resolves.toBeUndefined();

    expect(logException).toHaveBeenCalledWith(
      expect.any(Error),
      "agent_turn_completed_session_record_failed",
      expect.objectContaining({
        modelId: "test-model",
        slackChannelId: "C123",
        slackThreadId: "slack:C123:1",
        slackUserId: "U123",
      }),
      expect.objectContaining({
        "app.ai.resume_conversation_id": "conversation-1",
        "app.ai.resume_session_id": "turn-1",
        "app.ai.resume_slice_id": 1,
      }),
      "Failed to persist completed turn session record",
    );
  });

  it("keeps completed session bootstrap context for later turns in the same session", async () => {
    const { persistCompletedSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    await persistCompletedSessionRecord({
      conversationId: "conversation-completed",
      sessionId: "turn-completed",
      sliceId: 1,
      allMessages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<runtime-turn-context>\nstale\n</runtime-turn-context>",
            },
            { type: "text", text: "actual request" },
          ],
          timestamp: 1,
        } as PiMessage,
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          timestamp: 2,
        } as PiMessage,
      ],
      logContext: {
        modelId: "test-model",
      },
    });

    await expect(
      getAgentTurnSessionRecord("conversation-completed", "turn-completed"),
    ).resolves.toMatchObject({
      state: "completed",
      piMessages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<runtime-turn-context>\nstale\n</runtime-turn-context>",
            },
            { type: "text", text: "actual request" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      ],
    });
  });
});
