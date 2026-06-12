import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumeSlackTurnServices } from "@/chat/runtime/slack-resume";
import {
  createOauthResumeSlackFixture,
  makeResumeDiagnostics,
} from "../../fixtures/oauth-resume-slack";
import { TEST_SLACK_DESTINATION } from "../../fixtures/reply-context";
import { mockTestClock } from "../../fixtures/vitest";

type Testbed = Awaited<ReturnType<typeof createOauthResumeSlackFixture>>;

const TEST_SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T-test",
  channelId: "C-test",
} as const;

describe("Slack resume runtime", () => {
  let testbed: Testbed;
  let services: ResumeSlackTurnServices;

  const logExceptionMock = vi.fn();
  const postMessageMock = vi.fn();
  const postReplyPostsMock = vi.fn();
  const createAssistantStatusSessionMock = vi.fn();
  const startProcessingReactionMock = vi.fn();

  beforeEach(async () => {
    testbed = await createOauthResumeSlackFixture();
    mockTestClock();

    logExceptionMock.mockReset();
    logExceptionMock.mockReturnValue("evt_test");
    postMessageMock.mockReset();
    postMessageMock.mockResolvedValue({ ts: "1700000000.100" });
    postReplyPostsMock.mockReset();
    postReplyPostsMock.mockResolvedValue("1700000000.200");
    createAssistantStatusSessionMock.mockReset();
    createAssistantStatusSessionMock.mockReturnValue({
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      update: vi.fn(),
    });
    startProcessingReactionMock.mockReset();
    startProcessingReactionMock.mockResolvedValue({
      complete: vi.fn(async () => undefined),
      keep: vi.fn(),
      stop: vi.fn(async () => undefined),
    });

    services = {
      createAssistantStatusSession: createAssistantStatusSessionMock,
      generateAssistantReply: vi.fn(async () => ({
        text: "default resumed answer",
        diagnostics: makeResumeDiagnostics(),
      })),
      getStateAdapter: testbed.getStateAdapter,
      logException: logExceptionMock,
      postSlackMessage: postMessageMock,
      postSlackReplyPosts: postReplyPostsMock,
      startProcessingReactionForMessage: startProcessingReactionMock,
    };
  });

  afterEach(async () => {
    vi.useRealTimers();
    await testbed.cleanup();
  });

  it("fails fast when resumed reply generation exceeds the configured timeout", async () => {
    const onFailure = vi.fn(async () => undefined);

    const resumePromise = testbed.resumeAuthorizedRequest({
      messageText: "tell me the saved deadline",
      channelId: "C-test",
      threadTs: "1700000000.0001",
      connectedText: "connected",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U-test" },
        },
        destination: TEST_SLACK_DESTINATION,
        requester: { platform: "slack", teamId: "T-test", userId: "U-test" },
      },
      generateReply: () => new Promise<never>(() => {}),
      replyTimeoutMs: 10,
      onFailure,
      services,
    });

    await vi.advanceTimersByTimeAsync(10);
    await resumePromise;

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channelId: "C-test",
        threadTs: "1700000000.0001",
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
      testbed.resumeAuthorizedRequest({
        messageText: "tell me the saved deadline",
        channelId: "C-test",
        threadTs: "1700000000.0004",
        connectedText: "connected",
        replyContext: {
          credentialContext: {
            actor: { type: "user", userId: "U-test" },
          },
          destination: TEST_SLACK_DESTINATION,
          requester: { platform: "slack", teamId: "T-test", userId: "U-test" },
        },
        generateReply: async () => {
          throw new Error("resume failed");
        },
        onFailure,
        services,
      }),
    ).rejects.toThrow(
      "Sentry did not return an event ID for slack_resume_turn_failed",
    );

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C-test",
        threadTs: "1700000000.0004",
        text: "connected",
      }),
    );
    expect(postMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C-test",
        threadTs: "1700000000.0004",
        text: expect.stringContaining("event_id=unknown"),
      }),
    );
  });

  it("does not post a failure reply when completion persistence fails after final delivery", async () => {
    const onFailure = vi.fn(async () => undefined);

    await expect(
      testbed.resumeSlackTurn({
        messageText: "continue this turn",
        channelId: "C-test",
        threadTs: "1700000000.0005",
        replyContext: {
          credentialContext: {
            actor: { type: "user", userId: "U-test" },
          },
          destination: TEST_SLACK_DESTINATION,
          requester: { platform: "slack", teamId: "T-test", userId: "U-test" },
        },
        generateReply: async () => ({
          text: "Final resumed answer",
          diagnostics: makeResumeDiagnostics(),
        }),
        onSuccess: async () => {
          throw new Error("state write failed");
        },
        onFailure,
        services,
      }),
    ).rejects.toThrow("state write failed");

    expect(onFailure).not.toHaveBeenCalled();
    expect(postReplyPostsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C-test",
        threadTs: "1700000000.0005",
        posts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("Final resumed answer"),
          }),
        ]),
      }),
    );
    expect(postMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C-test",
        threadTs: "1700000000.0005",
        text: expect.stringContaining(
          "I ran into an internal error while processing that.",
        ),
      }),
    );
  });

  it("releases the thread lock before scheduling another timeout slice", async () => {
    const onTimeoutPause = vi.fn(async () => {
      const stateAdapter = testbed.getStateAdapter();
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

    await testbed.resumeSlackTurn({
      messageText: "continue this turn",
      channelId: "C-test",
      threadTs: "1700000000.0002",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U-test" },
        },
        destination: TEST_SLACK_DESTINATION,
        requester: { platform: "slack", teamId: "T-test", userId: "U-test" },
      },
      generateReply: async () => {
        throw new testbed.RetryableTurnError(
          "agent_continue",
          "timed out again",
          {
            conversationId: "conversation-1",
            sessionId: "turn-1",
            version: 3,
            sliceId: 3,
          },
        );
      },
      onTimeoutPause,
      services,
    });

    expect(onTimeoutPause).toHaveBeenCalledTimes(1);
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it("posts the canonical failure response when timeout pause handling throws", async () => {
    const onFailure = vi.fn(async () => undefined);

    await testbed.resumeSlackTurn({
      messageText: "continue this turn",
      channelId: "C-test",
      threadTs: "1700000000.0003",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U-test" },
        },
        destination: TEST_SLACK_DESTINATION,
        requester: { platform: "slack", teamId: "T-test", userId: "U-test" },
      },
      generateReply: async () => {
        throw new testbed.RetryableTurnError(
          "agent_continue",
          "timed out again",
          {
            conversationId: "conversation-1",
            sessionId: "turn-1",
            version: 3,
            sliceId: 6,
          },
        );
      },
      onTimeoutPause: async () => {
        throw new Error("continuation scheduling failed");
      },
      onFailure,
      services,
    });

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C-test",
        threadTs: "1700000000.0003",
        text: expect.stringContaining(
          "I ran into an internal error while processing that. Reference: `event_id=",
        ),
      }),
    );
  });
});
