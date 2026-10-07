import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  getSlackInterruptionMarker,
  slackOutputPolicy,
} from "@/chat/slack/output";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { createModelAgentRunner } from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";
import { getConversationEventStore } from "@/chat/db";

function toPostedText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const markdown = (value as { markdown?: unknown }).markdown;
    if (typeof markdown === "string") {
      return markdown;
    }
    const raw = (value as { raw?: unknown }).raw;
    if (typeof raw === "string") {
      return raw;
    }
    if ("files" in value) {
      return "";
    }
  }

  return String(value);
}

async function loadTurnLifecycleEvents(conversationId: string) {
  return (await getConversationEventStore().loadHistory(conversationId)).filter(
    (event) =>
      event.data.type === "turn_started" ||
      event.data.type === "turn_completed" ||
      event.data.type === "turn_failed",
  );
}

describe("Slack behavior: finalized thread replies", () => {
  it("explains a content-policy error after tool use", async () => {
    const errorMessage = JSON.stringify({
      type: "error",
      error: {
        type: "api_error",
        message:
          "Invalid prompt: your prompt was flagged as potentially violating our usage policy. (invalid_prompt)",
      },
      code: "invalid_prompt",
    });
    const { slackRuntime } = createTestChatRuntime({
      services: {
        agentRunner: createModelAgentRunner(
          createModelStream([
            {
              type: "message",
              message: fauxAssistantMessage(
                [
                  { type: "text", text: errorMessage },
                  fauxToolCall("bash", { command: "echo ignored" }),
                ],
                { stopReason: "error", errorMessage },
              ),
            },
          ]),
        ),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0FINAL:1700006011.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-11",
        text: "<@U0APP> inspect this",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.posts).toHaveLength(1);
    const postedText = toPostedText(thread.posts[0]);
    expect(postedText).toContain("content policy");
    expect(postedText).toContain("event_id=");
    expect(postedText).not.toContain("internal error");
  });

  it("marks provider-error replies with partial text as interrupted", async () => {
    const partialStart = "The budget review is complete.";
    const partialEnd = "This should continue into a second post.";
    const longReply = `${partialStart} ${"A".repeat(slackOutputPolicy.maxInlineChars)}\n\n${partialEnd}`;
    const { slackRuntime } = createTestChatRuntime({
      services: {
        agentRunner: createModelAgentRunner(
          createModelStream([
            {
              type: "message",
              message: fauxAssistantMessage(longReply, {
                stopReason: "error",
                errorMessage: "The model stream stopped.",
              }),
            },
          ]),
        ),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0FINAL:1700006007.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-8",
        text: "<@U0APP> long reply please",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.postKinds.every((kind) => kind === "value")).toBe(true);
    expect(thread.posts.length).toBeGreaterThan(1);
    const postedText = thread.posts.map(toPostedText).join("\n");
    expect(postedText).toContain(partialStart);
    expect(postedText).toContain(partialEnd);
    expect(postedText).toContain(getSlackInterruptionMarker().trim());
    const lifecycle = await loadTurnLifecycleEvents(thread.id);
    expect(lifecycle.map((event) => event.data)).toEqual([
      expect.objectContaining({
        type: "turn_started",
        turnId: "turn_m-final-8",
        inputMessageIds: ["m-final-8"],
        surface: "slack",
      }),
      expect.objectContaining({
        type: "turn_failed",
        turnId: "turn_m-final-8",
        failureCode: "model_execution_failed",
      }),
    ]);
  });
});
