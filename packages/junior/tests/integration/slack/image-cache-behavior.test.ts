import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import {
  createSlackImageConversationState,
  createSlackImageRuntime,
  resetSlackImageRuntimeEnv,
} from "../../fixtures/slack-image-runtime";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

const listThreadRepliesMock = vi.fn();

describe("Slack behavior: image cache", () => {
  beforeEach(() => {
    listThreadRepliesMock.mockReset();
  });

  afterEach(() => {
    resetSlackImageRuntimeEnv();
  });

  it("reuses the thread image summary instead of re-analyzing the same upload", async () => {
    listThreadRepliesMock.mockResolvedValue([
      {
        ts: "1700000003.100",
        files: [
          {
            id: "F_CUR",
            mimetype: "image/png",
            url_private_download: "https://files.slack.com/private/current.png",
          },
        ],
      },
    ]);
    const downloadFileMock = vi.fn(async () => Buffer.from("downloaded-image"));
    const completeTextMock = vi.fn(async () => ({
      text: "Current screenshot summary",
      message: {} as never,
    }));
    const attachmentFetch = vi.fn(async () => Buffer.from("attachment-image"));
    const generateAssistantReply = vi.fn(
      async (
        _text: string,
        context:
          | {
              userAttachments?: Array<{
                filename?: string;
                mediaType?: string;
              }>;
            }
          | undefined,
      ) => {
        expect(context?.userAttachments).toEqual([
          expect.objectContaining({
            mediaType: "image/png",
            filename: "screen.png",
          }),
        ]);
        return successfulAssistantReply("ok");
      },
    );

    const { slackRuntime } = await createSlackImageRuntime(
      {
        adapters: {
          listThreadReplies: listThreadRepliesMock,
          downloadSlackFile: downloadFileMock,
          describeImagesText: completeTextMock,
          generateAssistantReply,
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );

    await slackRuntime.handleNewMention(
      createTestThread({
        id: "slack:C_IMAGE:1700000003.000",
        state: createSlackImageConversationState(),
      }),
      createTestMessage({
        id: "1700000003.100",
        text: "explain this screenshot",
        threadId: "slack:C_IMAGE:1700000003.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            name: "screen.png",
            fetchData: attachmentFetch,
          },
        ],
      }),
    );

    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(attachmentFetch).not.toHaveBeenCalled();
    expect(generateAssistantReply).toHaveBeenCalledTimes(1);
  });

  it("keeps cached image summaries aligned with attachment positions", async () => {
    listThreadRepliesMock.mockResolvedValue([
      {
        ts: "1700000004.100",
        files: [
          {
            id: "F_MISSING",
            mimetype: "image/png",
            url_private_download: "https://files.slack.com/private/missing.png",
          },
          {
            id: "F_CACHED",
            mimetype: "image/png",
            url_private_download: "https://files.slack.com/private/cached.png",
          },
        ],
      },
    ]);
    const downloadFileMock = vi.fn(async () => Buffer.from("downloaded-image"));
    let completeTextCallCount = 0;
    const completeTextMock = vi.fn(async () => {
      completeTextCallCount += 1;
      if (completeTextCallCount === 1) {
        return {
          text: "",
          message: {} as never,
        };
      }
      if (completeTextCallCount === 2) {
        return {
          text: "Second cached summary",
          message: {} as never,
        };
      }
      return {
        text: "First attachment summary",
        message: {} as never,
      };
    });
    const firstAttachmentFetch = vi.fn(async () => Buffer.from("first-image"));
    const secondAttachmentFetch = vi.fn(async () =>
      Buffer.from("second-image"),
    );
    const generateAssistantReply = vi.fn(
      async (
        _text: string,
        context:
          | {
              userAttachments?: Array<{
                filename?: string;
              }>;
            }
          | undefined,
      ) => {
        expect(context?.userAttachments).toEqual([
          expect.objectContaining({
            filename: "first.png",
          }),
          expect.objectContaining({
            filename: "second.png",
          }),
        ]);
        return successfulAssistantReply("ok");
      },
    );

    const { slackRuntime } = await createSlackImageRuntime(
      {
        adapters: {
          listThreadReplies: listThreadRepliesMock,
          downloadSlackFile: downloadFileMock,
          describeImagesText: completeTextMock,
          generateAssistantReply,
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );

    await slackRuntime.handleNewMention(
      createTestThread({
        id: "slack:C_IMAGE:1700000004.000",
        state: createSlackImageConversationState(),
      }),
      createTestMessage({
        id: "1700000004.100",
        text: "compare these screenshots",
        threadId: "slack:C_IMAGE:1700000004.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            name: "first.png",
            fetchData: firstAttachmentFetch,
          },
          {
            type: "image",
            mimeType: "image/png",
            name: "second.png",
            fetchData: secondAttachmentFetch,
          },
        ],
      }),
    );

    expect(downloadFileMock).toHaveBeenCalledTimes(2);
    expect(completeTextMock).toHaveBeenCalledTimes(3);
    expect(firstAttachmentFetch).toHaveBeenCalledTimes(1);
    expect(secondAttachmentFetch).not.toHaveBeenCalled();
    expect(generateAssistantReply).toHaveBeenCalledTimes(1);
  });
});
