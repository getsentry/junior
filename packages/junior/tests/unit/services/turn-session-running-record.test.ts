import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  cleanupTurnSessionRecordTest,
  piTextMessage,
  setupTurnSessionRecordTest,
} from "../../fixtures/turn-session-record";

beforeEach(setupTurnSessionRecordTest);

afterEach(cleanupTurnSessionRecordTest);

describe("turn session running records", () => {
  it("stores running records only at continuable message boundaries", async () => {
    const { persistRunningSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const userBoundary = [piTextMessage("user", "help me", 1)];
    const unsafeAssistantBoundary: PiMessage[] = [
      ...userBoundary,
      piTextMessage("assistant", "working", 2),
    ];
    const toolResultBoundary: PiMessage[] = [
      ...unsafeAssistantBoundary,
      piTextMessage("toolResult", "ok", 3, {
        toolCallId: "call-1",
        toolName: "bash",
      }),
    ];

    await expect(
      persistRunningSessionRecord({
        conversationId: "conversation-1",
        sessionId: "turn-1",
        sliceId: 1,
        messages: userBoundary,
        logContext: {
          modelId: "test-model",
        },
      }),
    ).resolves.toBe(true);

    await expect(
      persistRunningSessionRecord({
        conversationId: "conversation-1",
        sessionId: "turn-1",
        sliceId: 1,
        messages: unsafeAssistantBoundary,
        logContext: {
          modelId: "test-model",
        },
      }),
    ).resolves.toBe(false);

    let sessionRecord = await getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(sessionRecord).toMatchObject({
      state: "running",
      piMessages: userBoundary,
    });

    await expect(
      persistRunningSessionRecord({
        conversationId: "conversation-1",
        sessionId: "turn-1",
        sliceId: 1,
        messages: toolResultBoundary,
        logContext: {
          modelId: "test-model",
        },
      }),
    ).resolves.toBe(true);

    sessionRecord = await getAgentTurnSessionRecord("conversation-1", "turn-1");
    expect(sessionRecord).toMatchObject({
      state: "running",
      piMessages: toolResultBoundary,
    });
  });

  it("branches Pi session state from the recoverable cursor after trimming an unsafe assistant tail", async () => {
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const user = piTextMessage("user", "help me", 1);
    const unsafeAssistant = piTextMessage("assistant", "not committed", 2);
    const replacementToolResult = piTextMessage(
      "toolResult",
      "safe result",
      3,
      {
        toolCallId: "call-1",
        toolName: "bash",
      },
    );

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-branch",
      sessionId: "turn-branch",
      sliceId: 1,
      state: "running",
      piMessages: [user, unsafeAssistant],
    });
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-branch",
      sessionId: "turn-branch",
      sliceId: 2,
      state: "awaiting_resume",
      piMessages: [user],
      resumeReason: "timeout",
    });
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-branch",
      sessionId: "turn-branch",
      sliceId: 2,
      state: "running",
      piMessages: [user, replacementToolResult],
    });

    await expect(
      getAgentTurnSessionRecord("conversation-branch", "turn-branch"),
    ).resolves.toMatchObject({
      state: "running",
      piMessages: [user, replacementToolResult],
    });
  });
});
