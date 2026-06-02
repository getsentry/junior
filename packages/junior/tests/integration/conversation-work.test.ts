import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Thread } from "chat";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import {
  appendAndEnqueueInboundMessage,
  appendInboundMessage,
  checkInConversationWork,
  completeConversationWork,
  CONVERSATION_WORK_LEASE_TTL_MS,
  countPendingConversationMessages,
  drainConversationMailbox,
  getConversationWorkState,
  markConversationMessagesInjected,
  requestConversationWork,
  startConversationWork,
  type InboundMessageRecord,
} from "@/chat/task-execution/store";
import {
  CONVERSATION_WORK_DEFER_DELAY_MS,
  processConversationWork,
} from "@/chat/task-execution/worker";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { createVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

const CONVERSATION_ID = "slack:C123:1712345.0001";
const SLACK_SIGNING_SECRET = "test-signing-secret";
const SLACK_BOT_USER_ID = "U_BOT";

class FakeQueue implements ConversationWorkQueue {
  fail = false;
  sent: Array<{
    conversationId: string;
    delayMs?: number;
    idempotencyKey?: string;
  }> = [];

  async send(
    message: { conversationId: string },
    options?: { delayMs?: number; idempotencyKey?: string },
  ): Promise<{ messageId: string }> {
    if (this.fail) {
      throw new Error("queue unavailable");
    }
    this.sent.push({
      conversationId: message.conversationId,
      delayMs: options?.delayMs,
      idempotencyKey: options?.idempotencyKey,
    });
    return { messageId: `queue-${this.sent.length}` };
  }
}

function inboundMessage(
  inboundMessageId: string,
  overrides: Partial<InboundMessageRecord> = {},
): InboundMessageRecord {
  return {
    conversationId: CONVERSATION_ID,
    inboundMessageId,
    source: "slack",
    createdAtMs: 1_000,
    receivedAtMs: 1_100,
    input: {
      text: `message ${inboundMessageId}`,
      authorId: "U123",
    },
    ...overrides,
  };
}

function signSlackBody(body: string, timestamp: string): string {
  return `v0=${createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
}

function slackWebhookRequest(body: unknown): Request {
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

function slackEnvelope(input: {
  channel?: string;
  eventType?: "app_mention" | "message";
  text?: string;
  threadTs?: string;
  ts?: string;
}) {
  const channel = input.channel ?? "C123";
  const ts = input.ts ?? "1712345.0001";
  return {
    team_id: "T123",
    type: "event_callback",
    event: {
      type: input.eventType ?? "app_mention",
      user: "U123",
      text: input.text ?? `<@${SLACK_BOT_USER_ID}> hello`,
      channel,
      ts,
      event_ts: ts,
      channel_type: channel.startsWith("D") ? "im" : "channel",
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("conversation work execution", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    vi.useRealTimers();
  });

  it("stores inbound mailbox messages idempotently", async () => {
    const queue = new FakeQueue();
    await expect(
      appendAndEnqueueInboundMessage({
        message: inboundMessage("m1"),
        nowMs: 2_000,
        queue,
      }),
    ).resolves.toMatchObject({ status: "appended", queueMessageId: "queue-1" });
    await expect(
      appendAndEnqueueInboundMessage({
        message: inboundMessage("m1"),
        nowMs: 3_000,
        queue,
      }),
    ).resolves.toMatchObject({
      status: "duplicate",
      queueMessageId: "queue-2",
    });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.messages).toHaveLength(1);
    expect(state ? countPendingConversationMessages(state) : 0).toBe(1);
    expect(queue.sent).toHaveLength(2);
  });

  it("repairs pending mailbox work when the initial queue send fails", async () => {
    const queue = new FakeQueue();
    queue.fail = true;
    await expect(
      appendAndEnqueueInboundMessage({
        message: inboundMessage("m1"),
        nowMs: 2_000,
        queue,
      }),
    ).rejects.toThrow("queue unavailable");

    queue.fail = false;
    await expect(
      recoverConversationWork({
        nowMs: 62_000,
        queue,
      }),
    ).resolves.toEqual({ expiredLeaseCount: 0, pendingCount: 1 });
    expect(queue.sent).toEqual([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `heartbeat:pending:${CONVERSATION_ID}`,
      },
    ]);
  });

  it("defers duplicate queue nudges while a conversation lease is active", async () => {
    const queue = new FakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const entered = deferred<void>();
    const finish = deferred<void>();
    let runs = 0;

    const first = processConversationWork(CONVERSATION_ID, {
      queue,
      run: async (context) => {
        runs += 1;
        await context.drainMailbox(async () => {});
        entered.resolve();
        await finish.promise;
        return { status: "completed" };
      },
    });
    await entered.promise;

    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        run: async () => {
          runs += 1;
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "active" });
    expect(runs).toBe(1);
    expect(queue.sent).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        delayMs: CONVERSATION_WORK_DEFER_DELAY_MS,
      },
    ]);

    finish.resolve();
    await expect(first).resolves.toEqual({ status: "completed" });
  });

  it("preserves work requested while a lease is running", async () => {
    const queue = new FakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        run: async (context) => {
          await context.drainMailbox(async () => {});
          await requestConversationWork({
            conversationId: context.conversationId,
            nowMs: 2_000,
          });
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "completed" });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(state?.needsRun).toBe(true);
    expect(state ? countPendingConversationMessages(state) : 0).toBe(0);
  });

  it("drains pending messages and completes the leased conversation", async () => {
    const queue = new FakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const injected: InboundMessageRecord[][] = [];

    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        run: async (context) => {
          injected.push(await context.drainMailbox(async () => {}));
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(injected).toEqual([
      [expect.objectContaining({ inboundMessageId: "m1" })],
    ]);
    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(state?.needsRun).toBe(false);
    expect(state ? countPendingConversationMessages(state) : 0).toBe(0);
  });

  it("extends the lease with worker check-ins during long execution", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const queue = new FakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const entered = deferred<void>();
    const finish = deferred<void>();

    const running = processConversationWork(CONVERSATION_ID, {
      checkInIntervalMs: 15_000,
      queue,
      run: async (context) => {
        await context.drainMailbox(async () => {});
        entered.resolve();
        await finish.promise;
        return { status: "completed" };
      },
    });
    await entered.promise;
    const before = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });

    await vi.advanceTimersByTimeAsync(15_000);
    const after = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });

    expect(before?.lease?.leaseExpiresAtMs).toBe(
      1_000 + CONVERSATION_WORK_LEASE_TTL_MS,
    );
    expect(after?.lease?.leaseExpiresAtMs).toBe(
      16_000 + CONVERSATION_WORK_LEASE_TTL_MS,
    );

    finish.resolve();
    await expect(running).resolves.toEqual({ status: "completed" });
  });

  it("requeues an expired conversation lease from heartbeat", async () => {
    const queue = new FakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    await expect(
      startConversationWork({ conversationId: CONVERSATION_ID, nowMs: 2_000 }),
    ).resolves.toMatchObject({ status: "acquired" });

    await expect(
      recoverConversationWork({
        nowMs: 2_000 + CONVERSATION_WORK_LEASE_TTL_MS,
        queue,
      }),
    ).resolves.toEqual({ expiredLeaseCount: 1, pendingCount: 0 });
    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(queue.sent).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `heartbeat:lease:${CONVERSATION_ID}`,
      },
    ]);
  });

  it("requeues pending mailbox work with no recent queue marker", async () => {
    const queue = new FakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      recoverConversationWork({
        nowMs: 62_000,
        queue,
      }),
    ).resolves.toEqual({ expiredLeaseCount: 0, pendingCount: 1 });
    expect(queue.sent).toHaveLength(1);
  });

  it("runs conversation work recovery from the core heartbeat", async () => {
    const queue = new FakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await runHeartbeat({
      nowMs: 62_000,
      conversationWorkQueue: queue,
    });

    expect(queue.sent).toEqual([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `heartbeat:pending:${CONVERSATION_ID}`,
      },
    ]);
  });

  it("injects messages that arrive during active execution at a safe boundary", async () => {
    const queue = new FakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const injected: string[][] = [];

    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        run: async (context) => {
          const first = await context.drainMailbox(async () => {});
          injected.push(first.map((message) => message.inboundMessageId));
          await appendInboundMessage({
            message: inboundMessage("m2", {
              createdAtMs: 2_000,
              receivedAtMs: 2_100,
            }),
            nowMs: 2_100,
          });
          const second = await context.drainMailbox(async () => {});
          injected.push(second.map((message) => message.inboundMessageId));
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(injected).toEqual([["m1"], ["m2"]]);
  });

  it("clears the run marker after draining messages that arrived during active execution", async () => {
    const queue = new FakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        run: async (context) => {
          await context.drainMailbox(async () => {});
          await appendInboundMessage({
            message: inboundMessage("m2", {
              createdAtMs: 2_000,
              receivedAtMs: 2_100,
            }),
            nowMs: 2_100,
          });
          await context.drainMailbox(async () => {});
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "completed" });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.needsRun).toBe(false);
    expect(state ? countPendingConversationMessages(state) : 0).toBe(0);
  });

  it("requeues instead of completing when final mailbox work remains", async () => {
    const queue = new FakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        run: async (context) => {
          await context.drainMailbox(async () => {});
          await appendInboundMessage({
            message: inboundMessage("m2", {
              createdAtMs: 2_000,
              receivedAtMs: 2_100,
            }),
            nowMs: 2_100,
          });
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "pending_requeued" });
    expect(queue.sent).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `pending:${CONVERSATION_ID}`,
      },
    ]);
  });

  it("yields cooperatively and leaves the conversation resumable", async () => {
    const queue = new FakeQueue();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(CONVERSATION_ID, {
        nowMs: () => currentNowMs,
        queue,
        run: async (context) => {
          await context.drainMailbox(async () => {});
          currentNowMs = 242_000;
          expect(context.shouldYield()).toBe(true);
          return { status: "yielded" };
        },
      }),
    ).resolves.toEqual({ status: "yielded" });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(state?.needsRun).toBe(true);
    expect(queue.sent).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `yield:${CONVERSATION_ID}`,
      },
    ]);
  });

  it("keeps lease mutations token-bound", async () => {
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const lease = await startConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: 2_000,
    });
    expect(lease.status).toBe("acquired");
    if (lease.status !== "acquired") {
      return;
    }

    await expect(
      checkInConversationWork({
        conversationId: CONVERSATION_ID,
        leaseToken: "wrong-token",
        nowMs: 3_000,
      }),
    ).resolves.toBe(false);
    await expect(
      drainConversationMailbox({
        conversationId: CONVERSATION_ID,
        leaseToken: "wrong-token",
        inject: async () => {},
        nowMs: 3_000,
      }),
    ).rejects.toThrow("lease is not held");
    await expect(
      completeConversationWork({
        conversationId: CONVERSATION_ID,
        leaseToken: "wrong-token",
        nowMs: 3_000,
      }),
    ).resolves.toBe("lost_lease");
    await expect(
      markConversationMessagesInjected({
        conversationId: CONVERSATION_ID,
        inboundMessageIds: ["m1"],
        leaseToken: "wrong-token",
        nowMs: 3_000,
      }),
    ).resolves.toBe(false);
  });

  it("maps the generic queue port to Vercel Queue send options", async () => {
    const sends: Array<{
      message: unknown;
      options: unknown;
      topic: string;
    }> = [];
    const queue = createVercelConversationWorkQueue({
      topic: "junior_test_work",
      client: {
        async send(topic, message, options) {
          sends.push({ topic, message, options });
          return { messageId: "msg_123" };
        },
      },
    });

    await expect(
      queue.send(
        { conversationId: CONVERSATION_ID },
        { delayMs: 15_001, idempotencyKey: "idem-1" },
      ),
    ).resolves.toEqual({ messageId: "msg_123" });

    expect(sends).toEqual([
      {
        topic: "junior_test_work",
        message: { conversationId: CONVERSATION_ID },
        options: {
          delaySeconds: 16,
          idempotencyKey: "idem-1",
          retentionSeconds: undefined,
        },
      },
    ]);
  });

  it("processes Vercel Queue payloads through the leased worker", async () => {
    const queue = new FakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const injected: string[] = [];

    await expect(
      processConversationQueueMessage(
        { conversationId: CONVERSATION_ID },
        {
          queue,
          run: async (context) => {
            const messages = await context.drainMailbox(async () => {});
            injected.push(
              ...messages.map((message) => message.inboundMessageId),
            );
            return { status: "completed" };
          },
        },
      ),
    ).resolves.toEqual({ status: "completed" });

    expect(injected).toEqual(["m1"]);
  });

  it("persists Slack mentions into the durable mailbox and wakes the queue", async () => {
    const queue = new FakeQueue();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createJuniorSlackAdapter({
      botToken: "xoxb-test",
      botUserId: SLACK_BOT_USER_ID,
      signingSecret: SLACK_SIGNING_SECRET,
    });

    const response = await handleSlackWebhook({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> deploy status`,
        }),
      ),
      waitUntil: () => {},
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: {
          handleAssistantContextChanged: async () => {},
          handleAssistantThreadStarted: async () => {},
          handleNewMention: async () => {},
          handleSubscribedMessage: async () => {},
        },
        state,
      },
    });

    expect(response.status).toBe(200);
    expect(queue.sent).toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
      }),
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.needsRun).toBe(true);
    expect(work?.messages).toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        source: "slack",
        input: expect.objectContaining({
          authorId: "U123",
          metadata: expect.objectContaining({
            platform: "slack",
            route: "mention",
          }),
        }),
      }),
    ]);
  });

  it("runs queued Slack mailbox work through the Slack runtime", async () => {
    const queue = new FakeQueue();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createJuniorSlackAdapter({
      botToken: "xoxb-test",
      botUserId: SLACK_BOT_USER_ID,
      signingSecret: SLACK_SIGNING_SECRET,
    });
    const calls: Array<{
      message: Message;
      skipped: Message[];
      thread: Thread;
    }> = [];

    await handleSlackWebhook({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
          ts: "1712345.0001",
        }),
      ),
      waitUntil: () => {},
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: {
          handleAssistantContextChanged: async () => {},
          handleAssistantThreadStarted: async () => {},
          handleNewMention: async () => {},
          handleSubscribedMessage: async () => {},
        },
        state,
      },
    });
    await handleSlackWebhook({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> second`,
          ts: "1712345.0002",
          threadTs: "1712345.0001",
        }),
      ),
      waitUntil: () => {},
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: {
          handleAssistantContextChanged: async () => {},
          handleAssistantThreadStarted: async () => {},
          handleNewMention: async () => {},
          handleSubscribedMessage: async () => {},
        },
        state,
      },
    });

    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        state,
        run: createSlackConversationWorker({
          getSlackAdapter: () => slackAdapter,
          runtime: {
            handleNewMention: async (thread, message, hooks) => {
              calls.push({
                thread,
                message,
                skipped: hooks?.messageContext?.skipped ?? [],
              });
            },
            handleSubscribedMessage: async () => {
              throw new Error("unexpected subscribed route");
            },
          },
          state,
        }),
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.thread.id).toBe(CONVERSATION_ID);
    expect(calls[0]?.message.id).toBe("1712345.0002");
    expect(calls[0]?.message.text).toContain("second");
    expect(calls[0]?.skipped.map((message) => message.id)).toEqual([
      "1712345.0001",
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
  });

  it("processes pending Slack follow-ups before timeout continuation", async () => {
    const queue = new FakeQueue();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createJuniorSlackAdapter({
      botToken: "xoxb-test",
      botUserId: SLACK_BOT_USER_ID,
      signingSecret: SLACK_SIGNING_SECRET,
    });
    await upsertAgentTurnSessionRecord({
      conversationId: CONVERSATION_ID,
      sessionId: "turn-timeout",
      sliceId: 2,
      state: "awaiting_resume",
      resumeReason: "timeout",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "original request" }],
          timestamp: 1_000,
        },
      ],
    });

    await handleSlackWebhook({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> follow-up`,
          ts: "1712345.0002",
          threadTs: "1712345.0001",
        }),
      ),
      waitUntil: () => {},
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: {
          handleAssistantContextChanged: async () => {},
          handleAssistantThreadStarted: async () => {},
          handleNewMention: async () => {},
          handleSubscribedMessage: async () => {},
        },
        state,
      },
    });

    const calls: string[] = [];
    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        state,
        run: createSlackConversationWorker({
          getSlackAdapter: () => slackAdapter,
          runtime: {
            handleNewMention: async (_thread, message) => {
              calls.push(message.text);
            },
            handleSubscribedMessage: async () => {
              throw new Error("unexpected subscribed route");
            },
          },
          state,
        }),
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(calls).toEqual([expect.stringContaining("follow-up")]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
  });

  it("does not replay injected Slack mailbox records after lease recovery", async () => {
    const queue = new FakeQueue();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createJuniorSlackAdapter({
      botToken: "xoxb-test",
      botUserId: SLACK_BOT_USER_ID,
      signingSecret: SLACK_SIGNING_SECRET,
    });

    await handleSlackWebhook({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
        }),
      ),
      waitUntil: () => {},
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: {
          handleAssistantContextChanged: async () => {},
          handleAssistantThreadStarted: async () => {},
          handleNewMention: async () => {},
          handleSubscribedMessage: async () => {},
        },
        state,
      },
    });
    const lease = await startConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: 2_000,
      state,
    });
    expect(lease.status).toBe("acquired");
    if (lease.status !== "acquired") {
      return;
    }
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    const inboundMessageIds =
      work?.messages.map((message) => message.inboundMessageId) ?? [];
    await markConversationMessagesInjected({
      conversationId: CONVERSATION_ID,
      inboundMessageIds,
      leaseToken: lease.leaseToken,
      nowMs: 3_000,
      state,
    });
    await recoverConversationWork({
      nowMs: 2_000 + CONVERSATION_WORK_LEASE_TTL_MS,
      queue,
      state,
    });

    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        state,
        run: createSlackConversationWorker({
          getSlackAdapter: () => slackAdapter,
          runtime: {
            handleNewMention: async () => {
              throw new Error("injected messages should not replay");
            },
            handleSubscribedMessage: async () => {
              throw new Error("injected messages should not replay");
            },
          },
          state,
        }),
      }),
    ).resolves.toEqual({ status: "no_work" });

    const recovered = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(recovered?.needsRun).toBe(false);
    expect(recovered ? countPendingConversationMessages(recovered) : 0).toBe(0);
  });

  it("keeps Slack mailbox records pending when the runtime handoff fails", async () => {
    const queue = new FakeQueue();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createJuniorSlackAdapter({
      botToken: "xoxb-test",
      botUserId: SLACK_BOT_USER_ID,
      signingSecret: SLACK_SIGNING_SECRET,
    });

    await handleSlackWebhook({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
        }),
      ),
      waitUntil: () => {},
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: {
          handleAssistantContextChanged: async () => {},
          handleAssistantThreadStarted: async () => {},
          handleNewMention: async () => {},
          handleSubscribedMessage: async () => {},
        },
        state,
      },
    });

    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        state,
        run: createSlackConversationWorker({
          getSlackAdapter: () => slackAdapter,
          runtime: {
            handleNewMention: async () => {
              throw new Error("runtime failed before durable handoff");
            },
            handleSubscribedMessage: async () => {
              throw new Error("unexpected subscribed route");
            },
          },
          state,
        }),
      }),
    ).rejects.toThrow("runtime failed before durable handoff");

    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.lease).toBeUndefined();
    expect(work ? countPendingConversationMessages(work) : 0).toBe(1);
    expect(work?.messages[0]?.injectedAtMs).toBeUndefined();
  });

  it("completes Slack mailbox work when the handler finishes after the soft deadline", async () => {
    const queue = new FakeQueue();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createJuniorSlackAdapter({
      botToken: "xoxb-test",
      botUserId: SLACK_BOT_USER_ID,
      signingSecret: SLACK_SIGNING_SECRET,
    });
    let currentNowMs = 1_000;

    await handleSlackWebhook({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
        }),
      ),
      waitUntil: () => {},
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: {
          handleAssistantContextChanged: async () => {},
          handleAssistantThreadStarted: async () => {},
          handleNewMention: async () => {},
          handleSubscribedMessage: async () => {},
        },
        state,
      },
    });
    queue.sent = [];

    await expect(
      processConversationWork(CONVERSATION_ID, {
        nowMs: () => currentNowMs,
        queue,
        state,
        run: createSlackConversationWorker({
          getSlackAdapter: () => slackAdapter,
          runtime: {
            handleNewMention: async () => {
              currentNowMs = 242_000;
            },
            handleSubscribedMessage: async () => {
              throw new Error("unexpected subscribed route");
            },
          },
          state,
        }),
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(queue.sent).toEqual([]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.needsRun).toBe(false);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
  });

  it("rejects malformed Vercel Queue payloads", async () => {
    const queue = new FakeQueue();

    await expect(
      processConversationQueueMessage(
        { wrong: CONVERSATION_ID },
        {
          queue,
          run: async () => ({ status: "completed" }),
        },
      ),
    ).rejects.toThrow("missing conversationId");
  });
});
