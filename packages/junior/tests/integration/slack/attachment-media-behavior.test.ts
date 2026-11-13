import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "chat";
import type { AgentAttachment } from "@/chat/agent/types";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { createModelAgentRunnerForRun } from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";

const ORIGINAL_ENV = { ...process.env };
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

async function createRuntime(
  args: Parameters<
    typeof import("../../fixtures/chat-runtime").createTestChatRuntime
  >[0],
  env: NodeJS.ProcessEnv = {},
) {
  process.env = {
    ...ORIGINAL_ENV,
    AI_VISION_MODEL: "",
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_BOT_USER_TOKEN: "",
    ...env,
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

describe("Slack behavior: mixed attachment media", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("sends images natively and gives other files a loadAttachment pointer", async () => {
    const imageFetch = vi.fn(async () => PNG_BYTES);

    const capturedAttachments: (readonly AgentAttachment[])[] = [];
    const capturedOmittedImageCounts: number[] = [];

    const { slackRuntime } = await createRuntime({
      services: {
        agentRunner: createModelAgentRunnerForRun((request) => {
          capturedAttachments.push(request.instruction.attachments ?? []);
          capturedOmittedImageCounts.push(
            request.instruction.omittedImageAttachmentCount ?? 0,
          );
          return createModelStream([
            { type: "text", text: "Processed attachments." },
          ]);
        }),
        visionContext: { attachmentStorage: createMemoryAttachmentStorage() },
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700004011.000",
    });
    const message = createTestMessage({
      id: "m-attachment-mixed-2",
      text: "<@U0APP> summarize these files",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
      attachments: [
        {
          type: "image",
          // Slack can mislabel a file; the type detected from the bytes wins.
          mimeType: "image/jpeg",
          name: "chart.png",
          url: "https://files.slack.com/private/chart.png",
          fetchData: imageFetch,
        },
        {
          type: "file",
          mimeType: "application/pdf",
          name: "incident.pdf",
          data: Buffer.from("pdf-bytes"),
        },
        {
          type: "video",
          mimeType: "video/mp4",
          name: "repro.mp4",
          data: Buffer.from("mp4-bytes"),
        },
      ] as Message["attachments"],
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(imageFetch).toHaveBeenCalledTimes(1);
    expect(capturedAttachments).toHaveLength(1);
    const [image, pdf, video] = capturedAttachments[0]!;
    expect(image).toMatchObject({
      data: PNG_BYTES,
      filename: "chart.png",
      mediaType: "image/png",
    });
    for (const file of [pdf, video]) {
      expect(file?.data).toBeUndefined();
      expect(file?.attachmentId).toEqual(expect.any(String));
      expect(file?.promptText).toContain(
        `attachment_id: ${file?.attachmentId}`,
      );
    }
    expect(video).toMatchObject({
      filename: "repro.mp4",
      mediaType: "video/mp4",
    });
    expect(capturedOmittedImageCounts).toEqual([0]);
  });

  it("still runs the assistant when nothing can read the attached images", async () => {
    const imageFetch = vi.fn(async () => Buffer.from("image-bytes"));
    const capturedOmittedImageCounts: number[] = [];
    const streamForRun = vi.fn((request) => {
      capturedOmittedImageCounts.push(
        request.instruction.omittedImageAttachmentCount ?? 0,
      );
      return createModelStream([
        {
          type: "text",
          text: "I can’t inspect the attached image in this runtime, but I do see that an image was included.",
        },
      ]);
    });

    const { slackRuntime } = await createRuntime(
      {
        services: {
          agentRunner: createModelAgentRunnerForRun(streamForRun),
        },
      },
      // A text-only profile model with no vision model cannot read images.
      { AI_MODEL: "alibaba/qwen3.7-max" },
    );

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700004012.000",
    });
    const message = createTestMessage({
      id: "m-attachment-mixed-3",
      text: "<@U0APP> what about this image?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          name: "chart.png",
          url: "https://files.slack.com/private/chart.png",
          fetchData: imageFetch,
        },
      ] as Message["attachments"],
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(imageFetch).toHaveBeenCalledTimes(1);
    expect(streamForRun).toHaveBeenCalledTimes(1);
    expect(capturedOmittedImageCounts).toEqual([1]);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "I can’t inspect the attached image",
    );
  });
});
