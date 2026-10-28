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
    AI_VISION_MODEL: "",
    SLACK_BOT_TOKEN: "xoxb-test-token",
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

describe("Slack behavior: mixed attachment media", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("keeps raw image attachments when AI_VISION_MODEL is explicitly empty", async () => {
    const imageFetch = vi.fn(async () => Buffer.from("image-bytes"));

    const capturedAttachmentMediaTypes: string[][] = [];
    const capturedAttachmentNames: string[][] = [];
    const capturedOmittedImageCounts: number[] = [];

    const { slackRuntime } = await createRuntime({
      services: {
        agentRunner: createModelAgentRunnerForRun((request) => {
          const attachments = request.instruction.attachments ?? [];
          capturedAttachmentMediaTypes.push(
            attachments.map((attachment) => attachment.mediaType),
          );
          capturedAttachmentNames.push(
            attachments.map((attachment) => attachment.filename ?? ""),
          );
          capturedOmittedImageCounts.push(
            request.instruction.omittedImageAttachmentCount ?? 0,
          );
          return createModelStream([
            { type: "text", text: "Processed attachments." },
          ]);
        }),
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
          mimeType: "image/png",
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
      ] as Message["attachments"],
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(imageFetch).toHaveBeenCalledTimes(1);
    expect(capturedAttachmentMediaTypes).toEqual([
      ["image/png", "application/pdf"],
    ]);
    expect(capturedAttachmentNames).toEqual([["chart.png", "incident.pdf"]]);
    expect(capturedOmittedImageCounts).toEqual([1]);
  });

  it("still runs the assistant when only images are attached and vision is disabled", async () => {
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

    const { slackRuntime } = await createRuntime({
      services: {
        agentRunner: createModelAgentRunnerForRun(streamForRun),
      },
    });

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
