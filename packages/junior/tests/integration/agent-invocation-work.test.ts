import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  completeAgentInvocation,
  createAgentInvocation,
  getAgentInvocation,
  getAgentInvocationId,
  getAgentInvocationMessageId,
  getAgentInvocationResultInvocationId,
  getAgentInvocationResultMessageId,
  getAgentInvocationTurnId,
} from "@/chat/agent-invocations/store";
import {
  enqueueAgentInvocationResult,
  startAgentInvocationsForChildResults,
  withAgentInvocationResultActors,
} from "@/chat/agent-invocations/result";
import type { TerminalAgentInvocation } from "@/chat/agent-invocations/types";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import { EVENT_MESSAGE_AUTHOR, EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { getConversationWorkState } from "@/chat/task-execution/store";
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
import {
  recoverPendingAgentInvocationMailboxAppends,
  recoverPendingAgentInvocationResults,
} from "@/chat/agent-dispatch/heartbeat";
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
  createEventSource,
  createLocalSource,
  createSlackSource,
} from "@sentry/junior-plugin-api";
import { getCurrentConversationPrivacy } from "@/chat/conversation-privacy";
const parentConversationId = "local:test:parent-agent";
const destination = {
  conversationId: parentConversationId,
  platform: "local",
} as const;
const invocationInput = {
  actor: { name: "parent-agent", platform: "system" } as const,
  destination,
  input: "Summarize the durable task.",
  parentConversationId,
  reasoningLevel: "medium" as const,
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
  visibility: "public",
});
const slackInvocationInput = {
  ...invocationInput,
  actor: {
    platform: "slack",
    teamId: "T123",
    userId: "U123",
  } as const,
  destination: slackDestination,
  parentConversationId: slackParentConversationId,
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
    visibility: "public",
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

      expect(replay).toEqual(first);
      await expect(
        getAgentInvocation(
          getAgentInvocationId(parentConversationId, "parent-turn:call-1"),
        ),
      ).resolves.toMatchObject({
        childConversationId: first.conversation_id,
        actor: { platform: "local", userId: "local-user" },
        agentName: "reviewer",
        credentialContext: {
          actor: { type: "user", userId: "local-user" },
        },
        destination,
        input: "Inspect the failing checks.",
        parentConversationId,
        reasoningLevel: "high",
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

  it("reads the parent Location and visibility without delivering child output", async () => {
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
      expect(child).not.toHaveProperty("visibility");
      let observedVisibility: ReturnType<typeof getCurrentConversationPrivacy>;
      const agentRunner = createModelAgentRunner(
        createModelStream([
          {
            type: "text",
            text: "Durable child result",
            onRequest: () => {
              observedVisibility = getCurrentConversationPrivacy();
            },
          },
        ]),
      );
      const run = vi.spyOn(agentRunner, "run");
      const fallbackWorker = vi.fn(async () => ({
        status: "completed" as const,
      }));
      const route = routeAgentInvocationWork({
        fallbackWorker,
        invocationWorker: createAgentInvocationWorker(agentRunner, {
          enqueueResult: async (invocation) =>
            await enqueueAgentInvocationResult(invocation, { queue, state }),
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

      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        mailboxStatus: "appended",
        parentMailboxStatus: "appended",
        result: "Durable child result",
        status: "completed",
        terminalAtMs: expect.any(Number),
      });
      // The parent gets one Event with the result, even after redelivery.
      const parentWork = await getConversationWorkState({
        conversationId: slackParentConversationId,
        state,
      });
      expect(parentWork?.messages).toEqual([
        expect.objectContaining({
          delivery: "defer",
          inboundMessageId: getAgentInvocationResultMessageId(
            created.invocationId,
          ),
          input: expect.objectContaining({
            metadata: {
              kind: "event",
              event: expect.objectContaining({
                eventType: "agent_invocation.completed",
                identifier: created.invocationId,
                namespace: "junior",
              }),
            },
            text: expect.stringContaining("Durable child result"),
          }),
          source: "event",
        }),
      ]);
      expect(
        queue
          .sentRecords()
          .filter(
            (record) => record.conversationId === slackParentConversationId,
          ),
      ).toHaveLength(1);
      // The parent Turn uses the Actor that spawned the child, read from SQL.
      const resultMessage = parentWork!.messages[0]!;
      const resultEntry = {
        actor: EVENT_SYSTEM_ACTOR,
        author: EVENT_MESSAGE_AUTHOR,
        message: resultMessage,
        source: createEventSource({
          eventKey: created.invocationId,
          eventType: "agent_invocation.completed",
          identifier: created.invocationId,
          namespace: "junior",
        }),
      };
      await expect(
        withAgentInvocationResultActors({
          kind: "mailbox",
          batch: [resultEntry],
        }),
      ).resolves.toMatchObject({
        batch: [{ actor: slackInvocationInput.actor }],
      });
      await expect(
        withAgentInvocationResultActors({
          kind: "mailbox",
          batch: [
            {
              ...resultEntry,
              message: {
                ...resultMessage,
                conversationId: parentConversationId,
              },
            },
          ],
        }),
      ).rejects.toThrow("does not belong to");
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
        location: {
          id: expect.any(String),
          provider: "slack",
          teamId: "T123",
          channelId: "C123",
          threadTs: "1712345.0001",
        },
        source: { kind: "agent_invocation" },
        surface: "internal",
        runId: created.invocationId,
      });
      expect(run.mock.calls[0]?.[0].delivery).toBeUndefined();
      expect(observedVisibility).toBe("public");
      expect(fallbackWorker).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("gives a nested child's result to its parent child before the root", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const context = (
      conversationId: string,
      messages: InboundMessage[] = [],
    ): ConversationWorkerContext => ({
      attempt: {
        ack: vi.fn(async () => undefined),
        conversationId,
        drain: async () => [],
        isFinalAttempt: false,
        messages,
      },
      checkIn: async () => true,
      conversationId,
      shouldYield: () => false,
    });
    const mailbox = async (conversationId: string) =>
      (await getConversationWorkState({ conversationId, state }))?.messages ??
      [];
    try {
      const child = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "nested-child",
      });
      const helper = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "nested-helper",
        parentConversationId: child.childConversationId,
      });

      // Depth 1 can spawn with maxAgentDepth 1. Depth 2 cannot. Both read
      // the root Location.
      const runs: AgentRun[] = [];
      const worker = createAgentInvocationWorker(
        {
          run: async (run) => {
            runs.push(run);
            throw new Error("stop after reading the run");
          },
        },
        { maxAgentDepth: 1 },
      );
      for (const invocation of [child, helper]) {
        await expect(
          worker(
            context(invocation.childConversationId),
            invocation.invocationId,
          ),
        ).rejects.toThrow("stop after reading the run");
      }
      expect(runs.map((run) => run.disabledFeatures)).toEqual([
        ["handoff", "interactive-auth"],
        ["handoff", "interactive-auth", "subagents"],
      ]);
      expect(runs[1]?.location).toMatchObject({
        provider: "slack",
        channelId: "C123",
      });

      // The child finishes while its helper runs, so its result waits.
      await expect(
        completeAgentInvocation({
          invocationId: child.invocationId,
          result: "Started a helper.",
          status: "completed",
        }),
      ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });
      const helperResult = await completeAgentInvocation({
        invocationId: helper.invocationId,
        result: "Helper fact: 42.",
        status: "completed",
      });
      expect(helperResult).toMatchObject({ parentMailboxStatus: "pending" });
      await enqueueAgentInvocationResult(
        helperResult as TerminalAgentInvocation,
        { queue, state },
      );

      // The helper result starts a new agent invocation on the child, once.
      const helperMessages = await mailbox(child.childConversationId);
      expect(helperMessages).toHaveLength(1);
      for (let attempt = 0; attempt < 2; attempt++) {
        const attemptContext = context(
          child.childConversationId,
          helperMessages,
        );
        await expect(
          startAgentInvocationsForChildResults(attemptContext, {
            queue,
            state,
          }),
        ).resolves.toEqual({ status: "completed" });
        expect(attemptContext.attempt.ack).toHaveBeenCalledOnce();
      }
      const resultInvocationId = getAgentInvocationResultInvocationId(
        slackParentConversationId,
        helper.invocationId,
      );
      const resultInvocation = await getAgentInvocation(resultInvocationId);
      expect(resultInvocation).toMatchObject({
        actor: slackInvocationInput.actor,
        childConversationId: child.childConversationId,
        input: expect.stringContaining("Helper fact: 42."),
        mailboxStatus: "appended",
        parentConversationId: slackParentConversationId,
        status: "pending",
      });
      expect(
        (await mailbox(child.childConversationId)).map(
          (message) => message.inboundMessageId,
        ),
      ).toEqual([
        getAgentInvocationResultMessageId(helper.invocationId),
        getAgentInvocationMessageId(resultInvocationId),
      ]);

      // With the helper result received, the child reports to the root once.
      const finalResult = await completeAgentInvocation({
        invocationId: resultInvocationId,
        result: "Final answer with the helper fact.",
        status: "completed",
      });
      expect(finalResult).toMatchObject({ parentMailboxStatus: "pending" });
      await enqueueAgentInvocationResult(
        finalResult as TerminalAgentInvocation,
        { queue, state },
      );
      const rootMessages = await mailbox(slackParentConversationId);
      expect(rootMessages).toEqual([
        expect.objectContaining({
          inboundMessageId:
            getAgentInvocationResultMessageId(resultInvocationId),
          input: expect.objectContaining({
            text: expect.stringContaining("Final answer with the helper fact."),
          }),
        }),
      ]);
      // A root Conversation runs results as Event Turns instead.
      await expect(
        startAgentInvocationsForChildResults(
          context(slackParentConversationId, rootMessages),
          { queue, state },
        ),
      ).resolves.toBeUndefined();
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
      ).resolves.toMatchObject({ status: "paused" });
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
        source: { kind: "agent_invocation" },
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
  it("repairs a terminal result that never reached its parent", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAgentInvocation(
        {
          ...slackInvocationInput,
          idempotencyKey: "parent-result-repair-1",
        },
        2_000,
      );
      // The worker stopped after the terminal write and before the parent append.
      await completeAgentInvocation({
        errorMessage: "GitHub authorization is required",
        invocationId: created.invocationId,
        status: "blocked",
      });
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({ parentMailboxStatus: "pending" });

      await recoverPendingAgentInvocationResults({
        conversationWorkQueue: queue,
        nowMs: Date.now(),
      });
      await recoverPendingAgentInvocationResults({
        conversationWorkQueue: queue,
        nowMs: Date.now(),
      });

      expect(
        queue
          .sentRecords()
          .filter(
            (record) => record.conversationId === slackParentConversationId,
          ),
      ).toHaveLength(1);
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({ parentMailboxStatus: "appended" });
      const parentWork = await getConversationWorkState({
        conversationId: slackParentConversationId,
        state,
      });
      expect(parentWork?.messages).toEqual([
        expect.objectContaining({
          inboundMessageId: getAgentInvocationResultMessageId(
            created.invocationId,
          ),
          source: "event",
        }),
      ]);
      expect(parentWork?.messages[0]?.input.text).toContain(
        "GitHub authorization is required",
      );
    } finally {
      await fixture.close();
    }
  });
});
