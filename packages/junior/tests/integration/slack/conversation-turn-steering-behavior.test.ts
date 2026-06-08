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
import type { ReplyExecutorServices } from "@/chat/runtime/reply-executor";
import type { ReplySteeringMessage } from "@/chat/respond";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import {
  countPendingConversationMessages,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";

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

function createTurnHarness(args: {
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
      generateAssistantReply: async () => ({
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

  it("steers rapid Slack webhook follow-ups into one active worker turn", async () => {
    const agentEntered = deferred();
    const releaseAgent = deferred();
    const agentCalls: Array<{
      prompt: string;
      steeringTexts: string[];
    }> = [];
    const state = getStateAdapter();
    const generateAssistantReply: ReplyExecutorServices["generateAssistantReply"] =
      async (prompt, context) => {
        await context?.onInputCommitted?.();
        agentEntered.resolve();
        await releaseAgent.promise;

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
        return {
          text: [
            `Handled initial: ${prompt}`,
            `Steered: ${steeringTexts.join(" | ")}`,
          ].join("\n"),
          diagnostics: makeDiagnostics(),
        };
      };
    const { conversationId, queue, runNextQueuedWork, services } =
      createTurnHarness({
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
      { text: "include the rollback owner", ts: "1712345.000300" },
      { text: "finish with the next action", ts: "1712345.000400" },
    ]) {
      const response = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          makeMessageEvent({
            eventType: "message",
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
    expect(queue.sentRecords()).toHaveLength(4);

    expect(agentCalls).toEqual([
      {
        prompt: "start the incident summary",
        steeringTexts: [
          "add customer impact",
          "include the rollback owner",
          "finish with the next action",
        ],
      },
    ]);

    const postCalls = slackApiOutbox.messages();
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.params).toEqual(
      expect.objectContaining({
        channel: CHANNEL_ID,
        thread_ts: THREAD_TS,
        text: expect.stringContaining("Steered: add customer impact"),
      }),
    );

    while (queue.hasQueuedMessages()) {
      await expect(runNextQueuedWork()).resolves.toEqual({ status: "no_work" });
    }

    expect(agentCalls).toHaveLength(1);
    expect(slackApiOutbox.messages()).toHaveLength(1);
    const work = await getConversationWorkState({
      conversationId,
      state,
    });
    expect(work?.messages).toEqual([]);
    expect(work?.execution.inboundMessageIds).toHaveLength(4);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
    expect(work?.needsRun).toBe(false);

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
        generateAssistantReply: async (prompt, context) => {
          replyCalls.push(prompt);
          await context?.onInputCommitted?.();
          return {
            text: "Started.",
            diagnostics: makeDiagnostics(),
          };
        },
        services: {
          subscribedReplyPolicy: {
            completeObject: async () =>
              ({
                object: {
                  should_reply: false,
                  confidence: 0,
                  reason: "side conversation",
                },
                text: '{"should_reply":false,"confidence":0,"reason":"side conversation"}',
              }) as never,
          },
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
