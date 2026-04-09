import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "chat";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

const ORIGINAL_ENV = { ...process.env };

async function createRuntime(
  args: Parameters<
    typeof import("../../fixtures/chat-runtime").createTestChatRuntime
  >[0],
) {
  process.env = {
    ...ORIGINAL_ENV,
    AI_VISION_MODEL: "openai/gpt-5.4",
  };
  vi.resetModules();
  const { createTestChatRuntime } = await import("../../fixtures/chat-runtime");
  return createTestChatRuntime(args);
}

function toPostedText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const markdown = (value as { markdown?: unknown }).markdown;
    if (typeof markdown === "string") {
      return markdown;
    }
  }

  return String(value);
}

describe("Slack behavior: attachment handling", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("rehydrates attachment data and forwards it to the agent context", async () => {
    const attachmentFetch = vi.fn(async () => Buffer.from("image-bytes"));
    const completeTextMock = vi.fn(async () => ({
      text: "The chart trend is upward.",
      message: {} as never,
    }));
    const capturedAttachmentCounts: number[] = [];
    const capturedAttachmentMediaTypes: string[] = [];

    const { slackRuntime } = await createRuntime({
      services: {
        visionContext: {
          completeText: completeTextMock,
        },
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            const attachments = context?.userAttachments ?? [];
            capturedAttachmentCounts.push(attachments.length);
            if (attachments[0]) {
              capturedAttachmentMediaTypes.push(attachments[0].mediaType);
            }

            return {
              text: "Image received. The chart trend is upward.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700004000.000" });
    const message = createTestMessage({
      id: "m-attachment-1",
      text: "<@U_APP> summarize this chart",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          name: "chart.png",
          url: "https://files.slack.com/private/chart.png",
          fetchData: attachmentFetch,
        },
      ] as Message["attachments"],
    });

    await slackRuntime.handleNewMention(thread, message);

    expect(attachmentFetch).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(capturedAttachmentCounts).toEqual([1]);
    expect(capturedAttachmentMediaTypes).toEqual(["image/png"]);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("chart trend is upward");
  });

  it("posts a fallback error reply when required image analysis fails", async () => {
    const attachmentFetch = vi.fn(async () => Buffer.from("image-bytes"));
    const completeTextMock = vi.fn(async () => {
      throw new Error("vision unavailable");
    });
    const generateAssistantReply = vi.fn(async () => ({
      text: "should not post",
      diagnostics: {
        assistantMessageCount: 1,
        modelId: "fake-agent-model",
        outcome: "success" as const,
        toolCalls: [],
        toolErrorCount: 0,
        toolResultCount: 0,
        usedPrimaryText: true,
      },
    }));

    const { slackRuntime } = await createRuntime({
      services: {
        visionContext: {
          completeText: completeTextMock,
        },
        replyExecutor: {
          generateAssistantReply,
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700004001.000" });
    const message = createTestMessage({
      id: "m-attachment-2",
      text: "<@U_APP> what does this screenshot mean?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          name: "error.png",
          url: "https://files.slack.com/private/error.png",
          fetchData: attachmentFetch,
        },
      ] as Message["attachments"],
    });

    await slackRuntime.handleNewMention(thread, message);

    expect(attachmentFetch).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "I ran into an internal error while processing that.",
    );
  });
});
