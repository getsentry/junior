import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, StateAdapter, Thread } from "chat";
import { CooperativeTurnYieldError } from "@/chat/runtime/turn";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import {
  CONVERSATION_WORK_LEASE_TTL_MS,
  countPendingConversationMessages,
  getConversationWorkState,
  markConversationMessagesInjected,
  requestConversationWork,
  startConversationWork,
} from "@/chat/task-execution/store";
import { processConversationWork } from "@/chat/task-execution/worker";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import { getMessageActorIdentity } from "@/chat/services/message-actor-identity";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import {
  CONVERSATION_ID,
  createConversationWorkQueueTestAdapter,
  SLACK_BOT_USER_ID,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  type ConversationWorkQueueTestAdapter,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";

type SlackWorkerOptions = Parameters<typeof createSlackConversationWorker>[0];

interface ProcessQueuedSlackWorkArgs {
  getSlackAdapter: SlackWorkerOptions["getSlackAdapter"];
  lookupSlackUser?: SlackWorkerOptions["lookupSlackUser"];
  nowMs?: () => number;
  queue: ConversationWorkQueueTestAdapter;
  resumeAwaitingContinuation?: SlackWorkerOptions["resumeAwaitingContinuation"];
  runtime: SlackWorkerOptions["runtime"];
  state: StateAdapter;
}

function processNextQueuedSlackWork(args: ProcessQueuedSlackWorkArgs) {
  return processConversationQueueMessage(args.queue.takeMessage(), {
    nowMs: args.nowMs,
    queue: args.queue,
    run: createSlackConversationWorker({
      getSlackAdapter: args.getSlackAdapter,
      lookupSlackUser: args.lookupSlackUser,
      resumeAwaitingContinuation: args.resumeAwaitingContinuation,
      runtime: args.runtime,
      state: args.state,
    }),
    state: args.state,
  });
}

/** Prove redundant queue deliveries do not replay already-drained Slack work. */
async function expectRemainingQueuedSlackWorkIsNoop(
  args: ProcessQueuedSlackWorkArgs,
): Promise<void> {
  while (args.queue.hasQueuedMessages()) {
    await expect(processNextQueuedSlackWork(args)).resolves.toEqual({
      status: "no_work",
    });
  }
}

describe("Slack conversation work execution", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("persists Slack mentions into the durable mailbox and wakes the queue", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();

    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> deploy status`,
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    expect(response.status).toBe(200);
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
      }),
    ]);
    expect(queue.queuedMessages()).toEqual([
      { conversationId: CONVERSATION_ID },
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

  it("does not persist Slack mailbox messages without actor ids", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();

    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest({
        team_id: "T123",
        type: "event_callback",
        event: {
          type: "app_mention",
          text: `<@${SLACK_BOT_USER_ID}> missing actor`,
          channel: "C123",
          ts: "1712345.0099",
          event_ts: "1712345.0099",
          channel_type: "channel",
        },
      }),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    expect(response.status).toBe(200);
    expect(queue.sentRecords()).toEqual([]);
    await expect(
      getConversationWorkState({ conversationId: CONVERSATION_ID, state }),
    ).resolves.toBeUndefined();
  });

  it("routes edited Slack mentions through the durable mailbox", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const editedTs = "1712345.0003";
    const editedText = `<@${SLACK_BOT_USER_ID}> edited ask`;

    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest({
        ...slackEnvelope({
          eventType: "message",
          text: "edited ask",
          ts: editedTs,
        }),
        event: {
          type: "message",
          subtype: "message_changed",
          channel: "C123",
          hidden: true,
          message: {
            type: "message",
            user: "U123",
            text: editedText,
            ts: editedTs,
          },
          previous_message: {
            type: "message",
            user: "U123",
            text: "edited ask",
            ts: editedTs,
          },
        },
      }),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    expect(response.status).toBe(200);
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId: `slack:C123:${editedTs}`,
        idempotencyKey: `slack:T123:slack:C123:${editedTs}:${editedTs}:message_changed_mention`,
      }),
    ]);

    const calls: Array<{ message: Message; thread: Thread }> = [];
    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: {
          handleNewMention: async (thread, message, hooks) => {
            await hooks?.onInputCommitted?.();
            calls.push({ thread, message });
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.thread.id).toBe(`slack:C123:${editedTs}`);
    expect(calls[0]?.message.id).toBe(`${editedTs}:message_changed_mention`);
    expect(calls[0]?.message.text).toBe(editedText);
    expect(calls[0]?.message.isMention).toBe(true);
  });

  it("runs queued Slack mailbox work through the Slack runtime", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const calls: Array<{
      message: Message;
      skipped: Message[];
      thread: Thread;
    }> = [];

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
          ts: "1712345.0001",
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });
    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> second`,
          ts: "1712345.0002",
          threadTs: "1712345.0001",
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    const runtime: SlackWorkerOptions["runtime"] = {
      handleNewMention: async (thread, message, hooks) => {
        await hooks?.onInputCommitted?.();
        calls.push({
          thread,
          message,
          skipped: hooks?.messageContext?.skipped ?? [],
        });
      },
      handleSubscribedMessage: async () => {
        throw new Error("unexpected subscribed route");
      },
    };
    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime,
        state,
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
    await expectRemainingQueuedSlackWorkIsNoop({
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime,
      state,
    });
  });

  it("binds resolved Slack actor identity before runtime handling", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    let capturedMessage: Message | undefined;

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> identify me`,
          ts: "1712345.0003",
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    const runtime: SlackWorkerOptions["runtime"] = {
      handleNewMention: async (_thread, message, hooks) => {
        capturedMessage = message;
        await hooks?.onInputCommitted?.();
      },
      handleSubscribedMessage: async () => {
        throw new Error("unexpected subscribed route");
      },
    };

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        lookupSlackUser: async () => ({
          email: "david@example.com",
          fullName: "David Cramer",
          userName: "dcramer",
        }),
        queue,
        runtime,
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(capturedMessage?.author).toMatchObject({
      userId: "U123",
      userName: "dcramer",
      fullName: "David Cramer",
    });
    expect(getMessageActorIdentity(capturedMessage!)).toEqual({
      email: "david@example.com",
      fullName: "David Cramer",
      userId: "U123",
      userName: "dcramer",
    });
  });

  it("keeps restored thread context aligned with promoted mention routing", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const calls: Array<{
      message: Message;
      skipped: Message[];
      thread: Thread;
    }> = [];
    const subscribedValues: boolean[] = [];
    const ingressServices = {
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    };

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
          ts: "1712345.0001",
        }),
      ),
      services: ingressServices,
    });
    await state.subscribe(CONVERSATION_ID);
    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          eventType: "message",
          text: "follow-up without an explicit mention",
          ts: "1712345.0002",
          threadTs: "1712345.0001",
        }),
      ),
      services: ingressServices,
    });
    const workBeforeProcessing = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(
      workBeforeProcessing?.messages.map((record) => record.input.metadata),
    ).toEqual([
      expect.objectContaining({ route: "mention" }),
      expect.objectContaining({ route: "subscribed" }),
    ]);
    await state.unsubscribe(CONVERSATION_ID);

    const runtime: SlackWorkerOptions["runtime"] = {
      handleNewMention: async (thread, message, hooks) => {
        await hooks?.onInputCommitted?.();
        subscribedValues.push(await thread.isSubscribed());
        calls.push({
          thread,
          message,
          skipped: hooks?.messageContext?.skipped ?? [],
        });
      },
      handleSubscribedMessage: async () => {
        throw new Error("mixed mention batches should promote to mention");
      },
    };
    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime,
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.message.id).toBe("1712345.0002");
    expect(calls[0]?.skipped.map((message) => message.id)).toEqual([
      "1712345.0001",
    ]);
    expect(subscribedValues).toEqual([false]);
    await expectRemainingQueuedSlackWorkIsNoop({
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime,
      state,
    });
  });

  it("processes pending Slack follow-ups when no continuation starts", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const resumeAwaitingContinuation = vi.fn(async () => false);

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> follow-up`,
          ts: "1712345.0002",
          threadTs: "1712345.0001",
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    const calls: string[] = [];
    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        resumeAwaitingContinuation,
        runtime: {
          handleNewMention: async (_thread, message, hooks) => {
            await hooks?.onInputCommitted?.();
            calls.push(message.text);
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(resumeAwaitingContinuation).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(calls).toEqual([expect.stringContaining("follow-up")]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
  });

  it("resumes awaiting continuations before routing pending Slack follow-ups", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const resumeAwaitingContinuation = vi.fn(async () => true);

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> follow-up`,
          ts: "1712345.0002",
          threadTs: "1712345.0001",
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });
    queue.clearSentRecords();

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        nowMs: () => 3_500,
        queue,
        resumeAwaitingContinuation,
        runtime: {
          handleNewMention: async () => {
            throw new Error("pending follow-up should wait for resume");
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "pending_requeued" });

    expect(resumeAwaitingContinuation).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        idempotencyKey: `pending:${CONVERSATION_ID}:3500`,
      }),
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.lease).toBeUndefined();
    expect(work?.needsRun).toBe(true);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(1);
    expect(work?.messages[0]?.injectedAtMs).toBeUndefined();
  });

  it("drains Slack messages that arrive during an active turn into steering", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const ingressServices = {
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    };
    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
          ts: "1712345.0001",
        }),
      ),
      services: ingressServices,
    });

    const injected: string[][] = [];
    const drained: string[][] = [];
    const runtime: SlackWorkerOptions["runtime"] = {
      handleNewMention: async (_thread, _message, hooks) => {
        await hooks?.onInputCommitted?.();
        await handleSlackWebhookAndFlush({
          request: slackWebhookRequest(
            slackEnvelope({
              text: `<@${SLACK_BOT_USER_ID}> steer this`,
              ts: "1712345.0002",
              threadTs: "1712345.0001",
            }),
          ),
          services: ingressServices,
        });
        const messages =
          (await hooks?.drainSteeringMessages?.(async (steering) => {
            injected.push(steering.map((message) => message.id));
          })) ?? [];
        drained.push(messages.map((message) => message.id));
      },
      handleSubscribedMessage: async () => {
        throw new Error("unexpected subscribed route");
      },
    };
    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime,
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(injected).toEqual([["1712345.0002"]]);
    expect(drained).toEqual([["1712345.0002"]]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.messages.map((message) => message.injectedAtMs)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
    await expectRemainingQueuedSlackWorkIsNoop({
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime,
      state,
    });
  });

  it("does not replay injected Slack mailbox records after lease recovery", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
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
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
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
    ).resolves.toEqual({ status: "completed" });

    const recovered = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(recovered?.needsRun).toBe(false);
    expect(recovered ? countPendingConversationMessages(recovered) : 0).toBe(0);
  });

  it("terminalizes invalid idle continuation metadata", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();

    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: 1_000,
      state,
    });
    await upsertAgentTurnSessionRecord({
      conversationId: CONVERSATION_ID,
      sessionId: "turn-invalid-timeout",
      sliceId: 1,
      state: "awaiting_resume",
      resumeReason: "timeout",
      piMessages: [],
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
    ).resolves.toEqual({ status: "completed" });

    const recovered = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(recovered?.lease).toBeUndefined();
    expect(recovered?.needsRun).toBe(false);
    expect(recovered?.messages).toEqual([]);
    await expect(
      getAgentTurnSessionRecord(CONVERSATION_ID, "turn-invalid-timeout"),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage:
        "Awaiting turn continuation metadata could not be materialized",
    });
  });

  it("terminalizes stale idle continuations skipped by resume startup", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const sessionId = "turn_1712345_0001";

    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: 1_000,
      state,
    });
    await upsertAgentTurnSessionRecord({
      conversationId: CONVERSATION_ID,
      sessionId,
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
    await persistThreadStateById(CONVERSATION_ID, {
      artifacts: {
        listColumnMap: {},
      },
      conversation: {
        schemaVersion: 1,
        backfill: {},
        compactions: [],
        piMessages: [],
        messages: [
          {
            id: "1712345.0001",
            role: "user",
            text: "original request",
            createdAtMs: 1_000,
            author: {
              userId: "U123",
            },
          },
        ],
        processing: {
          activeTurnId: "turn-newer",
        },
        stats: {
          compactedMessageCount: 0,
          estimatedContextTokens: 0,
          totalMessageCount: 1,
          updatedAtMs: 1_000,
        },
        vision: {
          byFileId: {},
        },
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
              throw new Error("injected messages should not replay");
            },
            handleSubscribedMessage: async () => {
              throw new Error("injected messages should not replay");
            },
          },
          state,
        }),
      }),
    ).resolves.toEqual({ status: "completed" });

    const recovered = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(recovered?.lease).toBeUndefined();
    expect(recovered?.needsRun).toBe(false);
    expect(recovered?.messages).toEqual([]);
    await expect(
      getAgentTurnSessionRecord(CONVERSATION_ID, sessionId),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage: "Awaiting turn continuation was stale before resuming",
    });
  });

  it("keeps Slack mailbox records pending when input commit fails", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: {
          handleNewMention: async () => {
            throw new Error("runtime failed before input commit");
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).rejects.toThrow("runtime failed before input commit");

    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.lease).toBeUndefined();
    expect(work ? countPendingConversationMessages(work) : 0).toBe(1);
    expect(work?.messages[0]?.injectedAtMs).toBeUndefined();
  });

  it("requeues Slack mailbox records when the runtime returns without input commit", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> follow-up during resume`,
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });
    queue.clearSentRecords();

    let handled = 0;
    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        nowMs: () => 3_000,
        queue,
        runtime: {
          handleNewMention: async () => {
            handled += 1;
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "pending_requeued" });

    expect(handled).toBe(1);
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        idempotencyKey: `pending:${CONVERSATION_ID}:3000`,
      }),
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.lease).toBeUndefined();
    expect(work?.needsRun).toBe(true);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(1);
    expect(work?.messages[0]?.injectedAtMs).toBeUndefined();
  });

  it("reports lost lease when input commit loses the mailbox lease", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    let currentNowMs = 1_000;

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> follow-up during lease loss`,
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });
    queue.clearSentRecords();

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        nowMs: () => currentNowMs,
        queue,
        runtime: {
          handleNewMention: async (_thread, _message, hooks) => {
            currentNowMs = 1_000 + CONVERSATION_WORK_LEASE_TTL_MS + 1;
            await recoverConversationWork({
              nowMs: currentNowMs,
              queue,
              state,
            });
            await hooks?.onInputCommitted?.();
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "lost_lease" });

    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        idempotencyKey: `heartbeat:lease:${CONVERSATION_ID}:${currentNowMs}`,
      }),
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.lease).toBeUndefined();
    expect(work?.needsRun).toBe(true);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(1);
    expect(work?.messages[0]?.injectedAtMs).toBeUndefined();
  });

  it("completes Slack mailbox work when the handler finishes after the soft deadline", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    let currentNowMs = 1_000;

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });
    queue.clearSentRecords();

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        nowMs: () => currentNowMs,
        queue,
        runtime: {
          handleNewMention: async (_thread, _message, hooks) => {
            currentNowMs = 242_000;
            await hooks?.onInputCommitted?.();
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(queue.sentRecords()).toEqual([]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.needsRun).toBe(false);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
  });

  it("yields Slack mailbox work after a persisted safe boundary", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    let currentNowMs = 1_000;

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });
    queue.clearSentRecords();

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        nowMs: () => currentNowMs,
        queue,
        runtime: {
          handleNewMention: async (_thread, _message, hooks) => {
            await hooks?.onInputCommitted?.();
            currentNowMs = 242_000;
            throw new CooperativeTurnYieldError();
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "yielded" });

    expect(queue.sentRecords()).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `yield:${CONVERSATION_ID}:242000`,
      },
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.lease).toBeUndefined();
    expect(work?.needsRun).toBe(true);
    expect(work?.messages.map((message) => message.injectedAtMs)).toEqual([
      expect.any(Number),
    ]);
  });
});
