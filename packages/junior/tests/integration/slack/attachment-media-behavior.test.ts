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
  env: NodeJS.ProcessEnv = {},
) {
  process.env = {
    ...ORIGINAL_ENV,
    ...env,
  };
  vi.resetModules();
  const { createTestChatRuntime } = await import("../../fixtures/chat-runtime");
  return createTestChatRuntime(args);
}

describe("Slack behavior: mixed attachment media", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
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

    const { slackRuntime } = await createRuntime(
      {
        services: {
          visionContext: {
            completeText: completeTextMock,
          },
          replyExecutor: {
            generateAssistantReply: async (_prompt, context) => {
              const attachments = context?.userAttachments ?? [];
              capturedAttachmentMediaTypes.push(
                attachments.map((attachment) => attachment.mediaType),
              );
              capturedAttachmentNames.push(
                attachments.map((attachment) => attachment.filename ?? ""),
              );
              return {
                text: "Processed attachments.",
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
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700004010.000" });
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

    await slackRuntime.handleNewMention(thread, message);

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

    const { slackRuntime } = await createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            const attachments = context?.userAttachments ?? [];
            capturedAttachmentMediaTypes.push(
              attachments.map((attachment) => attachment.mediaType),
            );
            capturedAttachmentNames.push(
              attachments.map((attachment) => attachment.filename ?? ""),
            );
            return {
              text: "Processed attachments.",
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

    await slackRuntime.handleNewMention(thread, message);

    expect(imageFetch).not.toHaveBeenCalled();
    expect(capturedAttachmentMediaTypes).toEqual([["application/pdf"]]);
    expect(capturedAttachmentNames).toEqual([["incident.pdf"]]);
  });
});
