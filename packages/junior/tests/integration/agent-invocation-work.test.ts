import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import type { PiMessage } from "@/chat/pi/messages";
import {
  completeAgentInvocation,
  createAgentInvocation,
  getAgentBinding,
  getAgentInvocation,
  getAgentInvocationTurnId,
} from "@/chat/agent-invocations/store";
import {
  createAgentInvocationConversationWorker,
  createAgentInvocationWorkRouter,
  createAndEnqueueAgentInvocation,
} from "@/chat/agent-invocations/work";
import {
  bindAgentSpawnControl,
  createAgentInvocationCreator,
} from "@/chat/agent-invocations/spawn";
import { createSpawnAgentTool } from "@/chat/tools/runtime/spawn-agent";
import type { AgentRunRequest } from "@/chat/agent/request";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { recoverPendingAgentInvocationMailboxAppends } from "@/chat/agent-dispatch/heartbeat";
import { CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS } from "@/chat/task-execution/store";
import {
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

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
        invocationId: first.invocation.invocationId,
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
      const ephemeral = await createAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "ephemeral-1",
        },
        5_000,
      );
      const ephemeralReplay = await createAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "ephemeral-1",
        },
        6_000,
      );
      const otherEphemeral = await createAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "ephemeral-2",
        },
        7_000,
      );

      expect(first.status).toBe("created");
      expect(replay).toEqual({
        invocation: first.invocation,
        status: "existing",
      });
      expect(next.invocation.invocationId).not.toBe(
        first.invocation.invocationId,
      );
      expect(next.invocation.childConversationId).toBe(
        first.invocation.childConversationId,
      );
      expect(ephemeralReplay.invocation.childConversationId).toBe(
        ephemeral.invocation.childConversationId,
      );
      expect(otherEphemeral.invocation.childConversationId).not.toBe(
        ephemeral.invocation.childConversationId,
      );
      await expect(
        getAgentBinding({
          name: "researcher",
          parentConversationId,
        }),
      ).resolves.toMatchObject({
        childConversationId: first.invocation.childConversationId,
        reasoningLevel: "medium",
      });
      const child = await conversationStore.get({
        conversationId: first.invocation.childConversationId,
      });
      expect(child).toMatchObject({
        lineage: { parentConversationId },
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
      await expect(
        createAgentInvocation({
          ...invocationInput,
          idempotencyKey: "recursive",
          parentConversationId: first.invocation.childConversationId,
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
        input: {
          messageText: "Delegate the investigation.",
        },
        routing: {
          actor: { platform: "local", userId: "local-user" },
          credentialContext: {
            actor: { type: "user", userId: "local-user" },
          },
          destination,
          destinationVisibility: "private",
          source: createLocalSource(parentConversationId),
        },
      } satisfies AgentRunRequest;
      const spawnAgent = bindAgentSpawnControl(
        request,
        createAgentInvocationCreator({
          conversationStore,
          queue,
        }),
      );
      expect(spawnAgent).toBeDefined();
      const tool = createSpawnAgentTool(spawnAgent!);
      const input = tool.prepareArguments!({
        task: "Inspect the failing checks.",
        name: "reviewer",
        reasoning_level: "high",
      });

      const first = await tool.execute!(input, { toolCallId: "call-1" });
      const replay = await tool.execute!(input, { toolCallId: "call-1" });

      expect(first).toMatchObject({
        agent_name: "reviewer",
        invocation_status: "pending",
        replayed: false,
      });
      expect(replay).toMatchObject({
        invocation_id: first.invocation_id,
        child_conversation_id: first.child_conversation_id,
        replayed: true,
      });
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
        idempotencyKey: "parent-turn:call-1",
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

  it("runs destinationless child work once and persists its terminal result", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAndEnqueueAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "execute-1",
        },
        {
          conversationStore,
          nowMs: 2_000,
          queue,
          state,
        },
      );
      const run = vi.fn(async (request) => {
        expect(request).toMatchObject({
          conversationId: created.invocation.childConversationId,
          input: { messageText: invocationInput.input },
          policy: {
            authorizationFlowMode: "disabled",
            reasoningLevel: "medium",
          },
          routing: {
            actor: invocationInput.actor,
            destination,
            destinationVisibility: "private",
            source: invocationInput.source,
            surface: "internal",
          },
          runId: created.invocation.invocationId,
        });
        await request.durability.onInputCommitted?.();
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
          text: "Durable child result",
        });
      });
      const fallbackWorker = vi.fn(async () => ({
        status: "completed" as const,
      }));
      const route = createAgentInvocationWorkRouter({
        fallbackWorker,
        invocationWorker: createAgentInvocationConversationWorker({
          agentRunner: { run },
        }),
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

      expect(run).toHaveBeenCalledOnce();
      expect(fallbackWorker).not.toHaveBeenCalled();
      await expect(
        getAgentInvocation(created.invocation.invocationId),
      ).resolves.toMatchObject({
        mailboxStatus: "appended",
        result: "Durable child result",
        status: "completed",
        terminalAtMs: expect.any(Number),
      });
      const completed = await getAgentInvocation(
        created.invocation.invocationId,
      );
      await completeAgentInvocation({
        errorMessage: "late conflicting failure",
        invocationId: created.invocation.invocationId,
        nowMs: Date.now() + 1_000,
        status: "failed",
      });
      await expect(
        getAgentInvocation(created.invocation.invocationId),
      ).resolves.toEqual(completed);
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
      let runCount = 0;
      const invocationWorker = createAgentInvocationConversationWorker({
        agentRunner: {
          run: vi.fn(async (request) => {
            runCount += 1;
            await request.durability.onInputCommitted?.();
            if (runCount === 1) {
              return { resumeVersion: 1, status: "suspended" as const };
            }
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
              text: "Resumed child result",
            });
          }),
        },
      });
      const route = createAgentInvocationWorkRouter({
        fallbackWorker: vi.fn(async () => ({ status: "completed" as const })),
        invocationWorker,
      });

      await expect(
        processConversationQueueMessage(queue.takeMessage(), {
          conversationStore,
          queue,
          run: route,
          state,
        }),
      ).resolves.toMatchObject({ status: "yielded" });
      await expect(
        getAgentInvocation(created.invocation.invocationId),
      ).resolves.toMatchObject({ status: "awaiting_resume" });

      await expect(
        processConversationQueueMessage(queue.takeMessage(), {
          conversationStore,
          queue,
          run: route,
          state,
        }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(runCount).toBe(2);
      await expect(
        getAgentInvocation(created.invocation.invocationId),
      ).resolves.toMatchObject({
        result: "Resumed child result",
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
        getAgentInvocation(created.invocation.invocationId),
      ).resolves.toMatchObject({ mailboxStatus: "appended" });
    } finally {
      await fixture.close();
    }
  });

  it("loads prior history when a named child receives another invocation", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const first = await createAgentInvocation(
        {
          ...invocationInput,
          agentName: "historian",
          idempotencyKey: "history-1",
        },
        2_000,
      );
      const priorMessages = [
        {
          role: "user",
          content: [{ type: "text", text: "First task" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Remembered answer" }],
          timestamp: 2,
        },
      ] as unknown as PiMessage[];
      await upsertAgentTurnSessionRecord({
        actor: invocationInput.actor,
        conversationId: first.invocation.childConversationId,
        destination,
        modelId: "test-model",
        piMessages: priorMessages,
        sessionId: getAgentInvocationTurnId(first.invocation.invocationId),
        sliceId: 1,
        source: invocationInput.source,
        state: "completed",
        surface: "internal",
      });
      await completeAgentInvocation({
        invocationId: first.invocation.invocationId,
        result: "Remembered answer",
        status: "completed",
      });
      const next = await createAndEnqueueAgentInvocation(
        {
          ...invocationInput,
          agentName: "historian",
          idempotencyKey: "history-2",
        },
        { conversationStore, queue, state },
      );
      const run = vi.fn(async (request) => {
        expect(request.input.piMessages).toEqual(priorMessages);
        await request.durability.onInputCommitted?.();
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
          text: "Continued answer",
        });
      });
      const route = createAgentInvocationWorkRouter({
        fallbackWorker: vi.fn(async () => ({ status: "completed" as const })),
        invocationWorker: createAgentInvocationConversationWorker({
          agentRunner: { run },
        }),
      });

      await processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run: route,
        state,
      });

      expect(run).toHaveBeenCalledOnce();
      await expect(
        conversationStore.get({
          conversationId: next.invocation.childConversationId,
        }),
      ).resolves.not.toHaveProperty("destination");
    } finally {
      await fixture.close();
    }
  });

  it("re-parks a stranded running child session before resuming", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAndEnqueueAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "running-recovery-1",
        },
        { conversationStore, queue, state },
      );
      const turnId = getAgentInvocationTurnId(created.invocation.invocationId);
      await upsertAgentTurnSessionRecord({
        actor: invocationInput.actor,
        conversationId: created.invocation.childConversationId,
        destination,
        modelId: "test-model",
        piMessages: [
          {
            role: "user",
            content: [{ type: "text", text: invocationInput.input }],
            timestamp: 1,
          },
        ],
        sessionId: turnId,
        sliceId: 1,
        source: invocationInput.source,
        state: "running",
        surface: "internal",
      });
      const run = vi.fn(async (request) => {
        await expect(
          getAgentTurnSessionRecord(
            created.invocation.childConversationId,
            turnId,
          ),
        ).resolves.toMatchObject({ state: "awaiting_resume" });
        await request.durability.onInputCommitted?.();
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
          text: "Recovered answer",
        });
      });
      const route = createAgentInvocationWorkRouter({
        fallbackWorker: vi.fn(async () => ({ status: "completed" as const })),
        invocationWorker: createAgentInvocationConversationWorker({
          agentRunner: { run },
        }),
      });

      await processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run: route,
        state,
      });

      expect(run).toHaveBeenCalledOnce();
      await expect(
        conversationStore.get({
          conversationId: created.invocation.childConversationId,
        }),
      ).resolves.not.toHaveProperty("destination");
    } finally {
      await fixture.close();
    }
  });

  it("recovers a completed child session without rerunning the agent", async () => {
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
      await upsertAgentTurnSessionRecord({
        actor: invocationInput.actor,
        conversationId: created.invocation.childConversationId,
        destination,
        modelId: "test-model",
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
        ] as unknown as PiMessage[],
        sessionId: getAgentInvocationTurnId(created.invocation.invocationId),
        sliceId: 1,
        source: invocationInput.source,
        state: "completed",
        surface: "internal",
      });
      const run = vi.fn(async () => {
        throw new Error("completed sessions must not rerun");
      });
      const route = createAgentInvocationWorkRouter({
        fallbackWorker: vi.fn(async () => ({ status: "completed" as const })),
        invocationWorker: createAgentInvocationConversationWorker({
          agentRunner: { run },
        }),
      });

      await expect(
        processConversationQueueMessage(queue.takeMessage(), {
          conversationStore,
          queue,
          run: route,
          state,
        }),
      ).resolves.toMatchObject({ status: "completed" });

      expect(run).not.toHaveBeenCalled();
      await expect(
        getAgentInvocation(created.invocation.invocationId),
      ).resolves.toMatchObject({
        result: "Recovered visible result",
        status: "completed",
      });
    } finally {
      await fixture.close();
    }
  });

  it("retries runner failures before persisting one final failure", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAndEnqueueAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "failure-1",
        },
        { conversationStore, queue, state },
      );
      const run = vi.fn(async () => {
        throw new Error("model unavailable");
      });
      const deliveryAttempts: Array<number | undefined> = [];
      const invocationWorker = createAgentInvocationConversationWorker({
        agentRunner: { run },
      });
      const route = createAgentInvocationWorkRouter({
        fallbackWorker: vi.fn(async () => ({ status: "completed" as const })),
        invocationWorker: async (context, invocationId) => {
          deliveryAttempts.push(context.attempt.messages[0]?.attemptCount);
          return await invocationWorker(context, invocationId);
        },
      });

      for (
        let attempt = 1;
        attempt <= CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS;
        attempt += 1
      ) {
        await expect(
          processConversationQueueMessage(queue.takeMessage(), {
            conversationStore,
            queue,
            run: route,
            state,
          }),
        ).resolves.toMatchObject({
          status:
            attempt === CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS
              ? "completed"
              : "failed",
        });
      }

      expect(run).toHaveBeenCalledTimes(
        CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS,
      );
      expect(deliveryAttempts).toEqual([undefined, 1, 2, 3, 4]);
      await expect(
        getAgentInvocation(created.invocation.invocationId),
      ).resolves.toMatchObject({
        errorMessage: "model unavailable",
        status: "failed",
      });
    } finally {
      await fixture.close();
    }
  });
});
