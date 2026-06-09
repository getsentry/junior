import { describe, expect, it, vi } from "vitest";
import { TurnInputCommitLostError } from "@/chat/runtime/turn";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { createProviderError } from "@/chat/services/provider-retry";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";

const emptyThreadReplies = async () => [];

function createRuntime(
  args: {
    services?: JuniorRuntimeServiceOverrides;
  } = {},
) {
  const services = args.services ?? {};
  return createTestChatRuntime({
    services: {
      ...services,
      visionContext: {
        listThreadReplies: emptyThreadReplies,
        ...(services.visionContext ?? {}),
      },
    },
  });
}

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

describe("Slack behavior: subscribed messages", () => {
  it("skips reply when classifier says not to reply", async () => {
    const classifierCalls: string[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async (params: { prompt?: unknown }) => {
            classifierCalls.push(String(params.prompt));
            return {
              object: {
                should_reply: false,
                confidence: 0,
                reason: "side conversation",
              },
              text: '{"should_reply":false,"confidence":0,"reason":"side conversation"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            throw new Error(
              "generateAssistantReply should not run when classifier skips reply",
            );
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002000.000" });
    const message = createTestMessage({
      id: "m-subscribed-skip",
      text: "sounds good thanks everyone",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleSubscribedMessage(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(classifierCalls).toHaveLength(1);
    expect(thread.posts).toHaveLength(0);
  });

  it("rethrows retryable classifier provider errors for durable retry", async () => {
    const providerError = createProviderError(
      new Error("Anthropic stream ended before message_stop"),
    );

    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            throw providerError;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            throw new Error("generateAssistantReply should not run");
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002000.001" });
    const message = createTestMessage({
      id: "m-subscribed-provider-retry",
      text: "can you check this?",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await expect(
      slackRuntime.handleSubscribedMessage(thread, message, {
        destination: createTestDestination(thread),
      }),
    ).rejects.toBe(providerError);
    expect(thread.posts).toHaveLength(0);
  });

  it("replies when classifier approves a subscribed-thread message", async () => {
    const classifierCalls: string[] = [];
    const replyCalls: string[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async (params: { prompt?: unknown }) => {
            classifierCalls.push(String(params.prompt));
            return {
              object: {
                should_reply: true,
                confidence: 1,
                reason: "explicit ask",
              },
              text: '{"should_reply":true,"confidence":1,"reason":"explicit ask"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async (prompt) => {
            replyCalls.push(prompt);
            return {
              text: "Action item captured: monitor dashboards for 30 minutes.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002001.000" });
    const message = createTestMessage({
      id: "m-subscribed-reply",
      text: "can you suggest one concrete next step?",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleSubscribedMessage(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(classifierCalls).toHaveLength(1);
    expect(replyCalls).toHaveLength(1);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("monitor dashboards");
  });

  it("replies directly to explicit mentions in subscribed threads", async () => {
    let classifierCalled = false;
    const replyCalls: string[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            return {
              object: {
                should_reply: true,
                confidence: 1,
                reason: "direct mention asking junior for status",
              },
              text: '{"should_reply":true,"confidence":1,"reason":"direct mention asking junior for status"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async (prompt) => {
            replyCalls.push(prompt);
            return {
              text: "Yes. Shipping status is green.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002002.000" });
    const message = createTestMessage({
      id: "m-subscribed-mention",
      text: "<@U_APP> quick status?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleSubscribedMessage(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(classifierCalled).toBe(false);
    expect(replyCalls).toHaveLength(1);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("Shipping status is green");
  });

  it("treats queued explicit mentions as part of the subscribed turn", async () => {
    let classifierCalled = false;
    const replyCalls: string[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            throw new Error(
              "classifier should be bypassed for queued explicit mentions",
            );
          },
        },
        replyExecutor: {
          generateAssistantReply: async (prompt) => {
            replyCalls.push(prompt);
            return {
              text: "Handled queued subscribed turn.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
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
      id: "slack:C_BEHAVIOR:1700002002.250",
    });
    const queued = createTestMessage({
      id: "m-subscribed-queued-mention",
      text: "<@U_APP> first queued request",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });
    const latest = createTestMessage({
      id: "m-subscribed-queued-latest",
      text: "latest follow-up",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleSubscribedMessage(thread, latest, {
      destination: createTestDestination(thread),
      messageContext: {
        skipped: [queued],
        totalSinceLastHandler: 2,
      },
    });

    expect(classifierCalled).toBe(false);
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]).toContain("first queued request");
    expect(replyCalls[0]).toContain("latest follow-up");
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "Handled queued subscribed turn.",
    );
  });

  it("unsubscribes on explicit stop-thread instructions and only re-engages on a later direct mention", async () => {
    let classifierCalled = false;
    const replyCalls: string[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            return {
              object: {
                should_reply: false,
                should_unsubscribe: true,
                confidence: 1,
                reason:
                  "user explicitly asked junior to stop participating in the thread",
              },
              text: '{"should_reply":false,"should_unsubscribe":true,"confidence":1,"reason":"user explicitly asked junior to stop participating in the thread"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async (prompt) => {
            replyCalls.push(prompt);
            return {
              text:
                replyCalls.length === 1
                  ? "I can help with this thread."
                  : "I'm back because you mentioned me again.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002002.500" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stop-thread-initial",
        text: "<@U_APP> can you help here?",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.subscribed).toBe(true);

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-stop-thread-opt-out",
        text: "<@U_APP> stop watching or participating in this thread",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(classifierCalled).toBe(false);
    expect(replyCalls).toHaveLength(1);
    expect(thread.subscribed).toBe(false);
    expect(toPostedText(thread.posts[1])).toContain(
      "I'll stay out of this thread unless someone @mentions me again.",
    );

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stop-thread-remention",
        text: "<@U_APP> actually, can you jump back in?",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(replyCalls).toHaveLength(2);
    expect(thread.subscribed).toBe(true);
    expect(toPostedText(thread.posts[2])).toContain(
      "I'm back because you mentioned me again.",
    );
  });

  it("short-circuits acknowledgment messages without calling the classifier", async () => {
    let classifierCalled = false;
    let replyCalled = false;

    const { slackRuntime } = createRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            throw new Error(
              "classifier should be bypassed for acknowledgments",
            );
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCalled = true;
            return {
              text: "This should never be posted.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002003.000" });
    const message = createTestMessage({
      id: "m-subscribed-ack",
      text: "thanks!",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleSubscribedMessage(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(classifierCalled).toBe(false);
    expect(replyCalled).toBe(false);
    expect(thread.posts).toHaveLength(0);
  });

  it("routes acknowledgment text with attachments through the classifier", async () => {
    let classifierCalled = false;
    let replyCalled = false;

    const { slackRuntime } = createRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            return {
              object: {
                should_reply: false,
                confidence: 0.95,
                reason: "attachment acknowledgment",
              },
              text: '{"should_reply":false,"confidence":0.95,"reason":"attachment acknowledgment"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCalled = true;
            return {
              text: "This should never be posted.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002003.125" });
    const message = createTestMessage({
      id: "m-subscribed-ack-attachment",
      text: "thanks!",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
      attachments: [
        {
          type: "image",
          url: "https://example.com/chart.png",
        },
      ],
    });

    await slackRuntime.handleSubscribedMessage(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(classifierCalled).toBe(true);
    expect(replyCalled).toBe(false);
    expect(thread.posts).toHaveLength(0);
  });

  it("routes attachment-only passive messages through the classifier", async () => {
    let classifierCalled = false;
    let replyCalled = false;

    const { slackRuntime } = createRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            return {
              object: {
                should_reply: false,
                confidence: 0.95,
                reason: "passive attachment",
              },
              text: '{"should_reply":false,"confidence":0.95,"reason":"passive attachment"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCalled = true;
            return {
              text: "This should never be posted.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002003.250" });
    const message = createTestMessage({
      id: "m-subscribed-attachment-only",
      text: "",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
      attachments: [
        {
          type: "image",
          url: "https://example.com/chart.png",
        },
      ],
    });

    await slackRuntime.handleSubscribedMessage(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(classifierCalled).toBe(true);
    expect(replyCalled).toBe(false);
    expect(thread.posts).toHaveLength(0);
  });

  it("routes legacy attachment-only passive messages through the classifier", async () => {
    let classifierCalled = false;
    let replyCalled = false;

    const { slackRuntime } = createRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async (args) => {
            classifierCalled = true;
            expect(args.prompt).toContain("Deploy failed");
            expect(args.prompt).toContain("Service: checkout");
            return {
              object: {
                should_reply: false,
                confidence: 0.95,
                reason: "passive legacy attachment",
              },
              text: '{"should_reply":false,"confidence":0.95,"reason":"passive legacy attachment"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCalled = true;
            return {
              text: "This should never be posted.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002003.275" });
    const message = createTestMessage({
      id: "m-subscribed-legacy-attachment-only",
      text: "",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
      raw: {
        channel: "C_BEHAVIOR",
        ts: "1700002003.275",
        thread_ts: "1700002003.275",
        attachments: [
          {
            fallback: "Deploy failed",
            fields: [{ title: "Service", value: "checkout" }],
          },
        ],
      },
    });

    await slackRuntime.handleSubscribedMessage(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(classifierCalled).toBe(true);
    expect(replyCalled).toBe(false);
    expect(thread.posts).toHaveLength(0);
  });

  it("short-circuits generic immediate side-conversation questions without calling the classifier", async () => {
    let classifierCalled = false;
    let replyCalled = false;

    const { slackRuntime } = createRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            throw new Error(
              "classifier should be bypassed for generic immediate side conversation",
            );
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCalled = true;
            return {
              text: "This should never be posted.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002003.300" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-subscribed-generic-side-1",
        text: "<@U_APP> summarize the deploy",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );
    replyCalled = false;

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-subscribed-generic-side-2",
        text: "can you check on this?",
        isMention: false,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(classifierCalled).toBe(false);
    expect(replyCalled).toBe(false);
    expect(thread.posts).toHaveLength(1);
  });

  it("routes generic immediate attachment follow-ups through the classifier", async () => {
    let classifierCalled = false;
    let replyCalled = false;

    const { slackRuntime } = createRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            return {
              object: {
                should_reply: false,
                confidence: 0.95,
                reason: "attachment follow-up",
              },
              text: '{"should_reply":false,"confidence":0.95,"reason":"attachment follow-up"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCalled = true;
            return {
              text: "This should never be posted.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002003.350" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-subscribed-generic-side-attachment-1",
        text: "<@U_APP> summarize the deploy",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );
    replyCalled = false;

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-subscribed-generic-side-attachment-2",
        text: "can you check on this?",
        isMention: false,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
        attachments: [
          {
            type: "image",
            url: "https://example.com/screenshot.png",
          },
        ],
      }),
      { destination: createTestDestination(thread) },
    );

    expect(classifierCalled).toBe(true);
    expect(replyCalled).toBe(false);
    expect(thread.posts).toHaveLength(1);
  });

  it("stays silent when a subscribed message is clearly directed at another bot", async () => {
    let classifierCalled = false;
    let replyCalled = false;

    const { slackRuntime } = createRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            throw new Error(
              "classifier should be bypassed for messages addressed to another bot",
            );
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCalled = true;
            return {
              text: "This should never be posted.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002003.500" });
    const message = createTestMessage({
      id: "m-subscribed-other-bot",
      text: "@Cursor can you help address issue 87?",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleSubscribedMessage(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(classifierCalled).toBe(false);
    expect(replyCalled).toBe(false);
    expect(thread.posts).toHaveLength(0);
    const state = (await thread.state) ?? {};
    const conversation = (state.conversation ?? {}) as {
      messages?: Array<{
        id: string;
        text: string;
        meta?: { replied?: boolean; skippedReason?: string };
      }>;
      processing?: { lastCompletedAtMs?: number };
    };
    expect(conversation.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "m-subscribed-other-bot",
          text: "@Cursor can you help address issue 87?",
          meta: expect.objectContaining({
            replied: false,
            skippedReason: "directed_to_other_party:named_mention:Cursor",
          }),
        }),
      ]),
    );
    expect(conversation.processing?.lastCompletedAtMs).toEqual(
      expect.any(Number),
    );
  });

  it("replies immediately to directed follow-up questions after junior just spoke", async () => {
    let classifierCalled = false;
    const replyCalls: string[] = [];

    const { slackRuntime } = createRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            return {
              object: {
                should_reply: true,
                confidence: 0.95,
                reason: "follow-up directed at assistant's previous response",
              },
              text: '{"should_reply":true,"confidence":0.95,"reason":"follow-up directed at assistant\'s previous response"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async (prompt) => {
            replyCalls.push(prompt);
            return {
              text: "You asked for the budget by Friday.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002004.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-subscribed-followup-1",
        text: "<@U_APP> I need the budget by Friday",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-subscribed-followup-2",
        text: "what did you just say about the budget?",
        isMention: false,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(classifierCalled).toBe(false);
    expect(replyCalls).toContain("what did you just say about the budget?");
    expect(thread.posts).toHaveLength(2);
    expect(toPostedText(thread.posts[1])).toContain("budget by Friday");
  });

  it("replies immediately to terse clarifications after junior just spoke", async () => {
    let classifierCalled = false;
    const replyCalls: string[] = [];

    const { slackRuntime } = createRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            return {
              object: {
                should_reply: true,
                confidence: 0.65,
                reason: "brief clarification after assistant reply",
              },
              text: '{"should_reply":true,"confidence":0.65,"reason":"brief clarification after assistant reply"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async (prompt) => {
            replyCalls.push(prompt);
            return {
              text:
                replyCalls.length === 1
                  ? "The deploy changed billing, auth, and the API gateway."
                  : "The three services were billing, auth, and the API gateway.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002004.500" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-subscribed-low-confidence-followup-1",
        text: "<@U_APP> what changed in the deploy?",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-subscribed-low-confidence-followup-2",
        text: "which one?",
        isMention: false,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(classifierCalled).toBe(false);
    expect(replyCalls).toContain("which one?");
    expect(thread.posts).toHaveLength(2);
    expect(toPostedText(thread.posts[1])).toContain(
      "billing, auth, and the API gateway",
    );
  });

  // Regression: skipped subscribed messages must commit inbound input so the
  // durable mailbox does not re-enqueue them forever.
  it("calls onInputCommitted when preflight skips a message directed at another user", async () => {
    const { slackRuntime } = createRuntime();
    const onInputCommitted = vi.fn().mockResolvedValue(undefined);
    const thread = createTestThread({ id: "slack:C_REGRESS:1700010000.001" });

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-preflight-skip",
        text: "@Alice can you take a look at this?",
        isMention: false,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread), onInputCommitted },
    );

    expect(onInputCommitted).toHaveBeenCalledTimes(1);
    expect(thread.posts).toHaveLength(0);
  });

  it("preserves an unrelated active continuation when preflight skips a message", async () => {
    const { slackRuntime } = createRuntime();
    const onInputCommitted = vi.fn().mockResolvedValue(undefined);
    const activeTurnId = "turn_existing_resume";
    const thread = createTestThread({
      id: "slack:C_REGRESS:1700010000.005",
      state: {
        conversation: {
          processing: {
            activeTurnId,
          },
        },
      },
    });

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-preflight-skip-while-resuming",
        text: "@Alice can you take this one?",
        isMention: false,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread), onInputCommitted },
    );

    const state = (await thread.state) ?? {};
    const conversation = state.conversation as {
      processing?: { activeTurnId?: string };
    };
    expect(onInputCommitted).toHaveBeenCalledTimes(1);
    expect(conversation.processing?.activeTurnId).toBe(activeTurnId);
    expect(thread.posts).toHaveLength(0);
  });

  it("calls onInputCommitted when the classifier decides not to reply", async () => {
    const { slackRuntime } = createRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () =>
            ({
              object: {
                should_reply: false,
                confidence: 0.9,
                reason: "side conversation",
              },
              text: '{"should_reply":false,"confidence":0.9,"reason":"side conversation"}',
            }) as never,
        },
      },
    });
    const onInputCommitted = vi.fn().mockResolvedValue(undefined);
    const thread = createTestThread({ id: "slack:C_REGRESS:1700010000.002" });

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-classifier-skip",
        text: "sounds good, let's ship it",
        isMention: false,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread), onInputCommitted },
    );

    expect(onInputCommitted).toHaveBeenCalledTimes(1);
    expect(thread.posts).toHaveLength(0);
  });

  it("calls onInputCommitted on the opt-out skip path", async () => {
    const { slackRuntime } = createRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () =>
            ({
              object: {
                should_reply: false,
                should_unsubscribe: true,
                confidence: 1,
                reason: "explicit stop",
              },
              text: '{"should_reply":false,"should_unsubscribe":true,"confidence":1,"reason":"explicit stop"}',
            }) as never,
        },
      },
    });
    const onInputCommitted = vi.fn().mockResolvedValue(undefined);
    const thread = createTestThread({ id: "slack:C_REGRESS:1700010000.003" });
    // Subscribe first so opt-out has something to unsubscribe from.
    thread.subscribe();

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-optout-skip",
        text: "<@U_APP> please stop watching this thread",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
      { destination: createTestDestination(thread), onInputCommitted },
    );

    expect(onInputCommitted).toHaveBeenCalledTimes(1);
  });

  it("propagates TurnInputCommitLostError when onInputCommitted fails on skip", async () => {
    const { slackRuntime } = createRuntime();
    const commitError = new TurnInputCommitLostError(
      "lease lost during skip commit",
    );
    const onInputCommitted = vi.fn().mockRejectedValue(commitError);
    const thread = createTestThread({ id: "slack:C_REGRESS:1700010000.004" });

    await expect(
      slackRuntime.handleSubscribedMessage(
        thread,
        createTestMessage({
          id: "m-commit-lost",
          text: "@Alice handle this please",
          isMention: false,
          threadId: thread.id,
          author: { userId: "U_TESTER" },
        }),
        { destination: createTestDestination(thread), onInputCommitted },
      ),
    ).rejects.toThrow(TurnInputCommitLostError);
  });
});
