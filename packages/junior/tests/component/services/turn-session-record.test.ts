import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSlackSource,
  type Destination,
  type Source,
} from "@sentry/junior-plugin-api";
import type { ConversationStore } from "@/chat/conversations/store";
import type { PiMessage } from "@/chat/pi/messages";

const ORIGINAL_ENV = { ...process.env };
const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const satisfies Destination;
const SLACK_SOURCE = createSlackSource({
  teamId: "T123",
  channelId: "C123",
  threadTs: "1700000000.001",
  type: "priv",
}) satisfies Source;

function userMessage(text: string): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function failingConversationStore(): ConversationStore {
  return {
    get: vi.fn(),
    getDestinationVisibility: vi.fn(async () => undefined),
    recordActivity: vi.fn(async () => {
      throw new Error("conversation metadata unavailable");
    }),
    recordExecution: vi.fn(),
    listByActivity: vi.fn(),
  };
}

describe("persistAuthPauseSessionRecord", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.resetModules();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    vi.doUnmock("@/chat/logging");
    vi.doUnmock("@/chat/state/turn-session");
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("reuses the latest stored transcript when the auth pause captured no messages", async () => {
    const { persistAuthPauseSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

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

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      state: "awaiting_resume",
      source: SLACK_SOURCE,
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
      source: SLACK_SOURCE,
      piMessages: [priorMessages[0]],
    });
  });

  it("records Slack turn activity in SQL conversation metadata", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const { upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const { getConversationStore } = await import("@/chat/db");
    const { appendInboundMessage } =
      await import("@/chat/task-execution/store");

    try {
      await appendInboundMessage({
        message: {
          conversationId: "slack:C123:turn-activity",
          createdAtMs: 9_000,
          destination: SLACK_DESTINATION,
          inboundMessageId: "turn-activity-message",
          input: {
            authorId: "U123",
            text: "start",
          },
          receivedAtMs: 9_000,
          source: "slack",
        },
        nowMs: 9_000,
      });
      await upsertAgentTurnSessionRecord({
        channelName: "runtime-team",
        conversationId: "slack:C123:turn-activity",
        destination: SLACK_DESTINATION,
        piMessages: [userMessage("ship it")],
        sessionId: "turn-activity",
        sliceId: 1,
        state: "completed",
        surface: "slack",
      });

      await expect(
        getConversationStore().get({
          conversationId: "slack:C123:turn-activity",
        }),
      ).resolves.toMatchObject({
        channelName: "runtime-team",
        conversationId: "slack:C123:turn-activity",
        destination: SLACK_DESTINATION,
        lastActivityAtMs: 10_000,
        source: "slack",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps turn-session records when conversation metadata update fails", async () => {
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    await expect(
      upsertAgentTurnSessionRecord({
        conversationId: "slack:C123:metadata-failure",
        conversationStore: failingConversationStore(),
        destination: SLACK_DESTINATION,
        piMessages: [userMessage("persist anyway")],
        sessionId: "turn-metadata-failure",
        sliceId: 1,
        state: "completed",
        surface: "slack",
      }),
    ).resolves.toMatchObject({
      conversationId: "slack:C123:metadata-failure",
      sessionId: "turn-metadata-failure",
      state: "completed",
    });

    await expect(
      getAgentTurnSessionRecord(
        "slack:C123:metadata-failure",
        "turn-metadata-failure",
      ),
    ).resolves.toMatchObject({
      conversationId: "slack:C123:metadata-failure",
      sessionId: "turn-metadata-failure",
      state: "completed",
    });
  });

  it("keeps turn-session summaries when conversation metadata update fails", async () => {
    const {
      listAgentTurnSessionSummariesForConversation,
      recordAgentTurnSessionSummary,
    } = await import("@/chat/state/turn-session");

    await expect(
      recordAgentTurnSessionSummary({
        conversationId: "slack:C123:summary-metadata-failure",
        conversationStore: failingConversationStore(),
        destination: SLACK_DESTINATION,
        sessionId: "turn-summary-metadata-failure",
        sliceId: 1,
        state: "failed",
        surface: "slack",
      }),
    ).resolves.toBeUndefined();

    await expect(
      listAgentTurnSessionSummariesForConversation(
        "slack:C123:summary-metadata-failure",
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        conversationId: "slack:C123:summary-metadata-failure",
        sessionId: "turn-summary-metadata-failure",
        state: "failed",
      }),
    ]);
  });

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

  it("persists requester identity when updating an unchanged projection", async () => {
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    const userMessage: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "keep going" }],
      timestamp: 1,
    } as PiMessage;

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-requester-empty-commit",
      sessionId: "turn-requester-empty-commit",
      sliceId: 1,
      state: "awaiting_resume",
      piMessages: [userMessage],
      resumeReason: "timeout",
    });
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-requester-empty-commit",
      sessionId: "turn-requester-empty-commit",
      sliceId: 2,
      state: "awaiting_resume",
      piMessages: [userMessage],
      requester: {
        platform: "slack",
        teamId: "T123",
        userId: "U123",
        userName: "alice",
        fullName: "Alice Example",
        email: "alice@sentry.io",
      },
      resumeReason: "timeout",
    });

    await expect(
      getAgentTurnSessionRecord(
        "conversation-requester-empty-commit",
        "turn-requester-empty-commit",
      ),
    ).resolves.toMatchObject({
      requester: {
        platform: "slack",
        teamId: "T123",
        userId: "U123",
        userName: "alice",
        fullName: "Alice Example",
        email: "alice@sentry.io",
      },
      piMessages: [userMessage],
    });
  });

  it("persists turn transcript scope and requester in the session log", async () => {
    const {
      getAgentTurnSessionRecord,
      listAgentTurnSessionSummariesForConversation,
      upsertAgentTurnSessionRecord,
    } = await import("@/chat/state/turn-session");
    const { loadProjectionWithRequester } =
      await import("@/chat/state/session-log");

    const previousQuestion: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "previous question" }],
      timestamp: 1,
    } as PiMessage;
    const currentQuestion: PiMessage = {
      role: "user",
      content: [{ type: "text", text: "current question" }],
      timestamp: 2,
    } as PiMessage;

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-turn-scope",
      sessionId: "turn-scope",
      sliceId: 1,
      state: "running",
      piMessages: [previousQuestion, currentQuestion],
      requester: {
        platform: "slack",
        teamId: "T123",
        userId: "U123",
        userName: "alice",
      },
      turnStartMessageIndex: 1,
    });
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-turn-scope",
      sessionId: "turn-scope",
      sliceId: 2,
      state: "completed",
      piMessages: [previousQuestion, currentQuestion],
    });

    await expect(
      getAgentTurnSessionRecord("conversation-turn-scope", "turn-scope"),
    ).resolves.toMatchObject({
      requester: {
        platform: "slack",
        teamId: "T123",
        userId: "U123",
        userName: "alice",
      },
      turnStartMessageIndex: 1,
      piMessages: [previousQuestion, currentQuestion],
    });
    await expect(
      loadProjectionWithRequester({
        conversationId: "conversation-turn-scope",
      }),
    ).resolves.toMatchObject({
      requester: {
        slackUserId: "U123",
        slackUserName: "alice",
      },
      messages: [previousQuestion, currentQuestion],
    });
    const summaries = await listAgentTurnSessionSummariesForConversation(
      "conversation-turn-scope",
    );
    expect(summaries[0]).not.toHaveProperty("turnStartMessageIndex");
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
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "continue me" }],
          timestamp: 1,
        },
      ],
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
    const { AGENT_CONTINUE_MAX_SLICES, persistTimeoutSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    const piMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "keep trying" }],
        timestamp: 1,
      },
    ];

    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-timeout-cap",
      sessionId: "turn-timeout-cap",
      sliceId: AGENT_CONTINUE_MAX_SLICES,
      state: "awaiting_resume",
      piMessages,
      resumeReason: "timeout",
      cumulativeDurationMs: 12_000,
    });

    await expect(
      persistTimeoutSessionRecord({
        conversationId: "conversation-timeout-cap",
        sessionId: "turn-timeout-cap",
        currentSliceId: AGENT_CONTINUE_MAX_SLICES,
        currentDurationMs: 3_000,
        messages: piMessages,
        errorMessage: "timed out again",
        logContext: {
          modelId: "test-model",
        },
      }),
    ).resolves.toMatchObject({
      state: "failed",
      sliceId: AGENT_CONTINUE_MAX_SLICES,
      cumulativeDurationMs: 15_000,
      errorMessage: expect.stringContaining("slice limit"),
      piMessages,
    });

    await expect(
      getAgentTurnSessionRecord("conversation-timeout-cap", "turn-timeout-cap"),
    ).resolves.toMatchObject({
      state: "failed",
      sliceId: AGENT_CONTINUE_MAX_SLICES,
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

    const safeBoundary: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "connect and answer" }],
        timestamp: 1,
      },
    ];

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
        {
          role: "assistant",
          content: [{ type: "text", text: "calling credential-gated tool" }],
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

  it("creates auth-pause records before a prompt checkpoint", async () => {
    const {
      loadTurnSessionRecord,
      persistAuthPauseSessionRecord,
      persistTimeoutSessionRecord,
    } = await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");

    const authRecord = await persistAuthPauseSessionRecord({
      conversationId: "conversation-auth-empty",
      sessionId: "turn-auth-empty",
      currentSliceId: 1,
      messages: [],
      errorMessage: "auth pause",
      logContext: {
        modelId: "test-model",
      },
    });

    expect(authRecord).toMatchObject({
      conversationId: "conversation-auth-empty",
      sessionId: "turn-auth-empty",
      state: "awaiting_resume",
      piMessages: [],
      resumeReason: "auth",
    });
    await expect(
      loadTurnSessionRecord({
        conversationId: "conversation-auth-empty",
        sessionId: "turn-auth-empty",
      }),
    ).resolves.toMatchObject({
      resumedFromSessionRecord: true,
      currentSliceId: 2,
    });

    await expect(
      persistTimeoutSessionRecord({
        conversationId: "conversation-timeout-empty",
        sessionId: "turn-timeout-empty",
        currentSliceId: 1,
        messages: [],
        errorMessage: "timeout",
        logContext: {
          modelId: "test-model",
        },
      }),
    ).resolves.toBeUndefined();

    await expect(
      getAgentTurnSessionRecord(
        "conversation-timeout-empty",
        "turn-timeout-empty",
      ),
    ).resolves.toBeUndefined();
  });

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
    vi.doMock("@/chat/state/turn-session", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("@/chat/state/turn-session")>();
      return {
        ...actual,
        upsertAgentTurnSessionRecord: vi.fn(async () => {
          throw new Error("storage unavailable");
        }),
      };
    });
    const { persistRunningSessionRecord } =
      await import("@/chat/services/turn-session-record");

    await expect(
      persistRunningSessionRecord({
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
      }),
    ).resolves.toBe(false);
  });

  it("promotes the latest running record when timeout capture has no messages", async () => {
    const { persistTimeoutSessionRecord, persistRunningSessionRecord } =
      await import("@/chat/services/turn-session-record");
    const { getAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const messages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "help me" }],
        timestamp: 1,
      },
    ];

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
