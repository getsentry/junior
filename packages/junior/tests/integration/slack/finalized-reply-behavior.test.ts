import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
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
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { flattenAgentRunRequestForTest } from "../../fixtures/agent-runner";

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

function toPostedFiles(value: unknown): Array<{ filename: string }> {
  if (
    value &&
    typeof value === "object" &&
    "files" in value &&
    Array.isArray(value.files)
  ) {
    return value.files as Array<{ filename: string }>;
  }

  return [];
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
  it("posts only the finalized assistant reply even when deltas were emitted", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const _prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              await context?.onTextDelta?.("Hello ");
              await context?.onTextDelta?.("world");
              return completedAgentRun({
                text: "Hello world",
                diagnostics: makeDiagnostics(),
              });
            },
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006000.000" });
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
  });

  it("drops provisional pre-tool deltas and posts the post-tool answer once", async () => {
    const finalReply =
      "I checked five outlets. The dominant story is the escalating US-Iran conflict.";
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const _prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              await context?.onTextDelta?.("Fetching sources now...");
              await context?.onAssistantMessageStart?.();
              await context?.onTextDelta?.(finalReply);
              return completedAgentRun({
                text: finalReply,
                diagnostics: makeDiagnostics({ toolCalls: ["webSearch"] }),
              });
            },
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006001.000" });
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

    expect(thread.postKinds).toEqual(["value"]);
    expect(thread.posts.map(toPostedText)).toEqual([finalReply]);
  });

  it("keeps file-only replies on the inline post path", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: "",
                files: [{ data: Buffer.from("hello"), filename: "hello.txt" }],
                diagnostics: makeDiagnostics(),
              }),
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006002.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-3",
        text: "<@U0APP> attach the file",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(thread.posts.map(toPostedText)).toEqual([""]);
    expect(toPostedFiles(thread.posts[0])).toEqual([
      expect.objectContaining({ filename: "hello.txt" }),
    ]);
  });

  it("still delivers files when thread text is suppressed", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: "Posted it in channel.",
                files: [
                  { data: Buffer.from("report"), filename: "report.txt" },
                ],
                deliveryPlan: {
                  mode: "channel_only",
                  postThreadText: false,
                  attachFiles: "inline",
                },
                diagnostics: makeDiagnostics(),
              }),
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006003.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-4",
        text: "<@U0APP> post in channel",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(toPostedText(thread.posts[0])).toBe("");
    expect(toPostedFiles(thread.posts[0])).toEqual([
      expect.objectContaining({ filename: "report.txt" }),
    ]);
  });

  it("posts a failure fallback instead of completing an empty final post plan", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: "",
                deliveryPlan: {
                  mode: "thread",
                  postThreadText: true,
                  attachFiles: "none",
                },
                diagnostics: makeDiagnostics(),
              }),
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006005.000" });
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

    expect(thread.postKinds).toEqual(["value"]);
    expect(toPostedText(thread.posts[0])).toContain(
      "I ran into an internal error while processing that.",
    );
  });

  it("does not delete an ack reply when it also carries files", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: "ok",
                files: [
                  { data: Buffer.from("report"), filename: "report.txt" },
                ],
                diagnostics: makeDiagnostics({
                  toolCalls: ["slackMessageAddReaction"],
                }),
              }),
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006004.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-5",
        text: "<@U0APP> react and attach",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(toPostedText(thread.posts[0])).toBe("ok");
    expect(toPostedFiles(thread.posts[0])).toEqual([
      expect.objectContaining({ filename: "report.txt" }),
    ]);
  });

  it("splits long replies into continuation posts after the final reply is known", async () => {
    const longReply = Array.from(
      { length: 80 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: longReply,
                diagnostics: makeDiagnostics(),
              }),
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006005.000" });
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
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: longReply,
                diagnostics: makeDiagnostics(),
              }),
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006006.000" });
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
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: longReply,
                diagnostics: makeDiagnostics({ outcome: "provider_error" }),
              }),
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C0FINAL:1700006007.000" });
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
  });
});
