import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  completeAgentInvocation,
  getAgentInvocation,
  getAgentInvocationMessageId,
  getAgentInvocationResultMessageId,
  getAgentInvocationTurnId,
} from "@/chat/agent-invocations/store";
import {
  enqueueAgentInvocationResult,
  withAgentInvocationResultActors,
} from "@/chat/agent-invocations/result";
import { EVENT_MESSAGE_AUTHOR, EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { getConversationWorkState } from "@/chat/task-execution/store";
import {
  createAgentInvocationWorker,
  routeAgentInvocationWork,
  createAndEnqueueAgentInvocation,
} from "@/chat/agent-invocations/work";
import { loadProjection } from "@/chat/conversations/projection";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import {
  createModelAgentRunner,
  neverRunAgentRunner,
} from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";
import { createEventSource } from "@sentry/junior-plugin-api";
import { getCurrentConversationPrivacy } from "@/chat/conversation-privacy";
import {
  destination,
  invocationInput,
  parentConversationId,
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
  prepareParentConversation,
  prepareSlackParentConversation,
  loadMessageEvents,
  loadTurnEvents,
  loadSubagentEvents,
} from "../fixtures/agent-invocations";

describe("agent invocation conversation work", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
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
            text: expect.stringMatching(
              /^\[agent result\][\s\S]*Durable child result/,
            ),
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
      await expect(
        loadSubagentEvents(slackParentConversationId),
      ).resolves.toEqual([
        expect.objectContaining({
          type: "subagent_started",
          subagentInvocationId: created.invocationId,
          childConversationId: created.childConversationId,
        }),
        {
          type: "subagent_ended",
          subagentInvocationId: created.invocationId,
          outcome: "success",
        },
      ]);
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
      // A child has no Location, so the dashboard reads its input and result
      // from these message events.
      await expect(
        loadMessageEvents(created.childConversationId),
      ).resolves.toEqual([
        {
          type: "message",
          messageId: getAgentInvocationMessageId(created.invocationId),
          role: "user",
          text: slackInvocationInput.input,
          meta: { agentInvocationId: created.invocationId },
        },
        {
          type: "message",
          messageId: `agent-invocation:${created.invocationId}:reply`,
          role: "assistant",
          text: "Durable child result",
        },
      ]);
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
      await expect(loadSubagentEvents(parentConversationId)).resolves.toEqual([
        expect.objectContaining({ type: "subagent_started" }),
        {
          type: "subagent_ended",
          subagentInvocationId: created.invocationId,
          outcome: "error",
        },
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

  const missing = "Write access to getsentry/junior. Ask the user.";
  it.each([
    {
      name: "a reply",
      tail: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Recovered visible result" }],
        },
      ],
      expected: { result: "Recovered visible result", status: "completed" },
    },
    {
      name: "a blocked report",
      tail: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-2",
              name: "reportBlocked",
              arguments: { missing },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-2",
          toolName: "reportBlocked",
          content: [{ type: "text", text: missing }],
          details: { missing },
          isError: false,
        },
      ],
      expected: { errorMessage: missing, status: "blocked" },
    },
  ])(
    "recovers a completed child turn that ends with $name through production routing",
    async ({ expected, tail }) => {
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
            ...tail,
          ] as PiMessage[],
          turnId: getAgentInvocationTurnId(created.invocationId),
          turnStartMessageIndex: 0,
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
        ).resolves.toMatchObject(expected);
      } finally {
        await fixture.close();
      }
    },
  );
});
