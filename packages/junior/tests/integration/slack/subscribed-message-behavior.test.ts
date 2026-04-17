import { describe, expect, it } from "vitest";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
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

    await slackRuntime.handleSubscribedMessage(thread, message);

    expect(classifierCalls).toHaveLength(1);
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

    await slackRuntime.handleSubscribedMessage(thread, message);

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

    await slackRuntime.handleSubscribedMessage(thread, message);

    expect(classifierCalled).toBe(false);
    expect(replyCalls).toHaveLength(1);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("Shipping status is green");
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

    await slackRuntime.handleSubscribedMessage(thread, message);

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

    await slackRuntime.handleSubscribedMessage(thread, message);

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

    await slackRuntime.handleSubscribedMessage(thread, message);

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

    await slackRuntime.handleSubscribedMessage(thread, message);

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
    );

    expect(classifierCalled).toBe(false);
    expect(replyCalls).toContain("which one?");
    expect(thread.posts).toHaveLength(2);
    expect(toPostedText(thread.posts[1])).toContain(
      "billing, auth, and the API gateway",
    );
  });
});
