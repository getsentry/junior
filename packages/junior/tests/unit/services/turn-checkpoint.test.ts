import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";

const ORIGINAL_ENV = { ...process.env };

describe("persistAuthPauseCheckpoint", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.resetModules();
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    vi.doUnmock("@/chat/logging");
    vi.doUnmock("@/chat/state/turn-session-store");
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("reuses the latest stored transcript when the auth pause captured no messages", async () => {
    const { persistAuthPauseCheckpoint } =
      await import("@/chat/services/turn-checkpoint");
    const { getAgentTurnSessionCheckpoint, upsertAgentTurnSessionCheckpoint } =
      await import("@/chat/state/turn-session-store");

    const priorMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "help me" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "working on it" }],
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
        timestamp: 2,
        stopReason: "toolUse",
      },
    ];

    await upsertAgentTurnSessionCheckpoint({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      state: "awaiting_resume",
      piMessages: priorMessages,
      loadedSkillNames: ["demo-skill"],
      resumeReason: "auth",
      errorMessage: "initial auth pause",
    });

    const authCheckpoint = await persistAuthPauseCheckpoint({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      currentSliceId: 1,
      messages: [],
      loadedSkillNames: ["demo-skill"],
      errorMessage: "plugin auth pause",
      logContext: {
        modelId: "test-model",
      },
    });

    expect(authCheckpoint?.sliceId).toBe(2);

    const checkpoint = await getAgentTurnSessionCheckpoint(
      "conversation-1",
      "turn-1",
    );
    expect(checkpoint).toMatchObject({
      state: "awaiting_resume",
      sliceId: 2,
      resumedFromSliceId: 1,
      loadedSkillNames: ["demo-skill"],
      resumeReason: "auth",
      errorMessage: "plugin auth pause",
      piMessages: [priorMessages[0]],
    });
  });

  it("carries cumulative diagnostics across pause checkpoints", async () => {
    const { persistTimeoutCheckpoint } =
      await import("@/chat/services/turn-checkpoint");
    const { getAgentTurnSessionCheckpoint, upsertAgentTurnSessionCheckpoint } =
      await import("@/chat/state/turn-session-store");

    await upsertAgentTurnSessionCheckpoint({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      state: "awaiting_resume",
      piMessages: [],
      resumeReason: "timeout",
      cumulativeDurationMs: 1_500,
      cumulativeUsage: {
        inputTokens: 10,
        outputTokens: 3,
      },
    });

    await persistTimeoutCheckpoint({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      currentSliceId: 1,
      currentDurationMs: 2_250,
      currentUsage: {
        outputTokens: 7,
        cachedInputTokens: 2,
      },
      messages: [],
      loadedSkillNames: [],
      errorMessage: "timed out again",
      logContext: {
        modelId: "test-model",
      },
    });

    const checkpoint = await getAgentTurnSessionCheckpoint(
      "conversation-1",
      "turn-1",
    );
    expect(checkpoint).toMatchObject({
      cumulativeDurationMs: 3_750,
      cumulativeUsage: {
        inputTokens: 10,
        outputTokens: 10,
        cachedInputTokens: 2,
      },
    });
  });

  it("does not fail a completed turn when checkpoint persistence fails", async () => {
    const logException = vi.fn();
    vi.doMock("@/chat/logging", () => ({
      logException,
    }));
    vi.doMock("@/chat/state/turn-session-store", () => ({
      getAgentTurnSessionCheckpoint: vi.fn(async () => {
        throw new Error("state adapter unavailable");
      }),
      upsertAgentTurnSessionCheckpoint: vi.fn(),
    }));
    const { persistCompletedCheckpoint } =
      await import("@/chat/services/turn-checkpoint");

    await expect(
      persistCompletedCheckpoint({
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
        loadedSkillNames: [],
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
      "agent_turn_completed_checkpoint_failed",
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
      "Failed to persist completed turn checkpoint",
    );
  });

  it("stores running checkpoints only at continuable message boundaries", async () => {
    const { persistRunningCheckpoint } =
      await import("@/chat/services/turn-checkpoint");
    const { getAgentTurnSessionCheckpoint } =
      await import("@/chat/state/turn-session-store");
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

    await persistRunningCheckpoint({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      messages: userBoundary,
      loadedSkillNames: [],
      logContext: {
        modelId: "test-model",
      },
    });

    await persistRunningCheckpoint({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      messages: unsafeAssistantBoundary,
      loadedSkillNames: [],
      logContext: {
        modelId: "test-model",
      },
    });

    let checkpoint = await getAgentTurnSessionCheckpoint(
      "conversation-1",
      "turn-1",
    );
    expect(checkpoint).toMatchObject({
      state: "running",
      piMessages: userBoundary,
    });

    await persistRunningCheckpoint({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      messages: toolResultBoundary,
      loadedSkillNames: ["demo-skill"],
      logContext: {
        modelId: "test-model",
      },
    });

    checkpoint = await getAgentTurnSessionCheckpoint(
      "conversation-1",
      "turn-1",
    );
    expect(checkpoint).toMatchObject({
      state: "running",
      loadedSkillNames: ["demo-skill"],
      piMessages: toolResultBoundary,
    });
  });

  it("promotes the latest running checkpoint when timeout capture has no messages", async () => {
    const { persistTimeoutCheckpoint, persistRunningCheckpoint } =
      await import("@/chat/services/turn-checkpoint");
    const { getAgentTurnSessionCheckpoint } =
      await import("@/chat/state/turn-session-store");
    const messages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "help me" }],
        timestamp: 1,
      },
    ];

    await persistRunningCheckpoint({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      messages,
      loadedSkillNames: ["demo-skill"],
      logContext: {
        modelId: "test-model",
      },
    });

    await persistTimeoutCheckpoint({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      currentSliceId: 1,
      messages: [],
      loadedSkillNames: ["demo-skill"],
      errorMessage: "provider stream interrupted",
      logContext: {
        modelId: "test-model",
      },
    });

    const checkpoint = await getAgentTurnSessionCheckpoint(
      "conversation-1",
      "turn-1",
    );
    expect(checkpoint).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "timeout",
      sliceId: 2,
      piMessages: messages,
    });
  });

  it("branches Pi session state from the recoverable cursor after trimming an unsafe assistant tail", async () => {
    const { getAgentTurnSessionCheckpoint, upsertAgentTurnSessionCheckpoint } =
      await import("@/chat/state/turn-session-store");
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

    await upsertAgentTurnSessionCheckpoint({
      conversationId: "conversation-branch",
      sessionId: "turn-branch",
      sliceId: 1,
      state: "running",
      piMessages: [user, unsafeAssistant],
    });
    await upsertAgentTurnSessionCheckpoint({
      conversationId: "conversation-branch",
      sessionId: "turn-branch",
      sliceId: 2,
      state: "awaiting_resume",
      piMessages: [user],
      resumeReason: "timeout",
    });
    await upsertAgentTurnSessionCheckpoint({
      conversationId: "conversation-branch",
      sessionId: "turn-branch",
      sliceId: 2,
      state: "running",
      piMessages: [user, replacementToolResult],
    });

    await expect(
      getAgentTurnSessionCheckpoint("conversation-branch", "turn-branch"),
    ).resolves.toMatchObject({
      state: "running",
      piMessages: [user, replacementToolResult],
    });
  });
});
