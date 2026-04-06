import { afterEach, describe, expect, it, vi } from "vitest";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { RetryableTurnError } from "@/chat/runtime/turn";
import {
  FakeSlackAdapter,
  createTestThread,
  createTestMessage,
} from "../../fixtures/slack-harness";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";

const emptyThreadReplies = async () => [];

function createRuntime(
  args: {
    services?: JuniorRuntimeServiceOverrides;
    slackAdapter?: FakeSlackAdapter;
  } = {},
) {
  const services = args.services ?? {};
  return createTestChatRuntime({
    slackAdapter: args.slackAdapter,
    services: {
      ...services,
      visionContext: {
        listThreadReplies: emptyThreadReplies,
        ...(services.visionContext ?? {}),
      },
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("bot handlers (integration)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handleNewMention: posts reply from generateAssistantReply", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "Hello from the bot!",
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "test-model",
              outcome: "success" as const,
              toolCalls: [],
              toolErrorCount: 0,
              toolResultCount: 0,
              usedPrimaryText: true,
            },
          }),
        },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_INT:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-new-mention",
        threadId: "slack:C_INT:1700000000.000",
        text: "hey bot",
        isMention: true,
      }),
    );

    expect(thread.posts.length).toBeGreaterThan(0);
    const hasReply = thread.posts.some((p) => {
      if (typeof p === "string") return p.includes("Hello from the bot!");
      if (
        p &&
        typeof p === "object" &&
        "markdown" in (p as Record<string, unknown>)
      ) {
        return String((p as { markdown: string }).markdown).includes(
          "Hello from the bot!",
        );
      }
      return false;
    });
    expect(hasReply).toBe(true);
  });

  it("handleSubscribedMessage with explicit mention: replies when should_reply is true", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () =>
            ({
              object: {
                should_reply: true,
                confidence: 1,
                reason: "explicit mention",
              },
              text: '{"should_reply":true,"confidence":1,"reason":"explicit mention"}',
            }) as any,
        },
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "Replying to mention",
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "test-model",
              outcome: "success" as const,
              toolCalls: [],
              toolErrorCount: 0,
              toolResultCount: 0,
              usedPrimaryText: true,
            },
          }),
        },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_SUB:1700000000.000" });

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "msg-sub-mention",
        threadId: "slack:C_SUB:1700000000.000",
        text: "<@UBOT> check this",
        isMention: true,
      }),
    );

    expect(thread.posts.length).toBeGreaterThan(0);
  });

  it("handleSubscribedMessage skip: does not reply when should_reply is false", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () =>
            ({
              object: {
                should_reply: false,
                confidence: 0,
                reason: "passive conversation",
              },
              text: '{"should_reply":false,"confidence":0,"reason":"passive conversation"}',
            }) as any,
        },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_SKIP:1700000000.000" });

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "msg-sub-skip",
        threadId: "slack:C_SKIP:1700000000.000",
        text: "just chatting among ourselves",
      }),
    );

    // Should not have posted a reply (no generateAssistantReply call)
    const hasReply = thread.posts.some((p) => {
      if (typeof p === "string") return !p.startsWith("Error:");
      if (
        p &&
        typeof p === "object" &&
        "markdown" in (p as Record<string, unknown>)
      )
        return true;
      return false;
    });
    expect(hasReply).toBe(false);

    // Verify state was persisted with replied: false
    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: { messages?: Array<{ meta?: { replied?: boolean } }> };
      }
    ).conversation;
    const lastMsg = conversation?.messages?.[conversation.messages.length - 1];
    expect(lastMsg?.meta?.replied).toBe(false);
  });

  it("handleAssistantThreadStarted: sets title and suggested prompts via adapter", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createTestChatRuntime({
      slackAdapter: fakeAdapter,
    });

    await slackRuntime.handleAssistantThreadStarted({
      threadId: "slack:C_ASSIST:1700000000.000",
      channelId: "C_ASSIST",
      threadTs: "1700000000.000",
      userId: "U-starter",
    });

    expect(fakeAdapter.titleCalls.length).toBe(1);
    expect(fakeAdapter.titleCalls[0].title).toBe("Junior");
    expect(fakeAdapter.titleCalls[0].channelId).toBe("C_ASSIST");
    expect(fakeAdapter.promptCalls.length).toBe(1);
    expect(fakeAdapter.promptCalls[0].prompts.length).toBe(3);
  });

  it("error recovery: posts safe error message when generateAssistantReply throws", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            throw new Error("LLM unavailable");
          },
        },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_ERR:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-err",
        threadId: "slack:C_ERR:1700000000.000",
        text: "trigger an error",
        isMention: true,
      }),
    );

    const errorPost = thread.posts.find(
      (p) =>
        typeof p === "string" &&
        p.includes("I ran into an internal error while processing that."),
    );
    expect(errorPost).toBeDefined();
    expect(String(errorPost)).not.toContain("LLM unavailable");
  });

  it("posts non-empty fallback text when streaming reply includes files", async () => {
    const { slackRuntime } = createRuntime({
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
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "success" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_FILES:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-files",
        threadId: "slack:C_FILES:1700000000.000",
        text: "attach files",
        isMention: true,
      }),
    );

    expect(thread.posts).toHaveLength(2);
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

  it("posts non-streamed reply when ack text bypasses streaming", async () => {
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.("👍");
            return {
              text: "👍",

              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "success" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 1,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_REACTION:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-reaction",
        threadId: "slack:C_REACTION:1700000000.000",
        text: "react only",
        isMention: true,
      }),
    );

    // Reply always posts to complete Slack's assistant response cycle
    expect(thread.posts).toHaveLength(1);
  });

  it("posts non-streamed reply when split ack text bypasses streaming", async () => {
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.("o");
            await context?.onTextDelta?.("k");
            return {
              text: "ok",

              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "success" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 1,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_REACTION_SPLIT:1700000000.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-reaction-split",
        threadId: "slack:C_REACTION_SPLIT:1700000000.000",
        text: "react only",
        isMention: true,
      }),
    );

    // Reply always posts to complete Slack's assistant response cycle
    expect(thread.posts).toHaveLength(1);
  });

  it("keeps trailing streamed text when the final delta looks like a redundant ack token", async () => {
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.("The task is ");
            await context?.onTextDelta?.("done.");
            return {
              text: "The task is done.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "success" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_STREAM_DONE:1700000000.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-stream-done",
        threadId: "slack:C_STREAM_DONE:1700000000.000",
        text: "status",
        isMention: true,
      }),
    );

    expect(thread.posts).toHaveLength(1);
    expect(thread.posts[0]).toBe("The task is done.");
  });

  it("passes conversation and turn correlation IDs into assistant reply context", async () => {
    const capturedCorrelation: Array<{
      conversationId?: string;
      threadId?: string;
      turnId?: string;
      runId?: string;
    }> = [];
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            capturedCorrelation.push({
              conversationId: context?.correlation?.conversationId,
              threadId: context?.correlation?.threadId,
              turnId: context?.correlation?.turnId,
              runId: context?.correlation?.runId,
            });
            return {
              text: "Done.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "success" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_CORRELATION:1700000000.000",
      runId: "run-123",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-correlation",
        threadId: "slack:C_CORRELATION:1700000000.000",
        text: "trace this turn",
        isMention: true,
      }),
    );

    expect(capturedCorrelation).toHaveLength(1);
    expect(capturedCorrelation[0]).toEqual(
      expect.objectContaining({
        conversationId: "slack:C_CORRELATION:1700000000.000",
        threadId: "slack:C_CORRELATION:1700000000.000",
        runId: "run-123",
      }),
    );
    expect(capturedCorrelation[0].turnId).toBe("turn_msg-correlation");
  });

  it("parks MCP auth resume turns without rethrowing to the queue", async () => {
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            throw new RetryableTurnError(
              "mcp_auth_resume",
              "simulated auth pause",
            );
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_AUTH:1700000000.000" });
    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-auth-pause",
          threadId: "slack:C_AUTH:1700000000.000",
          text: "please use notion",
          isMention: true,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(thread.posts).toHaveLength(0);
    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: {
          processing?: { activeTurnId?: string };
          messages?: Array<{
            meta?: { replied?: boolean; skippedReason?: string };
          }>;
        };
      }
    ).conversation;
    expect(conversation?.processing?.activeTurnId).toBe("turn_msg-auth-pause");
    const lastMessage =
      conversation?.messages?.[conversation.messages.length - 1];
    expect(lastMessage?.meta?.replied).toBeUndefined();
    expect(lastMessage?.meta?.skippedReason).toBeUndefined();
  });

  it("does not post synthetic failure reply when primary text was streamed", async () => {
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.("Partial output...");
            return {
              text: "Partial output...",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "provider_error" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_STREAM_FAIL:1700000000.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-stream-fail",
        threadId: "slack:C_STREAM_FAIL:1700000000.000",
        text: "do work",
        isMention: true,
      }),
    );

    expect(thread.posts).toHaveLength(1);
    expect(thread.posts[0]).toBe("Partial output...");
  });

  it("emits assistant status updates in shared channel threads", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onStatus?.("Listing channel messages...");
            return {
              text: "Done.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "success" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STATUS:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-status",
        threadId: "slack:C_STATUS:1700000000.000",
        text: "show the channel",
        isMention: true,
      }),
    );

    expect(fakeAdapter.statusCalls.length).toBeGreaterThan(0);
    expect(fakeAdapter.statusCalls[0]).toEqual(
      expect.objectContaining({
        channelId: "C_STATUS",
        threadTs: "1700000000.000",
      }),
    );
    expect(fakeAdapter.statusCalls.at(-1)).toEqual({
      channelId: "C_STATUS",
      threadTs: "1700000000.000",
      text: "",
      suggestions: undefined,
    });
  });

  it("thread title: generates and sets title after first assistant reply", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        conversationMemory: {
          completeText: async () =>
            ({
              text: "Debugging Node.js Memory Leaks",
              message: { role: "assistant", content: "" },
            }) as any,
        },
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "Here is how to debug memory leaks.",
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "test-model",
              outcome: "success" as const,
              toolCalls: [],
              toolErrorCount: 0,
              toolResultCount: 0,
              usedPrimaryText: true,
            },
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:D_TITLE:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title-1",
        threadId: "slack:D_TITLE:1700000000.000",
        text: "How do I debug memory leaks in Node?",
        isMention: true,
      }),
    );

    await new Promise((r) => setTimeout(r, 0));

    const generatedTitleCall = fakeAdapter.titleCalls.find(
      (c) => c.title !== "Junior",
    );
    expect(generatedTitleCall).toBeDefined();
    expect(generatedTitleCall!.title).toBe("Debugging Node.js Memory Leaks");
    expect(generatedTitleCall!.channelId).toBe("D_TITLE");
    expect(generatedTitleCall!.threadTs).toBe("1700000000.000");
  });

  it("thread title: does not generate title on subsequent replies", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    let turnCount = 0;
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        conversationMemory: {
          completeText: async () =>
            ({
              text: "Some Title",
              message: { role: "assistant", content: "" },
            }) as any,
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            turnCount += 1;
            return {
              text: `reply-${turnCount}`,
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "success" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:D_TITLE2:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t2-1",
        threadId: "slack:D_TITLE2:1700000000.000",
        text: "first message",
        isMention: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const titleCallsAfterFirst = fakeAdapter.titleCalls.filter(
      (c) => c.title !== "Junior",
    ).length;
    expect(titleCallsAfterFirst).toBe(1);

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t2-2",
        threadId: "slack:D_TITLE2:1700000000.000",
        text: "second message",
        isMention: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const titleCallsAfterSecond = fakeAdapter.titleCalls.filter(
      (c) => c.title !== "Junior",
    ).length;
    expect(titleCallsAfterSecond).toBe(1);
  });

  it("thread title: ignores Slack permission errors when setting title", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    fakeAdapter.setAssistantTitle = async () => {
      const error = new Error(
        "An API error occurred: no_permission",
      ) as Error & {
        data?: { error?: string };
      };
      error.data = { error: "no_permission" };
      throw error;
    };
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        conversationMemory: {
          completeText: async () =>
            ({
              text: "Permission Safe Title",
              message: { role: "assistant", content: "" },
            }) as any,
        },
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "This reply should still succeed.",
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "test-model",
              outcome: "success" as const,
              toolCalls: [],
              toolErrorCount: 0,
              toolResultCount: 0,
              usedPrimaryText: true,
            },
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:D_TITLE3:1700000000.000" });

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-title-3",
          threadId: "slack:D_TITLE3:1700000000.000",
          text: "title this thread please",
          isMention: true,
        }),
      ),
    ).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(thread.posts.length).toBeGreaterThan(0);
  });

  it("subscribed message: does not include newer thread messages in turn context", async () => {
    const capturedContexts: Array<string | undefined> = [];
    const { slackRuntime } = createRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () =>
            ({
              object: {
                should_reply: true,
                confidence: 1,
                reason: "follow-up",
              },
              text: '{"should_reply":true,"confidence":1,"reason":"follow-up"}',
            }) as any,
        },
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            capturedContexts.push(context?.conversationContext);
            return {
              text: "Responding to first message only.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "success" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const threadId = "slack:D_ORDER:1700000000.000";
    const thread = createTestThread({ id: threadId });
    const firstMessage = createTestMessage({
      id: "1700000000.100",
      threadId,
      text: "you work now?",
      isMention: false,
    });
    const laterMessage = createTestMessage({
      id: "1700000000.200",
      threadId,
      text: "hello",
      isMention: false,
    });

    Object.defineProperty(thread, "messages", {
      configurable: true,
      get() {
        return (async function* () {
          // Chat SDK thread iterators are newest-first.
          yield laterMessage;
          yield firstMessage;
        })();
      },
    });

    await slackRuntime.handleSubscribedMessage(thread, firstMessage);

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]).not.toContain("hello");
  });

  it("multi-turn state continuity: second turn sees first turn's conversation state", async () => {
    let turnCount = 0;
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            turnCount += 1;
            return {
              text: `reply-${turnCount}`,
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "success" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_MULTI:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t1",
        threadId: "slack:C_MULTI:1700000000.000",
        text: "first turn",
        isMention: true,
      }),
    );

    const stateAfterFirstTurn = thread.getState();
    const conv1 = (
      stateAfterFirstTurn as { conversation?: { messages?: unknown[] } }
    ).conversation;
    expect(conv1).toBeDefined();
    const messageCountAfterFirst = conv1?.messages?.length ?? 0;

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t2",
        threadId: "slack:C_MULTI:1700000000.000",
        text: "second turn",
        isMention: true,
      }),
    );

    const stateAfterSecondTurn = thread.getState();
    const conv2 = (
      stateAfterSecondTurn as { conversation?: { messages?: unknown[] } }
    ).conversation;
    expect(conv2).toBeDefined();
    expect(conv2?.messages?.length ?? 0).toBeGreaterThan(
      messageCountAfterFirst,
    );
  });
});
