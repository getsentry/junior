import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { postMessageMock, setStatusMock } = vi.hoisted(() => ({
  postMessageMock: vi.fn(),
  setStatusMock: vi.fn(),
}));

vi.mock("@/chat/config", () => ({
  botConfig: {
    userName: "junior",
  },
}));

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

import { resumeAuthorizedRequest } from "@/handlers/oauth-resume";

describe("resumeAuthorizedRequest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    postMessageMock.mockReset();
    setStatusMock.mockReset();
    postMessageMock.mockResolvedValue(undefined);
    setStatusMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails fast when resumed reply generation exceeds the configured timeout", async () => {
    const onFailure = vi.fn(async () => undefined);

    const resumePromise = resumeAuthorizedRequest({
      messageText: "tell me the saved deadline",
      requesterUserId: "U-test",
      provider: "eval-auth",
      channelId: "C-test",
      threadTs: "1700000000.0001",
      connectedText: "connected",
      failureText: "resume failed",
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
    expect(setStatusMock.mock.calls[0]?.[0]).toMatchObject({
      channel_id: "C-test",
      thread_ts: "1700000000.0001",
      status: expect.any(String),
      loading_messages: expect.arrayContaining([expect.any(String)]),
    });
    expect(
      (setStatusMock.mock.calls[0]?.[0] as { status?: string }).status,
    ).not.toBe("");
    expect(setStatusMock.mock.calls[1]?.[0]).toMatchObject({
      channel_id: "C-test",
      thread_ts: "1700000000.0001",
      status: "",
    });
  });
});
