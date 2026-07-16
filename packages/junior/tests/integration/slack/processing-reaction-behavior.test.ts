import { describe, expect, it } from "vitest";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { flattenAgentRunRequestForTest } from "../../fixtures/agent-runner";

function successDiagnostics(toolCalls: string[] = []) {
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

function reactionCall(name: string, timestamp: string) {
  return expect.objectContaining({
    params: expect.objectContaining({
      channel: "C0PROCESSING",
      timestamp,
      name,
    }),
  });
}

describe("Slack behavior: processing reaction", () => {
  it("adds eyes before mention work and marks the message complete after the reply", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () => {
              expect(slackApiOutbox.reactionAdds()).toHaveLength(1);
              expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
              return completedAgentRun({
                text: "Done.",
                diagnostics: successDiagnostics(),
              });
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C0PROCESSING:1700007000.000000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700007001.000000",
        text: "<@U0APP> handle this",
        isMention: true,
        threadId: thread.id,
        raw: {
          channel: "C0PROCESSING",
          ts: "1700007001.000000",
          thread_ts: "1700007000.000000",
        },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(slackApiOutbox.reactionAdds()).toEqual([
      reactionCall("eyes", "1700007001.000000"),
      reactionCall("white_check_mark", "1700007001.000000"),
    ]);
    expect(slackApiOutbox.reactionRemovals()).toEqual([
      reactionCall("eyes", "1700007001.000000"),
    ]);
  });

  it("does not add eyes when a subscribed message is skipped", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            expect(slackApiOutbox.reactionAdds()).toHaveLength(0);
            expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
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
          agentRunner: {
            run: async () => {
              throw new Error("assistant should not run for skipped message");
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C0PROCESSING:1700007100.000000",
    });
    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "1700007101.000000",
        text: "sounds good, thanks",
        isMention: false,
        threadId: thread.id,
        raw: {
          channel: "C0PROCESSING",
          ts: "1700007101.000000",
          thread_ts: "1700007100.000000",
        },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.posts).toHaveLength(0);
    expect(slackApiOutbox.reactionAdds()).toHaveLength(0);
    expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
  });

  it("adds eyes after a subscribed message is approved and marks the message complete after the reply", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            expect(slackApiOutbox.reactionAdds()).toHaveLength(0);
            expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
            return {
              object: {
                should_reply: true,
                should_unsubscribe: false,
                confidence: 1,
                reason: "direct follow-up",
              },
              text: '{"should_reply":true,"should_unsubscribe":false,"confidence":1,"reason":"direct follow-up"}',
            } as never;
          },
        },
        replyExecutor: {
          agentRunner: {
            run: async () => {
              expect(slackApiOutbox.reactionAdds()).toHaveLength(1);
              expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
              return completedAgentRun({
                text: "Done.",
                diagnostics: successDiagnostics(),
              });
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C0PROCESSING:1700007150.000000",
    });
    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "1700007151.000000",
        text: "can you check this next?",
        isMention: false,
        threadId: thread.id,
        raw: {
          channel: "C0PROCESSING",
          ts: "1700007151.000000",
          thread_ts: "1700007150.000000",
        },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(slackApiOutbox.reactionAdds()).toEqual([
      reactionCall("eyes", "1700007151.000000"),
      reactionCall("white_check_mark", "1700007151.000000"),
    ]);
    expect(slackApiOutbox.reactionRemovals()).toEqual([
      reactionCall("eyes", "1700007151.000000"),
    ]);
  });

  it("does not react to synthetic resource-event notifications", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () => {
              expect(slackApiOutbox.reactionAdds()).toHaveLength(0);
              expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
              return completedAgentRun({
                text: "Done.",
                diagnostics: successDiagnostics(),
              });
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C0PROCESSING:1700007160.000000",
    });
    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "resource-event-resub-1-check-suite-1",
        text: "[event notification]\n\nA subscribed resource changed.",
        isMention: false,
        threadId: thread.id,
        author: {
          userId: "UJRNEVENT",
          userName: "junior-event",
          fullName: "Junior event",
          isBot: true,
        },
        raw: {
          channel: "C0PROCESSING",
          event_type: "resource_event",
          thread_ts: "1700007160.000000",
          // Historical malformed records used the synthetic mailbox id as raw.ts.
          // It must still never be treated as a Slack Web API message target.
          ts: "resource-event-resub-1-check-suite-1",
          type: "message",
          user: "UJRNEVENT",
        },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.posts).toHaveLength(1);
    expect(slackApiOutbox.reactionAdds()).toHaveLength(0);
    expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
  });

  it("keeps eyes when the assistant explicitly adds an eyes reaction", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const _prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              context?.onToolInvocation?.({
                toolName: "addReaction",
                params: { emoji: ":eyes:" },
              });
              return completedAgentRun({
                text: "Done.",
                diagnostics: successDiagnostics(["addReaction"]),
              });
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C0PROCESSING:1700007200.000000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700007201.000000",
        text: "<@U0APP> add eyes to this",
        isMention: true,
        threadId: thread.id,
        raw: {
          channel: "C0PROCESSING",
          ts: "1700007201.000000",
          thread_ts: "1700007200.000000",
        },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(slackApiOutbox.reactionAdds()).toHaveLength(1);
    expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
  });

  it("clears eyes and marks complete for reaction-only no-reply turns", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              context?.onToolInvocation?.({
                toolName: "addReaction",
                params: { emoji: ":heart:" },
              });
              return completedAgentRun({
                text: "",
                deliveryPlan: {
                  mode: "thread",
                  postThreadText: false,
                },
                diagnostics: successDiagnostics(["addReaction"]),
              });
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C0PROCESSING:1700007300.000000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700007301.000000",
        text: "<@U0APP> give me a heart reaction",
        isMention: true,
        threadId: thread.id,
        raw: {
          channel: "C0PROCESSING",
          ts: "1700007301.000000",
          thread_ts: "1700007300.000000",
        },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(slackApiOutbox.reactionAdds()).toEqual([
      reactionCall("eyes", "1700007301.000000"),
      reactionCall("white_check_mark", "1700007301.000000"),
    ]);
    expect(slackApiOutbox.reactionRemovals()).toEqual([
      reactionCall("eyes", "1700007301.000000"),
    ]);
    expect(thread.posts).toHaveLength(0);
  });
});
