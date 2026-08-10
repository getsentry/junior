import { describe, expect, it, vi } from "vitest";
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
import { scriptedAssistantMessageRunner } from "../../fixtures/agent-runner";

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

function makeDiagnostics(
  overrides: Partial<{
    outcome: "success" | "execution_failure" | "provider_error";
    toolCalls: string[];
  }> = {},
) {
  return {
    assistantMessageCount: 1,
    modelId: "fake-agent-model",
    outcome: overrides.outcome ?? ("success" as const),
    toolCalls: overrides.toolCalls ?? [],
    toolErrorCount: 0,
    toolResultCount: (overrides.toolCalls ?? []).length,
    usedPrimaryText: true,
  };
}

describe("Slack behavior: finalized thread replies", () => {
  it("posts each completed assistant message", async () => {
    const turnLifecycle = {
      complete: vi.fn(),
      fail: vi.fn(),
      start: vi.fn(),
    };
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          turnLifecycle,
          agentRunner: scriptedAssistantMessageRunner({
            messages: [{ text: "Hello world" }],
            result: {
              text: "Hello world",
              diagnostics: makeDiagnostics(),
            },
          }),
        },
      },
    });

    const thread = await createTestThread({ id: "slack:C0FINAL:1700006000.000" });
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
    expect(turnLifecycle.start).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: thread.id,
        inputMessageIds: ["m-final-1"],
        surface: "slack",
      }),
    );
    expect(turnLifecycle.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: thread.id,
        outcome: "success",
      }),
    );
    expect(turnLifecycle.fail).not.toHaveBeenCalled();
  });

  it("posts completed assistant messages separately", async () => {
    const finalReply =
      "I checked five outlets. The dominant story is the escalating US-Iran conflict.";
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: scriptedAssistantMessageRunner({
            messages: [
              { text: "Fetching sources now..." },
              { text: finalReply },
            ],
            result: {
              text: finalReply,
              diagnostics: makeDiagnostics({ toolCalls: ["webSearch"] }),
            },
          }),
        },
      },
    });

    const thread = await createTestThread({ id: "slack:C0FINAL:1700006001.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-2",
        text: "<@U0APP> summarize the news",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.postKinds).toEqual(["value", "value"]);
    expect(thread.posts.map(toPostedText)).toEqual([
      "Fetching sources now...",
      finalReply,
    ]);
  });

  it("posts a fallback after progress when the run fails", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: scriptedAssistantMessageRunner({
            messages: [{ text: "Checking that now..." }],
            result: {
              text: "",
              diagnostics: makeDiagnostics({ outcome: "execution_failure" }),
            },
          }),
        },
      },
    });

    const thread = await createTestThread({ id: "slack:C0FINAL:1700006005.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-empty-plan",
        text: "<@U0APP> reply invisibly",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread), isFinalAttempt: true },
    );

    expect(thread.postKinds).toEqual(["value", "value"]);
    expect(toPostedText(thread.posts[0])).toBe("Checking that now...");
    expect(toPostedText(thread.posts[1])).toContain(
      "I ran into an internal error while processing that.",
    );
  });

  it("splits long completed messages into continuation posts", async () => {
    const longReply = Array.from(
      { length: 80 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: scriptedAssistantMessageRunner({
            messages: [{ text: longReply }],
            result: {
              text: longReply,
              diagnostics: makeDiagnostics(),
            },
          }),
        },
      },
    });

    const thread = await createTestThread({ id: "slack:C0FINAL:1700006005.000" });
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
        replyExecutor: {
          agentRunner: scriptedAssistantMessageRunner({
            messages: [{ text: longReply }],
            result: {
              text: longReply,
              diagnostics: makeDiagnostics(),
            },
          }),
        },
      },
    });

    const thread = await createTestThread({ id: "slack:C0FINAL:1700006006.000" });
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

  it("marks provider-error replies with partial text as interrupted", async () => {
    const partialStart = "The budget review is complete.";
    const partialEnd = "This should continue into a second post.";
    const longReply = `${partialStart} ${"A".repeat(slackOutputPolicy.maxInlineChars)}\n\n${partialEnd}`;
    const turnLifecycle = {
      complete: vi.fn(),
      fail: vi.fn(),
      start: vi.fn(),
    };
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          turnLifecycle,
          agentRunner: scriptedAssistantMessageRunner({
            messages: [],
            result: {
              text: longReply,
              diagnostics: makeDiagnostics({ outcome: "provider_error" }),
            },
          }),
        },
      },
    });

    const thread = await createTestThread({ id: "slack:C0FINAL:1700006007.000" });
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
    expect(postedText).not.toContain("event_id=");
    expect(turnLifecycle.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: thread.id,
        eventId: expect.stringMatching(/^[a-f0-9]{32}$/i),
        failureCode: "model_execution_failed",
      }),
    );
    expect(turnLifecycle.complete).not.toHaveBeenCalled();
  });
});
