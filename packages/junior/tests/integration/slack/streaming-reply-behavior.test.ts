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
  }

  return String(value);
}

function makeDiagnostics(toolCalls: string[] = []) {
  return {
    assistantMessageCount: 1,
    modelId: "fake-agent-model",
    outcome: "success" as const,
    toolCalls,
    toolErrorCount: 0,
    toolResultCount: toolCalls.length,
    usedPrimaryText: true,
  };
}

describe("Slack behavior: streaming replies", () => {
  it("passes streamed text to thread.post as an AsyncIterable", async () => {
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

    const thread = createTestThread({ id: "slack:C_STREAM:1700006000.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-1",
        text: "<@U_APP> say hello",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["stream"]);
    expect(thread.posts).toEqual(["Hello world"]);
  });

  it("keeps explicit paragraph separators in streamed text", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.("First part");
            await context?.onTextDelta?.("\n\nSecond part");
            return {
              text: "First part\n\nSecond part",
              diagnostics: makeDiagnostics(),
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006001.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-2",
        text: "<@U_APP> continue",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["stream"]);
    expect(thread.posts).toEqual(["First part\n\nSecond part"]);
  });

  it("normalizes CRLF text without forcing a continuation post", async () => {
    const output = "First line\r\nSecond line";
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.(output);
            return {
              text: output,
              diagnostics: makeDiagnostics(),
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006001.250" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-crlf",
        text: "<@U_APP> continue",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["stream"]);
    expect(thread.posts).toEqual(["First line\nSecond line"]);
  });

  it("does not rewrite mention-like text while streaming", async () => {
    const output =
      "Ask @alice to review @sentry/junior and see https://x.com/@alice";
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.(output);
            return {
              text: output,
              diagnostics: makeDiagnostics(),
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006001.500" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-mentions",
        text: "<@U_APP> continue",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["stream"]);
    expect(thread.posts).toEqual([output]);
  });

  it("keeps ack-only replies on the non-streamed post path", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.("o");
            await context?.onTextDelta?.("k");
            return {
              text: "ok",
              diagnostics: makeDiagnostics(),
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006002.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-3",
        text: "<@U_APP> react only",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(toPostedText(thread.posts[0])).toBe("ok");
  });

  it("waits for a fresh assistant message after tool work before streaming the visible reply", async () => {
    const finalReply =
      "I checked five outlets. The dominant story is the escalating US-Iran conflict, with the clearest cross-source agreement on the blockade and the conflicting signals about whether talks will resume.";
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onToolCall?.("webSearch");
            await context?.onTextDelta?.(
              "Good — 5 solid sources. Fetching all of them now.\n",
            );
            await context?.onToolCall?.("webFetch");
            await context?.onTextDelta?.(
              "Live blogs are too large — let me try fetching with smaller limits.\n",
            );
            await context?.onToolCall?.("webFetch");
            await context?.onAssistantMessageStart?.();
            await context?.onTextDelta?.(finalReply);
            return {
              text: finalReply,
              diagnostics: makeDiagnostics(["webSearch", "webFetch"]),
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006002.375" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-research-no-chatter",
        text: "<@U_APP> find the hottest news article today and summarize it",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["stream"]);
    expect(thread.posts).toEqual([finalReply]);
  });

  it("keeps file-only replies on the non-streamed inline post path", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "",
            files: [
              {
                data: Buffer.from("image-bytes"),
                filename: "generated.png",
                mimeType: "image/png",
              },
            ],
            diagnostics: makeDiagnostics(),
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006002.500" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-file-only",
        text: "<@U_APP> generate image",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(thread.posts[0]).toEqual(
      expect.objectContaining({
        raw: "",
        files: [
          expect.objectContaining({
            filename: "generated.png",
            mimeType: "image/png",
          }),
        ],
      }),
    );
  });

  it("still delivers files when thread text is suppressed", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "👍",
            files: [
              {
                data: Buffer.from("image-bytes"),
                filename: "generated.png",
                mimeType: "image/png",
              },
            ],
            deliveryPlan: {
              mode: "thread",
              postThreadText: false,
              attachFiles: "inline",
            },
            diagnostics: makeDiagnostics(),
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006002.625" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-file-only-suppressed",
        text: "<@U_APP> generate image",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(thread.posts[0]).toEqual(
      expect.objectContaining({
        raw: "",
        files: [
          expect.objectContaining({
            filename: "generated.png",
            mimeType: "image/png",
          }),
        ],
      }),
    );
  });

  it("does not delete an ack reply when it also carries files", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "ok",
            files: [
              {
                data: Buffer.from("image-bytes"),
                filename: "generated.png",
                mimeType: "image/png",
              },
            ],
            diagnostics: makeDiagnostics(["slackMessageAddReaction"]),
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006002.688" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-ack-file",
        text: "<@U_APP> react and attach",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(thread.posts[0]).toEqual(
      expect.objectContaining({
        markdown: "ok",
        files: [
          expect.objectContaining({
            filename: "generated.png",
            mimeType: "image/png",
          }),
        ],
      }),
    );
  });

  it("normalizes raw non-streamed fallback replies before posting", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "\r\n\t  \r\n",
            diagnostics: makeDiagnostics(),
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006002.750" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-whitespace-fallback",
        text: "<@U_APP> whitespace",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(toPostedText(thread.posts[0])).toBe(
      "I couldn't produce a response.",
    );
  });

  it("keeps trailing ack-like text once streaming has started", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.("The task is ");
            await context?.onTextDelta?.("done.");
            return {
              text: "The task is done.",
              diagnostics: makeDiagnostics(),
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006003.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-4",
        text: "<@U_APP> status",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["stream"]);
    expect(thread.posts).toEqual(["The task is done."]);
  });

  it("posts streamed text before the file followup", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.("Here is the result.");
            return {
              text: "Here is the result.",
              files: [
                {
                  data: Buffer.from("file-data"),
                  filename: "result.txt",
                },
              ],
              diagnostics: makeDiagnostics(),
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006004.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-5",
        text: "<@U_APP> attach files",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["stream", "value"]);
    expect(thread.posts[0]).toBe("Here is the result.");
    expect(thread.posts[1]).toEqual(
      expect.objectContaining({
        files: [
          expect.objectContaining({
            filename: "result.txt",
          }),
        ],
      }),
    );
  });

  it("overflows long streamed replies into explicit continuation posts", async () => {
    const longReply = Array.from(
      { length: 80 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.(longReply);
            return {
              text: longReply,
              diagnostics: makeDiagnostics(),
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006005.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-6",
        text: "<@U_APP> summarize",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds[0]).toBe("stream");
    expect(thread.postKinds.slice(1).every((kind) => kind === "value")).toBe(
      true,
    );
    expect(thread.posts.length).toBeGreaterThan(1);
    expect(String(thread.posts[0])).toContain(getSlackContinuationMarker());
    expect(toPostedText(thread.posts[1])).toContain(
      getSlackContinuationMarker(),
    );
    const lastPost = thread.posts[thread.posts.length - 1];
    expect(lastPost).toBeDefined();
    expect(toPostedText(lastPost)).not.toContain(getSlackContinuationMarker());
    expect(toPostedText(lastPost)).toContain("line 80");
  });

  it("closes and reopens code fences when streamed replies overflow", async () => {
    const code = Array.from(
      { length: 80 },
      (_, i) => `const value${i + 1} = ${i + 1};`,
    ).join("\n");
    const longReply = `\`\`\`ts\n${code}\n\`\`\``;
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.(longReply);
            return {
              text: longReply,
              diagnostics: makeDiagnostics(),
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006005.500" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-6-code",
        text: "<@U_APP> show code",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds[0]).toBe("stream");
    expect(thread.posts.length).toBeGreaterThan(1);
    expect(String(thread.posts[0])).toContain(
      `\`\`\`${getSlackContinuationMarker()}`,
    );
    expect(toPostedText(thread.posts[1])).toMatch(/^```ts\nconst value/);
  });

  it("does not garble streamed fence continuations near the budget boundary", async () => {
    const firstDelta =
      "```\n" +
      "a".repeat(
        slackOutputPolicy.maxInlineChars -
          getSlackContinuationMarker().length -
          1 -
          "```\n".length,
      );
    const tail = "bcdef\n```";
    const fullReply = `${firstDelta}${tail}`;
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.(firstDelta);
            await context?.onTextDelta?.(tail);
            return {
              text: fullReply,
              diagnostics: makeDiagnostics(),
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006005.750" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-6-code-boundary",
        text: "<@U_APP> show edge code",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["stream", "value"]);
    const firstPost = String(thread.posts[0]);
    const secondPost = toPostedText(thread.posts[1]);
    const continuationSuffix = `\n\`\`\`${getSlackContinuationMarker()}`;

    expect(firstPost.endsWith(continuationSuffix)).toBe(true);
    expect(secondPost.startsWith("```\n")).toBe(true);
    expect(secondPost).toContain("bcdef\n```");
  });

  it("posts an interruption notice when a streamed reply ends in provider error", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.("Partial output...");
            return {
              text: "Partial output...",
              diagnostics: {
                ...makeDiagnostics(),
                outcome: "provider_error" as const,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STREAM:1700006006.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stream-7",
        text: "<@U_APP> continue",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["stream", "value"]);
    expect(thread.posts[0]).toBe("Partial output...");
    expect(toPostedText(thread.posts[1])).toBe(
      getSlackInterruptionMarker().trimStart(),
    );
  });
});
