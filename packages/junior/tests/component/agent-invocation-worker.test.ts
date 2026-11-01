import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { buildSteeringPiMessage } from "@/chat/agent/prompt";
import type { AgentRun, AgentSteeringMessage } from "@/chat/agent/types";
import { agentInstructionProvenance } from "@/chat/conversations/provenance";
import {
  createAgentInvocation,
  createAgentInvocationForMessage,
  getAgentInvocation,
  getAgentInvocationMessageId,
  getAgentInvocationTurnId,
  markAgentInvocationRunning,
} from "@/chat/agent-invocations/store";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import {
  buildAgentInvocationInboundMessage,
  createAgentInvocationWorker,
  agentInvocationInputText,
} from "@/chat/agent-invocations/work";
import { commitMessages } from "@/chat/conversations/projection";
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
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";
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

  it("stops a stranded running child without starting another agent run", async () => {
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

  it("stops open child agents when a stop comes after the child saved its result", async () => {
    const fixture = await prepareParentConversation();
    try {
      const created = await createAgentInvocation({
        ...INVOCATION_INPUT,
        idempotencyKey: "late-stop",
      });
      const helper = await createAgentInvocation({
        ...INVOCATION_INPUT,
        idempotencyKey: "late-stop-helper",
        parentConversationId: created.childConversationId,
      });
      const stopRequest = new AbortController();
      const enqueueResult = vi
        .fn(async () => {})
        .mockRejectedValueOnce(new Error("Parent mailbox unavailable"));
      const worker = createAgentInvocationWorker(
        {
          run: async () => {
            // The stop request arrives after the run finished.
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
        },
        { enqueueResult },
      );
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

      // A failed report after the save retries the attempt. The pending stop
      // must not end the saved result as stopped.
      await expect(worker(context, created.invocationId)).rejects.toThrow(
        "Parent mailbox unavailable",
      );
      expect(context.attempt.ack).not.toHaveBeenCalled();
      await expect(worker(context, created.invocationId)).resolves.toEqual({
        status: "completed",
      });
      expect(enqueueResult).toHaveBeenLastCalledWith(
        expect.objectContaining({
          parentMailboxStatus: "pending",
          status: "completed",
        }),
      );

      // The open helper would have reported for the child. The stop ends the
      // helper, so the child's own result reports now.
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        parentMailboxStatus: "pending",
        result: "Partial result",
        status: "completed",
      });
      await expect(
        getAgentInvocation(helper.invocationId),
      ).resolves.toMatchObject({
        parentMailboxStatus: "skipped",
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
      });
      await markAgentInvocationRunning(created.invocationId);
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
      await upsertTurnRecord({
        actor: INVOCATION_INPUT.actor,
        conversationId: created.childConversationId,
        destination: DESTINATION,
        piMessages: [
          buildSteeringPiMessage({
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
      const worker = createAgentInvocationWorker({
        run: async (run) => {
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
      // The parent's text is labeled as agent-written and has no Actor.
      expect(steered).toEqual([
        [
          expect.objectContaining({
            provenance: agentInstructionProvenance,
            text: expect.stringMatching(
              /^\[parent agent task\][\s\S]*Also check the retry path\.$/,
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
        ],
      ]);
      for (const steeredMessage of [message, savedMessage]) {
        await expect(
          getAgentInvocation(steeredMessage.invocationId),
        ).resolves.toMatchObject({
          parentMailboxStatus: "steered",
          status: "completed",
        });
      }
      // The running agent invocation reports for all of them.
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        parentMailboxStatus: "pending",
        result: "Checked both paths.",
        status: "completed",
      });
      await expect(
        createListAgentsTool({ conversationId: PARENT_CONVERSATION_ID })
          .execute!({}, {}),
      ).resolves.toMatchObject({
        agents: [
          {
            last_result: "completed",
            name: "researcher",
            status: "idle",
            task: `Skip the "cache" path & <retry>.`,
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

  it("lets child agents spawn only down to maxAgentDepth", async () => {
    const fixture = await prepareParentConversation();
    try {
      const child = await createAgentInvocation({
        ...INVOCATION_INPUT,
        idempotencyKey: "depth-child",
      });
      const helper = await createAgentInvocation({
        ...INVOCATION_INPUT,
        idempotencyKey: "depth-helper",
        parentConversationId: child.childConversationId,
      });
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
      // With maxAgentDepth 1, depth 1 can spawn and depth 2 cannot.
      for (const invocation of [child, helper]) {
        await expect(
          worker(
            {
              attempt: {
                ack: vi.fn(),
                conversationId: invocation.childConversationId,
                drain: vi.fn(),
                isFinalAttempt: false,
                messages: [buildAgentInvocationInboundMessage(invocation)],
              },
              checkIn: vi.fn(),
              conversationId: invocation.childConversationId,
              shouldYield: () => false,
            },
            invocation.invocationId,
          ),
        ).rejects.toThrow("stop after reading the run");
      }
      expect(runs.map((run) => run.disabledFeatures)).toEqual([
        ["handoff", "interactive-auth"],
        ["handoff", "interactive-auth", "subagents"],
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
