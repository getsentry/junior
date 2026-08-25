import { describe, expect, it, vi } from "vitest";
import { TurnInputCommitLostError } from "@/chat/runtime/turn";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { createProviderError } from "@/chat/services/provider-error";
import type { AgentRun } from "@/chat/agent/types";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  createResourceEventSubscription,
  listResourceEventSubscriptions,
} from "@/chat/resource-events/store";
import {
  createModelAgentRunnerForRun,
  neverRunAgentRunner,
} from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";

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

function replyForRun(selectText: (run: AgentRun) => string) {
  return createModelAgentRunnerForRun((run) =>
    createModelStream([{ type: "text", text: selectText(run) }]),
  );
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
        agentRunner: neverRunAgentRunner(),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002000.000",
    });
    const message = createTestMessage({
      id: "m-subscribed-skip",
      text: "sounds good thanks everyone",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
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
        agentRunner: neverRunAgentRunner(),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002000.001",
    });
    const message = createTestMessage({
      id: "m-subscribed-provider-retry",
      text: "can you check this?",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
    });

    await expect(
      slackRuntime.handleSubscribedMessage(thread, message, {
        destination: createTestDestination(thread),
      }),
    ).rejects.toBe(providerError);
    expect(thread.posts).toHaveLength(0);
  });

  it("runs resource-event notifications as system actor turns", async () => {
    let classifierCalled = false;
    const agentRuns: AgentRun[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            throw new Error("resource events bypass subscribed classifier");
          },
        },
        agentRunner: replyForRun((run) => {
          agentRuns.push(run);
          return "I checked the subscribed PR event.\nThe PR is merged.";
        }),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002000.002",
    });
    const message = createTestMessage({
      id: "resource-event-resub-1-check-suite-1",
      text: "[event notification]\n\nA subscribed resource changed.\n\nHandling:\n- Stay concise.",
      isMention: false,
      threadId: thread.id,
      author: {
        userId: "UJRNEVENT",
        userName: "junior-event",
        fullName: "Junior event",
        isBot: true,
      },
      raw: {
        channel: "C0BEHAVIOR",
        event_type: "resource_event",
        thread_ts: "1700002000.002",
        ts: "resource-event-resub-1-check-suite-1",
        type: "message",
        user: "UJRNEVENT",
      },
    });

    await slackRuntime.handleSubscribedMessage(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(classifierCalled).toBe(false);
    expect(agentRuns).toEqual([
      expect.objectContaining({
        conversationId: "slack:C0BEHAVIOR:1700002000.002",
        turnId: "turn_resource-event-resub-1-check-suite-1",
        credentialContext: {
          actor: { platform: "system", name: "resource-event" },
        },
        actor: { platform: "system", name: "resource-event" },
      }),
    ]);
    expect(thread.posts).toHaveLength(1);
    const conversation = coerceThreadConversationState(
      (await thread.state) ?? {},
    );
    await hydrateConversationMessages({
      conversation,
      conversationId: thread.id,
    });
    expect(conversation.messages).toContainEqual(
      expect.objectContaining({
        id: "resource-event-resub-1-check-suite-1",
        text: "[event notification]\n\nA subscribed resource changed.\n\nHandling:\n- Stay concise.",
      }),
    );
    expect(conversation.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        text: "I checked the subscribed PR event.\nThe PR is merged.",
      }),
    );
  });

  it("processes resource events when compacted history retains a handled marker without its message", async () => {
    const agentRuns: AgentRun[] = [];
    const agentRunner = replyForRun((run) => {
      agentRuns.push(run);
      return "I processed the recovered check event.";
    });
    const { slackRuntime } = createRuntime({
      services: {
        agentRunner,
      },
    });
    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002000.0025",
    });
    const destination = createTestDestination(thread);
    await getConversationStore().recordActivity({
      conversationId: thread.id,
      destination,
      nowMs: 1_000,
      source: "resource_event",
      visibility: "private",
    });
    // Late delivery state remains valid after its covered message falls before
    // the readable compaction boundary.
    await getConversationEventStore().append(thread.id, [
      {
        data: {
          type: "message",
          messageId: "compacted-user-message",
          role: "user",
          text: "Old request that has already been summarized.",
        },
        createdAtMs: 1_000,
      },
      {
        data: {
          type: "messages_summarized",
          historyFromSeq: 2,
          compactions: [
            {
              id: "compaction-1",
              summary: "The old request was completed.",
              coveredMessageCount: 1,
              createdAtMs: 2_000,
            },
          ],
        },
        createdAtMs: 2_000,
      },
      {
        data: {
          type: "message_handled",
          messageId: "compacted-user-message",
        },
        createdAtMs: 3_000,
      },
    ]);

    const message = createTestMessage({
      id: "resource-event-resub-checks-recovered",
      text: "[event notification]\n\nThe subscribed check recovered.",
      isMention: false,
      threadId: thread.id,
      author: {
        userId: "UJRNEVENT",
        userName: "junior-event",
        fullName: "Junior event",
        isBot: true,
      },
      raw: {
        channel: "C0BEHAVIOR",
        event_type: "resource_event",
        thread_ts: "1700002000.0025",
        ts: "resource-event-resub-checks-recovered",
        type: "message",
        user: "UJRNEVENT",
      },
    });

    await slackRuntime.handleSubscribedMessage(thread, message, {
      destination,
    });

    expect(agentRuns).toHaveLength(1);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "I processed the recovered check event.",
    );
    const conversation = coerceThreadConversationState(
      (await thread.state) ?? {},
    );
    await hydrateConversationMessages({
      conversation,
      conversationId: thread.id,
    });
    expect(conversation.messages).not.toContainEqual(
      expect.objectContaining({ id: "compacted-user-message" }),
    );
    expect(conversation.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "resource-event-resub-checks-recovered",
          role: "user",
        }),
        expect.objectContaining({
          role: "assistant",
          text: "I processed the recovered check event.",
        }),
      ]),
    );
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
                should_unsubscribe: false,
                confidence: 1,
                reason: "explicit ask",
              },
              text: '{"should_reply":true,"should_unsubscribe":false,"confidence":1,"reason":"explicit ask"}',
            } as never;
          },
        },
        agentRunner: replyForRun((run) => {
          replyCalls.push(run.instruction.text);
          return "Action item captured: monitor dashboards for 30 minutes.";
        }),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002001.000",
    });
    const message = createTestMessage({
      id: "m-subscribed-reply",
      text: "can you suggest one concrete next step?",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
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
        agentRunner: replyForRun((run) => {
          replyCalls.push(run.instruction.text);
          return "Yes. Shipping status is green.";
        }),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002002.000",
    });
    const message = createTestMessage({
      id: "m-subscribed-mention",
      text: "<@U0APP> quick status?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
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
    const replyCalls: Array<{ piMessages?: unknown[]; prompt: string }> = [];

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
        agentRunner: replyForRun((run) => {
          replyCalls.push({
            prompt: run.instruction.text,
            piMessages: run.history ? [...run.history] : undefined,
          });
          return "Handled queued subscribed turn.";
        }),
      },
    });
    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002002.250",
    });
    const queued = createTestMessage({
      id: "m-subscribed-queued-mention",
      text: "<@U0APP> first queued request",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
    });
    const latest = createTestMessage({
      id: "m-subscribed-queued-latest",
      text: "latest follow-up",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
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
    expect(replyCalls[0]?.prompt).toContain("latest follow-up");
    expect(replyCalls[0]?.prompt).not.toContain("first queued request");
    expect(JSON.stringify(replyCalls[0]?.piMessages)).toContain(
      "first queued request",
    );
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "Handled queued subscribed turn.",
    );
  });

  it("forces unsubscribe on !stop and only re-engages on a later direct mention", async () => {
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
        agentRunner: replyForRun((run) => {
          replyCalls.push(run.instruction.text);
          return replyCalls.length === 1
            ? "I can help with this thread."
            : "I'm back because you mentioned me again.";
        }),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002002.500",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stop-thread-initial",
        text: "<@U0APP> can you help here?",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.subscribed).toBe(true);

    const subscriptionDestination = createTestDestination(thread);
    const expiresAtMs = Date.now() + 60_000;
    await createResourceEventSubscription({
      conversationId: thread.id,
      destination: subscriptionDestination,
      events: ["pull_request.checks.failed"],
      expiresAtMs,
      intent: "Watch CI for this thread.",
      label: "Pull request checks",
      namespace: "github",
      identifier: "getsentry/junior#100",
      resourceType: "pull_request",
    });
    await createResourceEventSubscription({
      conversationId: thread.id,
      destination: subscriptionDestination,
      events: ["issue.closed"],
      expiresAtMs,
      intent: "Watch the issue for this thread.",
      label: "Tracking issue",
      namespace: "github",
      identifier: "getsentry/junior#101",
      resourceType: "issue",
    });

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-stop-thread-opt-out",
        text: "!stop",
        isMention: false,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(classifierCalled).toBe(false);
    expect(replyCalls).toHaveLength(1);
    expect(thread.subscribed).toBe(false);
    await expect(
      listResourceEventSubscriptions({ conversationId: thread.id }),
    ).resolves.toEqual([]);
    expect(toPostedText(thread.posts[1])).toContain(
      "I'll stay out of this thread unless someone @mentions me again.",
    );

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stop-thread-remention",
        text: "<@U0APP> actually, can you jump back in?",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
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
        agentRunner: neverRunAgentRunner(),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002003.000",
    });
    const message = createTestMessage({
      id: "m-subscribed-ack",
      text: "thanks!",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
    });

    await slackRuntime.handleSubscribedMessage(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(classifierCalled).toBe(false);
    expect(thread.posts).toHaveLength(0);
  });

  it("routes acknowledgment text with attachments through the classifier", async () => {
    let classifierCalled = false;

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
        agentRunner: neverRunAgentRunner(),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002003.125",
    });
    const message = createTestMessage({
      id: "m-subscribed-ack-attachment",
      text: "thanks!",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
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
    expect(thread.posts).toHaveLength(0);
  });

  it("routes attachment-only passive messages through the classifier", async () => {
    let classifierCalled = false;

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
        agentRunner: neverRunAgentRunner(),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002003.250",
    });
    const message = createTestMessage({
      id: "m-subscribed-attachment-only",
      text: "",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
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
    expect(thread.posts).toHaveLength(0);
  });

  it("routes legacy attachment-only passive messages through the classifier", async () => {
    let classifierCalled = false;

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
        agentRunner: neverRunAgentRunner(),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002003.275",
    });
    const message = createTestMessage({
      id: "m-subscribed-legacy-attachment-only",
      text: "",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
      raw: {
        channel: "C0BEHAVIOR",
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
    expect(thread.posts).toHaveLength(0);
  });

  it("routes generic immediate follow-up questions through the classifier", async () => {
    let classifierCalled = false;
    const agentRuns: AgentRun[] = [];

    const { slackRuntime } = createRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            return {
              object: {
                should_reply: false,
                confidence: 0.95,
                reason: "human side conversation",
              },
              text: '{"should_reply":false,"confidence":0.95,"reason":"human side conversation"}',
            } as never;
          },
        },
        agentRunner: replyForRun((run) => {
          agentRuns.push(run);
          return "Deploy summarized.";
        }),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002003.300",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-subscribed-generic-side-1",
        text: "<@U0APP> summarize the deploy",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-subscribed-generic-side-2",
        text: "can you check on this?",
        isMention: false,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(classifierCalled).toBe(true);
    expect(agentRuns).toHaveLength(1);
    expect(thread.posts).toHaveLength(1);
  });

  it("routes generic immediate attachment follow-ups through the classifier", async () => {
    let classifierCalled = false;
    const agentRuns: AgentRun[] = [];

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
        agentRunner: replyForRun((run) => {
          agentRuns.push(run);
          return "Deploy summarized.";
        }),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002003.350",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-subscribed-generic-side-attachment-1",
        text: "<@U0APP> summarize the deploy",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
      }),
      { destination: createTestDestination(thread) },
    );

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-subscribed-generic-side-attachment-2",
        text: "can you check on this?",
        isMention: false,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
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
    expect(agentRuns).toHaveLength(1);
    expect(thread.posts).toHaveLength(1);
  });

  it("stays silent when a subscribed message is clearly directed at another bot", async () => {
    let classifierCalled = false;

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
        agentRunner: neverRunAgentRunner(),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002003.500",
    });
    const message = createTestMessage({
      id: "m-subscribed-other-bot",
      text: "@Cursor can you help address issue 87?",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
    });

    await slackRuntime.handleSubscribedMessage(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(classifierCalled).toBe(false);
    expect(thread.posts).toHaveLength(0);
    const conversation = coerceThreadConversationState(
      (await thread.state) ?? {},
    );
    await hydrateConversationMessages({
      conversation,
      conversationId: thread.id,
    });
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
        agentRunner: replyForRun((run) => {
          replyCalls.push(run.instruction.text);
          return "You asked for the budget by Friday.";
        }),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002004.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-subscribed-followup-1",
        text: "<@U0APP> I need the budget by Friday",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
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
        author: { userId: "U0TESTER" },
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
        agentRunner: replyForRun((run) => {
          replyCalls.push(run.instruction.text);
          return replyCalls.length === 1
            ? "The deploy changed billing, auth, and the API gateway."
            : "The three services were billing, auth, and the API gateway.";
        }),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700002004.500",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-subscribed-low-confidence-followup-1",
        text: "<@U0APP> what changed in the deploy?",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
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
        author: { userId: "U0TESTER" },
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
  it("calls ack when preflight skips a message directed at another user", async () => {
    const { slackRuntime } = createRuntime();
    const ack = vi.fn().mockResolvedValue(undefined);
    const thread = await createTestThread({
      id: "slack:C0REGRESS:1700010000.001",
    });

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-preflight-skip",
        text: "@Alice can you take a look at this?",
        isMention: false,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
      }),
      { destination: createTestDestination(thread), ack },
    );

    expect(ack).toHaveBeenCalledTimes(1);
    expect(thread.posts).toHaveLength(0);
  });

  it("preserves an unrelated active continuation when preflight skips a message", async () => {
    const { slackRuntime } = createRuntime();
    const ack = vi.fn().mockResolvedValue(undefined);
    const activeTurnId = "turn_existing_resume";
    const thread = await createTestThread({
      id: "slack:C0REGRESS:1700010000.005",
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
        author: { userId: "U0TESTER" },
      }),
      { destination: createTestDestination(thread), ack },
    );

    const state = (await thread.state) ?? {};
    const conversation = state.conversation as {
      processing?: { activeTurnId?: string };
    };
    expect(ack).toHaveBeenCalledTimes(1);
    expect(conversation.processing?.activeTurnId).toBe(activeTurnId);
    expect(thread.posts).toHaveLength(0);
  });

  it("calls ack when the classifier decides not to reply", async () => {
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
    const ack = vi.fn().mockResolvedValue(undefined);
    const thread = await createTestThread({
      id: "slack:C0REGRESS:1700010000.002",
    });

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-classifier-skip",
        text: "sounds good, let's ship it",
        isMention: false,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
      }),
      { destination: createTestDestination(thread), ack },
    );

    expect(ack).toHaveBeenCalledTimes(1);
    expect(thread.posts).toHaveLength(0);
  });

  it("calls ack on the opt-out skip path", async () => {
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
    const ack = vi.fn().mockResolvedValue(undefined);
    const thread = await createTestThread({
      id: "slack:C0REGRESS:1700010000.003",
    });
    // Subscribe first so opt-out has something to unsubscribe from.
    thread.subscribe();

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-optout-skip",
        text: "<@U0APP> please stop watching this thread",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U0TESTER" },
      }),
      { destination: createTestDestination(thread), ack },
    );

    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("propagates TurnInputCommitLostError when ack fails on skip", async () => {
    const { slackRuntime } = createRuntime();
    const commitError = new TurnInputCommitLostError(
      "lease lost during skip commit",
    );
    const ack = vi.fn().mockRejectedValue(commitError);
    const thread = await createTestThread({
      id: "slack:C0REGRESS:1700010000.004",
    });

    await expect(
      slackRuntime.handleSubscribedMessage(
        thread,
        createTestMessage({
          id: "m-commit-lost",
          text: "@Alice handle this please",
          isMention: false,
          threadId: thread.id,
          author: { userId: "U0TESTER" },
        }),
        { destination: createTestDestination(thread), ack },
      ),
    ).rejects.toThrow(TurnInputCommitLostError);
  });
});
