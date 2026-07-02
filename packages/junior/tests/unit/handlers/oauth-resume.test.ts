import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { RetryableTurnError } from "@/chat/runtime/turn";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { setPlugins } from "@/chat/plugins/agent-hooks";

const { postMessageMock, setStatusMock, uploadFilesToThreadMock } = vi.hoisted(
  () => ({
    postMessageMock: vi.fn(),
    setStatusMock: vi.fn(),
    uploadFilesToThreadMock: vi.fn(),
  }),
);

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

vi.mock("@/chat/slack/outbound", () => ({
  postSlackMessage: async (input: {
    blocks?: unknown[];
    channelId: string;
    text: string;
    threadTs?: string;
  }) =>
    await postMessageMock({
      channel: input.channelId,
      text: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      ...(input.blocks ? { blocks: input.blocks } : {}),
    }),
  uploadFilesToThread: uploadFilesToThreadMock,
}));

import {
  resumeAuthorizedRequest,
  resumeSlackTurn,
} from "@/chat/runtime/slack-resume";

const TEST_SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T-test",
  channelId: "C-test",
} as const;

function testSlackSource(threadTs: string) {
  return createSlackSource({
    teamId: TEST_SLACK_DESTINATION.teamId,
    channelId: TEST_SLACK_DESTINATION.channelId,
    threadTs,

    type: "priv",
  });
}

describe("resumeAuthorizedRequest", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    postMessageMock.mockReset();
    setStatusMock.mockReset();
    uploadFilesToThreadMock.mockReset();
    postMessageMock.mockResolvedValue({ ts: "1700000000.100" });
    setStatusMock.mockResolvedValue(undefined);
    uploadFilesToThreadMock.mockResolvedValue(undefined);
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    vi.useRealTimers();
    setPlugins([]);
    await disconnectStateAdapter();
  });

  it("runs failure handling when resumed reply generation exceeds the configured timeout", async () => {
    const onFailure = vi.fn(async () => undefined);

    const resumePromise = resumeAuthorizedRequest({
      messageText: "tell me the saved deadline",
      channelId: "C-test",
      threadTs: "1700000000.0001",
      connectedText: "connected",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U-test" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.0001"),
        requester: { platform: "slack", teamId: "T-test", userId: "U-test" },
      },
      generateReply: () => new Promise<never>(() => {}),
      replyTimeoutMs: 10,
      onFailure,
    });

    await vi.advanceTimersByTimeAsync(10);
    await resumePromise;

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0001",
        text: "connected",
      }),
    );
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

  it("persists failure state before posting the failure reply", async () => {
    const onFailure = vi.fn(async () => undefined);

    await resumeAuthorizedRequest({
      messageText: "tell me the saved deadline",
      channelId: "C-test",
      threadTs: "1700000000.0004",
      connectedText: "connected",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U-test" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.0004"),
        requester: { platform: "slack", teamId: "T-test", userId: "U-test" },
      },
      generateReply: async () => {
        throw new Error("resume failed");
      },
      onFailure,
    });

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0004",
        text: "connected",
      }),
    );
    expect(postMessageMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0004",
        text: expect.stringContaining(
          "I ran into an internal error while processing that. Reference: `event_id=",
        ),
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
          credentialContext: {
            actor: { type: "user", userId: "U-test" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.0005"),
          requester: { platform: "slack", teamId: "T-test", userId: "U-test" },
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

  it("schedules plugin tasks after a successful resumed turn", async () => {
    const scheduleSessionCompletedPluginTasks = vi.fn(async () => undefined);

    await resumeSlackTurn({
      messageText: "continue this turn",
      channelId: "C-test",
      threadTs: "1700000000.0006",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U-test" },
        },
        correlation: {
          conversationId: "slack:T-test:C-test:1700000000.0006",
          turnId: "turn_1700000000_0006",
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.0006"),
        requester: { platform: "slack", teamId: "T-test", userId: "U-test" },
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
      scheduleSessionCompletedPluginTasks,
    });

    expect(scheduleSessionCompletedPluginTasks).toHaveBeenCalledWith({
      conversationId: "slack:T-test:C-test:1700000000.0006",
      sessionId: "turn_1700000000_0006",
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
        credentialContext: {
          actor: { type: "user", userId: "U-test" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.0002"),
        requester: { platform: "slack", teamId: "T-test", userId: "U-test" },
      },
      generateReply: async () => {
        throw new RetryableTurnError("agent_continue", "timed out again", {
          conversationId: "conversation-1",
          sessionId: "turn-1",
          version: 3,
          sliceId: 3,
        });
      },
      onTimeoutPause,
    });

    expect(onTimeoutPause).toHaveBeenCalledTimes(1);
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it("runs failure handling when timeout pause handling throws", async () => {
    const onFailure = vi.fn(async () => undefined);

    await resumeSlackTurn({
      messageText: "continue this turn",
      channelId: "C-test",
      threadTs: "1700000000.0003",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U-test" },
        },
        destination: TEST_SLACK_DESTINATION,
        source: testSlackSource("1700000000.0003"),
        requester: { platform: "slack", teamId: "T-test", userId: "U-test" },
      },
      generateReply: async () => {
        throw new RetryableTurnError("agent_continue", "timed out again", {
          conversationId: "conversation-1",
          sessionId: "turn-1",
          version: 3,
          sliceId: 6,
        });
      },
      onTimeoutPause: async () => {
        throw new Error("continuation scheduling failed");
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
