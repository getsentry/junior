import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  resumeSlackTurnMock,
  scheduleTurnTimeoutResumeMock,
  verifyTurnTimeoutResumeRequestMock,
  waitUntilCallbacks,
} = vi.hoisted(() => ({
  resumeSlackTurnMock: vi.fn(),
  scheduleTurnTimeoutResumeMock: vi.fn(),
  verifyTurnTimeoutResumeRequestMock: vi.fn(),
  waitUntilCallbacks: [] as Array<() => Promise<unknown> | void>,
}));

vi.mock("@/chat/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/chat/config")>();
  const memoryConfig = original.readChatConfig({
    ...process.env,
    JUNIOR_STATE_ADAPTER: "memory",
  });
  return {
    ...original,
    botConfig: memoryConfig.bot,
    getChatConfig: () => memoryConfig,
  };
});

vi.mock("@/chat/services/timeout-resume", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/services/timeout-resume")>()),
  scheduleTurnTimeoutResume: scheduleTurnTimeoutResumeMock,
  verifyTurnTimeoutResumeRequest: verifyTurnTimeoutResumeRequestMock,
}));

vi.mock("@/chat/runtime/slack-resume", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/runtime/slack-resume")>()),
  resumeSlackTurn: resumeSlackTurnMock,
}));

import { RetryableTurnError } from "@/chat/runtime/turn";
import { ResumeTurnBusyError } from "@/chat/runtime/slack-resume";
import * as threadStateModule from "@/chat/runtime/thread-state";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { POST } from "@/handlers/turn-resume";
import type { WaitUntilFn } from "@/handlers/types";

const testWaitUntil: WaitUntilFn = (task) => {
  waitUntilCallbacks.push(typeof task === "function" ? task : () => task);
};

describe("turn resume handler", () => {
  beforeEach(async () => {
    waitUntilCallbacks.length = 0;
    resumeSlackTurnMock.mockReset();
    scheduleTurnTimeoutResumeMock.mockReset();
    verifyTurnTimeoutResumeRequestMock.mockReset();

    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();

    scheduleTurnTimeoutResumeMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
    delete process.env.JUNIOR_STATE_ADAPTER;
    vi.restoreAllMocks();
  });

  it("rejects unauthenticated internal resume callbacks", async () => {
    verifyTurnTimeoutResumeRequestMock.mockResolvedValue(undefined);

    const response = await POST(
      new Request("https://example.com/api/internal/turn-resume", {
        method: "POST",
      }),
      testWaitUntil,
    );

    expect(response.status).toBe(401);
    expect(waitUntilCallbacks).toHaveLength(0);
  });

  it("drops stale callbacks after the resume lock is acquired", async () => {
    const conversationId = "slack:C123:1712345.0000";
    const sessionId = "turn_msg_0";
    const sessionRecord = await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      errorMessage: "Agent turn timed out",
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
            id: "msg.0",
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

    verifyTurnTimeoutResumeRequestMock.mockResolvedValue({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    resumeSlackTurnMock.mockImplementationOnce(async (args) => {
      await upsertAgentTurnSessionRecord({
        conversationId,
        sessionId,
        sliceId: sessionRecord.sliceId,
        state: "completed",
        piMessages: sessionRecord.piMessages,
      });
      expect(await args.beforeStart?.()).toBe(false);
    });

    const response = await POST(
      new Request("https://example.com/api/internal/turn-resume", {
        method: "POST",
      }),
      testWaitUntil,
    );

    expect(response.status).toBe(202);
    await waitUntilCallbacks[0]?.();

    expect(scheduleTurnTimeoutResumeMock).not.toHaveBeenCalled();
  });

  it("re-enqueues the next slice when a resumed turn times out again", async () => {
    const conversationId = "slack:C123:1712345.0001";
    const sessionId = "turn_msg_1";
    const sessionRecord = await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      errorMessage: "Agent turn timed out",
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
            id: "msg.1",
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

    verifyTurnTimeoutResumeRequestMock.mockResolvedValue({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    resumeSlackTurnMock.mockImplementationOnce(async (args) => {
      const prepared = await args.beforeStart?.();
      if (prepared === false) return;
      const runArgs = { ...args, ...(prepared ?? {}) };
      await runArgs.onTimeoutPause?.(
        new RetryableTurnError("turn_timeout_resume", "timed out again", {
          conversationId,
          sessionId,
          version: sessionRecord.version + 1,
          sliceId: sessionRecord.sliceId + 1,
        }),
      );
    });

    const response = await POST(
      new Request("https://example.com/api/internal/turn-resume", {
        method: "POST",
      }),
      testWaitUntil,
    );

    expect(response.status).toBe(202);
    await waitUntilCallbacks[0]?.();

    expect(scheduleTurnTimeoutResumeMock).toHaveBeenCalledWith({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version + 1,
    });
  });

  it("retries when the timeout-resume callback races the active thread lock", async () => {
    vi.useFakeTimers();
    const conversationId = "slack:C123:1712345.0005";
    const sessionId = "turn_msg_5";
    const sessionRecord = await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      errorMessage: "Agent turn timed out",
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

    verifyTurnTimeoutResumeRequestMock.mockResolvedValue({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });
    resumeSlackTurnMock
      .mockRejectedValueOnce(new ResumeTurnBusyError(conversationId))
      .mockResolvedValueOnce(undefined);

    const response = await POST(
      new Request("https://example.com/api/internal/turn-resume", {
        method: "POST",
      }),
      testWaitUntil,
    );

    expect(response.status).toBe(202);
    const task = waitUntilCallbacks[0]?.();
    await vi.runOnlyPendingTimersAsync();
    await task;

    expect(resumeSlackTurnMock).toHaveBeenCalledTimes(2);
  });

  it("reschedules when the timeout-resume callback remains lock-busy", async () => {
    vi.useFakeTimers();
    const conversationId = "slack:C123:1712345.0006";
    const sessionId = "turn_msg_6";
    const sessionRecord = await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      errorMessage: "Agent turn timed out",
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
            id: "msg.6",
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

    verifyTurnTimeoutResumeRequestMock.mockResolvedValue({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });
    resumeSlackTurnMock.mockRejectedValue(
      new ResumeTurnBusyError(conversationId),
    );

    const response = await POST(
      new Request("https://example.com/api/internal/turn-resume", {
        method: "POST",
      }),
      testWaitUntil,
    );

    expect(response.status).toBe(202);
    const task = waitUntilCallbacks[0]?.();
    await vi.runAllTimersAsync();
    await task;

    expect(resumeSlackTurnMock).toHaveBeenCalledTimes(4);
    expect(scheduleTurnTimeoutResumeMock).toHaveBeenCalledWith({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });
  });

  it("leaves persisted state unchanged when completion persistence fails after delivery", async () => {
    const conversationId = "slack:C123:1712345.0001";
    const sessionId = "turn_msg_1";
    const sessionRecord = await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      errorMessage: "Agent turn timed out",
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
            id: "msg.1",
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

    verifyTurnTimeoutResumeRequestMock.mockResolvedValue({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    vi.spyOn(threadStateModule, "persistThreadStateById").mockRejectedValueOnce(
      new Error("state write failed"),
    );

    resumeSlackTurnMock.mockImplementationOnce(async (args) => {
      const prepared = await args.beforeStart?.();
      if (prepared === false) return;
      const runArgs = { ...args, ...(prepared ?? {}) };
      const reply = {
        text: "Final resumed answer",
        diagnostics: {
          outcome: "success",
          assistantMessageCount: 1,
          toolCalls: [],
          toolResultCount: 0,
          toolErrorCount: 0,
          usedPrimaryText: true,
        },
      } as any;

      await runArgs.onSuccess?.(reply);
    });

    const response = await POST(
      new Request("https://example.com/api/internal/turn-resume", {
        method: "POST",
      }),
      testWaitUntil,
    );

    expect(response.status).toBe(202);
    await waitUntilCallbacks[0]?.();

    expect(scheduleTurnTimeoutResumeMock).not.toHaveBeenCalled();

    const persisted = await getPersistedThreadState(conversationId);
    const conversation = (persisted.conversation ?? {}) as {
      processing?: { activeTurnId?: string };
      messages?: Array<{ role?: string; text?: string }>;
    };
    expect(conversation.processing?.activeTurnId).toBe(sessionId);
    expect(conversation.messages).toHaveLength(1);
  });

  it("persists timeout-resume failure state when terminalization fails", async () => {
    const conversationId = "slack:C123:1712345.0001";
    const sessionId = "turn_msg_1";
    const sessionRecord = await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 5,
      state: "awaiting_resume",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
      resumeReason: "timeout",
      resumedFromSliceId: 4,
      errorMessage: "Agent turn timed out",
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
            id: "msg.1",
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

    verifyTurnTimeoutResumeRequestMock.mockResolvedValue({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    resumeSlackTurnMock.mockImplementationOnce(async (args) => {
      const prepared = await args.beforeStart?.();
      if (prepared === false) return;
      const runArgs = { ...args, ...(prepared ?? {}) };
      try {
        await runArgs.onTimeoutPause?.(
          new RetryableTurnError("turn_timeout_resume", "timed out again", {
            conversationId,
            sessionId,
            version: sessionRecord.version + 1,
            sliceId: 6,
          }),
        );
      } catch (error) {
        const adapter = getStateAdapter();
        const originalGet = adapter.get.bind(adapter);
        vi.spyOn(adapter, "get").mockImplementation(async (key: string) => {
          if (key.startsWith("junior:agent_turn_session:")) {
            throw new Error("session record store unavailable");
          }
          return await originalGet(key);
        });
        await runArgs.onFailure?.(error);
      }
    });

    const response = await POST(
      new Request("https://example.com/api/internal/turn-resume", {
        method: "POST",
      }),
      testWaitUntil,
    );

    expect(response.status).toBe(202);
    await waitUntilCallbacks[0]?.();

    expect(scheduleTurnTimeoutResumeMock).not.toHaveBeenCalled();

    const persisted = await getPersistedThreadState(conversationId);
    const conversation = (persisted.conversation ?? {}) as {
      processing?: { activeTurnId?: string };
    };
    expect(conversation.processing?.activeTurnId).toBeUndefined();
  });
});
