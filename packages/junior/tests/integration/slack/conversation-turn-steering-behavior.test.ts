import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StateAdapter } from "chat";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";
import { createSlackRuntime } from "@/chat/app/factory";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import type { ReplyExecutorServices } from "@/chat/runtime/reply-executor";
import type { ReplySteeringMessage } from "@/chat/respond";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import type {
  ConversationQueueMessage,
  ConversationQueueSendOptions,
  ConversationWorkQueue,
} from "@/chat/task-execution/queue";
import { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { processConversationWork } from "@/chat/task-execution/worker";
import type { WaitUntilFn } from "@/handlers/types";

const BOT_USER_ID = "U_BOT";
const CHANNEL_ID = "C_STEER";
const SIGNING_SECRET = "slack-signature-fixture";
const THREAD_TS = "1712345.000100";

class FakeQueue implements ConversationWorkQueue {
  sent: Array<{
    conversationId: string;
    delayMs?: number;
    idempotencyKey?: string;
  }> = [];

  async send(
    message: ConversationQueueMessage,
    options?: ConversationQueueSendOptions,
  ): Promise<{ messageId: string }> {
    this.sent.push({
      conversationId: message.conversationId,
      delayMs: options?.delayMs,
      idempotencyKey: options?.idempotencyKey,
    });
    return { messageId: `fake-queue-${this.sent.length}` };
  }
}

type WaitUntilTask = () => Promise<unknown>;

function collectWaitUntil(tasks: WaitUntilTask[]): WaitUntilFn {
  return (task) => {
    tasks.push(typeof task === "function" ? task : () => task);
  };
}

async function flushWaitUntil(tasks: WaitUntilTask[]): Promise<void> {
  for (let index = 0; index < tasks.length; index += 1) {
    await tasks[index]?.();
  }
}

function signSlackBody(body: string, timestamp: string): string {
  return `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
}

function slackRequest(body: unknown): Request {
  const serialized = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://example.test/api/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlackBody(serialized, timestamp),
    },
    body: serialized,
  });
}

async function handleSlackWebhookAndFlush(args: {
  request: Request;
  services: Parameters<typeof handleSlackWebhook>[0]["services"];
}): Promise<Response> {
  const waitUntilTasks: WaitUntilTask[] = [];
  const response = await handleSlackWebhook({
    ...args,
    waitUntil: collectWaitUntil(waitUntilTasks),
  });
  await flushWaitUntil(waitUntilTasks);
  return response;
}

function makeMessageEvent(args: {
  eventType: "app_mention" | "message";
  text: string;
  ts: string;
}) {
  return slackEventsApiEnvelope({
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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createTurnHarness(args: {
  generateAssistantReply: ReplyExecutorServices["generateAssistantReply"];
  state: StateAdapter;
}) {
  const queue = new FakeQueue();
  const adapter = createJuniorSlackAdapter({
    botToken: "slack-bot-fixture",
    botUserId: BOT_USER_ID,
    signingSecret: SIGNING_SECRET,
  });
  const runtime = createSlackRuntime({
    getSlackAdapter: () => adapter,
    services: {
      replyExecutor: {
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
  const runWorker = () =>
    processConversationWork(conversationId, {
      queue,
      run: createSlackConversationWorker({
        getSlackAdapter: () => adapter,
        runtime,
        state: args.state,
      }),
      state: args.state,
    });

  return {
    conversationId,
    queue,
    runWorker,
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
    const { conversationId, queue, runWorker, services } = createTurnHarness({
      generateAssistantReply,
      state,
    });

    const firstResponse = await handleSlackWebhookAndFlush({
      request: slackRequest(
        makeMessageEvent({
          eventType: "app_mention",
          text: `<@${BOT_USER_ID}> start the incident summary`,
          ts: THREAD_TS,
        }),
      ),
      services,
    });
    expect(firstResponse.status).toBe(200);
    expect(queue.sent).toHaveLength(1);

    const activeTurn = runWorker();
    await agentEntered.promise;

    for (const followUp of [
      { text: "add customer impact", ts: "1712345.000200" },
      { text: "include the rollback owner", ts: "1712345.000300" },
      { text: "finish with the next action", ts: "1712345.000400" },
    ]) {
      const response = await handleSlackWebhookAndFlush({
        request: slackRequest(
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
    expect(queue.sent).toHaveLength(4);

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

    const postCalls = getCapturedSlackApiCalls("chat.postMessage");
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.params).toEqual(
      expect.objectContaining({
        channel: CHANNEL_ID,
        thread_ts: THREAD_TS,
        text: expect.stringContaining("Steered: add customer impact"),
      }),
    );

    const queuedWakeups = queue.sent.length;
    for (let index = 1; index < queuedWakeups; index += 1) {
      await expect(runWorker()).resolves.toEqual({ status: "no_work" });
    }

    expect(agentCalls).toHaveLength(1);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(1);
    const work = await getConversationWorkState({
      conversationId,
      state,
    });
    expect(work?.messages).toHaveLength(4);
    expect(
      work?.messages.every((message) => message.injectedAtMs !== undefined),
    ).toBe(true);
    expect(work?.needsRun).toBe(false);
  });
});
