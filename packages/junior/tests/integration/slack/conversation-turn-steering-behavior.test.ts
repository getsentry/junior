import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StateAdapter } from "chat";
import {
  SLACK_BOT_USER_ID,
  SLACK_DESTINATION,
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
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { AgentRun } from "@/chat/agent/types";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { loadConversationProjection } from "@/chat/conversations/projection";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import {
  countPendingConversationMessages,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { isUserActor } from "@/chat/actor";
import type { CrossActorMidRunMode } from "@/chat/config";
import {
  createResourceEventSubscription,
  listResourceEventSubscriptions,
} from "@/chat/resource-events/store";
import {
  createModelAgentRunnerForRun,
  neverRunAgentRunner,
} from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";

const CHANNEL_ID = "CSTEER";
const THREAD_TS = "1712345.000100";

function makeMessageEvent(args: {
  eventType: "app_mention" | "message";
  text: string;
  ts: string;
  user?: string;
}) {
  return slackEnvelope({
    channel: CHANNEL_ID,
    eventType: args.eventType,
    text: args.text,
    threadTs: args.ts === THREAD_TS ? undefined : THREAD_TS,
    ts: args.ts,
    user: args.user,
  });
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

async function loadMessageProvenance(conversationId: string, text: string) {
  const projection = await loadConversationProjection({ conversationId });
  const index = projection.messages.findIndex((message) =>
    JSON.stringify(message).includes(text),
  );
  return index === -1 ? undefined : projection.provenance[index];
}

function createTurnHarness(args: {
  completeObject?: CompleteObjectOverride;
  crossActorMidRunMode?: CrossActorMidRunMode;
  agentRunner: AgentRunner;
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
        agentRunner: args.agentRunner,
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
        crossActorMidRunMode: args.crossActorMidRunMode,
        getSlackAdapter: () => adapter,
        runNextPausedTurn: async () => false,
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
      agentRunner: neverRunAgentRunner(),
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
    expect(queue.sendAttempts()).toEqual([
      {
        conversationId,
        idempotencyKey: inboundMessageId,
      },
    ]);
    expect(queue.sentRecords()).toEqual([
      {
        conversationId,
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

  it("steers same-actor explicit mentions and then processes follow-up messages", async () => {
    const agentEntered = deferred();
    const releaseAgent = deferred();
    const agentRuns: AgentRun[] = [];
    let firstRun = true;
    const state = getStateAdapter();
    const agentRunner = createModelAgentRunnerForRun((run) => {
      agentRuns.push(run);
      if (firstRun) {
        firstRun = false;
        return createModelStream([
          {
            type: "text",
            text: "Started the incident summary.",
            onRequest: () => agentEntered.resolve(),
            waitFor: releaseAgent.promise,
          },
          { type: "text", text: "Included the rollback owner." },
        ]);
      }
      return createModelStream([
        {
          type: "text",
          text: `Handled follow-up: ${run.instruction.text}`,
        },
      ]);
    });
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
        agentRunner,
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
    ]);

    // The steered follow-up keeps its own Slack author as an instruction,
    // rather than being attributed to the current run's actor.
    await expect(
      loadMessageProvenance(conversationId, "include the rollback owner"),
    ).resolves.toEqual({
      authority: "instruction",
      actor: expect.objectContaining({
        platform: "slack",
        teamId: "T123",
        userId: "U123",
      }),
    });

    const queuedResults: string[] = [];
    while (queue.hasQueuedMessages()) {
      queuedResults.push((await runNextQueuedWork()).status);
    }
    expect(
      queuedResults.filter((status) => status === "completed"),
    ).toHaveLength(0);

    expect(
      agentRuns.map((run) => ({
        context: run.instruction.context,
        prompt: run.instruction.text,
      })),
    ).toEqual([
      { context: undefined, prompt: "start the incident summary" },
      {
        context: expect.stringContaining("add customer impact"),
        prompt: "finish with the next action",
      },
    ]);
    const deliveredMessages = slackApiOutbox.messages();
    expect(deliveredMessages.map((message) => message.params.text)).toEqual([
      "Started the incident summary.",
      "Included the rollback owner.",
      "Handled follow-up: finish with the next action",
    ]);
    const work = await getConversationWorkState({
      conversationId,
      state,
    });
    expect(work?.messages).toEqual([]);
    expect(work?.execution.inboundMessageIds).toHaveLength(5);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
    expect(work?.needsRun).toBe(false);
    const expectedReactionTargets = (name: string) =>
      [
        THREAD_TS,
        "1712345.000200",
        "1712345.000250",
        "1712345.000300",
        "1712345.000400",
      ].map((timestamp) => ({
        channel: CHANNEL_ID,
        name,
        timestamp,
      }));
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

  it("isolates cross-actor mentions into actor-scoped follow-up turns unless !! overrides", async () => {
    const agentEntered = deferred();
    const releaseAgent = deferred();
    const agentRuns: AgentRun[] = [];
    const state = getStateAdapter();
    let firstRun = true;
    const agentRunner = createModelAgentRunnerForRun((run) => {
      agentRuns.push(run);
      if (firstRun) {
        firstRun = false;
        return createModelStream([
          {
            type: "text",
            text: "Started the incident summary.",
            onRequest: () => agentEntered.resolve(),
            waitFor: releaseAgent.promise,
          },
          { type: "text", text: "Stopped and reconsidered." },
        ]);
      }
      return createModelStream([{ type: "text", text: "Done." }]);
    });
    const { conversationId, runNextQueuedWork, services } = createTurnHarness({
      agentRunner,
      state,
    });

    await expect(
      handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          makeMessageEvent({
            eventType: "app_mention",
            text: `<@${SLACK_BOT_USER_ID}> start the incident summary`,
            ts: THREAD_TS,
            user: "U123",
          }),
        ),
        services,
      }),
    ).resolves.toMatchObject({ status: 200 });

    const activeTurn = runNextQueuedWork();
    await agentEntered.promise;

    for (const message of [
      {
        text: `<@${SLACK_BOT_USER_ID}> add customer impact`,
        ts: "1712345.000200",
        user: "U456",
      },
      {
        text: `<@${SLACK_BOT_USER_ID}> add the rollback owner`,
        ts: "1712345.000300",
        user: "U456",
      },
      {
        text: `<@${SLACK_BOT_USER_ID}> add the next action`,
        ts: "1712345.000400",
        user: "U789",
      },
      {
        text: `<@${SLACK_BOT_USER_ID}> add one more customer`,
        ts: "1712345.000500",
        user: "U456",
      },
      {
        text: `<@${SLACK_BOT_USER_ID}> !! stop and reconsider`,
        ts: "1712345.000600",
        user: "U999",
      },
    ]) {
      await expect(
        handleSlackWebhookAndFlush({
          request: slackWebhookRequest(
            makeMessageEvent({
              eventType: "app_mention",
              ...message,
            }),
          ),
          services,
        }),
      ).resolves.toMatchObject({ status: 200 });
    }

    releaseAgent.resolve();
    await expect(activeTurn).resolves.toEqual({ status: "completed" });

    expect(
      agentRuns.map((run) => ({
        actorId: isUserActor(run.actor) ? run.actor.userId : undefined,
        prompt: run.instruction.text,
      })),
    ).toEqual([
      {
        actorId: "U123",
        prompt: "start the incident summary",
      },
      {
        actorId: "U456",
        prompt: "add the rollback owner",
      },
      {
        actorId: "U789",
        prompt: "add the next action",
      },
      {
        actorId: "U456",
        prompt: "add one more customer",
      },
    ]);
    expect(agentRuns[1]?.instruction.context).toContain("add customer impact");
    await expect(
      loadMessageProvenance(conversationId, "stop and reconsider"),
    ).resolves.toEqual({
      authority: "instruction",
      actor: expect.objectContaining({ userId: "U999" }),
    });

    const work = await getConversationWorkState({
      conversationId,
      state,
    });
    expect(work?.messages).toEqual([]);
    expect(work?.execution.inboundMessageIds).toHaveLength(6);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
    expect(work?.needsRun).toBe(false);
  });

  it("supports configured cross-actor steering", async () => {
    const agentEntered = deferred();
    const releaseAgent = deferred();
    const state = getStateAdapter();
    const agentRuns: AgentRun[] = [];
    const { conversationId, runNextQueuedWork, services } = createTurnHarness({
      crossActorMidRunMode: "steer",
      agentRunner: createModelAgentRunnerForRun((run) => {
        agentRuns.push(run);
        return createModelStream([
          {
            type: "text",
            text: "Started the incident summary.",
            onRequest: () => agentEntered.resolve(),
            waitFor: releaseAgent.promise,
          },
          { type: "text", text: "Included the rollback owner." },
        ]);
      }),
      state,
    });

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        makeMessageEvent({
          eventType: "app_mention",
          text: `<@${SLACK_BOT_USER_ID}> start the incident summary`,
          ts: THREAD_TS,
          user: "U123",
        }),
      ),
      services,
    });
    const activeTurn = runNextQueuedWork();
    await agentEntered.promise;
    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        makeMessageEvent({
          eventType: "app_mention",
          text: `<@${SLACK_BOT_USER_ID}> include the rollback owner`,
          ts: "1712345.000200",
          user: "U456",
        }),
      ),
      services,
    });

    releaseAgent.resolve();
    await expect(activeTurn).resolves.toEqual({ status: "completed" });
    expect(agentRuns).toHaveLength(1);
    await expect(
      loadMessageProvenance(conversationId, "include the rollback owner"),
    ).resolves.toEqual({
      authority: "instruction",
      actor: expect.objectContaining({ userId: "U456" }),
    });
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
        agentRunner: createModelAgentRunnerForRun((run) => {
          replyCalls.push(run.instruction.text);
          return createModelStream([{ type: "text", text: "Started." }]);
        }),
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

  it("applies follow-up opt-out decisions after the active turn", async () => {
    const agentEntered = deferred();
    const releaseAgent = deferred();
    const agentRuns: AgentRun[] = [];
    const state = getStateAdapter();
    const agentRunner = createModelAgentRunnerForRun((run) => {
      agentRuns.push(run);
      return createModelStream([
        {
          type: "text",
          text: "Done with the initial request.",
          onRequest: () => agentEntered.resolve(),
          waitFor: releaseAgent.promise,
        },
      ]);
    });
    const { conversationId, queue, runNextQueuedWork, services } =
      createTurnHarness({
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
        agentRunner,
        state,
      });
    await createResourceEventSubscription(
      {
        conversationId,
        destination: SLACK_DESTINATION,
        events: ["pull_request.checks.failed"],
        expiresAtMs: Date.now() + 60_000,
        intent: "Watch CI while this turn is active.",
        label: "Pull request checks",
        namespace: "github",
        identifier: "getsentry/junior#steering",
        resourceType: "pull_request",
      },
      { state },
    );

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
    while (queue.hasQueuedMessages()) {
      await runNextQueuedWork();
    }
    expect(await state.isSubscribed(conversationId)).toBe(false);
    await expect(
      listResourceEventSubscriptions({ conversationId, state }),
    ).resolves.toEqual([]);
    expect(agentRuns).toHaveLength(1);

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
    await hydrateConversationMessages({ conversation, conversationId });
    expect(conversation.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "also add the rollout timeline",
          meta: expect.objectContaining({
            replied: false,
            skippedReason: "thread_opt_out:explicit stop instruction",
          }),
        }),
      ]),
    );
  });
});
