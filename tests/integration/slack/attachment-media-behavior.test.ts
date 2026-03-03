import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "chat";
import { appSlackRuntime, resetBotDepsForTests, setBotDepsForTests } from "@/chat/bot";
import { createTestMessage, createTestThread } from "../../fixtures/slack-harness";

describe("Slack behavior: mixed attachment media", () => {
  afterEach(() => {
    resetBotDepsForTests();
  });

  it("keeps valid attachments while skipping oversized and failed fetch attachments", async () => {
    const imageFetch = vi.fn(async () => Buffer.from("image-bytes"));
    const oversizedFetch = vi.fn(async () => Buffer.alloc(5 * 1024 * 1024 + 1));
    const failingFetch = vi.fn(async () => {
      throw new Error("download failed");
    });

    const capturedAttachmentMediaTypes: string[][] = [];
    const capturedAttachmentNames: string[][] = [];

    setBotDepsForTests({
      generateAssistantReply: async (_prompt, context) => {
        const attachments = context?.userAttachments ?? [];
        capturedAttachmentMediaTypes.push(attachments.map((attachment) => attachment.mediaType));
        capturedAttachmentNames.push(attachments.map((attachment) => attachment.filename ?? ""));
        return {
          text: "Processed attachments.",
          diagnostics: {
            assistantMessageCount: 1,
            modelId: "fake-agent-model",
            outcome: "success",
            toolCalls: [],
            toolErrorCount: 0,
            toolResultCount: 0,
            usedPrimaryText: true
          }
        };
      }
    });

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
          fetchData: imageFetch
        },
        {
          type: "file",
          mimeType: "application/pdf",
          name: "incident.pdf",
          data: Buffer.from("pdf-bytes")
        },
        {
          type: "file",
          mimeType: "application/zip",
          name: "large.zip",
          url: "https://files.slack.com/private/large.zip",
          fetchData: oversizedFetch
        },
        {
          type: "file",
          mimeType: "application/json",
          name: "broken.json",
          url: "https://files.slack.com/private/broken.json",
          fetchData: failingFetch
        }
      ] as Message["attachments"]
    });

    await appSlackRuntime.handleNewMention(thread, message);

    expect(imageFetch).toHaveBeenCalledTimes(1);
    expect(oversizedFetch).toHaveBeenCalledTimes(1);
    expect(failingFetch).toHaveBeenCalledTimes(1);

    expect(capturedAttachmentMediaTypes).toEqual([["image/png", "application/pdf"]]);
    expect(capturedAttachmentNames).toEqual([["chart.png", "incident.pdf"]]);
  });
});
