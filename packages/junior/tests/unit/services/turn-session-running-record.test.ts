import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  cleanupTurnSessionRecordTest,
  createTurnSessionRecordServices,
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
    const userBoundary: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "help me" }],
        timestamp: 1,
      },
    ];
    const unsafeAssistantBoundary: PiMessage[] = [
      ...userBoundary,
      {
        role: "assistant",
        content: [{ type: "text", text: "working" }],
        timestamp: 2,
      } as PiMessage,
    ];
    const toolResultBoundary: PiMessage[] = [
      ...unsafeAssistantBoundary,
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        timestamp: 3,
      } as PiMessage,
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

  it("reports running record storage failures", async () => {
    const services = createTurnSessionRecordServices({
      upsertAgentTurnSessionRecord: async () => {
        throw new Error("storage unavailable");
      },
    });
    const { persistRunningSessionRecord } =
      await import("@/chat/services/turn-session-record");

    await expect(
      persistRunningSessionRecord(
        {
          conversationId: "conversation-storage-failure",
          sessionId: "turn-storage-failure",
          sliceId: 1,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "help me" }],
              timestamp: 1,
            },
          ],
          logContext: {
            modelId: "test-model",
          },
        },
        services,
      ),
    ).resolves.toBe(false);
  });

  it("branches Pi session state from the recoverable cursor after trimming an unsafe assistant tail", async () => {
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const user: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "help me" }],
      timestamp: 1,
    };
    const unsafeAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "not committed" }],
      timestamp: 2,
    } as PiMessage;
    const replacementToolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "safe result" }],
      timestamp: 3,
    } as PiMessage;

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
