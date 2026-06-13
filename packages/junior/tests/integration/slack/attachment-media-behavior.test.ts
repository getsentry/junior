import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "chat";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import {
  createSlackImageRuntime,
  resetSlackImageRuntimeEnv,
} from "../../fixtures/slack/image-runtime";
import { toPostedText } from "../../fixtures/slack/posts";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack/harness";

describe("Slack behavior: mixed attachment media", () => {
  afterEach(() => {
    resetSlackImageRuntimeEnv();
  });

  it("keeps valid attachments while skipping oversized and failed fetch attachments", async () => {
    const imageFetch = vi.fn(async () => Buffer.from("image-bytes"));
    const oversizedFetch = vi.fn(async () => Buffer.alloc(5 * 1024 * 1024 + 1));
    const failingFetch = vi.fn(async () => {
      throw new Error("download failed");
    });
    const completeTextMock = vi.fn(async () => ({
      text: "Chart screenshot with an upward trend.",
      message: {} as never,
    }));

    const capturedAttachmentMediaTypes: string[][] = [];
    const capturedAttachmentNames: string[][] = [];

    const { slackRuntime } = await createSlackImageRuntime(
      {
        adapters: {
          describeImagesText: completeTextMock,
          generateAssistantReply: async (_prompt, context) => {
            const attachments = context?.userAttachments ?? [];
            capturedAttachmentMediaTypes.push(
              attachments.map((attachment) => attachment.mediaType),
            );
            capturedAttachmentNames.push(
              attachments.map((attachment) => attachment.filename ?? ""),
            );
            return successfulAssistantReply("Processed attachments.");
          },
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );

    const thread = createTestThread({
      id: "slack:C_BEHAVIOR:1700004010.000",
    });
    const message = createTestMessage({
      id: "m-attachment-mixed-1",
      text: "<@U_APP> summarize these files",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
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
        {
          type: "file",
          mimeType: "application/zip",
          name: "large.zip",
          url: "https://files.slack.com/private/large.zip",
          fetchData: oversizedFetch,
        },
        {
          type: "file",
          mimeType: "application/json",
          name: "broken.json",
          url: "https://files.slack.com/private/broken.json",
          fetchData: failingFetch,
        },
      ] as Message["attachments"],
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(imageFetch).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(oversizedFetch).toHaveBeenCalledTimes(1);
    expect(failingFetch).toHaveBeenCalledTimes(1);

    expect(capturedAttachmentMediaTypes).toEqual([
      ["image/png", "application/pdf"],
    ]);
    expect(capturedAttachmentNames).toEqual([["chart.png", "incident.pdf"]]);
  });

  it("drops image attachments when AI_VISION_MODEL is unset", async () => {
    const imageFetch = vi.fn(async () => Buffer.from("image-bytes"));

    const capturedAttachmentMediaTypes: string[][] = [];
    const capturedAttachmentNames: string[][] = [];
    const capturedOmittedImageCounts: number[] = [];

    const { slackRuntime } = await createSlackImageRuntime({
      adapters: {
        generateAssistantReply: async (_prompt, context) => {
          const attachments = context?.userAttachments ?? [];
          capturedAttachmentMediaTypes.push(
            attachments.map((attachment) => attachment.mediaType),
          );
          capturedAttachmentNames.push(
            attachments.map((attachment) => attachment.filename ?? ""),
          );
          capturedOmittedImageCounts.push(
            context?.omittedImageAttachmentCount ?? 0,
          );
          return successfulAssistantReply("Processed attachments.");
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700004011.000" });
    const message = createTestMessage({
      id: "m-attachment-mixed-2",
      text: "<@U_APP> summarize these files",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
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

    expect(imageFetch).not.toHaveBeenCalled();
    expect(capturedAttachmentMediaTypes).toEqual([["application/pdf"]]);
    expect(capturedAttachmentNames).toEqual([["incident.pdf"]]);
    expect(capturedOmittedImageCounts).toEqual([1]);
  });

  it("still runs the assistant when only images are attached and vision is disabled", async () => {
    const imageFetch = vi.fn(async () => Buffer.from("image-bytes"));
    const capturedOmittedImageCounts: number[] = [];
    const generateAssistantReply = vi.fn(
      async (_prompt?: string, _context?: unknown) =>
        successfulAssistantReply(
          "I can’t inspect the attached image in this runtime, but I do see that an image was included.",
        ),
    );

    const { slackRuntime } = await createSlackImageRuntime({
      adapters: {
        generateAssistantReply: async (prompt, context) => {
          capturedOmittedImageCounts.push(
            context?.omittedImageAttachmentCount ?? 0,
          );
          return generateAssistantReply(prompt, context);
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700004012.000" });
    const message = createTestMessage({
      id: "m-attachment-mixed-3",
      text: "<@U_APP> what about this image?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
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

    expect(imageFetch).not.toHaveBeenCalled();
    expect(generateAssistantReply).toHaveBeenCalledTimes(1);
    expect(capturedOmittedImageCounts).toEqual([1]);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "I can’t inspect the attached image",
    );
  });
});
