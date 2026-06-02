import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message, Thread } from "chat";
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
import { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import {
  CONVERSATION_ID,
  createFakeQueue,
  SLACK_BOT_USER_ID,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";

describe("Slack conversation work execution", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("persists Slack mentions into the durable mailbox and wakes the queue", async () => {
    const queue = createFakeQueue();
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

  it("routes edited Slack mentions through the durable mailbox", async () => {
    const queue = createFakeQueue();
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
    expect(queue.sent).toEqual([
      expect.objectContaining({
        conversationId: `slack:C123:${editedTs}`,
        idempotencyKey: `slack:T123:slack:C123:${editedTs}:${editedTs}:message_changed_mention`,
      }),
    ]);

    const calls: Array<{ message: Message; thread: Thread }> = [];
    await expect(
      processConversationWork(`slack:C123:${editedTs}`, {
        queue,
        state,
        run: createSlackConversationWorker({
          getSlackAdapter: () => slackAdapter,
          runtime: {
            handleNewMention: async (thread, message) => {
              calls.push({ thread, message });
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
    expect(calls[0]?.thread.id).toBe(`slack:C123:${editedTs}`);
    expect(calls[0]?.message.id).toBe(`${editedTs}:message_changed_mention`);
    expect(calls[0]?.message.text).toBe(editedText);
    expect(calls[0]?.message.isMention).toBe(true);
  });

  it("runs queued Slack mailbox work through the Slack runtime", async () => {
    const queue = createFakeQueue();
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

  it("keeps restored thread context aligned with promoted mention routing", async () => {
    const queue = createFakeQueue();
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

    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        state,
        run: createSlackConversationWorker({
          getSlackAdapter: () => slackAdapter,
          runtime: {
            handleNewMention: async (thread, message, hooks) => {
              subscribedValues.push(await thread.isSubscribed());
              calls.push({
                thread,
                message,
                skipped: hooks?.messageContext?.skipped ?? [],
              });
            },
            handleSubscribedMessage: async () => {
              throw new Error(
                "mixed mention batches should promote to mention",
              );
            },
          },
          state,
        }),
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.message.id).toBe("1712345.0002");
    expect(calls[0]?.skipped.map((message) => message.id)).toEqual([
      "1712345.0001",
    ]);
    expect(subscribedValues).toEqual([false]);
  });

  it("processes pending Slack follow-ups before timeout continuation", async () => {
    const queue = createFakeQueue();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
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

  it("drains Slack messages that arrive during an active turn into steering", async () => {
    const queue = createFakeQueue();
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
    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        state,
        run: createSlackConversationWorker({
          getSlackAdapter: () => slackAdapter,
          runtime: {
            handleNewMention: async (_thread, _message, hooks) => {
              await hooks?.onTurnStatePersisted?.();
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
          },
          state,
        }),
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
  });

  it("does not replay injected Slack mailbox records after lease recovery", async () => {
    const queue = createFakeQueue();
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
    expect(recovered?.needsRun).toBe(false);
    expect(recovered ? countPendingConversationMessages(recovered) : 0).toBe(0);
  });

  it("keeps idle Slack work runnable when continuation metadata is invalid", async () => {
    const queue = createFakeQueue();
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
    ).rejects.toThrow(
      'Unable to build continuation request for turn session "turn-invalid-timeout"',
    );

    const recovered = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(recovered?.lease).toBeUndefined();
    expect(recovered?.needsRun).toBe(true);
    expect(recovered?.messages).toEqual([]);
  });

  it("keeps Slack mailbox records pending when the runtime handoff fails", async () => {
    const queue = createFakeQueue();
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

  it("reports lost lease when Slack injection marking loses ownership", async () => {
    const queue = createFakeQueue();
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

    let handled = 0;
    const worker = createSlackConversationWorker({
      getSlackAdapter: () => slackAdapter,
      runtime: {
        handleNewMention: async () => {
          handled += 1;
        },
        handleSubscribedMessage: async () => {
          throw new Error("unexpected subscribed route");
        },
      },
      state,
    });

    await expect(
      worker({
        checkIn: async () => true,
        conversationId: CONVERSATION_ID,
        drainMailbox: async () => [],
        leaseToken: "stale-lease",
        shouldYield: () => false,
      }),
    ).resolves.toEqual({ status: "lost_lease" });

    expect(handled).toBe(1);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work ? countPendingConversationMessages(work) : 0).toBe(1);
  });

  it("completes Slack mailbox work when the handler finishes after the soft deadline", async () => {
    const queue = createFakeQueue();
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

  it("yields Slack mailbox work after a persisted safe boundary", async () => {
    const queue = createFakeQueue();
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
    queue.sent = [];

    await expect(
      processConversationWork(CONVERSATION_ID, {
        nowMs: () => currentNowMs,
        queue,
        state,
        run: createSlackConversationWorker({
          getSlackAdapter: () => slackAdapter,
          runtime: {
            handleNewMention: async (_thread, _message, hooks) => {
              await hooks?.onTurnStatePersisted?.();
              currentNowMs = 242_000;
              throw new CooperativeTurnYieldError();
            },
            handleSubscribedMessage: async () => {
              throw new Error("unexpected subscribed route");
            },
          },
          state,
        }),
      }),
    ).resolves.toEqual({ status: "yielded" });

    expect(queue.sent).toMatchObject([
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
