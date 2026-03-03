import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "chat";
import { appSlackRuntime, resetBotDepsForTests, setBotDepsForTests } from "@/chat/bot";
import { createTestMessage, createTestThread } from "../../fixtures/slack-harness";

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
    resetBotDepsForTests();
  });

  it("rehydrates attachment data and forwards it to the agent context", async () => {
    const attachmentFetch = vi.fn(async () => Buffer.from("image-bytes"));
    const capturedAttachmentCounts: number[] = [];
    const capturedAttachmentMediaTypes: string[] = [];

    setBotDepsForTests({
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
            usedPrimaryText: true
          }
        };
      }
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
          fetchData: attachmentFetch
        }
      ] as Message["attachments"]
    });

    await appSlackRuntime.handleNewMention(thread, message);

    expect(attachmentFetch).toHaveBeenCalledTimes(1);
    expect(capturedAttachmentCounts).toEqual([1]);
    expect(capturedAttachmentMediaTypes).toEqual(["image/png"]);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("chart trend is upward");
  });
});
