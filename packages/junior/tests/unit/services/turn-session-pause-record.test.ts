import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  cleanupTurnSessionRecordTest,
  piTextMessage,
  setupTurnSessionRecordTest,
} from "../../fixtures/turn-session-record";

beforeEach(setupTurnSessionRecordTest);

afterEach(cleanupTurnSessionRecordTest);

describe("turn session pause records", () => {
  it("reuses the latest stored transcript when the auth pause captured no messages", async () => {
    const { persistAuthPauseSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    const priorMessages: PiMessage[] = [
      piTextMessage("user", "help me", 1),
      piTextMessage("assistant", "working on it", 2, {
        api: "responses",
        provider: "openai",
        model: "gpt-5.3",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "toolUse",
      }),
    ];

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      state: "awaiting_resume",
      piMessages: priorMessages,
      resumeReason: "auth",
      errorMessage: "initial auth pause",
    });

    const authSessionRecord = await persistAuthPauseSessionRecord({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      currentSliceId: 1,
      messages: [],
      errorMessage: "plugin auth pause",
      logContext: {
        modelId: "test-model",
      },
    });

    expect(authSessionRecord?.sliceId).toBe(2);

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(sessionRecord).toMatchObject({
      state: "awaiting_resume",
      sliceId: 2,
      resumedFromSliceId: 1,
      resumeReason: "auth",
      errorMessage: "plugin auth pause",
      piMessages: [priorMessages[0]],
    });
  });

  it("carries cumulative diagnostics across pause records", async () => {
    const { persistTimeoutSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      state: "awaiting_resume",
      piMessages: [piTextMessage("user", "continue me", 1)],
      resumeReason: "timeout",
      cumulativeDurationMs: 1_500,
      cumulativeUsage: {
        inputTokens: 10,
        outputTokens: 3,
      },
    });

    await persistTimeoutSessionRecord({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      currentSliceId: 1,
      currentDurationMs: 2_250,
      currentUsage: {
        outputTokens: 7,
        cachedInputTokens: 2,
      },
      messages: [],
      errorMessage: "timed out again",
      logContext: {
        modelId: "test-model",
      },
    });

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(sessionRecord).toMatchObject({
      cumulativeDurationMs: 3_750,
      cumulativeUsage: {
        inputTokens: 10,
        outputTokens: 10,
        cachedInputTokens: 2,
      },
    });
  });

  it("fails timeout sessions instead of scheduling beyond the slice cap", async () => {
    const {
      AGENT_TURN_TIMEOUT_RESUME_MAX_SLICES,
      persistTimeoutSessionRecord,
    } = await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    const piMessages = [piTextMessage("user", "keep trying", 1)];

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-timeout-cap",
      sessionId: "turn-timeout-cap",
      sliceId: AGENT_TURN_TIMEOUT_RESUME_MAX_SLICES,
      state: "awaiting_resume",
      piMessages,
      resumeReason: "timeout",
      cumulativeDurationMs: 12_000,
    });

    await expect(
      persistTimeoutSessionRecord({
        conversationId: "conversation-timeout-cap",
        sessionId: "turn-timeout-cap",
        currentSliceId: AGENT_TURN_TIMEOUT_RESUME_MAX_SLICES,
        currentDurationMs: 3_000,
        messages: piMessages,
        errorMessage: "timed out again",
        logContext: {
          modelId: "test-model",
        },
      }),
    ).resolves.toMatchObject({
      state: "failed",
      sliceId: AGENT_TURN_TIMEOUT_RESUME_MAX_SLICES,
      cumulativeDurationMs: 15_000,
      errorMessage: expect.stringContaining("slice limit"),
      piMessages,
    });

    await expect(
      getAgentTurnSessionRecord("conversation-timeout-cap", "turn-timeout-cap"),
    ).resolves.toMatchObject({
      state: "failed",
      sliceId: AGENT_TURN_TIMEOUT_RESUME_MAX_SLICES,
      cumulativeDurationMs: 15_000,
      errorMessage: expect.stringContaining("slice limit"),
      piMessages,
    });
  });

  it("falls back to the last stored safe boundary when auth pause captures a non-continuable tail", async () => {
    const { persistAuthPauseSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    const safeBoundary = [piTextMessage("user", "connect and answer", 1)];

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-auth-tail",
      sessionId: "turn-auth-tail",
      sliceId: 1,
      state: "running",
      piMessages: safeBoundary,
    });

    const authSessionRecord = await persistAuthPauseSessionRecord({
      conversationId: "conversation-auth-tail",
      sessionId: "turn-auth-tail",
      currentSliceId: 1,
      messages: [
        piTextMessage("assistant", "calling credential-gated tool", 2, {
          api: "responses",
          provider: "openai",
          model: "gpt-5.3",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "toolUse",
        }),
      ],
      errorMessage: "plugin auth pause",
      logContext: {
        modelId: "test-model",
      },
    });

    expect(authSessionRecord).toMatchObject({
      state: "awaiting_resume",
      sliceId: 2,
      resumeReason: "auth",
      piMessages: safeBoundary,
    });

    await expect(
      getAgentTurnSessionRecord("conversation-auth-tail", "turn-auth-tail"),
    ).resolves.toMatchObject({
      state: "awaiting_resume",
      piMessages: safeBoundary,
    });
  });

  it("does not create an awaiting-resume record without a continuable Pi boundary", async () => {
    const { persistAuthPauseSessionRecord, persistTimeoutSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    await expect(
      persistAuthPauseSessionRecord({
        conversationId: "conversation-empty",
        sessionId: "turn-empty",
        currentSliceId: 1,
        messages: [],
        errorMessage: "auth pause",
        logContext: {
          modelId: "test-model",
        },
      }),
    ).resolves.toBeUndefined();

    await expect(
      persistTimeoutSessionRecord({
        conversationId: "conversation-empty",
        sessionId: "turn-empty",
        currentSliceId: 1,
        messages: [],
        errorMessage: "timeout",
        logContext: {
          modelId: "test-model",
        },
      }),
    ).resolves.toBeUndefined();

    await expect(
      getAgentTurnSessionRecord("conversation-empty", "turn-empty"),
    ).resolves.toBeUndefined();
  });

  it("promotes the latest running record when timeout capture has no messages", async () => {
    const { persistTimeoutSessionRecord, persistRunningSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const messages = [piTextMessage("user", "help me", 1)];

    await persistRunningSessionRecord({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      messages,
      logContext: {
        modelId: "test-model",
      },
    });

    await persistTimeoutSessionRecord({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      currentSliceId: 1,
      messages: [],
      errorMessage: "provider stream interrupted",
      logContext: {
        modelId: "test-model",
      },
    });

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(sessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "timeout",
      sliceId: 2,
      piMessages: messages,
    });
  });
});
