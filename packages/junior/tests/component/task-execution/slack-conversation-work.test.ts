import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Message, ThreadImpl, type StateAdapter, type Thread } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import {
  CooperativeTurnYieldError,
  TurnInputDeferredError,
} from "@/chat/runtime/turn";
import { getSlackClient } from "@/chat/slack/client";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import {
  appendInboundMessage,
  CONVERSATION_WORK_LEASE_TTL_MS,
  CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS,
  countPendingConversationMessages,
  getConversationWorkState,
  ackMessages,
  requestConversationWork,
  startConversationWork,
} from "@/chat/task-execution/store";
import { processConversationWork } from "@/chat/task-execution/worker";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  buildSlackInboundMessage,
  createSlackConversationWorker,
  createSlackResourceEventInboundMessage,
} from "@/chat/task-execution/slack-work";
import { getMessageActorIdentity } from "@/chat/services/message-actor-identity";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  failAgentTurnSessionRecord,
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  conversationQueueMessage,
  createConversationWorkQueueTestAdapter,
  SLACK_BOT_USER_ID,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  type ConversationWorkQueueTestAdapter,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import { flattenAgentRunRequestForTest } from "../../fixtures/agent-runner";

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
      resumeAwaitingContinuation:
        args.resumeAwaitingContinuation ?? (async () => false),
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
    resetSlackApiMockState();
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
    expect(queue.queuedMessages()).toEqual([conversationQueueMessage()]);
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

  it("routes resource-event mailbox records without Slack requester lookup", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const lookupSlackUser = vi.fn(async () => {
      throw new Error("resource event notifications do not have Slack users");
    });
    const calls: Message[] = [];

    await appendInboundMessage({
      message: createSlackResourceEventInboundMessage({
        event: {
          eventKey: "check-suite-1",
          eventType: "checks.failed",
          occurredAtMs: 1_700_000_000_000,
          provider: "github",
          resourceRef: "github:pull_request:getsentry/junior#691",
        },
        subscription: {
          conversationId: CONVERSATION_ID,
          destination: SLACK_DESTINATION,
          id: "resub_1",
        },
        text: "[event notification]\n\nA subscribed resource changed.",
      }),
      state,
    });
    await queue.send(conversationQueueMessage(), {
      idempotencyKey: "resource-event-test",
    });

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        lookupSlackUser,
        queue,
        runtime: {
          handleNewMention: async () => {
            throw new Error("unexpected mention route");
          },
          handleSubscribedMessage: async (_thread, message, hooks) => {
            await hooks.ack?.();
            calls.push(message);
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(lookupSlackUser).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.raw).toMatchObject({ event_type: "resource_event" });
    expect(calls[0]?.raw).not.toHaveProperty("ts");
    expect(getMessageActorIdentity(calls[0]!)).toEqual({
      userId: "UJRNEVENT",
    });
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
            await hooks.ack?.();
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
      destination: unknown;
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
        await hooks.ack?.();
        calls.push({
          destination: hooks.destination,
          thread,
          message,
          skipped: hooks.messageContext?.skipped ?? [],
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
    expect(calls[0]?.destination).toEqual(SLACK_DESTINATION);
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

  it("binds resolved Slack requester before runtime handling", async () => {
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
        await hooks.ack?.();
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
      platform: "slack",
      teamId: "T123",
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
        await hooks.ack?.();
        subscribedValues.push(await thread.isSubscribed());
        calls.push({
          thread,
          message,
          skipped: hooks.messageContext?.skipped ?? [],
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

  it("processes pending Slack follow-ups before checking idle continuations", async () => {
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
            await hooks.ack?.();
            calls.push(message.text);
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(resumeAwaitingContinuation).not.toHaveBeenCalled();
    expect(calls).toEqual([expect.stringContaining("follow-up")]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
  });

  it("routes pending Slack follow-ups before awaiting continuations", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const resumeAwaitingContinuation = vi.fn(async () => true);
    const calls: string[] = [];

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
          handleNewMention: async (_thread, message, hooks) => {
            await hooks.ack?.();
            calls.push(message.text);
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(resumeAwaitingContinuation).not.toHaveBeenCalled();
    expect(calls).toEqual([expect.stringContaining("follow-up")]);
    expect(queue.sentRecords()).toEqual([]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.lease).toBeUndefined();
    expect(work?.needsRun).toBe(false);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
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
    const runtime: SlackWorkerOptions["runtime"] = {
      handleNewMention: async (_thread, _message, hooks) => {
        await hooks.ack?.();
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
        await hooks.drainSteeringMessages?.(async (steering) => {
          injected.push(steering.map((candidate) => candidate.message.id));
          return steering.map((candidate) => candidate.inboundMessageId);
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

    expect(injected).toEqual([["1712345.0002"]]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.messages).toEqual([]);
    expect(work?.execution.inboundMessageIds).toEqual([
      "slack:T123:slack:C123:1712345.0001:1712345.0001",
      "slack:T123:slack:C123:1712345.0001:1712345.0002",
    ]);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
    await expectRemainingQueuedSlackWorkIsNoop({
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime,
      state,
    });
  });

  it("treats Slack assistant-thread user messages as active steering", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const dmChannelId = "D123";
    const threadTs = "1712345.1001";
    const conversationId = `slack:${dmChannelId}:${threadTs}`;
    const ingressServices = {
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    };
    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          channel: dmChannelId,
          eventType: "message",
          text: "first",
          threadTs,
          ts: threadTs,
        }),
      ),
      services: ingressServices,
    });

    const observed: Array<Array<{ activeRequest: boolean; id: string }>> = [];
    const runtime: SlackWorkerOptions["runtime"] = {
      handleNewMention: async (_thread, _message, hooks) => {
        await hooks.ack?.();
        const followUp = new Message({
          id: "1712345.1002",
          threadId: conversationId,
          text: "steer this assistant thread",
          attachments: [],
          metadata: { dateSent: new Date(1_000), edited: false },
          formatted: { type: "root", children: [] },
          raw: {
            channel: dmChannelId,
            channel_type: "im",
            thread_ts: threadTs,
            ts: "1712345.1002",
            user: "U123",
          },
          author: {
            userId: "U123",
            userName: "",
            fullName: "",
            isBot: false,
            isMe: false,
          },
        });
        const thread = new ThreadImpl({
          adapter: slackAdapter,
          stateAdapter: state,
          id: conversationId,
          channelId: dmChannelId,
          currentMessage: followUp,
          initialMessage: followUp,
          isDM: true,
          isSubscribedContext: true,
        });
        await appendInboundMessage({
          message: buildSlackInboundMessage({
            conversationId,
            installation: { teamId: "T123" },
            message: followUp,
            receivedAtMs: 1_100,
            route: "subscribed",
            thread,
          }),
          state,
        });
        await hooks.drainSteeringMessages?.(async (steering) => {
          observed.push(
            steering.map((candidate) => ({
              activeRequest: candidate.activeRequest,
              id: candidate.message.id,
            })),
          );
          return steering.map((candidate) => candidate.inboundMessageId);
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

    expect(observed).toEqual([[{ activeRequest: true, id: "1712345.1002" }]]);
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
    await ackMessages({
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
      destination: SLACK_DESTINATION,
      nowMs: 1_000,
      state,
    });
    const sessionRecord = await upsertAgentTurnSessionRecord({
      conversationId: CONVERSATION_ID,
      sessionId: "turn-invalid-timeout",
      sliceId: 1,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
      resumeReason: "timeout",
      piMessages: [],
    });

    await expect(
      processConversationWork(conversationQueueMessage(), {
        queue,
        state,
        run: createSlackConversationWorker({
          getSlackAdapter: () => slackAdapter,
          resumeAwaitingContinuation: async () => {
            await failAgentTurnSessionRecord({
              conversationId: CONVERSATION_ID,
              expectedVersion: sessionRecord.version,
              sessionId: "turn-invalid-timeout",
              errorMessage:
                "Awaiting agent continuation metadata could not be materialized",
            });
            return false;
          },
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
        "Awaiting agent continuation metadata could not be materialized",
    });
  });

  it("binds the destination installation token while recovering idle continuations", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const resolveTokenForTeam = vi.fn(
      async (teamId: string, isEnterpriseInstall?: boolean) => ({
        botUserId: SLACK_BOT_USER_ID,
        token: `xoxb-${isEnterpriseInstall ? "enterprise" : teamId}`,
      }),
    );
    const requestContextRun = vi.fn(
      async (_context: unknown, fn: () => Promise<void>) => await fn(),
    );
    const slackAdapter = {
      botUserId: SLACK_BOT_USER_ID,
      initialize: vi.fn(async () => {}),
      requestContext: {
        run: requestContextRun,
      },
      resolveTokenForTeam,
    } as unknown as SlackAdapter;

    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: 1_000,
      state,
    });

    let observedToken: string | undefined;
    await expect(
      processConversationWork(conversationQueueMessage(), {
        queue,
        state,
        run: createSlackConversationWorker({
          getSlackAdapter: () => slackAdapter,
          resumeAwaitingContinuation: async () => {
            observedToken = getSlackClient().token;
            return true;
          },
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

    expect(resolveTokenForTeam).toHaveBeenCalledWith("T123", undefined);
    expect(requestContextRun).toHaveBeenCalledWith(
      expect.objectContaining({ token: "xoxb-T123" }),
      expect.any(Function),
    );
    expect(observedToken).toBe("xoxb-T123");
  });

  it("terminalizes stale idle continuations skipped by resume startup", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const sessionId = "turn_1712345_0001";

    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: 1_000,
      state,
    });
    const sessionRecord = await upsertAgentTurnSessionRecord({
      conversationId: CONVERSATION_ID,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
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
      processConversationWork(conversationQueueMessage(), {
        queue,
        state,
        run: createSlackConversationWorker({
          getSlackAdapter: () => slackAdapter,
          resumeAwaitingContinuation: async () => {
            await failAgentTurnSessionRecord({
              conversationId: CONVERSATION_ID,
              expectedVersion: sessionRecord.version,
              sessionId,
              errorMessage:
                "Awaiting agent continuation was stale before it could run",
            });
            return false;
          },
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
      errorMessage: "Awaiting agent continuation was stale before it could run",
    });
  });

  it("exposes final attempt state to the runtime failure path", async () => {
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

    const observed: Array<boolean | undefined> = [];
    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: {
          handleNewMention: async (_thread, _message, hooks) => {
            observed.push(hooks.isFinalAttempt);
            await hooks.ack?.();
            observed.push(hooks.isFinalAttempt);
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(observed).toEqual([false, false]);
  });

  it("keeps Slack mailbox records pending when ack fails", async () => {
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
            throw new Error("runtime failed before ack");
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "failed" });

    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.lease).toBeUndefined();
    expect(work ? countPendingConversationMessages(work) : 0).toBe(1);
    expect(work?.messages[0]?.injectedAtMs).toBeUndefined();
    expect(work?.messages[0]?.attemptCount).toBe(1);
  });

  it("marks the terminal Slack delivery attempt before dead-lettering", async () => {
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

    const observed: boolean[] = [];
    const runtime: SlackWorkerOptions["runtime"] = {
      handleNewMention: async (_thread, _message, hooks) => {
        observed.push(hooks.isFinalAttempt === true);
        throw new Error("runtime failed before ack");
      },
      handleSubscribedMessage: async () => {
        throw new Error("unexpected subscribed route");
      },
    };

    for (
      let attempt = 1;
      attempt < CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS;
      attempt += 1
    ) {
      await expect(
        processNextQueuedSlackWork({
          getSlackAdapter: () => slackAdapter,
          queue,
          runtime,
          state,
        }),
      ).resolves.toEqual({ status: "failed" });
      const work = await getConversationWorkState({
        conversationId: CONVERSATION_ID,
        state,
      });
      expect(work?.messages[0]?.attemptCount).toBe(attempt);
      expect(queue.hasQueuedMessages()).toBe(true);
    }

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime,
        state,
      }),
    ).resolves.toEqual({ status: "failed" });

    expect(observed).toEqual([false, false, false, false, true]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.messages).toEqual([]);
    expect(work?.needsRun).toBe(false);
    expect(work?.execution.status).toBe("failed");
  });

  it("posts one fallback reply on the final queued Slack delivery attempt", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () => {
              throw new Error("persistent queued failure");
            },
          },
        },
      },
    });

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

    for (
      let attempt = 1;
      attempt < CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS;
      attempt += 1
    ) {
      await expect(
        processNextQueuedSlackWork({
          getSlackAdapter: () => slackAdapter,
          queue,
          runtime: slackRuntime,
          state,
        }),
      ).resolves.toEqual({ status: "pending_requeued" });
      expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);
    }

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: slackRuntime,
        state,
      }),
    ).resolves.toEqual({ status: "failed" });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          text: expect.stringContaining(
            "I ran into an internal error while processing that.",
          ),
        }),
      }),
    ]);
  });

  it("requeues deferred Slack mailbox records without consuming retry attempts", async () => {
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
            throw new TurnInputDeferredError();
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
        idempotencyKey: `deferred:${CONVERSATION_ID}:3000`,
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
    expect(work?.messages[0]?.attemptCount).toBeUndefined();
  });

  it("reports lost lease when ack loses the mailbox lease", async () => {
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
            await hooks.ack?.();
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
            await hooks.ack?.();
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
            await hooks.ack?.();
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
    expect(work?.messages).toEqual([]);
    expect(work?.execution.inboundMessageIds).toEqual(
      expect.arrayContaining([
        "slack:T123:slack:C123:1712345.0001:1712345.0001",
      ]),
    );
  });

  it("keeps yielded executor outcomes resumable without failure recovery", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    let currentNowMs = 1_000;
    let yieldedSessionId: string | undefined;
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const _text = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              await context?.onInputCommitted?.();
              await context?.onArtifactStateUpdated?.({
                lastCanvasId: "F_YIELD_CANVAS",
                lastCanvasUrl: "https://slack.example/docs/T/F_YIELD_CANVAS",
                recentCanvases: [
                  {
                    id: "F_YIELD_CANVAS",
                    title: "Yielded canvas",
                    url: "https://slack.example/docs/T/F_YIELD_CANVAS",
                    createdAt: "2026-07-02T12:00:00.000Z",
                  },
                ],
              });
              currentNowMs = 242_000;
              yieldedSessionId = context?.correlation?.turnId;
              return { status: "suspended", resumeVersion: 1 };
            },
          },
        },
      },
    });

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> create the canvas and continue later`,
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
        runtime: slackRuntime,
        state,
      }),
    ).resolves.toEqual({ status: "yielded" });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);
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
    expect(work?.needsRun).toBe(true);
    expect(work?.messages).toEqual([]);
    const persistedState = await getPersistedThreadState(CONVERSATION_ID);
    const conversation = coerceThreadConversationState(persistedState);
    expect(conversation.processing.activeTurnId).toBe(yieldedSessionId);
    const sessionRecord = await getAgentTurnSessionRecord(
      CONVERSATION_ID,
      yieldedSessionId ?? "",
    );
    expect(sessionRecord?.state).not.toBe("failed");
  });
});
