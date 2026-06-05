import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import {
  SLACK_DESTINATION,
  createTurnResumeSlackFixture,
} from "../../fixtures/turn-resume-slack";

let testbed: Awaited<ReturnType<typeof createTurnResumeSlackFixture>>;

describe("turn resume slack continuation", () => {
  beforeEach(async () => {
    testbed = await createTurnResumeSlackFixture();
  });

  afterEach(async () => {
    await testbed.cleanup();
  });

  it("reschedules resumed turns without posting a Slack notice", async () => {
    const conversationId = "slack:C123:1712345.0002";
    const sessionId = "turn_msg_2";
    const sessionRecord = await testbed.createTimeoutResumeThread({
      conversationId,
      sessionId,
      messageId: "msg.2",
      sliceId: 5,
    });
    const { RetryableTurnError } = await import("@/chat/runtime/turn");
    testbed.generateAssistantReplyMock.mockRejectedValueOnce(
      new RetryableTurnError("turn_timeout_resume", "timed out again", {
        conversationId,
        sessionId,
        version: sessionRecord.version + 1,
        sliceId: 6,
      }),
    );

    const response = await testbed.postResumeRequest({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    expect(response.status).toBe(202);
    expect(testbed.waitUntil.pendingCount()).toBe(1);

    await testbed.waitUntil.flush();

    expect(slackApiOutbox.messages()).toEqual([]);
    expect(testbed.queue.sentRecords()).toEqual([
      {
        conversationId,
        destination: SLACK_DESTINATION,
        idempotencyKey: expect.stringContaining(
          `timeout:${conversationId}:${sessionId}:`,
        ),
      },
    ]);

    const persisted =
      await testbed.threadState.getPersistedThreadState(conversationId);
    const conversation = (persisted.conversation ?? {}) as {
      processing?: { activeTurnId?: string };
    };
    expect(conversation.processing?.activeTurnId).toBe(sessionId);
  });
});
