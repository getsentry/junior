import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  completeAgentInvocation,
  createAgentInvocation,
  getAgentInvocation,
  getAgentInvocationMessageId,
  getAgentInvocationTurnId,
} from "@/chat/agent-invocations/store";
import {
  createAgentInvocationWorker,
  routeAgentInvocationWork,
  createAndEnqueueAgentInvocation,
} from "@/chat/agent-invocations/work";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import { createSpawnAgentTool } from "@/chat/tools/runtime/spawn-agent";
import type { AgentRun } from "@/chat/agent/types";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { loadProjection } from "@/chat/conversations/projection";
import { getConversationEventStore } from "@/chat/db";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { recoverPendingAgentInvocationMailboxAppends } from "@/chat/agent-dispatch/heartbeat";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";
import {
  createModelAgentRunner,
  neverRunAgentRunner,
} from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";
import {
  createLocalSource,
  createSlackSource,
} from "@sentry/junior-plugin-api";
const parentConversationId = "local:test:parent-agent";
const destination = {
  conversationId: parentConversationId,
  platform: "local",
} as const;
const invocationInput = {
  actor: { name: "parent-agent", platform: "system" } as const,
  destination,
  destinationVisibility: "private" as const,
  input: "Summarize the durable task.",
  parentConversationId,
  reasoningLevel: "medium" as const,
  source: createLocalSource(parentConversationId),
};
const slackParentConversationId = "slack:C123:1712345.0001";
const slackDestination = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;
const slackSource = createSlackSource({
  channelId: "C123",
  teamId: "T123",
  threadTs: "1712345.0001",
  visibility: "private",
});
const slackInvocationInput = {
  ...invocationInput,
  destination: slackDestination,
  parentConversationId: slackParentConversationId,
  source: slackSource,
};

async function prepareParentConversation() {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  const conversationStore = createSqlStore(fixture.sql);
  await conversationStore.recordActivity({
    conversationId: parentConversationId,
    destination,
    nowMs: 1_000,
    source: "local",
  });
  return { conversationStore, fixture };
}

async function prepareSlackParentConversation() {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  const conversationStore = createSqlStore(fixture.sql);
  await conversationStore.recordActivity({
    conversationId: slackParentConversationId,
    destination: slackDestination,
    nowMs: 1_000,
    sessionSource: slackSource,
    source: "slack",
    visibility: "private",
  });
  return { conversationStore, fixture };
}

async function loadTurnEvents(conversationId: string) {
  return (await getConversationEventStore().loadHistory(conversationId)).filter(
    (event) =>
      event.data.type === "turn_started" ||
      event.data.type === "turn_completed" ||
      event.data.type === "turn_failed",
  );
}

describe("agent invocation conversation work", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("keeps named bindings stable and idempotent invocation input immutable", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    try {
      const first = await createAgentInvocation(
        {
          ...invocationInput,
          agentName: "researcher",
          idempotencyKey: "named-1",
        },
        2_000,
      );
      const replay = await createAgentInvocation(
        {
          ...invocationInput,
          agentName: "researcher",
          idempotencyKey: "named-1",
        },
        3_000,
      );
      await completeAgentInvocation({
        invocationId: first.invocationId,
        result: "Finished.",
        status: "completed",
      });
      const next = await createAgentInvocation(
        {
          ...invocationInput,
          agentName: "researcher",
          idempotencyKey: "named-2",
        },
        4_000,
      );
      const unnamed = await createAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "unnamed-1",
        },
        5_000,
      );
      const unnamedReplay = await createAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "unnamed-1",
        },
        6_000,
      );
      const otherUnnamed = await createAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "unnamed-2",
        },
        7_000,
      );

      expect(replay).toEqual(first);
      expect(next.invocationId).not.toBe(first.invocationId);
      expect(next.childConversationId).toBe(first.childConversationId);
      expect(unnamedReplay.childConversationId).toBe(
        unnamed.childConversationId,
      );
      expect(otherUnnamed.childConversationId).not.toBe(
        unnamed.childConversationId,
      );
      const child = await conversationStore.get({
        conversationId: first.childConversationId,
      });
      expect(child).toMatchObject({
        parentConversationId,
        source: "internal",
      });
      expect(child).not.toHaveProperty("destination");
      await expect(
        createAgentInvocation({
          ...invocationInput,
          idempotencyKey: "named-1",
          input: "Different input must not reuse the key.",
          agentName: "researcher",
        }),
      ).rejects.toThrow("idempotency key was reused with different input");
      await completeAgentInvocation({
        invocationId: next.invocationId,
        result: "Next finished.",
        status: "completed",
      });
      const nextWithDifferentReasoning = await createAgentInvocation({
        ...invocationInput,
        agentName: "researcher",
        idempotencyKey: "named-reasoning-per-task",
        reasoningLevel: "high",
      });
      expect(nextWithDifferentReasoning.childConversationId).toBe(
        first.childConversationId,
      );
      expect(nextWithDifferentReasoning.reasoningLevel).toBe("high");
      await expect(
        createAgentInvocation({
          ...invocationInput,
          idempotencyKey: "recursive",
          parentConversationId: first.childConversationId,
        }),
      ).rejects.toThrow("Recursive agent delegation is not enabled");
    } finally {
      await fixture.close();
    }
  });

  it("derives spawn authority from the parent run and replays one tool call", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    try {
      const request = {
        conversationId: parentConversationId,
        turnId: "parent-turn",
        instruction: { text: "Delegate the investigation." },
        actor: { platform: "local", userId: "local-user" },
        credentialContext: {
          actor: { type: "user", userId: "local-user" },
        },
        destination,
        destinationVisibility: "private",
        source: createLocalSource(parentConversationId),
      } satisfies AgentRun;
      const spawnAgent = bindSpawnAgent(request, {
        conversationStore,
        queue,
      });
      expect(spawnAgent).toBeDefined();
      const tool = createSpawnAgentTool(spawnAgent!);
      const input = tool.prepareArguments!({
        task: "Inspect the failing checks.",
        name: "reviewer",
        reasoning_level: "high",
      });

      const first = await tool.execute!(input, { toolCallId: "call-1" });
      const replay = await tool.execute!(input, { toolCallId: "call-1" });

      expect(first.invocation_id).toBeTruthy();
      expect(replay.invocation_id).toBe(first.invocation_id);
      await expect(
        getAgentInvocation(first.invocation_id),
      ).resolves.toMatchObject({
        actor: { platform: "local", userId: "local-user" },
        agentName: "reviewer",
        credentialContext: {
          actor: { type: "user", userId: "local-user" },
        },
        destination,
        destinationVisibility: "private",
        input: "Inspect the failing checks.",
        parentConversationId,
        reasoningLevel: "high",
        source: createLocalSource(parentConversationId),
      });
      expect(queue.sentRecords()).toHaveLength(1);
      await expect(
        tool.execute!(
          tool.prepareArguments!({
            task: "Start overlapping work.",
            name: "reviewer",
            reasoning_level: "high",
          }),
          { toolCallId: "call-2" },
        ),
      ).rejects.toMatchObject({
        name: "ToolInputError",
        message:
          'Named agent "reviewer" already has active work. Wait for it to finish or use a different name.',
      });
    } finally {
      await fixture.close();
    }
  });

  it("reads the parent Location without delivering child output", async () => {
    const { conversationStore, fixture } =
      await prepareSlackParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAndEnqueueAgentInvocation(
        {
          ...slackInvocationInput,
          idempotencyKey: "execute-1",
        },
        {
          conversationStore,
          nowMs: 2_000,
          queue,
          state,
        },
      );
      const child = await conversationStore.get({
        conversationId: created.childConversationId,
      });
      expect(child).toMatchObject({
        parentConversationId: slackParentConversationId,
      });
      expect(child).not.toHaveProperty("destination");
      expect(child).not.toHaveProperty("location");
      expect(child).not.toHaveProperty("sessionSource");
      const agentRunner = createModelAgentRunner(
        createModelStream([{ type: "text", text: "Durable child result" }]),
      );
      const run = vi.spyOn(agentRunner, "run");
      const fallbackWorker = vi.fn(async () => ({
        status: "completed" as const,
      }));
      const route = routeAgentInvocationWork({
        fallbackWorker,
        invocationWorker: createAgentInvocationWorker(agentRunner),
      });
      const queueMessage = queue.takeMessage();

      await expect(
        processConversationQueueMessage(queueMessage, {
          conversationStore,
          queue,
          run: route,
          state,
        }),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(
        processConversationQueueMessage(queueMessage, {
          conversationStore,
          queue,
          run: route,
          state,
        }),
      ).resolves.toMatchObject({ status: "no_work" });

      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        mailboxStatus: "appended",
        result: "Durable child result",
        status: "completed",
        terminalAtMs: expect.any(Number),
      });
      const completed = await getAgentInvocation(created.invocationId);
      await completeAgentInvocation({
        errorMessage: "late conflicting failure",
        invocationId: created.invocationId,
        nowMs: Date.now() + 1_000,
        status: "failed",
      });
      await expect(getAgentInvocation(created.invocationId)).resolves.toEqual(
        completed,
      );
      await expect(
        loadProjection({ conversationId: created.childConversationId }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: "Durable child result",
              }),
            ]),
          }),
        ]),
      );
      await expect(
        loadTurnEvents(created.childConversationId),
      ).resolves.toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            inputMessageIds: [
              getAgentInvocationMessageId(created.invocationId),
            ],
            surface: "internal",
            turnId: getAgentInvocationTurnId(created.invocationId),
            type: "turn_started",
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            outcome: "success",
            turnId: getAgentInvocationTurnId(created.invocationId),
            type: "turn_completed",
          }),
        }),
      ]);
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0]).toMatchObject({
        conversationId: created.childConversationId,
        instruction: { text: slackInvocationInput.input },
        disabledFeatures: ["handoff", "interactive-auth", "subagents"],
        reasoning: "medium",
        actor: slackInvocationInput.actor,
        destination: slackDestination,
        destinationVisibility: "private",
        publishExternally: false,
        source: {
          ...slackInvocationInput.source,
          location: {
            id: expect.any(String),
            provider: "slack",
            tenantId: "T123",
            providerId: "C123",
          },
        },
        surface: "internal",
        runId: created.invocationId,
      });
      expect(fallbackWorker).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("finishes a failed child Turn after saving its result", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAndEnqueueAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "failed-result-1",
        },
        { conversationStore, queue, state },
      );
      const route = routeAgentInvocationWork({
        fallbackWorker: vi.fn(async () => ({ status: "completed" as const })),
        invocationWorker: createAgentInvocationWorker(
          createModelAgentRunner(
            createModelStream([
              { type: "error", errorMessage: "model unavailable" },
            ]),
          ),
        ),
      });

      await expect(
        processConversationQueueMessage(queue.takeMessage(), {
          conversationStore,
          queue,
          run: route,
          state,
        }),
      ).resolves.toMatchObject({ status: "completed" });

      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        errorMessage: "model unavailable",
        status: "failed",
      });
      await expect(
        loadTurnEvents(created.childConversationId),
      ).resolves.toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            type: "turn_started",
            turnId: getAgentInvocationTurnId(created.invocationId),
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            failureCode: "model_execution_failed",
            type: "turn_failed",
            turnId: getAgentInvocationTurnId(created.invocationId),
          }),
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("resumes a yielded invocation from durable child state", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAndEnqueueAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "resume-1",
        },
        {
          conversationStore,
          nowMs: 2_000,
          queue,
          state,
        },
      );
      const agentRunner = createModelAgentRunner(
        createModelStream([
          { type: "toolCall", name: "systemTime", arguments: {} },
          { type: "text", text: "Resumed child result" },
        ]),
      );
      const run = vi.spyOn(agentRunner, "run");
      const invocationWorker = createAgentInvocationWorker(agentRunner);
      const route = routeAgentInvocationWork({
        fallbackWorker: vi.fn(async () => ({ status: "completed" as const })),
        invocationWorker,
      });

      await expect(
        processConversationQueueMessage(queue.takeMessage(), {
          conversationStore,
          queue,
          run: route,
          softYieldAfterMs: 0,
          state,
        }),
      ).resolves.toMatchObject({ status: "yielded" });
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({ status: "awaiting_resume" });
      await expect(
        getTurnRecord(
          created.childConversationId,
          getAgentInvocationTurnId(created.invocationId),
        ),
      ).resolves.toMatchObject({
        state: "paused",
        resumeReason: "yield",
        piMessages: expect.arrayContaining([
          expect.objectContaining({
            role: "toolResult",
            toolName: "systemTime",
          }),
        ]),
      });

      await expect(
        processConversationQueueMessage(queue.takeMessage(), {
          conversationStore,
          queue,
          run: route,
          state,
        }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(run).toHaveBeenCalledTimes(2);
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        result: "Resumed child result",
        status: "completed",
      });
      const projection = await loadProjection({
        conversationId: created.childConversationId,
      });
      expect(
        projection.filter(
          (message) =>
            message.role === "toolResult" && message.toolName === "systemTime",
        ),
      ).toHaveLength(1);
      expect(projection).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: "Resumed child result",
              }),
            ]),
          }),
        ]),
      );
    } finally {
      await fixture.close();
    }
  });

  it("recovers a completed child turn through production routing", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAndEnqueueAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "completed-recovery-1",
        },
        { conversationStore, queue, state },
      );
      await upsertTurnRecord({
        actor: invocationInput.actor,
        conversationId: created.childConversationId,
        destination,
        piMessages: [
          {
            role: "user",
            content: [{ type: "text", text: invocationInput.input }],
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Calling a tool" },
              {
                type: "toolCall",
                id: "tool-1",
                name: "lookup",
                arguments: {},
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "lookup",
            content: [{ type: "text", text: "tool output" }],
            isError: false,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Recovered visible result" }],
          },
        ] as PiMessage[],
        turnId: getAgentInvocationTurnId(created.invocationId),
        sliceId: 1,
        source: invocationInput.source,
        state: "completed",
        surface: "internal",
      });
      const route = routeAgentInvocationWork({
        fallbackWorker: vi.fn(async () => ({ status: "completed" as const })),
        invocationWorker: createAgentInvocationWorker(neverRunAgentRunner()),
      });

      await expect(
        processConversationQueueMessage(queue.takeMessage(), {
          conversationStore,
          queue,
          run: route,
          state,
        }),
      ).resolves.toMatchObject({ status: "completed" });

      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        result: "Recovered visible result",
        status: "completed",
      });
    } finally {
      await fixture.close();
    }
  });

  it("repairs the durable creation-to-mailbox crash gap once", async () => {
    const { fixture } = await prepareParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "mailbox-repair-1",
        },
        2_000,
      );

      await recoverPendingAgentInvocationMailboxAppends({
        conversationWorkQueue: queue,
        nowMs: 3_000,
      });
      await recoverPendingAgentInvocationMailboxAppends({
        conversationWorkQueue: queue,
        nowMs: 4_000,
      });

      expect(queue.sentRecords()).toHaveLength(1);
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({ mailboxStatus: "appended" });
    } finally {
      await fixture.close();
    }
  });
});
