import { describe, expect, it, vi } from "vitest";
import type { AgentRunRequest } from "@/chat/agent/request";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import { deliverAssistantMessagesForTest } from "../../fixtures/agent-runner";
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
    const executeAgentRun = vi.fn(async (request: AgentRunRequest) => {
      await deliverAssistantMessagesForTest(request, [
        { text: "I’m creating the canvas now." },
      ]);
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
    });
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: executeAgentRun },
        },
      },
    });
    const thread = await createTestThread({
      id: "slack:C0CANVAS:1700008008.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-canvas-1",
        text: "<@U0APP> Put the research in a canvas.",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.posts).toHaveLength(2);
    expect(toPostedText(thread.posts[0])).toBe("I’m creating the canvas now.");
    expect(toPostedText(thread.posts[1])).toContain(
      "https://slack.example/docs/T/F_CANVAS",
    );
    const conversation = coerceThreadConversationState(
      (await thread.state) ?? {},
    );
    await hydrateConversationMessages({
      conversation,
      conversationId: thread.id,
    });
    expect(
      conversation.messages
        .filter((message) => message.role === "assistant")
        .map((message) => ({ id: message.id, text: message.text })),
    ).toEqual([
      {
        id: "turn_m-canvas-1:assistant:1",
        text: "I’m creating the canvas now.",
      },
      {
        id: "turn_m-canvas-1:assistant:2",
        text: expect.stringContaining("https://slack.example/docs/T/F_CANVAS"),
      },
    ]);
    expect(await thread.getState()).toMatchObject({
      artifacts: {
        lastCanvasId: "F_CANVAS",
        lastCanvasUrl: "https://slack.example/docs/T/F_CANVAS",
      },
    });
  });

  it("does not recover with a canvas from a prior turn", async () => {
    const executeAgentRun = vi.fn(async () => {
      throw new Error("forced unrelated failure");
    });
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: executeAgentRun },
        },
      },
    });
    const thread = await createTestThread({
      id: "slack:C0CANVAS:1700008009.000",
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
        text: "<@U0APP> Summarize the latest thread update.",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.posts).toHaveLength(1);
    const postedText = toPostedText(thread.posts[0]);
    expect(postedText).toContain("I ran into an internal error");
    expect(postedText).not.toContain("https://slack.example/docs/T/F_OLD");
    expect(await thread.getState()).toMatchObject({
      artifacts: {
        lastCanvasUrl: "https://slack.example/docs/T/F_OLD",
      },
    });
  });
});
