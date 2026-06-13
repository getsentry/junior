import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import {
  createSlackImageConversationState,
  createSlackImageRuntime,
  resetSlackImageRuntimeEnv,
} from "../../fixtures/slack/image-runtime";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack/harness";

const listThreadRepliesMock = vi.fn();

describe("Slack behavior: image hydration", () => {
  beforeEach(() => {
    listThreadRepliesMock.mockReset();
  });

  afterEach(() => {
    resetSlackImageRuntimeEnv();
  });

  it("does not hydrate thread images when AI_VISION_MODEL is unset", async () => {
    const { slackRuntime } = await createSlackImageRuntime({
      adapters: {
        listThreadReplies: listThreadRepliesMock,
        generateAssistantReply: async () => successfulAssistantReply("ok"),
      },
    });
    const thread = createTestThread({
      id: "slack:C_IMAGE:1700000001.000",
      state: createSlackImageConversationState(),
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700000001.200",
        text: "",
        threadId: "slack:C_IMAGE:1700000001.000",
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
            data: Buffer.from("fake-image"),
          },
        ],
      }),
    );

    expect(listThreadRepliesMock).not.toHaveBeenCalled();
    const persistedState = thread.getState() as {
      conversation: {
        messages: Array<{
          author?: {
            isBot?: boolean;
          };
          text: string;
          meta?: {
            attachmentCount?: number;
            imageAttachmentCount?: number;
            imagesHydrated?: boolean;
            slackTs?: string;
          };
        }>;
        vision: {
          backfillCompletedAtMs?: number;
        };
      };
    };
    expect(
      persistedState.conversation.vision.backfillCompletedAtMs,
    ).toBeUndefined();
    const persistedMessage = persistedState.conversation.messages.find(
      (entry) => entry.meta?.slackTs === "1700000001.200",
    );
    expect(persistedMessage).toMatchObject({
      author: {
        isBot: false,
      },
      text: "[non-text message]",
      meta: {
        attachmentCount: 1,
        imageAttachmentCount: 1,
        imagesHydrated: false,
        slackTs: "1700000001.200",
      },
    });
  });

  it("backfills older image messages after vision is enabled later", async () => {
    const firstRuntime = await createSlackImageRuntime({
      adapters: {
        listThreadReplies: listThreadRepliesMock,
        generateAssistantReply: async () => successfulAssistantReply("ok"),
      },
    });
    const firstThread = createTestThread({
      id: "slack:C_IMAGE:1700000002.000",
      state: createSlackImageConversationState(),
    });

    await firstRuntime.slackRuntime.handleNewMention(
      firstThread,
      createTestMessage({
        id: "1700000002.100",
        text: "what is in this screenshot?",
        threadId: "slack:C_IMAGE:1700000002.000",
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
            data: Buffer.from("fake-image"),
          },
        ],
      }),
    );

    listThreadRepliesMock.mockResolvedValue([
      {
        ts: "1700000002.100",
        files: [
          {
            id: "F_OLD",
            mimetype: "image/png",
            url_private_download: "https://files.slack.com/private/old.png",
          },
        ],
      },
    ]);
    const downloadFileMock = vi.fn(async () => Buffer.from("downloaded-image"));
    const completeTextMock = vi.fn(async () => ({
      text: "Recovered screenshot context",
      message: {} as never,
    }));

    const secondRuntime = await createSlackImageRuntime(
      {
        adapters: {
          listThreadReplies: listThreadRepliesMock,
          downloadSlackFile: downloadFileMock,
          describeImagesText: completeTextMock,
          generateAssistantReply: async () => successfulAssistantReply("ok"),
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );
    const secondThread = createTestThread({
      id: "slack:C_IMAGE:1700000002.000",
      state: firstThread.getState(),
    });

    await secondRuntime.slackRuntime.handleNewMention(
      secondThread,
      createTestMessage({
        id: "1700000002.200",
        text: "follow up without new uploads",
        threadId: "slack:C_IMAGE:1700000002.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
      }),
    );

    expect(listThreadRepliesMock).toHaveBeenCalledTimes(1);
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    const persistedState = secondThread.getState() as {
      conversation: {
        messages: Array<{
          id: string;
          meta?: {
            imagesHydrated?: boolean;
            imageFileIds?: string[];
          };
        }>;
        vision: {
          backfillCompletedAtMs?: number;
          byFileId: Record<string, { summary: string }>;
        };
      };
    };
    expect(
      persistedState.conversation.messages.find(
        (message) => message.id === "1700000002.100",
      )?.meta,
    ).toEqual(
      expect.objectContaining({
        imagesHydrated: true,
        imageFileIds: ["F_OLD"],
      }),
    );
    expect(persistedState.conversation.vision.byFileId.F_OLD?.summary).toBe(
      "Recovered screenshot context",
    );
    expect(persistedState.conversation.vision.backfillCompletedAtMs).toBeTypeOf(
      "number",
    );
  });

  it("hydrates skipped passive screenshots when a later explicit mention needs them", async () => {
    listThreadRepliesMock.mockResolvedValue([
      {
        ts: "1700000002.100",
        files: [
          {
            id: "F_PASSIVE",
            mimetype: "image/png",
            url_private_download: "https://files.slack.com/private/passive.png",
          },
        ],
      },
    ]);
    const downloadFileMock = vi.fn(async () => Buffer.from("downloaded-image"));
    const completeTextMock = vi.fn(async () => ({
      text: "Passive screenshot summary",
      message: {} as never,
    }));
    const generateAssistantReply = vi.fn(
      async (
        _text: string,
        context: { conversationContext?: string } | undefined,
      ) => {
        expect(context?.conversationContext).toContain(
          "Passive screenshot summary",
        );
        return successfulAssistantReply("ok");
      },
    );

    const { slackRuntime } = await createSlackImageRuntime(
      {
        adapters: {
          classifySubscribedReply: async () => {
            throw new Error(
              "classifier should not run for messages addressed to another bot",
            );
          },
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
    const thread = createTestThread({
      id: "slack:C_IMAGE:1700000006.000",
      state: createSlackImageConversationState(),
    });

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "1700000002.100",
        text: "@Cursor can you look at this?",
        threadId: "slack:C_IMAGE:1700000006.000",
        isMention: false,
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
            name: "passive.png",
            url: "https://files.slack.com/private/passive.png",
          },
        ],
      }),
    );

    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(listThreadRepliesMock).not.toHaveBeenCalled();

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700000002.200",
        text: "<@U_APP> what is in the screenshot above?",
        threadId: "slack:C_IMAGE:1700000006.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
      }),
    );

    expect(listThreadRepliesMock).toHaveBeenCalledTimes(1);
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(generateAssistantReply).toHaveBeenCalledTimes(1);

    const persistedState = thread.getState() as {
      conversation: {
        messages: Array<{
          id: string;
          meta?: {
            imagesHydrated?: boolean;
            imageFileIds?: string[];
          };
        }>;
        vision: {
          byFileId: Record<string, { summary: string }>;
        };
      };
    };
    expect(
      persistedState.conversation.messages.find(
        (message) => message.id === "1700000002.100",
      )?.meta,
    ).toEqual(
      expect.objectContaining({
        imagesHydrated: true,
        imageFileIds: ["F_PASSIVE"],
      }),
    );
    expect(persistedState.conversation.vision.byFileId.F_PASSIVE?.summary).toBe(
      "Passive screenshot summary",
    );
  });
});
