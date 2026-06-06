import { afterEach, describe, expect, it, vi } from "vitest";
import { RetryableTurnError } from "@/chat/runtime/turn";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestDestination,
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

describe("Slack contract: turn continuation", () => {
  afterEach(() => {
    resetSlackApiMockState();
    vi.restoreAllMocks();
  });

  it("does not post a Slack continuation notice when a live turn times out", async () => {
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const conversationId = "slack:C_TIMEOUT_API:1700000000.000";
    const sessionId = "turn_msg-timeout-api";
    const { slackRuntime } = createTestChatRuntime({
      adapters: {
        listThreadReplies: async () => [],
        scheduleAgentContinue,
        generateAssistantReply: async () => {
          throw new RetryableTurnError(
            "agent_continue",
            "simulated timeout continuation",
            {
              conversationId,
              sessionId,
              version: 3,
              sliceId: 2,
            },
          );
        },
      },
    });

    const thread = createTestThread({ id: conversationId });
    (thread.adapter as { name?: string }).name = "slack";
    const destination = createTestDestination(thread);

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-timeout-api",
          threadId: conversationId,
          text: "please keep working",
          isMention: true,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      destination,
      sessionId,
      expectedVersion: 3,
    });
    expect(thread.posts).toEqual([]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);
  });
});
