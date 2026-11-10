import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { buildSteeringPiMessage } from "@/chat/agent/prompt";
import type { AgentRun, AgentSteeringMessage } from "@/chat/agent/types";
import { agentInstructionProvenance } from "@/chat/conversations/provenance";
import {
  createAgentInvocation,
  createAgentInvocationForMessage,
} from "@/chat/agent-invocations/create";
import {
  getAgentInvocationMessageId,
  getAgentInvocationTurnId,
} from "@/chat/agent-invocations/ids";
import {
  appendAgentInvocationReport,
  getAgentInvocation,
  markAgentInvocationRunning,
} from "@/chat/agent-invocations/store";
import { getConversationEventStore } from "@/chat/db";
import { createSearchAgentsTool } from "@/chat/tools/runtime/search-agents";
import { agentInvocationInputText } from "@/chat/agent-invocations/steering";
import {
  buildAgentInvocationInboundMessage,
  createAgentInvocationWorker,
} from "@/chat/agent-invocations/work";
import { commitMessages } from "@/chat/conversations/projection";
import { stopConversation } from "@/chat/conversations/stop";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import type {
  ConversationWorkerContext,
  InboxAttempt,
} from "@/chat/task-execution/worker";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";
import { finishAgentInvocation } from "@/chat/agent-invocations/finish";
const PARENT_CONVERSATION_ID = "local:test:component-parent-agent";
const DESTINATION = {
  conversationId: PARENT_CONVERSATION_ID,
  platform: "local",
} as const;
const INVOCATION_INPUT = {
  actor: { name: "parent-agent", platform: "system" } as const,
  destination: DESTINATION,
  input: "Summarize the durable task.",
  parentConversationId: PARENT_CONVERSATION_ID,
  reasoningLevel: "medium" as const,
};

async function prepareParentConversation() {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  const conversationStore = createSqlStore(fixture.sql);
  await conversationStore.recordActivity({
    conversationId: PARENT_CONVERSATION_ID,
    destination: DESTINATION,
    nowMs: 1_000,
    source: "local",
  });
  return fixture;
}

describe("agent invocation worker", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("stops a stranded running child that already used its resume", async () => {
    const fixture = await prepareParentConversation();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAgentInvocation(
        {
          ...INVOCATION_INPUT,
          agentName: "researcher",
          idempotencyKey: "running-no-boundary-1",
        },
        2_000,
      );
      const turnId = getAgentInvocationTurnId(created.invocationId);
      await markAgentInvocationRunning(created.invocationId);
      await upsertTurnRecord({
        actor: INVOCATION_INPUT.actor,
        conversationId: created.childConversationId,
        destination: DESTINATION,
        piMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "partial output" }],
            api: "responses",
            provider: "openai",
            model: "gpt-5.3",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: 2,
          },
        ] as PiMessage[],
        turnId,
        lostWorkerResumeCount: 1,
        sliceId: 1,
        source: { kind: "agent_invocation" },
        state: "running",
        surface: "internal",
      });
      const worker = createAgentInvocationWorker(neverRunAgentRunner());
      const context = {
        attempt: {
          ack: vi.fn(),
          conversationId: created.childConversationId,
          drain: vi.fn(),
          isFinalAttempt: false,
          messages: [],
        },
        checkIn: vi.fn(),
        conversationId: created.childConversationId,
        shouldYield: () => false,
      } satisfies ConversationWorkerContext;

      await expect(worker(context, created.invocationId)).resolves.toEqual({
        status: "completed",
      });

      expect(context.attempt.ack).not.toHaveBeenCalled();
      await expect(
        getTurnRecord(created.childConversationId, turnId),
      ).resolves.toMatchObject({
        errorMessage: expect.stringContaining("lost its worker"),
        state: "failed",
      });
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        errorMessage: expect.stringContaining("lost its worker"),
        status: "failed",
      });
      // A failed child takes new work from a parent message.
      await expect(
        createAgentInvocationForMessage({
          ...INVOCATION_INPUT,
          childConversationId: created.childConversationId,
          idempotencyKey: "running-no-boundary-2",
          parentToolCallId: "call-running-no-boundary-2",
        }),
      ).resolves.toMatchObject({
        invocation: {
          childConversationId: created.childConversationId,
          status: "pending",
        },
        queued: false,
      });
    } finally {
      await fixture.close();
    }
  });

  it("stops open child agents when the child is stopped during its run", async () => {
    const fixture = await prepareParentConversation();
    try {
      const created = await createAgentInvocation({
        ...INVOCATION_INPUT,
        idempotencyKey: "late-stop",
        parentToolCallId: "call-late-stop",
      });
      const helper = await createAgentInvocation({
        ...INVOCATION_INPUT,
        idempotencyKey: "late-stop-helper",
        parentConversationId: created.childConversationId,
      });
      const stopRequest = new AbortController();
      const worker = createAgentInvocationWorker({
        run: async () => {
          // A person stops the child as its run finishes. This harness has no
          // stop check, so abort the signal that the check would abort.
          await stopConversation({
            conversationId: created.childConversationId,
            queue: createConversationWorkQueueTestAdapter(),
          });
          stopRequest.abort(new Error("Conversation work stopped"));
          return {
            status: "completed" as const,
            result: {
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "success" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
              text: "Partial result",
            },
          };
        },
      });
      const context = {
        attempt: {
          ack: vi.fn(async () => {}),
          conversationId: created.childConversationId,
          drain: vi.fn(),
          isFinalAttempt: false,
          messages: [buildAgentInvocationInboundMessage(created)],
        },
        checkIn: vi.fn(),
        conversationId: created.childConversationId,
        shouldYield: () => false,
        stopSignal: () => stopRequest.signal,
      } satisfies ConversationWorkerContext;

      await expect(worker(context, created.invocationId)).resolves.toEqual({
        status: "completed",
      });

      // The stop ended the helper before the child saved, and the child's
      // task still reports.
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        status: "completed",
      });
      await expect(
        getAgentInvocation(helper.invocationId),
      ).resolves.toMatchObject({
        status: "stopped",
      });
    } finally {
      await fixture.close();
    }
  });

  it("lets a running child read a parent message as a steering message", async () => {
    const fixture = await prepareParentConversation();
    try {
      const created = await createAgentInvocation({
        ...INVOCATION_INPUT,
        agentName: "researcher",
        idempotencyKey: "steer-task",
        parentToolCallId: "call-steer-task",
      });
      await markAgentInvocationRunning(created.invocationId);
      // The Run already reported for its first task, as `messageAgent` does.
      await appendAgentInvocationReport(created.invocationId, {
        kind: "report",
        text: "Checked the cache path.",
        key: "report-1",
      });
      const { invocation: message, queued } =
        await createAgentInvocationForMessage({
          ...INVOCATION_INPUT,
          childConversationId: created.childConversationId,
          idempotencyKey: "steer-message",
          input: "Also check the retry path.",
          parentToolCallId: "call-steer-message",
        });
      expect(queued).toBe(true);
      // An earlier drain saved this message in the Turn, then failed before
      // it marked the agent invocation read.
      const { invocation: savedMessage } =
        await createAgentInvocationForMessage({
          ...INVOCATION_INPUT,
          childConversationId: created.childConversationId,
          idempotencyKey: "steer-saved-message",
          // The Turn saves escaped text, so use characters that change.
          input: `Skip the "cache" path & <retry>.`,
          parentToolCallId: "call-steer-saved-message",
        });
      // Another drain marked this message read, then failed before the
      // parent saw it end and before it acknowledged the message.
      const { invocation: markedMessage } =
        await createAgentInvocationForMessage({
          ...INVOCATION_INPUT,
          childConversationId: created.childConversationId,
          idempotencyKey: "steer-marked-message",
          input: "Check the timeout path.",
          parentToolCallId: "call-steer-marked-message",
        });
      await finishAgentInvocation({
        invocationId: markedMessage.invocationId,
        status: "completed",
        steered: true,
      });
      await upsertTurnRecord({
        actor: INVOCATION_INPUT.actor,
        conversationId: created.childConversationId,
        destination: DESTINATION,
        piMessages: [
          buildSteeringPiMessage({
            kind: "runtime",
            provenance: agentInstructionProvenance,
            text: agentInvocationInputText(savedMessage),
            timestampMs: savedMessage.createdAtMs,
          }),
        ],
        turnId: getAgentInvocationTurnId(created.invocationId),
        sliceId: 1,
        source: { kind: "agent_invocation" },
        state: "paused",
        surface: "internal",
      });

      // The runner drains steering messages, as the agent does before its
      // next model call.
      const steered: AgentSteeringMessage[][] = [];
      const provenances: unknown[] = [];
      const worker = createAgentInvocationWorker({
        run: async (run) => {
          provenances.push(run.instruction.provenance);
          await run.durability?.drainSteeringMessages?.(async (messages) => {
            steered.push(messages);
          });
          return {
            status: "completed" as const,
            result: {
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "success" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
              text: "Checked both paths.",
            },
          };
        },
      });
      const acknowledged: Array<readonly string[] | void> = [];
      const ownMessage = buildAgentInvocationInboundMessage(created);
      const context = {
        attempt: {
          ack: vi.fn(async () => {}),
          conversationId: created.childConversationId,
          drain: vi.fn(async (handle: Parameters<InboxAttempt["drain"]>[0]) => {
            acknowledged.push(
              await handle([
                ownMessage,
                buildAgentInvocationInboundMessage(message),
                buildAgentInvocationInboundMessage(savedMessage),
                buildAgentInvocationInboundMessage(markedMessage),
              ]),
            );
            return [];
          }),
          isFinalAttempt: false,
          messages: [ownMessage],
        },
        checkIn: vi.fn(),
        conversationId: created.childConversationId,
        shouldYield: () => false,
      } satisfies ConversationWorkerContext;

      await expect(worker(context, created.invocationId)).resolves.toEqual({
        status: "completed",
      });

      expect(context.attempt.drain).toHaveBeenCalledWith(expect.any(Function), {
        deferred: true,
      });
      // The parent's task and messages are the child's instructions, with no
      // Actor.
      expect(provenances).toEqual([agentInstructionProvenance]);
      expect(steered).toEqual([
        [
          expect.objectContaining({
            kind: "runtime",
            provenance: agentInstructionProvenance,
            text: expect.stringMatching(
              /^<parent-agent-task>\n[\s\S]*Also check the retry path\.\n<\/parent-agent-task>$/,
            ),
          }),
        ],
      ]);
      // The Turn reads the saved message only once. Both parent messages are
      // acknowledged. The running agent invocation acknowledges its own input
      // when the Turn commits it.
      expect(acknowledged).toEqual([
        [
          getAgentInvocationMessageId(message.invocationId),
          getAgentInvocationMessageId(savedMessage.invocationId),
          getAgentInvocationMessageId(markedMessage.invocationId),
        ],
      ]);
      // The parent sees each steered agent invocation end.
      const parentEvents = await getConversationEventStore().loadHistory(
        PARENT_CONVERSATION_ID,
      );
      expect(
        parentEvents.flatMap((event) =>
          event.data.type === "subagent_ended"
            ? [event.data.subagentInvocationId]
            : [],
        ),
      ).toEqual(
        expect.arrayContaining([
          markedMessage.invocationId,
          message.invocationId,
          savedMessage.invocationId,
        ]),
      );
      for (const steeredMessage of [message, savedMessage]) {
        await expect(
          getAgentInvocation(steeredMessage.invocationId),
        ).resolves.toMatchObject({
          status: "completed",
        });
      }
      // The running agent invocation reports for all of them. Its report
      // came before the steering tasks, so the result says that they got
      // none.
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        reportLog: [
          expect.objectContaining({ text: "Checked the cache path." }),
          expect.objectContaining({ kind: "steered_task" }),
          expect.objectContaining({ kind: "steered_task" }),
        ],
        status: "completed",
      });
      await expect(
        createSearchAgentsTool({ conversationId: PARENT_CONVERSATION_ID })
          .execute!({}, {}),
      ).resolves.toMatchObject({
        agents: [
          {
            last_result: "completed",
            name: "researcher",
            status: "idle",
            task: "Check the timeout path.",
          },
        ],
      });
    } finally {
      await fixture.close();
    }
  });

  it("starts a fork child with the parent history before the spawn call", async () => {
    const fixture = await prepareParentConversation();
    try {
      const usage = {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const assistant = (content: unknown[], timestamp: number): PiMessage =>
        ({
          role: "assistant",
          content,
          api: "responses",
          provider: "openai",
          model: "gpt-5.3",
          usage,
          stopReason: content.some(
            (part) => (part as { type: string }).type === "toolCall",
          )
            ? "toolUse"
            : "stop",
          timestamp,
        }) as PiMessage;
      const readRound: PiMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Compare the two retry paths." }],
          timestamp: 1,
        },
        assistant(
          [
            {
              type: "toolCall",
              id: "call-read",
              name: "readFile",
              arguments: { path: "retry.ts" },
            },
          ],
          2,
        ),
        {
          role: "toolResult",
          toolCallId: "call-read",
          toolName: "readFile",
          content: [{ type: "text", text: "export const RETRIES = 3;" }],
          isError: false,
          timestamp: 3,
        },
      ];
      await commitMessages({
        conversationId: PARENT_CONVERSATION_ID,
        messages: [
          ...readRound,
          assistant(
            [
              {
                type: "toolCall",
                id: "call-fork",
                name: "spawnAgent",
                arguments: {
                  agent_type: "fork",
                  task: "Check the other path.",
                },
              },
            ],
            4,
          ),
        ],
      });
      const created = await createAgentInvocation({
        ...INVOCATION_INPUT,
        agentType: "fork",
        idempotencyKey: "fork-task",
        input: "Check the other path.",
        parentToolCallId: "call-fork",
      });
      const histories: (readonly PiMessage[])[] = [];
      const worker = createAgentInvocationWorker({
        run: async (run) => {
          histories.push(run.history ?? []);
          return {
            status: "completed" as const,
            result: {
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "success" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
              text: "The other path retries twice.",
            },
          };
        },
      });
      const message = buildAgentInvocationInboundMessage(created);

      await expect(
        worker(
          {
            attempt: {
              ack: vi.fn(async () => {}),
              conversationId: created.childConversationId,
              drain: vi.fn(),
              isFinalAttempt: false,
              messages: [message],
            },
            checkIn: vi.fn(),
            conversationId: created.childConversationId,
            shouldYield: () => false,
          } satisfies ConversationWorkerContext,
          created.invocationId,
        ),
      ).resolves.toEqual({ status: "completed" });

      // The fork reads what the parent read, but not the unanswered spawn
      // call, which a model request would reject.
      expect(histories).toEqual([
        readRound.map((item) => expect.objectContaining(item)),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("offers spawnAgent to a child only when maxAgentDepth is above 0", async () => {
    const fixture = await prepareParentConversation();
    try {
      const [first, second] = await Promise.all(
        ["depth-default", "depth-1"].map((idempotencyKey) =>
          createAgentInvocation({ ...INVOCATION_INPUT, idempotencyKey }),
        ),
      );
      const runs: AgentRun[] = [];
      const runner = {
        run: async (run: AgentRun) => {
          runs.push(run);
          throw new Error("stop after reading the run");
        },
      };
      // The default, 0, lets only the root spawn. With 1, the child's Runs
      // offer spawnAgent, and spawnAgent checks the depth when it is called.
      for (const [child, worker] of [
        [first!, createAgentInvocationWorker(runner)],
        [second!, createAgentInvocationWorker(runner, { maxAgentDepth: 1 })],
      ] as const) {
        await expect(
          worker(
            {
              attempt: {
                ack: vi.fn(),
                conversationId: child.childConversationId,
                drain: vi.fn(),
                isFinalAttempt: false,
                messages: [buildAgentInvocationInboundMessage(child)],
              },
              checkIn: vi.fn(),
              conversationId: child.childConversationId,
              shouldYield: () => false,
            },
            child.invocationId,
          ),
        ).rejects.toThrow("stop after reading the run");
      }
      expect(runs.map((run) => run.disabledFeatures)).toEqual([
        ["interactive-auth", "subagents"],
        ["interactive-auth"],
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps unexpected runner failures retryable until the final attempt", async () => {
    const fixture = await prepareParentConversation();
    try {
      const created = await createAgentInvocation({
        ...INVOCATION_INPUT,
        idempotencyKey: "failure-1",
      });
      const run = vi.fn(async () => {
        throw new Error("agent runner unavailable");
      });
      const worker = createAgentInvocationWorker({ run });
      const message = buildAgentInvocationInboundMessage(created);
      const context = (isFinalAttempt: boolean, ack: () => Promise<void>) =>
        ({
          attempt: {
            ack,
            conversationId: created.childConversationId,
            drain: vi.fn(),
            isFinalAttempt,
            messages: [message],
          },
          checkIn: vi.fn(),
          conversationId: created.childConversationId,
          shouldYield: () => false,
        }) satisfies ConversationWorkerContext;
      const firstAck = vi.fn(async () => {});

      await expect(
        worker(context(false, firstAck), created.invocationId),
      ).rejects.toThrow("agent runner unavailable");
      expect(firstAck).not.toHaveBeenCalled();
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({ status: "running" });

      const finalAck = vi.fn(async () => {});
      await expect(
        worker(context(true, finalAck), created.invocationId),
      ).resolves.toEqual({ status: "completed" });

      expect(run).toHaveBeenCalledTimes(2);
      expect(finalAck).toHaveBeenCalledOnce();
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        errorMessage: "agent runner unavailable",
        status: "failed",
      });
    } finally {
      await fixture.close();
    }
  });

  it("persists invariant failures on the final attempt", async () => {
    const fixture = await prepareParentConversation();
    try {
      const created = await createAgentInvocation({
        ...INVOCATION_INPUT,
        agentName: "researcher",
        idempotencyKey: "invalid-child-1",
      });
      const ack = vi.fn();
      const worker = createAgentInvocationWorker(neverRunAgentRunner());
      const context = {
        attempt: {
          ack,
          conversationId: created.childConversationId,
          destination: DESTINATION,
          drain: vi.fn(),
          isFinalAttempt: true,
          messages: [buildAgentInvocationInboundMessage(created)],
        },
        checkIn: vi.fn(),
        conversationId: created.childConversationId,
        destination: DESTINATION,
        shouldYield: () => false,
      } satisfies ConversationWorkerContext;

      await expect(worker(context, created.invocationId)).resolves.toEqual({
        status: "completed",
      });

      expect(ack).toHaveBeenCalledOnce();
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        errorMessage: expect.stringContaining(
          "must not own a provider destination",
        ),
        status: "failed",
      });
      // A failed child takes new work from a parent message.
      await expect(
        createAgentInvocationForMessage({
          ...INVOCATION_INPUT,
          childConversationId: created.childConversationId,
          idempotencyKey: "invalid-child-2",
          parentToolCallId: "call-invalid-child-2",
        }),
      ).resolves.toMatchObject({
        invocation: {
          childConversationId: created.childConversationId,
          status: "pending",
        },
        queued: false,
      });
    } finally {
      await fixture.close();
    }
  });
});
