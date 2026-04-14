import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryableTurnError } from "@/chat/runtime/turn";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";

const { postMessageMock, setStatusMock } = vi.hoisted(() => ({
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

import {
  resumeAuthorizedRequest,
  resumeSlackTurn,
} from "@/handlers/oauth-resume";

describe("resumeAuthorizedRequest", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    postMessageMock.mockReset();
    setStatusMock.mockReset();
    postMessageMock.mockResolvedValue(undefined);
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
      provider: "eval-auth",
      channelId: "C-test",
      threadTs: "1700000000.0001",
      connectedText: "connected",
      failureText: "resume failed",
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
    expect(postMessageMock).toHaveBeenNthCalledWith(1, {
      channel: "C-test",
      thread_ts: "1700000000.0001",
      text: "connected",
    });
    expect(postMessageMock).toHaveBeenNthCalledWith(2, {
      channel: "C-test",
      thread_ts: "1700000000.0001",
      text: "resume failed",
    });
    expect(setStatusMock).toHaveBeenCalledTimes(2);
    const firstStatusCall = setStatusMock.mock.calls[0]?.[0];
    expect(firstStatusCall).toBeDefined();
    if (!firstStatusCall) {
      throw new Error("expected status update call");
    }
    expect(firstStatusCall).toMatchObject({
      channel_id: "C-test",
      thread_ts: "1700000000.0001",
      status: expect.any(String),
      loading_messages: expect.arrayContaining([expect.any(String)]),
    });
    expect((firstStatusCall as { status?: string }).status).not.toBe("");
    expect(setStatusMock.mock.calls[1]?.[0]).toMatchObject({
      channel_id: "C-test",
      thread_ts: "1700000000.0001",
      status: "",
    });
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
          checkpointVersion: 3,
          sliceId: 3,
        });
      },
      onTimeoutPause,
    });

    expect(onTimeoutPause).toHaveBeenCalledTimes(1);
  });

  it("falls back to normal failure handling when timeout pause handling throws", async () => {
    const onFailure = vi.fn(async () => undefined);

    await resumeSlackTurn({
      messageText: "continue this turn",
      channelId: "C-test",
      threadTs: "1700000000.0003",
      failureText: "resume failed",
      replyContext: {
        requester: { userId: "U-test" },
      },
      generateReply: async () => {
        throw new RetryableTurnError("turn_timeout_resume", "timed out again", {
          conversationId: "conversation-1",
          sessionId: "turn-1",
          checkpointVersion: 3,
          sliceId: 6,
        });
      },
      onTimeoutPause: async () => {
        throw new Error("slice limit reached");
      },
      onFailure,
    });

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith({
      channel: "C-test",
      thread_ts: "1700000000.0003",
      text: "resume failed",
    });
  });
});
