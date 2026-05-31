import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryableTurnError } from "@/chat/runtime/turn";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";

const { logExceptionMock, postMessageMock, setStatusMock } = vi.hoisted(() => ({
  logExceptionMock: vi.fn(),
  postMessageMock: vi.fn(),
  setStatusMock: vi.fn(),
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

vi.mock("@/chat/slack/client", () => ({
  SlackActionError: class SlackActionError extends Error {
    code: string;

    constructor(message: string, code: string) {
      super(message);
      this.name = "SlackActionError";
      this.code = code;
    }
  },
  normalizeSlackConversationId: (value: string | undefined) => value,
  withSlackRetries: async (task: () => Promise<unknown>) => await task(),
  getSlackClient: () => ({
    chat: {
      postMessage: postMessageMock,
    },
    assistant: {
      threads: {
        setStatus: setStatusMock,
      },
    },
  }),
}));

vi.mock("@/chat/logging", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/chat/logging")>();
  return {
    ...original,
    logException: logExceptionMock,
  };
});

import {
  resumeAuthorizedRequest,
  resumeSlackTurn,
} from "@/chat/runtime/slack-resume";

describe("resumeAuthorizedRequest", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    logExceptionMock.mockReset();
    logExceptionMock.mockReturnValue("evt_test");
    postMessageMock.mockReset();
    setStatusMock.mockReset();
    postMessageMock.mockResolvedValue({ ts: "1700000000.100" });
    setStatusMock.mockResolvedValue(undefined);
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  it("fails fast when resumed reply generation exceeds the configured timeout", async () => {
    const onFailure = vi.fn(async () => undefined);

    const resumePromise = resumeAuthorizedRequest({
      messageText: "tell me the saved deadline",
      channelId: "C-test",
      threadTs: "1700000000.0001",
      connectedText: "connected",
      replyContext: {
        requester: { userId: "U-test" },
      },
      generateReply: () => new Promise<never>(() => {}),
      replyTimeoutMs: 10,
      onFailure,
    });

    await vi.advanceTimersByTimeAsync(10);
    await resumePromise;

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0001",
        text: expect.stringContaining(
          "I ran into an internal error while processing that. Reference: `event_id=",
        ),
      }),
    );
  });

  it("persists failure state before requiring a Sentry event ID", async () => {
    const onFailure = vi.fn(async () => undefined);
    logExceptionMock.mockReturnValueOnce(undefined);

    await expect(
      resumeAuthorizedRequest({
        messageText: "tell me the saved deadline",
        channelId: "C-test",
        threadTs: "1700000000.0004",
        connectedText: "connected",
        replyContext: {
          requester: { userId: "U-test" },
        },
        generateReply: async () => {
          throw new Error("resume failed");
        },
        onFailure,
      }),
    ).rejects.toThrow(
      "Sentry did not return an event ID for slack_resume_turn_failed",
    );

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0004",
        text: "connected",
      }),
    );
    expect(postMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0004",
        text: expect.stringContaining("event_id=unknown"),
      }),
    );
  });

  it("does not post a failure reply when completion persistence fails after final delivery", async () => {
    const onFailure = vi.fn(async () => undefined);

    await expect(
      resumeSlackTurn({
        messageText: "continue this turn",
        channelId: "C-test",
        threadTs: "1700000000.0005",
        replyContext: {
          requester: { userId: "U-test" },
        },
        generateReply: async () => ({
          text: "Final resumed answer",
          diagnostics: {
            assistantMessageCount: 1,
            modelId: "fake-agent-model",
            outcome: "success",
            toolCalls: [],
            toolErrorCount: 0,
            toolResultCount: 0,
            usedPrimaryText: true,
          },
        }),
        onSuccess: async () => {
          throw new Error("state write failed");
        },
        onFailure,
      }),
    ).rejects.toThrow("state write failed");

    expect(onFailure).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0005",
        text: expect.stringContaining("Final resumed answer"),
      }),
    );
    expect(postMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0005",
        text: expect.stringContaining(
          "I ran into an internal error while processing that.",
        ),
      }),
    );
  });

  it("releases the thread lock before scheduling another timeout slice", async () => {
    const onTimeoutPause = vi.fn(async () => {
      const stateAdapter = getStateAdapter();
      await stateAdapter.connect();
      const lock = await stateAdapter.acquireLock(
        "slack:C-test:1700000000.0002",
        60_000,
      );
      expect(lock).not.toBeNull();
      if (lock) {
        await stateAdapter.releaseLock(lock);
      }
    });

    await resumeSlackTurn({
      messageText: "continue this turn",
      channelId: "C-test",
      threadTs: "1700000000.0002",
      replyContext: {
        requester: { userId: "U-test" },
      },
      generateReply: async () => {
        throw new RetryableTurnError("turn_timeout_resume", "timed out again", {
          conversationId: "conversation-1",
          sessionId: "turn-1",
          version: 3,
          sliceId: 3,
        });
      },
      onTimeoutPause,
    });

    expect(onTimeoutPause).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0002",
      }),
    );
  });

  it("posts the canonical failure response when timeout pause handling throws", async () => {
    const onFailure = vi.fn(async () => undefined);

    await resumeSlackTurn({
      messageText: "continue this turn",
      channelId: "C-test",
      threadTs: "1700000000.0003",
      replyContext: {
        requester: { userId: "U-test" },
      },
      generateReply: async () => {
        throw new RetryableTurnError("turn_timeout_resume", "timed out again", {
          conversationId: "conversation-1",
          sessionId: "turn-1",
          version: 3,
          sliceId: 6,
        });
      },
      onTimeoutPause: async () => {
        throw new Error("slice limit reached");
      },
      onFailure,
    });

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0003",
        text: expect.stringContaining(
          "I ran into an internal error while processing that. Reference: `event_id=",
        ),
      }),
    );
  });
});
