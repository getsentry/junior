import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFauxCore,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createConversationWork } from "@/chat/app/conversation-work";
import { loadProjection } from "@/chat/conversations/projection";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { executeAgentRun } from "@/chat/agent";
import type { PiMessage } from "@/chat/pi/messages";
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
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
  SLACK_BOT_USER_ID,
  createSlackAdapterFixture,
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
    next: async () =>
      await processConversationQueueMessage(wakes.takeMessage(), {
        queue: wakes,
        run,
        state,
      }),
    send: async () =>
      await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          slackEnvelope({
            text: `<@${SLACK_BOT_USER_ID}> inspect the deploy`,
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

  it("commits and delivers accepted input exactly once", async () => {
    const q = await slack();
    await expect(q.send()).resolves.toMatchObject({ status: 200 });
    await expect(q.next()).resolves.toEqual({ status: "completed" });

    expect(slackApiOutbox.messages().map((call) => call.params.text)).toEqual([
      "Deploy checked.",
    ]);
    expect(
      JSON.stringify(await loadProjection({ conversationId: CONVERSATION_ID })),
    ).toContain("Deploy checked.");
    await expect(
      getTurnRecord(CONVERSATION_ID, "turn_1712345_0001"),
    ).resolves.toMatchObject({ state: "completed" });
    await expect(q.next()).rejects.toThrow("Expected queued conversation work");
    await expect(
      getConversationWorkState({
        conversationId: CONVERSATION_ID,
        state: q.state,
      }),
    ).resolves.toMatchObject({ needsRun: false, messages: [] });
  });

  it("retries uncommitted input without duplicate delivery", async () => {
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
    expect(slackApiOutbox.messages().map((call) => call.params.text)).toEqual([
      "Deploy checked.",
    ]);
  });

  it("stops a paused turn that repeats its committed boundary", async () => {
    const turnId = await seedTurn("paused");
    const q = await slack({
      shouldYield: () => true,
      pausedRunner: {
        run: async (request) => {
          const piMessages = request.input.piMessages?.map((message) =>
            message.role === "assistant"
              ? { ...message, usage: { ...message.usage, output: 99 } }
              : message,
          );
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
              policy: { ...request.policy, turnDeadlineAtMs: Date.now() + 10 },
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
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: Date.now() + 60_000,
      state: q.state,
    });
    await ensureConversationWake({
      conversationId: CONVERSATION_ID,
      idempotencyKey: "stuck-turn-redelivery",
      nowMs: Date.now() + 60_000,
      queue: q.wakes,
      state: q.state,
    });
    await expect(q.next()).resolves.toEqual({ status: "completed" });
    expect(q.wakes.hasQueuedMessages()).toBe(false);
    expect(slackApiOutbox.messages()).toHaveLength(1);
    expect(
      JSON.stringify(await loadProjection({ conversationId: CONVERSATION_ID })),
    ).toContain("inspect the deploy");
    await expect(getTurnRecord(CONVERSATION_ID, turnId)).resolves.toMatchObject(
      {
        state: "failed",
        errorMessage: expect.stringContaining("made no progress"),
      },
    );
  });

  it("stops a stranded turn while preserving committed history", async () => {
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
    await expect(getTurnRecord(CONVERSATION_ID, turnId)).resolves.toMatchObject(
      {
        state: "failed",
        errorMessage: expect.stringContaining("lost its worker"),
      },
    );
    expect(
      JSON.stringify(await loadProjection({ conversationId: CONVERSATION_ID })),
    ).toContain("inspect the deploy");
    expect(slackApiOutbox.messages()).toHaveLength(1);
  });

  it("stops at the retry limit without duplicate delivery", async () => {
    let attempts = 0;
    const q = await slack({
      agentRunner: {
        run: async () => {
          attempts += 1;
          throw new Error("agent unavailable");
        },
      },
    });
    await q.send();

    const results: string[] = [];
    while (q.wakes.hasQueuedMessages()) results.push((await q.next()).status);

    expect(results.at(-1)).toBe("failed");
    expect(attempts).toBe(CONVERSATION_WORK_MAX_RETRIES);
    expect(slackApiOutbox.messages()).toHaveLength(1);
    await expect(
      getConversationWorkState({
        conversationId: CONVERSATION_ID,
        state: q.state,
      }),
    ).resolves.toMatchObject({ needsRun: false, messages: [] });
  });
});
