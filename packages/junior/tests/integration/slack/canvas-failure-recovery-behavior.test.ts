import { describe, expect, it, vi } from "vitest";
import type { ReplyRequestContext } from "@/chat/respond";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";

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

describe("Slack behavior: canvas failure recovery", () => {
  it("points to a created canvas when reply generation fails before final text", async () => {
    const generateAssistantReply = vi.fn(
      async (request: ReplyRequestContext) => {
        await request.durability?.onArtifactStateUpdated?.({
          lastCanvasId: "F_CANVAS",
          lastCanvasUrl: "https://slack.example/docs/T/F_CANVAS",
          recentCanvases: [
            {
              id: "F_CANVAS",
              title: "Research reference",
              url: "https://slack.example/docs/T/F_CANVAS",
              createdAt: "2026-05-20T20:00:00.000Z",
            },
          ],
        });
        throw new Error("forced failure after canvas");
      },
    );
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: generateAssistantReply },
        },
      },
    });
    const thread = createTestThread({
      id: "slack:C_CANVAS:1700008008.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-canvas-1",
        text: "<@U_APP> Put the research in a canvas.",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "https://slack.example/docs/T/F_CANVAS",
    );
    expect(thread.getState()).toMatchObject({
      artifacts: {
        lastCanvasId: "F_CANVAS",
        lastCanvasUrl: "https://slack.example/docs/T/F_CANVAS",
      },
    });
  });

  it("does not recover with a canvas from a prior turn", async () => {
    const generateAssistantReply = vi.fn(async () => {
      throw new Error("forced unrelated failure");
    });
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: generateAssistantReply },
        },
      },
    });
    const thread = createTestThread({
      id: "slack:C_CANVAS:1700008009.000",
      state: {
        artifacts: {
          lastCanvasId: "F_OLD",
          lastCanvasUrl: "https://slack.example/docs/T/F_OLD",
          recentCanvases: [
            {
              id: "F_OLD",
              title: "Previous reference",
              url: "https://slack.example/docs/T/F_OLD",
              createdAt: "2026-05-20T19:00:00.000Z",
            },
          ],
        },
      },
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-canvas-2",
        text: "<@U_APP> Summarize the latest thread update.",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.posts).toHaveLength(1);
    const postedText = toPostedText(thread.posts[0]);
    expect(postedText).toContain("I ran into an internal error");
    expect(postedText).not.toContain("https://slack.example/docs/T/F_OLD");
    expect(thread.getState()).toMatchObject({
      artifacts: {
        lastCanvasUrl: "https://slack.example/docs/T/F_OLD",
      },
    });
  });
});
