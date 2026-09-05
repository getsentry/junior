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
  env: NodeJS.ProcessEnv = {},
) {
  process.env = {
    ...ORIGINAL_ENV,
    AI_VISION_MODEL: "",
    SLACK_BOT_TOKEN: "",
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

  it("keeps valid attachments, skips oversized attachments, and flags failed fetch attachments instead of dropping them", async () => {
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
    const capturedAttachmentPromptTexts: Array<string | undefined>[] = [];

    const { slackRuntime } = await createRuntime(
      {
        services: {
          visionContext: {
            completeText: completeTextMock,
          },
          agentRunner: createModelAgentRunnerForRun((request) => {
            const attachments = request.instruction.attachments ?? [];
            capturedAttachmentMediaTypes.push(
              attachments.map((attachment) => attachment.mediaType),
            );
            capturedAttachmentNames.push(
              attachments.map((attachment) => attachment.filename ?? ""),
            );
            capturedAttachmentPromptTexts.push(
              attachments.map((attachment) => attachment.promptText),
            );
            return createModelStream([
              { type: "text", text: "Processed attachments." },
            ]);
          }),
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700004010.000",
    });
    const message = createTestMessage({
      id: "m-attachment-mixed-1",
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
        {
          type: "image",
          mimeType: "image/svg+xml",
          name: "icon.svg",
          data: Buffer.from('<svg viewBox="0 0 16 16" />'),
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

    // The per-turn attachment cap (3) is reached by chart.png, incident.pdf,
    // and the now-surfaced broken.json failure, so icon.svg is dropped by the
    // cap rather than by the fetch failure.
    expect(capturedAttachmentMediaTypes).toEqual([
      ["image/png", "application/pdf", "application/json"],
    ]);
    expect(capturedAttachmentNames).toEqual([
      ["chart.png", "incident.pdf", "broken.json"],
    ]);
    // The failed download is surfaced to the model instead of vanishing, so
    // Junior can tell the user it saw an attachment it could not read.
    expect(capturedAttachmentPromptTexts[0]?.[2]).toContain(
      "could not download its content",
    );
  }, 20_000);

  it("keeps raw image attachments when AI_VISION_MODEL is unset", async () => {
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
