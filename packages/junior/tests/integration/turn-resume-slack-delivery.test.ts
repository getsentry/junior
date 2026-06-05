import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import {
  SLACK_DESTINATION,
  createTurnResumeSlackFixture,
} from "../fixtures/turn-resume-slack";

let testbed: Awaited<ReturnType<typeof createTurnResumeSlackFixture>>;

describe("turn resume slack delivery", () => {
  beforeEach(async () => {
    testbed = await createTurnResumeSlackFixture();
  });

  afterEach(async () => {
    await testbed.cleanup();
  });

  it("posts the resumed reply through the Slack MSW harness and persists completion", async () => {
    const conversationId = "slack:C123:1712345.0001";
    const sessionId = "turn_msg_1";
    const sessionRecord = await testbed.createTimeoutResumeThread({
      conversationId,
      sessionId,
      messageId: "msg.1",
      artifacts: {
        assistantContextChannelId: "C999",
        listColumnMap: {},
      },
      author: {
        userId: "U123",
        userName: "alice",
      },
      messageMeta: {
        attachmentCount: 2,
        imageAttachmentCount: 1,
        imagesHydrated: false,
      },
    });
    await testbed.threadState.getChannelConfigurationServiceById("C123").set({
      key: "demo.org",
      value: "acme",
      source: "test",
    });

    const response = await testbed.postResumeRequest({
      conversationId,
      sessionId,
      expectedVersion: sessionRecord.version,
    });

    expect(response.status).toBe(202);
    expect(testbed.waitUntil.pendingCount()).toBe(1);

    await testbed.waitUntil.flush();

    expect(testbed.generateAssistantReplyMock).toHaveBeenCalledWith(
      "resume this request",
      expect.objectContaining({
        requester: expect.objectContaining({
          email: "testuser@example.com",
          fullName: "Test User",
          userId: "U123",
          userName: "testuser",
        }),
        destination: SLACK_DESTINATION,
        toolChannelId: "C999",
        inboundAttachmentCount: 2,
        omittedImageAttachmentCount: 1,
        sandbox: expect.objectContaining({
          sandboxId: undefined,
          sandboxDependencyProfileHash: undefined,
        }),
      }),
    );
    const resumeContext = testbed.generateAssistantReplyMock.mock
      .calls[0]?.[1] as {
      channelConfiguration?: {
        resolve: (key: string) => Promise<unknown>;
      };
      turnDeadlineAtMs?: number;
    };
    expect(resumeContext.turnDeadlineAtMs).toEqual(expect.any(Number));
    expect(resumeContext.turnDeadlineAtMs).toBeGreaterThan(Date.now());
    expect(await resumeContext.channelConfiguration?.resolve("demo.org")).toBe(
      "acme",
    );

    expect(slackApiOutbox.calls("assistant.threads.setStatus")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            channel_id: "C123",
            thread_ts: "1712345.0001",
            status: expect.any(String),
            loading_messages: expect.arrayContaining([expect.any(String)]),
          }),
        }),
        expect.objectContaining({
          params: expect.objectContaining({
            channel_id: "C123",
            thread_ts: "1712345.0001",
            status: "",
          }),
        }),
      ]),
    );
    expect(slackApiOutbox.messages()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1712345.0001",
          text: "Final resumed answer",
        }),
      }),
    ]);

    const persisted =
      await testbed.threadState.getPersistedThreadState(conversationId);
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
});
