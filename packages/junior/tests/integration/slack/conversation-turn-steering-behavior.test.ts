import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StateAdapter } from "chat";
import {
  SLACK_BOT_USER_ID,
  SLACK_SIGNING_SECRET,
  createConversationWorkQueueTestAdapter,
  deferred,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { resetSlackApiMockState } from "../../msw/handlers/slack-api";
import { createSlackRuntime } from "@/chat/app/factory";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import type { ReplyExecutorServices } from "@/chat/runtime/reply-executor";
import type { ReplySteeringMessage } from "@/chat/respond";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import {
  countPendingConversationMessages,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";

const CHANNEL_ID = "CSTEER";
const THREAD_TS = "1712345.000100";

function makeMessageEvent(args: {
  eventType: "app_mention" | "message";
  text: string;
  ts: string;
}) {
  return slackEnvelope({
    channel: CHANNEL_ID,
    eventType: args.eventType,
    text: args.text,
    threadTs: args.ts === THREAD_TS ? undefined : THREAD_TS,
    ts: args.ts,
  });
}

function makeDiagnostics() {
  return {
    assistantMessageCount: 1,
    modelId: "fake-agent-model",
    outcome: "success" as const,
    toolCalls: [],
    toolErrorCount: 0,
    toolResultCount: 0,
    usedPrimaryText: true,
  };
}

function reactionTargets(
  calls: ReturnType<typeof slackApiOutbox.reactionAdds>,
) {
  return calls
    .map((call) => ({
      channel: call.params.channel,
      name: call.params.name,
      timestamp: call.params.timestamp,
    }))
    .sort((left, right) =>
      `${left.channel}:${left.timestamp}:${left.name}`.localeCompare(
        `${right.channel}:${right.timestamp}:${right.name}`,
      ),
    );
}

function reactionTargetsByName(name: string) {
  return reactionTargets(
    slackApiOutbox.reactionAdds().filter((call) => call.params.name === name),
  );
}

type CompleteObjectOverride = NonNullable<
  JuniorRuntimeServiceOverrides["subscribedReplyPolicy"]
>["completeObject"];

interface RouterDecision {
  confidence: number;
  reason: string;
  should_unsubscribe?: boolean;
  should_reply: boolean;
}

function completeObjectWithDecision(
  decide: (prompt: string) => RouterDecision,
): CompleteObjectOverride {
  return async (args) => {
    const decision = decide(args.prompt);
    return {
      object: args.schema.parse(decision),
      text: JSON.stringify(decision),
    };
  };
}

function createTurnHarness(args: {
  completeObject?: CompleteObjectOverride;
  generateAssistantReply: ReplyExecutorServices["generateAssistantReply"];
  services?: Parameters<typeof createSlackRuntime>[0]["services"];
  state: StateAdapter;
}) {
  const queue = createConversationWorkQueueTestAdapter();
  const adapter = createJuniorSlackAdapter({
    botToken: "slack-bot-fixture",
    botUserId: SLACK_BOT_USER_ID,
    signingSecret: SLACK_SIGNING_SECRET,
  });
  const runtime = createSlackRuntime({
    getSlackAdapter: () => adapter,
    services: {
      ...(args.services ?? {}),
      replyExecutor: {
        ...(args.services?.replyExecutor ?? {}),
        generateAssistantReply: args.generateAssistantReply,
      },
      subscribedReplyPolicy: {
        completeObject:
          args.completeObject ??
          completeObjectWithDecision(() => ({
            should_reply: true,
            should_unsubscribe: false,
            confidence: 1,
            reason: "steering follow-up",
          })),
      },
    },
  });
  const services = {
    getSlackAdapter: () => adapter,
    queue,
    runtime,
    state: args.state,
  };
  const conversationId = adapter.encodeThreadId({
    channel: CHANNEL_ID,
    threadTs: THREAD_TS,
  });
  const runNextQueuedWork = () => {
    const message = queue.takeMessage();
    return processConversationQueueMessage(message, {
      queue,
      run: createSlackConversationWorker({
        getSlackAdapter: () => adapter,
        resumeAwaitingContinuation: async () => false,
        runtime,
        state: args.state,
      }),
      state: args.state,
    });
  };

  return {
    conversationId,
    queue,
    runNextQueuedWork,
    services,
  };
}

describe("Slack behavior: durable turn steering", () => {
  beforeEach(async () => {
    resetSlackApiMockState();
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    resetSlackApiMockState();
    await disconnectStateAdapter();
  });

  it("does not enqueue duplicate Slack event retries for a persisted message", async () => {
    const state = getStateAdapter();
    const { conversationId, queue, services } = createTurnHarness({
      generateAssistantReply: async () =>
        completedAgentRun({
          text: "not used",
          diagnostics: makeDiagnostics(),
        }),
      state,
    });
    const event = makeMessageEvent({
      eventType: "app_mention",
      text: `<@${SLACK_BOT_USER_ID}> start the incident summary`,
      ts: THREAD_TS,
    });

    await expect(
      handleSlackWebhookAndFlush({
        request: slackWebhookRequest(event),
        services,
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      handleSlackWebhookAndFlush({
        request: slackWebhookRequest(event),
        services,
      }),
    ).resolves.toMatchObject({ status: 200 });

    const inboundMessageId = `slack:T123:${conversationId}:${THREAD_TS}`;
    const destination = {
      platform: "slack",
      teamId: "T123",
      channelId: CHANNEL_ID,
    };
    expect(queue.sendAttempts()).toEqual([
      {
        conversationId,
        destination,
        idempotencyKey: inboundMessageId,
      },
    ]);
    expect(queue.sentRecords()).toEqual([
      {
        conversationId,
        destination,
        idempotencyKey: inboundMessageId,
      },
    ]);

    const work = await getConversationWorkState({
      conversationId,
      state,
    });
    expect(work?.messages.map((message) => message.inboundMessageId)).toEqual([
      inboundMessageId,
    ]);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(1);
  });

  it("interrupts explicit follow-ups and defers passive follow-ups during an active turn", async () => {
    const agentEntered = deferred();
    const releaseAgent = deferred();
    let blockingCallReleased = false;
    const agentCalls: Array<{
      prompt: string;
      steeringTexts: string[];
    }> = [];
    const state = getStateAdapter();
    const generateAssistantReply: ReplyExecutorServices["generateAssistantReply"] =
      async (prompt, context) => {
        await context?.onInputCommitted?.();
        if (!blockingCallReleased) {
          agentEntered.resolve();
          await releaseAgent.promise;
          blockingCallReleased = true;
        }

        const steeringMessages: ReplySteeringMessage[] = [];
        const drained = await context?.drainSteeringMessages?.(
          async (messages) => {
            steeringMessages.push(...messages);
          },
        );
        if (steeringMessages.length === 0 && drained) {
          steeringMessages.push(...drained);
        }

        const steeringTexts = steeringMessages.map((message) => message.text);
        agentCalls.push({ prompt, steeringTexts });
        return completedAgentRun({
          text: [
            `Handled initial: ${prompt}`,
            `Steered: ${steeringTexts.join(" | ")}`,
          ].join("\n"),
          diagnostics: makeDiagnostics(),
        });
      };
    const { conversationId, queue, runNextQueuedWork, services } =
      createTurnHarness({
        completeObject: completeObjectWithDecision((prompt) =>
          prompt.includes("<latest-message>thanks folks</latest-message>")
            ? {
                should_reply: false,
                should_unsubscribe: false,
                confidence: 1,
                reason: "passive side conversation",
              }
            : {
                should_reply: true,
                should_unsubscribe: false,
                confidence: 1,
                reason: "active steering follow-up",
              },
        ),
        generateAssistantReply,
        state,
      });

    const firstResponse = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        makeMessageEvent({
          eventType: "app_mention",
          text: `<@${SLACK_BOT_USER_ID}> start the incident summary`,
          ts: THREAD_TS,
        }),
      ),
      services,
    });
    expect(firstResponse.status).toBe(200);
    expect(queue.sentRecords()).toHaveLength(1);

    const activeTurn = runNextQueuedWork();
    await agentEntered.promise;

    for (const followUp of [
      { text: "add customer impact", ts: "1712345.000200" },
      { text: "thanks folks", ts: "1712345.000250" },
      {
        eventType: "app_mention" as const,
        text: `<@${SLACK_BOT_USER_ID}> include the rollback owner`,
        ts: "1712345.000300",
      },
      { text: "finish with the next action", ts: "1712345.000400" },
    ]) {
      const response = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          makeMessageEvent({
            eventType: followUp.eventType ?? "message",
            text: followUp.text,
            ts: followUp.ts,
          }),
        ),
        services,
      });
      expect(response.status).toBe(200);
    }

    releaseAgent.resolve();
    await expect(activeTurn).resolves.toEqual({ status: "completed" });
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId,
        idempotencyKey: `slack:T123:${conversationId}:${THREAD_TS}`,
      }),
      expect.objectContaining({
        conversationId,
        idempotencyKey: `slack:T123:${conversationId}:1712345.000200`,
      }),
    ]);

    expect(agentCalls).toEqual([
      {
        prompt: "start the incident summary",
        steeringTexts: ["include the rollback owner"],
      },
    ]);

    const postCalls = slackApiOutbox.messages();
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.params).toEqual(
      expect.objectContaining({
        channel: CHANNEL_ID,
        thread_ts: THREAD_TS,
        text: expect.stringContaining("Steered: include the rollback owner"),
      }),
    );

    const queuedResults: string[] = [];
    while (queue.hasQueuedMessages()) {
      queuedResults.push((await runNextQueuedWork()).status);
    }
    expect(
      queuedResults.filter((status) => status === "completed"),
    ).toHaveLength(1);

    expect(agentCalls).toEqual([
      {
        prompt: "start the incident summary",
        steeringTexts: ["include the rollback owner"],
      },
      {
        prompt: expect.stringMatching(
          /add customer impact\s+finish with the next action/,
        ),
        steeringTexts: [],
      },
    ]);
    const deliveredMessages = slackApiOutbox.messages();
    expect(deliveredMessages).toHaveLength(2);
    expect(deliveredMessages.map((message) => message.params.text)).toEqual([
      "Handled initial: start the incident summary\n\nSteered: include the rollback owner",
      `Handled initial: ${agentCalls[1]?.prompt}\n\nSteered:`,
    ]);
    const work = await getConversationWorkState({
      conversationId,
      state,
    });
    expect(work?.messages).toEqual([]);
    expect(work?.execution.inboundMessageIds).toHaveLength(5);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
    expect(work?.needsRun).toBe(false);
    const persistedState = await getPersistedThreadState(conversationId);
    const conversation = coerceThreadConversationState(persistedState);
    expect(conversation.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "thanks folks",
          meta: expect.objectContaining({
            replied: false,
            skippedReason: "side_conversation:passive side conversation",
          }),
        }),
      ]),
    );

    const expectedReactionTargets = (name: string) =>
      [THREAD_TS, "1712345.000200", "1712345.000300", "1712345.000400"].map(
        (timestamp) => ({
          channel: CHANNEL_ID,
          name,
          timestamp,
        }),
      );
    const expectedProcessingReactions = expectedReactionTargets("eyes");
    const expectedCompletedReactions =
      expectedReactionTargets("white_check_mark");

    expect(reactionTargetsByName("eyes")).toEqual(expectedProcessingReactions);
    expect(reactionTargets(slackApiOutbox.reactionRemovals())).toEqual(
      expectedProcessingReactions,
    );
    expect(reactionTargetsByName("white_check_mark")).toEqual(
      expectedCompletedReactions,
    );
  });

  it("consumes subscribed messages skipped by reply policy", async () => {
    const state = getStateAdapter();
    const replyCalls: string[] = [];
    const { conversationId, queue, runNextQueuedWork, services } =
      createTurnHarness({
        completeObject: completeObjectWithDecision(() => ({
          should_reply: false,
          should_unsubscribe: false,
          confidence: 1,
          reason: "side conversation",
        })),
        generateAssistantReply: async (prompt, context) => {
          replyCalls.push(prompt);
          await context?.onInputCommitted?.();
          return completedAgentRun({
            text: "Started.",
            diagnostics: makeDiagnostics(),
          });
        },
        state,
      });

    await expect(
      handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          makeMessageEvent({
            eventType: "app_mention",
            text: `<@${SLACK_BOT_USER_ID}> start the incident summary`,
            ts: THREAD_TS,
          }),
        ),
        services,
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(runNextQueuedWork()).resolves.toEqual({
      status: "completed",
    });
    queue.clearSentRecords();

    await expect(
      handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          makeMessageEvent({
            eventType: "message",
            text: "thanks, sounds good",
            ts: "1712345.000200",
          }),
        ),
        services,
      }),
    ).resolves.toMatchObject({ status: 200 });

    await expect(runNextQueuedWork()).resolves.toEqual({
      status: "completed",
    });
    const work = await getConversationWorkState({
      conversationId,
      state,
    });
    expect(work?.messages).toEqual([]);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
    expect(work?.needsRun).toBe(false);
    expect(queue.sentRecords()).toHaveLength(1);
    expect(replyCalls).toEqual(["start the incident summary"]);
  });

  it("applies opt-out decisions from drained steering messages without reacting to them", async () => {
    const agentEntered = deferred();
    const releaseAgent = deferred();
    const drainedTexts: string[] = [];
    const state = getStateAdapter();
    const generateAssistantReply: ReplyExecutorServices["generateAssistantReply"] =
      async (_prompt, context) => {
        await context?.onInputCommitted?.();
        agentEntered.resolve();
        await releaseAgent.promise;
        const drained = await context?.drainSteeringMessages?.(
          async (messages) => {
            drainedTexts.push(...messages.map((message) => message.text));
          },
        );
        if (drainedTexts.length === 0 && drained) {
          drainedTexts.push(...drained.map((message) => message.text));
        }
        return completedAgentRun({
          text: "Done with the initial request.",
          diagnostics: makeDiagnostics(),
        });
      };
    const { conversationId, runNextQueuedWork, services } = createTurnHarness({
      completeObject: completeObjectWithDecision((prompt) =>
        prompt.includes("stop watching")
          ? {
              should_reply: false,
              should_unsubscribe: true,
              confidence: 1,
              reason: "explicit stop instruction",
            }
          : {
              should_reply: true,
              should_unsubscribe: false,
              confidence: 1,
              reason: "active steering follow-up",
            },
      ),
      generateAssistantReply,
      state,
    });

    await expect(
      handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          makeMessageEvent({
            eventType: "app_mention",
            text: `<@${SLACK_BOT_USER_ID}> start the incident summary`,
            ts: THREAD_TS,
          }),
        ),
        services,
      }),
    ).resolves.toMatchObject({ status: 200 });

    const activeTurn = runNextQueuedWork();
    await agentEntered.promise;

    await expect(
      handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          makeMessageEvent({
            eventType: "message",
            text: "stop watching this thread",
            ts: "1712345.000500",
          }),
        ),
        services,
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          makeMessageEvent({
            eventType: "message",
            text: "also add the rollout timeline",
            ts: "1712345.000600",
          }),
        ),
        services,
      }),
    ).resolves.toMatchObject({ status: 200 });

    releaseAgent.resolve();
    await expect(activeTurn).resolves.toEqual({ status: "completed" });
    expect(await state.isSubscribed(conversationId)).toBe(false);
    expect(drainedTexts).toEqual([]);

    expect(reactionTargetsByName("eyes")).toEqual([
      {
        channel: CHANNEL_ID,
        name: "eyes",
        timestamp: THREAD_TS,
      },
    ]);
    expect(reactionTargetsByName("white_check_mark")).toEqual([
      {
        channel: CHANNEL_ID,
        name: "white_check_mark",
        timestamp: THREAD_TS,
      },
    ]);
    const persistedState = await getPersistedThreadState(conversationId);
    const conversation = coerceThreadConversationState(persistedState);
    expect(conversation.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "stop watching this thread",
          meta: expect.objectContaining({
            replied: false,
            skippedReason: "thread_opt_out:explicit stop instruction",
          }),
        }),
        expect.objectContaining({
          text: "also add the rollout timeline",
          meta: expect.objectContaining({
            replied: false,
            skippedReason: "thread_opt_out:batch opt-out",
          }),
        }),
      ]),
    );
  });

  it("keeps the mailbox pending when the agent fails before input commit", async () => {
    const state = getStateAdapter();
    const generateAssistantReply: ReplyExecutorServices["generateAssistantReply"] =
      async (_prompt, context) => {
        expect(context?.onInputCommitted).toEqual(expect.any(Function));
        throw new Error("agent crashed before input commit");
      };
    const { conversationId, queue, runNextQueuedWork, services } =
      createTurnHarness({
        generateAssistantReply,
        state,
      });

    await expect(
      handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          makeMessageEvent({
            eventType: "app_mention",
            text: `<@${SLACK_BOT_USER_ID}> start the incident summary`,
            ts: THREAD_TS,
          }),
        ),
        services,
      }),
    ).resolves.toMatchObject({ status: 200 });

    await expect(runNextQueuedWork()).resolves.toEqual({
      status: "pending_requeued",
    });

    const work = await getConversationWorkState({
      conversationId,
      state,
    });
    expect(work?.needsRun).toBe(true);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(1);
    expect(work?.messages[0]?.injectedAtMs).toBeUndefined();
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({ conversationId }),
      expect.objectContaining({
        conversationId,
        idempotencyKey: expect.stringContaining(`pending:${conversationId}:`),
      }),
    ]);
  });
});
