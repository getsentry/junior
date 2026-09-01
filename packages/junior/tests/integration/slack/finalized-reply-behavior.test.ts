import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import {
  getSlackContinuationMarker,
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
  it("posts a completed assistant message", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        agentRunner: createModelAgentRunner(
          createModelStream([{ type: "text", text: "Hello world" }]),
        ),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0FINAL:1700006000.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-1",
        text: "<@U0APP> say hello",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(thread.posts.map(toPostedText)).toEqual(["Hello world"]);
    const lifecycle = await loadTurnLifecycleEvents(thread.id);
    expect(lifecycle.map((event) => event.data)).toEqual([
      expect.objectContaining({
        type: "turn_started",
        turnId: "turn_m-final-1",
        inputMessageIds: ["m-final-1"],
        surface: "slack",
      }),
      expect.objectContaining({
        type: "turn_completed",
        turnId: "turn_m-final-1",
        outcome: "success",
      }),
    ]);
  });

  it("splits long completed messages into continuation posts", async () => {
    const longReply = Array.from(
      { length: 80 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    const { slackRuntime } = createTestChatRuntime({
      services: {
        agentRunner: createModelAgentRunner(
          createModelStream([{ type: "text", text: longReply }]),
        ),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0FINAL:1700006005.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-6",
        text: "<@U0APP> give me all lines",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.postKinds.every((kind) => kind === "value")).toBe(true);
    expect(thread.posts.length).toBeGreaterThan(1);
    expect(
      toPostedText(thread.posts[0]).endsWith(getSlackContinuationMarker()),
    ).toBe(true);
    expect(toPostedText(thread.posts.at(-1))).not.toContain(
      getSlackContinuationMarker(),
    );
  });

  it("preserves fenced code blocks across continuation posts", async () => {
    const repeated = "console.log('hello');\n".repeat(200);
    const longReply = `Here is the script:\n\`\`\`ts\n${repeated}\`\`\``;
    const { slackRuntime } = createTestChatRuntime({
      services: {
        agentRunner: createModelAgentRunner(
          createModelStream([{ type: "text", text: longReply }]),
        ),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0FINAL:1700006006.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-7",
        text: "<@U0APP> send the script",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.posts.length).toBeGreaterThan(1);
    const firstPost = toPostedText(thread.posts[0]);
    const secondPost = toPostedText(thread.posts[1]);

    expect(firstPost.endsWith(`\n\`\`\`${getSlackContinuationMarker()}`)).toBe(
      true,
    );
    expect(secondPost.startsWith("```ts\n")).toBe(true);
  });

  it("posts answers that mention the no-reply marker", async () => {
    const answer = `Earlier turn used ${NO_REPLY_MARKER} and then stopped.`;
    const { slackRuntime } = createTestChatRuntime({
      services: {
        agentRunner: createModelAgentRunner(
          createModelStream([{ type: "text", text: answer }]),
        ),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0FINAL:1700006008.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-9",
        text: "<@U0APP> why was there no reply?",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(thread.posts.map(toPostedText)).toEqual([answer]);
    const lifecycle = await loadTurnLifecycleEvents(thread.id);
    expect(lifecycle.map((event) => event.data)).toEqual([
      expect.objectContaining({
        type: "turn_started",
        turnId: "turn_m-final-9",
        inputMessageIds: ["m-final-9"],
        surface: "slack",
      }),
      expect.objectContaining({
        type: "turn_completed",
        turnId: "turn_m-final-9",
        outcome: "success",
      }),
    ]);
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
