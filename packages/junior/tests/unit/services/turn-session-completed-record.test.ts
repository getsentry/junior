import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  cleanupTurnSessionRecordTest,
  piTextMessage,
  setupTurnSessionRecordTest,
} from "../../fixtures/turn-session-record";

beforeEach(setupTurnSessionRecordTest);

afterEach(cleanupTurnSessionRecordTest);

describe("turn session completed records", () => {
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
        piTextMessage("assistant", "done", 2),
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
