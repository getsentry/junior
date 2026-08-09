import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFauxCore,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createConversationWork } from "@/chat/app/conversation-work";
import { commitAcceptedReply } from "@/chat/conversations/projection";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { AgentRunSteeringMessage } from "@/chat/agent/request";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { executeAgentRun } from "@/chat/agent";
import type { PiMessage } from "@/chat/pi/messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { getConversationStore } from "@/chat/db";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import {
  CONVERSATION_WORK_LEASE_TTL_MS,
  CONVERSATION_WORK_MAX_RETRIES,
  ensureConversationWake,
  getConversationWorkState,
  requestConversationWork,
  startConversationWork,
} from "@/chat/task-execution/store";
import {
  getTurnRecord,
  listTurnSummaries,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
  SLACK_BOT_USER_ID,
  createSlackAdapterFixture,
  deferred,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../fixtures/conversation-work";
import { deliverAssistantMessagesForTest } from "../fixtures/agent-runner";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";

async function complete(request: Parameters<AgentRunner["run"]>[0]) {
  await request.durability?.onInputCommitted?.();
  const piMessages = await deliverAssistantMessagesForTest(request, [
    { text: "Deploy checked." },
  ]);
  return completedAgentRun({
    diagnostics: {
      assistantMessageCount: 1,
      modelId: "test-model",
      outcome: "success",
      toolCalls: [],
      toolErrorCount: 0,
      toolResultCount: 0,
      usedPrimaryText: true,
    },
    piMessages,
    text: "Deploy checked.",
  });
}

/**
 * Compose the same ingress, runtime, worker, resume, SQL, and delivery path used
 * in production. Tests replace agent behavior and Slack HTTP, select the real
 * memory-backed StateAdapter, and use an in-memory implementation of the queue's
 * one-method transport port. The Vercel transport has its own contract test.
 */
async function slack(
  options: {
    agentRunner?: AgentRunner;
    pausedRunner?: AgentRunner;
    shouldYield?: () => boolean;
  } = {},
) {
  const state = getStateAdapter();
  await state.connect();
  const wakes = createConversationWorkQueueTestAdapter();
  const adapter = createSlackAdapterFixture();
  const agentRunner = options.agentRunner ?? { run: complete };
  const work = createConversationWork({
    agentRunner: options.pausedRunner ?? agentRunner,
    conversationStore: getConversationStore(),
    getSlackAdapter: () => adapter,
    queue: wakes,
    services: { replyExecutor: { agentRunner } },
    state,
  });
  const run = async (context: Parameters<typeof work.run>[0]) =>
    await work.run({
      ...context,
      shouldYield: options.shouldYield ?? context.shouldYield,
    });
  return {
    state,
    wakes,
    replies: () => slackApiOutbox.messages().map((call) => call.params.text),
    next: async () =>
      await processConversationQueueMessage(wakes.takeMessage(), {
        queue: wakes,
        run,
        state,
      }),
    send: async (
      input: {
        eventType?: "app_mention" | "message";
        text?: string;
        threadTs?: string;
        ts?: string;
      } = {},
    ) =>
      await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          slackEnvelope({
            text: `<@${SLACK_BOT_USER_ID}> inspect the deploy`,
            ...input,
          }),
        ),
        services: {
          getSlackAdapter: () => adapter,
          queue: wakes,
          runtime: work.runtime,
          state,
        },
      }),
  };
}

type QueueTest = Awaited<ReturnType<typeof slack>>;

/** Assert the durable state left by a turn that cannot run again. */
async function expectTerminalTurn(
  q: QueueTest,
  expected: {
    turnId: string;
    state: "completed" | "failed";
    replies: string[] | number;
    error?: string;
  },
): Promise<void> {
  const record = await getTurnRecord(CONVERSATION_ID, expected.turnId);
  expect(record).toMatchObject({
    state: expected.state,
    turnId: expected.turnId,
  });
  expect(record?.errorMessage ?? "").toContain(expected.error ?? "");
  await expect(listTurnSummaries(CONVERSATION_ID)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        state: expected.state,
        turnId: expected.turnId,
      }),
    ]),
  );

  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(CONVERSATION_ID),
  );
  await hydrateConversationMessages({
    conversation,
    conversationId: CONVERSATION_ID,
  });
  expect(conversation.processing.activeTurnId).toBeUndefined();
  expect(conversation.processing.pendingAuth).toBeUndefined();
  await expect(
    getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state: q.state,
    }),
  ).resolves.toMatchObject({ needsRun: false, messages: [] });
  expect(q.wakes.hasQueuedMessages()).toBe(false);

  const replies = q.replies();
  expect(replies).toHaveLength(
    typeof expected.replies === "number"
      ? expected.replies
      : expected.replies.length,
  );
  expect(replies.join("\n")).toContain(
    typeof expected.replies === "number" ? "" : expected.replies.join("\n"),
  );
}

/** Prove that a terminal turn does not block a later user request. */
async function expectNextTurn(q: QueueTest, ts: string): Promise<void> {
  const priorReplies = q.replies();
  await q.send({
    text: `<@${SLACK_BOT_USER_ID}> check the next deploy`,
    threadTs: "1712345.0001",
    ts,
  });
  await expect(q.next()).resolves.toEqual({ status: "completed" });
  await expectTerminalTurn(q, {
    turnId: `turn_${ts.replace(".", "_")}`,
    state: "completed",
    replies: [...priorReplies, "Deploy checked."],
  });
}

/** Assert the durable state left by a turn that waits for an external event. */
async function expectPausedTurn(
  q: QueueTest,
  expected: { turnId: string; reason: "auth"; replies: number },
): Promise<void> {
  await expect(
    getTurnRecord(CONVERSATION_ID, expected.turnId),
  ).resolves.toMatchObject({
    state: "paused",
    resumeReason: expected.reason,
  });
  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(CONVERSATION_ID),
  );
  expect(conversation.processing.pendingAuth).toMatchObject({
    sessionId: expected.turnId,
  });
  await expect(
    getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state: q.state,
    }),
  ).resolves.toMatchObject({ needsRun: false, messages: [] });
  expect(q.wakes.hasQueuedMessages()).toBe(false);
  expect(q.replies()).toHaveLength(expected.replies);
}

function history(): PiMessage[] {
  const assistant = fauxAssistantMessage("checking");
  assistant.timestamp = 2;
  assistant.content.push({
    type: "toolCall",
    id: "call-1",
    name: "bash",
    arguments: { command: "echo ok" },
  });
  return [
    {
      role: "user",
      content: [{ type: "text", text: "inspect the deploy" }],
      timestamp: 1,
    },
    assistant,
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 3,
    },
  ];
}

/** Seed only the persisted condition that a dead prior invocation leaves behind. */
async function seedTurn(mode: "paused" | "running") {
  const turnId = "turn_1712345_0001";
  const checkpoint = {
    conversationId: CONVERSATION_ID,
    turnId,
    sliceId: 1,
    modelId: "test-model",
    messages: history(),
    destination: SLACK_DESTINATION,
    source: createSlackSource({
      teamId: SLACK_DESTINATION.teamId,
      channelId: SLACK_DESTINATION.channelId,
      threadTs: "1712345.0001",
      visibility: "private",
    }),
    surface: "slack" as const,
  };
  if (mode === "paused") {
    await saveTurnCheckpoint({ ...checkpoint, mode, reason: "timeout" });
  } else {
    await saveTurnCheckpoint({ ...checkpoint, mode });
  }
  await persistThreadStateById(CONVERSATION_ID, {
    conversation: {
      schemaVersion: 1,
      compactions: [],
      messages: [
        {
          id: "1712345.0001",
          role: "user",
          text: "inspect the deploy",
          createdAtMs: 1,
          author: { userId: "U123" },
        },
      ],
      processing: { activeTurnId: turnId },
      vision: { byFileId: {} },
    },
  });
  return turnId;
}

describe("durable queue contract", () => {
  beforeEach(async () => {
    resetSlackApiMockState();
    await disconnectStateAdapter();
  });
  afterEach(async () => {
    resetSlackApiMockState();
    await disconnectStateAdapter();
  });

  describe("success", () => {
    it("commits and delivers one turn exactly once", async () => {
      const q = await slack();
      await expect(q.send()).resolves.toMatchObject({ status: 200 });
      await expect(q.next()).resolves.toEqual({ status: "completed" });

      await expectTerminalTurn(q, {
        turnId: "turn_1712345_0001",
        state: "completed",
        replies: ["Deploy checked."],
      });
    });
  });

  describe("interrupts", () => {
    it("steers an explicit mid-turn instruction into the active turn", async () => {
      const entered = deferred();
      const release = deferred();
      const steering: AgentRunSteeringMessage[] = [];
      const q = await slack({
        agentRunner: {
          run: async (request) => {
            await request.durability?.onInputCommitted?.();
            entered.resolve(undefined);
            await release.promise;
            await request.durability?.drainSteeringMessages?.(
              async (messages) => {
                steering.push(...messages);
              },
            );
            return await complete(request);
          },
        },
      });
      await q.send({ text: `<@${SLACK_BOT_USER_ID}> inspect the deploy` });

      const activeTurn = q.next();
      await entered.promise;
      await q.send({
        text: `<@${SLACK_BOT_USER_ID}> include the rollback owner`,
        threadTs: "1712345.0001",
        ts: "1712345.0002",
      });
      release.resolve(undefined);

      await expect(activeTurn).resolves.toEqual({ status: "completed" });
      expect(steering.map((message) => message.text)).toEqual([
        "include the rollback owner",
      ]);
      await expectTerminalTurn(q, {
        turnId: "turn_1712345_0001",
        state: "completed",
        replies: ["Deploy checked."],
      });
    });

    it("parks a turn that needs authorization without retrying it", async () => {
      const q = await slack({
        agentRunner: {
          run: async (request) => {
            await request.durability?.onInputCommitted?.();
            await request.durability?.recordPendingAuth?.({
              actorId: "U123",
              kind: "plugin",
              linkSentAtMs: Date.now(),
              provider: "github",
              sessionId: request.turnId,
            });
            await saveTurnCheckpoint({
              mode: "paused",
              reason: "auth",
              actor: request.routing.actor,
              conversationId: request.conversationId,
              destination: request.routing.destination,
              messages: request.input.piMessages ?? [],
              modelId: "test-model",
              sliceId: 1,
              source: request.routing.source,
              surface: request.routing.surface,
              turnId: request.turnId,
            });
            return {
              status: "awaiting_auth" as const,
              providerDisplayName: "GitHub",
            };
          },
        },
      });
      await q.send();

      await expect(q.next()).resolves.toEqual({ status: "completed" });
      await expectPausedTurn(q, {
        turnId: "turn_1712345_0001",
        reason: "auth",
        replies: 1,
      });
    });
  });

  describe("failures", () => {
    it("retries a failure before input commit without duplicate delivery", async () => {
      let attempts = 0;
      const q = await slack({
        agentRunner: {
          run: async (request) => {
            attempts += 1;
            if (attempts === 1) throw new Error("agent unavailable");
            return await complete(request);
          },
        },
      });
      await q.send();

      await expect(q.next()).resolves.toEqual({ status: "pending_requeued" });
      await expect(q.next()).resolves.toEqual({ status: "completed" });
      expect(attempts).toBe(2);
      await expectTerminalTurn(q, {
        turnId: "turn_1712345_0001",
        state: "completed",
        replies: ["Deploy checked."],
      });
    });

    it("continues a paused turn on the same queue, then stops when progress stalls", async () => {
      const turnId = await seedTurn("paused");
      let resumes = 0;
      let shouldYield = true;
      const q = await slack({
        shouldYield: () => shouldYield,
        pausedRunner: {
          run: async (request) => {
            if (request.turnId !== turnId) return await complete(request);
            resumes += 1;
            const piMessages = request.input.piMessages?.map((message) =>
              message.role === "assistant"
                ? { ...message, usage: { ...message.usage, output: 99 } }
                : message,
            );
            if (resumes === 1) {
              const record = await saveTurnCheckpoint({
                mode: "paused",
                reason: "timeout",
                actor: request.routing.actor,
                conversationId: request.conversationId,
                destination: request.routing.destination,
                messages: [
                  ...(piMessages ?? []),
                  {
                    role: "user",
                    content: [{ type: "text", text: "new committed input" }],
                    timestamp: 4,
                  },
                ],
                modelId: "test-model",
                sliceId: 2,
                source: request.routing.source,
                surface: request.routing.surface,
                turnId: request.turnId,
              });
              if (!record) throw new Error("Expected paused checkpoint");
              return { status: "suspended", resumeVersion: record.version };
            }
            const faux = createFauxCore({ api: "test", provider: "test" });
            faux.setResponses([
              async () => {
                await new Promise((resolve) => setTimeout(resolve, 50));
                return fauxAssistantMessage("not delivered");
              },
            ]);
            return await executeAgentRun(
              {
                ...request,
                input: { ...request.input, piMessages },
                policy: {
                  ...request.policy,
                  turnDeadlineAtMs: Date.now() + 10,
                },
              },
              faux.stream,
            );
          },
        },
      });
      await requestConversationWork({
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        state: q.state,
      });
      await ensureConversationWake({
        conversationId: CONVERSATION_ID,
        idempotencyKey: "stuck-turn",
        queue: q.wakes,
      });

      await expect(q.next()).resolves.toEqual({ status: "completed" });
      expect(resumes).toBeGreaterThan(1);
      await expectTerminalTurn(q, {
        turnId,
        state: "failed",
        replies: 1,
        error: "made no progress",
      });
      shouldYield = false;
      await expectNextTurn(q, "1712345.0005");
    });

    it("does not report failure after SQL recorded an accepted reply", async () => {
      const turnId = await seedTurn("running");
      await commitAcceptedReply({
        conversationId: CONVERSATION_ID,
        conversationMessageId: `${turnId}:assistant:1`,
        conversation: {
          schemaVersion: 1,
          compactions: [],
          messages: [
            {
              id: "1712345.0001",
              role: "user",
              text: "inspect the deploy",
              createdAtMs: 1,
              author: { userId: "U123" },
              meta: { replied: true },
            },
            {
              id: `${turnId}:assistant:1`,
              role: "assistant",
              text: "Deploy checked.",
              createdAtMs: 2,
              author: { isBot: true },
              meta: { replied: true, slackTs: "1712345.0002" },
            },
          ],
          processing: { activeTurnId: turnId },
          vision: { byFileId: {} },
        },
      });
      const q = await slack();
      expect(
        coerceThreadConversationState(
          await getPersistedThreadState(CONVERSATION_ID),
        ).processing.activeTurnId,
      ).toBe(turnId);
      await requestConversationWork({
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        nowMs: 1_000,
        state: q.state,
      });
      await startConversationWork({
        conversationId: CONVERSATION_ID,
        nowMs: 1_000,
        state: q.state,
      });
      await recoverConversationWork({
        nowMs: 1_000 + CONVERSATION_WORK_LEASE_TTL_MS,
        queue: q.wakes,
        state: q.state,
      });

      await expect(q.next()).resolves.toEqual({ status: "completed" });

      await expectTerminalTurn(q, {
        turnId,
        state: "completed",
        replies: [],
      });

      await expectNextTurn(q, "1712345.0003");
    });

    it("stops a running turn after its worker disappears", async () => {
      const turnId = await seedTurn("running");
      const q = await slack();
      await requestConversationWork({
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        nowMs: 1_000,
        state: q.state,
      });
      await startConversationWork({
        conversationId: CONVERSATION_ID,
        nowMs: 1_000,
        state: q.state,
      });

      await expect(
        recoverConversationWork({
          nowMs: 1_000 + CONVERSATION_WORK_LEASE_TTL_MS,
          queue: q.wakes,
          state: q.state,
        }),
      ).resolves.toEqual({ expiredLeaseCount: 1, pendingCount: 0 });
      await expect(q.next()).resolves.toEqual({ status: "completed" });
      expect(q.wakes.sentRecords()).toHaveLength(1);
      await expectTerminalTurn(q, {
        turnId,
        state: "failed",
        replies: 1,
        error: "lost its worker",
      });
      await expectNextTurn(q, "1712345.0006");
    });

    it("stops at the retry limit without duplicate delivery", async () => {
      let attempts = 0;
      const q = await slack({
        agentRunner: {
          run: async (request) => {
            attempts += 1;
            if (attempts <= CONVERSATION_WORK_MAX_RETRIES) {
              throw new Error("agent unavailable");
            }
            return await complete(request);
          },
        },
      });
      await q.send();

      const results: string[] = [];
      while (q.wakes.hasQueuedMessages()) results.push((await q.next()).status);

      expect(results.at(-1)).toBe("failed");
      expect(attempts).toBe(CONVERSATION_WORK_MAX_RETRIES);
      expect(q.replies()).toHaveLength(1);
      await expect(
        getConversationWorkState({
          conversationId: CONVERSATION_ID,
          state: q.state,
        }),
      ).resolves.toMatchObject({ needsRun: false, messages: [] });
      expect(q.wakes.hasQueuedMessages()).toBe(false);
      await expectNextTurn(q, "1712345.0007");
    });
  });
});
