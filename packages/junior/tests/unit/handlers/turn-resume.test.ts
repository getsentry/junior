import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  postSlackMessageMock,
  resumeSlackTurnMock,
  scheduleTurnTimeoutResumeMock,
  uploadFilesToThreadMock,
  verifyTurnTimeoutResumeRequestMock,
  waitUntilCallbacks,
} = vi.hoisted(() => ({
  postSlackMessageMock: vi.fn(),
  resumeSlackTurnMock: vi.fn(),
  scheduleTurnTimeoutResumeMock: vi.fn(),
  uploadFilesToThreadMock: vi.fn(),
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

vi.mock("@/handlers/oauth-resume", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/handlers/oauth-resume")>()),
  postSlackMessage: postSlackMessageMock,
  resumeSlackTurn: resumeSlackTurnMock,
}));

vi.mock("@/chat/slack/client", () => ({
  uploadFilesToThread: uploadFilesToThreadMock,
}));

import { RetryableTurnError } from "@/chat/runtime/turn";
import * as threadStateModule from "@/chat/runtime/thread-state";
import {
  getChannelConfigurationServiceById,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionCheckpoint } from "@/chat/state/turn-session-store";
import { POST } from "@/handlers/turn-resume";
import type { WaitUntilFn } from "@/handlers/types";

const testWaitUntil: WaitUntilFn = (task) => {
  waitUntilCallbacks.push(typeof task === "function" ? task : () => task);
};

describe("turn resume handler", () => {
  beforeEach(async () => {
    waitUntilCallbacks.length = 0;
    postSlackMessageMock.mockReset();
    resumeSlackTurnMock.mockReset();
    scheduleTurnTimeoutResumeMock.mockReset();
    uploadFilesToThreadMock.mockReset();
    verifyTurnTimeoutResumeRequestMock.mockReset();

    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();

    postSlackMessageMock.mockResolvedValue(undefined);
    scheduleTurnTimeoutResumeMock.mockResolvedValue(undefined);
    uploadFilesToThreadMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
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

  it("rebuilds persisted turn state and posts the resumed reply on success", async () => {
    const conversationId = "slack:C123:1712345.0001";
    const sessionId = "turn_msg_1";
    const checkpoint = await upsertAgentTurnSessionCheckpoint({
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
      loadedSkillNames: ["demo-skill"],
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      errorMessage: "Agent turn timed out",
    });

    await persistThreadStateById(conversationId, {
      artifacts: {
        assistantContextChannelId: "C999",
        listColumnMap: {},
      },
      conversation: {
        schemaVersion: 1,
        backfill: {},
        compactions: [],
        messages: [
          {
            id: "msg.1",
            role: "user",
            text: "resume this request",
            createdAtMs: 1,
            author: {
              userId: "U123",
              userName: "alice",
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
    await getChannelConfigurationServiceById("C123").set({
      key: "demo.org",
      value: "acme",
      source: "test",
    });

    verifyTurnTimeoutResumeRequestMock.mockResolvedValue({
      conversationId,
      sessionId,
      expectedCheckpointVersion: checkpoint.checkpointVersion,
    });

    resumeSlackTurnMock.mockImplementationOnce(async (args) => {
      expect(args.messageText).toBe("resume this request");
      expect(args.lockKey).toBe(conversationId);
      expect(args.replyContext?.requester?.userId).toBe("U123");
      expect(args.replyContext?.toolChannelId).toBe("C999");
      expect(
        await args.replyContext?.channelConfiguration?.resolve("demo.org"),
      ).toBe("acme");
      expect(args.replyContext?.sandbox).toMatchObject({
        sandboxId: undefined,
        sandboxDependencyProfileHash: undefined,
      });

      const reply = {
        text: "Final resumed answer",
        sandboxId: "sandbox-1",
        sandboxDependencyProfileHash: "hash-1",
        diagnostics: {
          outcome: "success",
          assistantMessageCount: 1,
          toolCalls: [],
          toolResultCount: 0,
          toolErrorCount: 0,
          usedPrimaryText: true,
        },
      } as any;

      await args.onReply?.(reply);
      await args.onSuccess?.(reply);
    });

    const response = await POST(
      new Request("https://example.com/api/internal/turn-resume", {
        method: "POST",
      }),
      testWaitUntil,
    );

    expect(response.status).toBe(202);
    expect(waitUntilCallbacks).toHaveLength(1);

    await waitUntilCallbacks[0]?.();

    expect(postSlackMessageMock).toHaveBeenCalledWith(
      "C123",
      "1712345.0001",
      "Final resumed answer",
    );

    const persisted = await getPersistedThreadState(conversationId);
    const conversation = (persisted.conversation ?? {}) as {
      messages?: Array<{ role?: string; text?: string }>;
      processing?: { activeTurnId?: string };
    };
    expect(conversation.processing?.activeTurnId).toBeUndefined();
    expect(conversation.messages?.at(-1)).toMatchObject({
      role: "assistant",
      text: "Final resumed answer",
    });
  });

  it("re-enqueues the next slice when a resumed turn times out again", async () => {
    const conversationId = "slack:C123:1712345.0001";
    const sessionId = "turn_msg_1";
    const checkpoint = await upsertAgentTurnSessionCheckpoint({
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
      loadedSkillNames: ["demo-skill"],
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
      expectedCheckpointVersion: checkpoint.checkpointVersion,
    });

    resumeSlackTurnMock.mockImplementationOnce(async (args) => {
      await args.onTimeoutPause?.(
        new RetryableTurnError("turn_timeout_resume", "timed out again", {
          conversationId,
          sessionId,
          checkpointVersion: checkpoint.checkpointVersion + 1,
          sliceId: checkpoint.sliceId + 1,
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
      expectedCheckpointVersion: checkpoint.checkpointVersion + 1,
    });
  });

  it("keeps the delivered reply when completion persistence fails afterward", async () => {
    const conversationId = "slack:C123:1712345.0001";
    const sessionId = "turn_msg_1";
    const checkpoint = await upsertAgentTurnSessionCheckpoint({
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
      loadedSkillNames: ["demo-skill"],
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
      expectedCheckpointVersion: checkpoint.checkpointVersion,
    });

    vi.spyOn(threadStateModule, "persistThreadStateById").mockRejectedValueOnce(
      new Error("state write failed"),
    );

    resumeSlackTurnMock.mockImplementationOnce(async (args) => {
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

      try {
        await args.onReply?.(reply);
        await args.onSuccess?.(reply);
      } catch (error) {
        await args.onFailure?.(error);
        if (args.failureText) {
          await postSlackMessageMock(
            args.channelId,
            args.threadTs,
            args.failureText,
          );
        }
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

    expect(postSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(postSlackMessageMock).toHaveBeenCalledWith(
      "C123",
      "1712345.0001",
      "Final resumed answer",
    );
    expect(postSlackMessageMock).not.toHaveBeenCalledWith(
      "C123",
      "1712345.0001",
      "I hit an error while resuming that request. Please try the command again.",
    );
  });

  it("fails the resumed turn when the timeout slice limit is reached", async () => {
    const conversationId = "slack:C123:1712345.0001";
    const sessionId = "turn_msg_1";
    const checkpoint = await upsertAgentTurnSessionCheckpoint({
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
      loadedSkillNames: ["demo-skill"],
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
      expectedCheckpointVersion: checkpoint.checkpointVersion,
    });

    resumeSlackTurnMock.mockImplementationOnce(async (args) => {
      try {
        await args.onTimeoutPause?.(
          new RetryableTurnError("turn_timeout_resume", "timed out again", {
            conversationId,
            sessionId,
            checkpointVersion: checkpoint.checkpointVersion + 1,
            sliceId: 6,
          }),
        );
      } catch (error) {
        await args.onFailure?.(error);
        if (args.failureText) {
          await postSlackMessageMock(
            args.channelId,
            args.threadTs,
            args.failureText,
          );
        }
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
    expect(postSlackMessageMock).toHaveBeenCalledWith(
      "C123",
      "1712345.0001",
      "I hit an error while resuming that request. Please try the command again.",
    );

    const persisted = await getPersistedThreadState(conversationId);
    const conversation = (persisted.conversation ?? {}) as {
      processing?: { activeTurnId?: string };
    };
    expect(conversation.processing?.activeTurnId).toBeUndefined();
  });
});
