import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "chat";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { createModelAgentRunnerForRun } from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";

const ORIGINAL_ENV = { ...process.env };

async function createRuntime(
  args: Parameters<
    typeof import("../../fixtures/chat-runtime").createTestChatRuntime
  >[0],
) {
  process.env = {
    ...ORIGINAL_ENV,
    AI_VISION_MODEL: "openai/gpt-5.4",
    SLACK_BOT_TOKEN: "",
    SLACK_BOT_USER_TOKEN: "",
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
          agentRunner: createModelAgentRunnerForRun((request) => {
            const attachments = request.instruction.attachments ?? [];
            capturedAttachmentCounts.push(attachments.length);
            if (attachments[0]) {
              capturedAttachmentMediaTypes.push(attachments[0].mediaType);
            }
            return createModelStream([
              {
                type: "text",
                text: "Image received. The chart trend is upward.",
              },
            ]);
          }),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700004000.000",
    });
    const message = createTestMessage({
      id: "m-attachment-1",
      text: "<@U0APP> summarize this chart",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
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

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(attachmentFetch).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(capturedAttachmentCounts).toEqual([1]);
    expect(capturedAttachmentMediaTypes).toEqual(["image/png"]);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("chart trend is upward");
  }, 10_000);

  it("lets the agent respond when image analysis fails", async () => {
    const attachmentFetch = vi.fn(async () => Buffer.from("image-bytes"));
    const completeTextMock = vi.fn(async () => {
      throw new Error("vision unavailable");
    });
    const streamForRun = vi.fn((request) => {
      const attachments = request.instruction.attachments ?? [];
      expect(attachments).toEqual([
        expect.objectContaining({
          filename: "error.png",
          mediaType: "image/png",
          promptText: expect.stringContaining(
            'Image attachment "error.png" could not be analyzed',
          ),
        }),
      ]);
      return createModelStream([
        {
          type: "text",
          text: "I couldn’t inspect the attached image. Please try uploading it again.",
        },
      ]);
    });

    const { slackRuntime } = await createRuntime({
      services: {
        visionContext: {
          completeText: completeTextMock,
        },
        replyExecutor: {
          agentRunner: createModelAgentRunnerForRun(streamForRun),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700004001.000",
    });
    const message = createTestMessage({
      id: "m-attachment-2",
      text: "<@U0APP> what does this screenshot mean?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
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

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(attachmentFetch).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(streamForRun).toHaveBeenCalledTimes(1);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "I couldn’t inspect the attached image.",
    );
  });
});
