import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { successfulAssistantReply } from "../fixtures/assistant-reply";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { createTurnResumeSlackFixture } from "../fixtures/turn-resume-slack";

let testbed: Awaited<ReturnType<typeof createTurnResumeSlackFixture>>;

describe("turn resume slack file delivery", () => {
  beforeEach(async () => {
    testbed = await createTurnResumeSlackFixture();
  });

  afterEach(async () => {
    await testbed.cleanup();
  });

  it("uploads resumed reply files through the shared delivery path", async () => {
    const conversationId = "slack:C123:1712345.0003";
    const sessionId = "turn_msg_3";
    const sessionRecord = await testbed.createTimeoutResumeThread({
      conversationId,
      sessionId,
      messageId: "msg.3",
      artifacts: {
        assistantContextChannelId: "C999",
        listColumnMap: {},
      },
      author: {
        userId: "U123",
        userName: "alice",
      },
    });
    testbed.generateAssistantReplyMock.mockResolvedValueOnce(
      successfulAssistantReply("Final resumed answer with artifact", {
        files: [
          {
            data: Buffer.from("resume-file"),
            filename: "resume.txt",
          },
        ],
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

    expect(slackApiOutbox.messages()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1712345.0003",
          text: "Final resumed answer with artifact",
        }),
      }),
    ]);
    expect(slackApiOutbox.calls("files.getUploadURLExternal")).toHaveLength(1);
    expect(slackApiOutbox.calls("files.completeUploadExternal")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: "C123",
          thread_ts: "1712345.0003",
        }),
      }),
    ]);
    expect(slackApiOutbox.fileUploads()).toHaveLength(1);

    const persisted =
      await testbed.threadState.getPersistedThreadState(conversationId);
    const conversation = (persisted.conversation ?? {}) as {
      messages?: Array<{ role?: string; text?: string }>;
      processing?: { activeTurnId?: string };
    };
    expect(conversation.processing?.activeTurnId).toBeUndefined();
    expect(conversation.messages?.at(-1)).toMatchObject({
      role: "assistant",
      text: "Final resumed answer with artifact",
    });
  });
});
