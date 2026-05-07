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
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.("Hello ");
            await context?.onTextDelta?.("world");
            return {
              text: "Hello world",
              diagnostics: makeDiagnostics(),
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_FINAL:1700006000.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-1",
        text: "<@U_APP> say hello",
        isMention: true,
        threadId: thread.id,
      }),
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
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.("Fetching sources now...");
            await context?.onAssistantMessageStart?.();
            await context?.onTextDelta?.(finalReply);
            return {
              text: finalReply,
              diagnostics: makeDiagnostics({ toolCalls: ["webSearch"] }),
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_FINAL:1700006001.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-2",
        text: "<@U_APP> summarize the news",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(thread.posts.map(toPostedText)).toEqual([finalReply]);
  });

  it("keeps file-only replies on the inline post path", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "",
            files: [{ data: Buffer.from("hello"), filename: "hello.txt" }],
            diagnostics: makeDiagnostics(),
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_FINAL:1700006002.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-3",
        text: "<@U_APP> attach the file",
        isMention: true,
        threadId: thread.id,
      }),
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
          generateAssistantReply: async () => ({
            text: "Posted it in channel.",
            files: [{ data: Buffer.from("report"), filename: "report.txt" }],
            deliveryPlan: {
              mode: "channel_only",
              postThreadText: false,
              attachFiles: "inline",
            },
            diagnostics: makeDiagnostics(),
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_FINAL:1700006003.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-4",
        text: "<@U_APP> post in channel",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(toPostedText(thread.posts[0])).toBe("");
    expect(toPostedFiles(thread.posts[0])).toEqual([
      expect.objectContaining({ filename: "report.txt" }),
    ]);
  });

  it("does not delete an ack reply when it also carries files", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "ok",
            files: [{ data: Buffer.from("report"), filename: "report.txt" }],
            diagnostics: makeDiagnostics({
              toolCalls: ["slackMessageAddReaction"],
            }),
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_FINAL:1700006004.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-5",
        text: "<@U_APP> react and attach",
        isMention: true,
        threadId: thread.id,
      }),
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
          generateAssistantReply: async () => ({
            text: longReply,
            diagnostics: makeDiagnostics(),
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_FINAL:1700006005.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-6",
        text: "<@U_APP> give me all lines",
        isMention: true,
        threadId: thread.id,
      }),
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
          generateAssistantReply: async () => ({
            text: longReply,
            diagnostics: makeDiagnostics(),
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_FINAL:1700006006.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-7",
        text: "<@U_APP> send the script",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.posts.length).toBeGreaterThan(1);
    const firstPost = toPostedText(thread.posts[0]);
    const secondPost = toPostedText(thread.posts[1]);

    expect(firstPost.endsWith(`\n\`\`\`${getSlackContinuationMarker()}`)).toBe(
      true,
    );
    expect(secondPost.startsWith("```ts\n")).toBe(true);
  });

  it("adds an interruption marker to provider-error replies", async () => {
    const longReply =
      `${"A".repeat(slackOutputPolicy.maxInlineChars)}\n\n` +
      "This should continue into a second post.";
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: longReply,
            diagnostics: makeDiagnostics({ outcome: "provider_error" }),
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_FINAL:1700006007.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-final-8",
        text: "<@U_APP> long reply please",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds.every((kind) => kind === "value")).toBe(true);
    expect(toPostedText(thread.posts.at(-1))).toContain(
      getSlackInterruptionMarker().trim(),
    );
  });
});
